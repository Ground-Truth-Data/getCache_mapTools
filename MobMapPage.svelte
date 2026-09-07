<!--
    Shell for /mobile/map. Composes initializeMap + MapDrawControls
    (3×2 tool grid) + eye toggle for map-only mode.
-->
<script lang="ts">
import { retreeverMapPorts } from "$lib/mobile/offline/host/retreeverMapPorts";
const mapPorts = retreeverMapPorts();
import { onMount } from "svelte";
import { dev } from "$app/environment";
import { goto, replaceState } from "$app/navigation";
import { MAP_CONFIG } from "$parent/siblings/getCache_OnlineMap/lib/MAP_CONFIG";
import { initializeMap } from "$parent/siblings/getCache_OnlineMap/lib/mapInit";
import { NiceScaleBarControl } from "$parent/siblings/getCache_OnlineMap/lib/mapScaleBar";
import { parseMapHash } from "$parent/siblings/getCache_OnlineMap/lib/mapUtilsHash";
import MapDrawControls from "./MapDrawControls.svelte";
import MapLegend from "$parent/siblings/getCache_OfflineMap/lib/mapUi/MapLegend.svelte";
import MapTopControls from "$parent/siblings/getCache_OfflineMap/lib/mapUi/MapTopControls.svelte";
import { attachDoubleTapToPin } from "$parent/siblings/getCache_OfflineMap/lib/shared/doubleTapToPin";
import { attachMapErrorCapture } from "$parent/siblings/getCache_OfflineMap/lib/shared/mapboxErrorCapture";
import {
    applyCameraOrientation,
    attachCameraPersistence,
    loadCamera,
    MAP_HOME_CENTER,
} from "$parent/siblings/getCache_OfflineMap/lib/mapState/mapViewport";
import {
    ONLINE_MAP_ROUTE,
    OFFLINE_MAP_ROUTE,
    saveLastMapRoute,
} from "$parent/siblings/getCache_OfflineMap/lib/mapState/lastMapRoute.svelte";
import {
    HOSPITAL_LAYER_ID_LIST,
    type HospitalLayerHandle,
    attachHospitalLayer,
} from "$parent/siblings/getCache_OfflineMap/routes/hospitals/hospitalLayer";
import type maplibregl from "maplibre-gl";
// TYPE-ONLY import: erased at build time, so it does NOT pull the 1,397-line
// fireLayer module (and its whole dependency graph) into this route's bundle.
// The implementation is loaded lazily below, and ONLY when fires are enabled —
// see the attach site. BISECT_STATE.md is explicit that a module live on ANY
// route stays resident in this one-process app, so a static import of a
// runtime-disabled layer is not free: it costs parse, evaluate and retention
// for code that can never run.
import type { FireLayerHandle } from "./fireLayer";
import { overlayVisibility } from "$parent/siblings/getCache_OfflineMap/lib/mapState/overlayVisibility.svelte";
import OfflineWorkMeter from "$parent/siblings/getCache_OfflineMap/lib/shared/OfflineWorkMeter.svelte";
import OfflineConfigPanel from "$parent/siblings/getCache_OfflineMap/lib/panels/OfflineConfigPanel.svelte";
import { fireOrigins } from "./fireOrigins";
import { createMapStore } from "$lib/mobile/stores/mapStore.svelte";
import { onlineMapHitchState } from "$parent/siblings/getCache_OfflineMap/lib/mapState/onlineMapHitchState.svelte";
import type { MapDemoKey } from "./mapDemoScheduler.svelte";

// When set (the anime/<key> showcase routes), MapDrawControls loops that one
// demo and the idle teaching hand is bypassed. Unset on the real /mobile/map.
//
// `showConfig` mirrors offline's `rails`: OFF by default (the real /map), ON
// only for /map/debug. Reuses OfflineConfigPanel's `layers` prop rather than
// building a second copy — it is already a generic on/off list, not
// offline-specific.
let {
    demoShowcase = null,
    showConfig = false,
}: { demoShowcase?: MapDemoKey | null; showConfig?: boolean } = $props();

let hospitalsOn = $state(true);
function toggleHospitals(): void {
    hospitalsOn = !hospitalsOn;
    if (!mapInstance) return;
    const vis = hospitalsOn ? "visible" : "none";
    for (const id of HOSPITAL_LAYER_ID_LIST) {
        if (mapInstance.getLayer(id))
            mapInstance.setLayoutProperty(id, "visibility", vis);
    }
}
// FIRES ROW: listed but DISABLED. Fires stay behind the
// FIRE_LAYER_ENABLED_ONLINE compile-time bisect, untouched — v1 measured
// ~4GB heap / crashed the tab (see [[fires-v2-rewrite]]), and the module is
// dynamic-imported specifically so a runtime switch can never load it. The
// row exists here so the panel doesn't need rediscovering when fires v2
// ships and this becomes safe to wire for real.
const configLayers = $derived([
    { key: "hospitals", label: "Hospitals", on: hospitalsOn, toggle: toggleHospitals },
    {
        key: "fires",
        label: "Fires",
        on: false,
        toggle: () => {},
        disabled: true,
        disabledHint:
            "v1 measured ~4GB heap and is compile-time disabled (FIRE_LAYER_ENABLED_ONLINE). Not switchable until fires v2 ships.",
    },
]);

// Home fallback — used ONLY when there's nowhere else to go: no resumable
// camera AND no map to frame. A valid saved camera resumes; an active map
// auto-frames (MapDrawControls). MAP_HOME_CENTER is the ONE shared constant
// (mapViewport.ts) so the offline route's home is the same spot. Null-island
// (0,0) cameras are rejected in loadCamera, so a stray jump to the Gulf of
// Guinea never wins over this.
const DEFAULT_ZOOM = 3.5;

// Module-scope store instance — the established pattern on this route
// (fireLayer.ts:184, MapDrawControls.svelte:294). Read-only here: the
// hospital wall is measured from the anchors in it.
const mapStore = createMapStore();

/** The same view on the offline map, in the ?at&z shape it reads. */
function offlineHref(): string {
    const m = mapInstance;
    if (!m) return OFFLINE_MAP_ROUTE;
    const c = m.getCenter();
    return `${OFFLINE_MAP_ROUTE}?at=${c.lat.toFixed(6)},${c.lng.toFixed(6)}&z=${m.getZoom().toFixed(2)}`;
}

/**
 * Where the hospital wall is measured from — the fire layer's anchor ladder
 * (live GPS fix → features touched in 30 days → map centre as the last
 * resort), read at paint time so the store has hydrated. Unhitched (a
 * checkout with no ReTreever) has no store to anchor from, so no layer.
 */
function hospitalOrigins(map: mapboxgl.Map): readonly (readonly [number, number])[] {
	if (!onlineMapHitchState.hitched) return [];
	const c = map.getCenter();
	return fireOrigins([c.lng, c.lat], mapStore.allMaps);
}

let mapContainer: HTMLDivElement | undefined = $state();
let mapError: string | null = $state(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mapInstance: any = $state(null);
// EARLY map handle — set at CONSTRUCTION time (onMapCreated), before the
// style loads. ONLY the location layer (blue dot) consumes it, via
// MapDrawControls' `locMap` prop: on a weak signal the hosted style fetch can
// hang for minutes and `mapInstance` stays null, but the dot (a DOM Marker)
// works on a bare map with pure GPS. Never hand this to anything else —
// general map wiring keeps waiting for onMapReady / `mapInstance`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let locMapInstance: any = $state(null);
// Bound instance of <MapDrawControls>, used ONLY to reach its exported
// requestMyLocation() from the hospital popup's GPS button (see
// onShowMyLocation above). Everything else flows through props.
let drawControlsRef: ReturnType<typeof MapDrawControls> | undefined =
    $state();
let armKind: "polygon" | "line" | "pin" | null = $state(null);
// Double-tap-to-pin: the gesture sets this → MapDrawControls creates the pin
// AND opens its editor (name / icon / share), same as the offline map.
let dropPinAt: [number, number] | null = $state(null);
// Bullseye drag → drive the Snake Ruler (start / move / commit).
let measureEvent: { lng: number; lat: number; n: number } | null = $state(null);
let measureN = 0;
// Set by the double-tap gesture: tears down its "Drop" card the instant the
// bullseye is grabbed and the snake starts (it's a line now, not a pin).
let dismissDropCard: (() => void) | null = null;

// Map-only mode — toggled by the eye inside MapTopControls (bound below);
// passed to MapDrawControls so it can react.
let mapOnly = $state(false);

// Legend — opened by the LEGEND tile in the map tool drawer. The online map has
// no custom basemap line layers (it's a Mapbox style), so the legend lists only
// the user's drawn overlays (pin / plot / polygon / PDF map) — no basemapRows.
let legendOpen = $state(false);

// Full-bleed map: the route flags the shell so we can lift the top/tab bars
// above the (now fullscreen) map via :global() CSS. Added on mount, removed
// on unmount — never pollutes other routes.
$effect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.add("demo-map-fullbleed");
    return () => document.body.classList.remove("demo-map-fullbleed");
});

// showConfig ⇒ this mounted via /map/debug's `@` layout reset, which skips
// (getcache)/+layout@.svelte and so never gets its `mobile-app` body class
// (position: fixed). Without it the site-wide `overflow-x: clip` on <body>
// (app.css, the VIEWPORT LOCK rule) clips every position:fixed descendant —
// HostPill included — off-screen: still in the DOM, still clickable via the
// accessibility tree, invisible on every actual paint. MEASURED: HostPill on
// /map (has mobile-app) renders; the identical component on /map/debug
// (no mobile-app) does not, confirmed by getComputedStyle(body).overflow
// reading "clip visible" there vs "hidden" on the real route. Scoped to
// showConfig so the real /map (which already gets mobile-app from its own
// layout) is never touched by this.
$effect(() => {
    if (!showConfig || typeof document === "undefined") return;
    document.body.style.overflow = "hidden";
    return () => {
        document.body.style.overflow = "";
    };
});

// Component-scoped (not onMount-local) so the legend-toggle effect below can
// reach it to repaint. $state so that effect re-runs once the layer attaches.
let detachFire: FireLayerHandle | undefined = $state();
let detachHospitals: HospitalLayerHandle | undefined;

onMount(() => {
    // STICKY MAP: record that ONLINE is the map in use, so the bottom bar's MAP
    // tab and every "See on map" eye come back HERE rather than to a hardcoded
    // route. Recorded at the destination (not at the crow toggle) so arriving by
    // deep link or share URL sticks too. Set BEFORE the mapContainer guard —
    // the user is on this route either way.
    saveLastMapRoute(ONLINE_MAP_ROUTE);

    let cleanup: (() => void) | undefined;
    let detachCamera: (() => void) | undefined;
    let detachDblTap: (() => void) | undefined;
    let seedResizeRaf = 0;

    if (!mapContainer) return;
    // Resume the last viewport (set on a prior mount / before the crow
    // toggle) so switching baselayers or returning to the page stays put.
    const savedCam = loadCamera();
    // ?at=lat,lng&z= is the offline pages' URL shape; honour it here too so a
    // link hops between the maps on the same spot. A hash still wins over it
    // (mapInit applies the hash after these initials).
    const atParam = new URLSearchParams(window.location.search);
    const [atLat, atLng] = (atParam.get("at") ?? "").split(",").map(Number);
    const atZoom = Number(atParam.get("z"));
    const atCam =
        Number.isFinite(atLat) && Number.isFinite(atLng)
            ? { center: [atLng, atLat] as [number, number], zoom: Number.isFinite(atZoom) && atZoom > 0 ? atZoom : DEFAULT_ZOOM }
            : null;
    try {
        cleanup = initializeMap(mapContainer, {
            showNavigation: true,
            // Style control removed — eye takes the top-right slot.
            showStyleControl: false,
            showDrawTools: false,
            mobileControls: true,
            loadMarkers: false,
            autoRotate: false,
            globeProjection: false,
            // Camera in the URL so a tier switch — a different ORIGIN, so
            // loadCamera()'s storage doesn't carry over — lands on the same
            // spot. A #zoom/lat/lng hash present at boot beats savedCam
            // (mapInit applies it after these initials), so old share links
            // still land.
            enableHash: true,
            // Written as ?at&z ONLY — the offline pages' shape — so the URL
            // carries the camera once. mapInit hands us the hash form; it is
            // converted, never kept, and any hash we arrived with is dropped.
            writeHash: (url: string) => {
                const cam = parseMapHash(url);
                if (!cam) return;
                const u = new URL(window.location.href);
                u.hash = "";
                u.searchParams.set("at", `${cam.center[1].toFixed(6)},${cam.center[0].toFixed(6)}`);
                u.searchParams.set("z", cam.zoom.toFixed(2));
                if (u.href === window.location.href) return;
                replaceState(u, {});
            },
            scrollZoom: true,
            initialCenter: atCam?.center ?? savedCam?.center ?? MAP_HOME_CENTER,
            initialZoom: atCam?.zoom ?? savedCam?.zoom ?? DEFAULT_ZOOM,
            hideLabels: true,
            labelWhitelist: ["road-", "settlement-"],
            style: MAP_CONFIG.styles.defaultSat,
            onMapCreated: (map) => {
                // Pre-style handle for the blue dot only (see locMapInstance).
                locMapInstance = map;
                // Sentry capture must ride the EARLY handle: a hung/failed
                // style load is exactly the event to catch, and it happens
                // before onMapReady ever fires.
                attachMapErrorCapture(map, "map");
            },
            onMapReady: (map) => {
                // Geolocate removed — location lives in the tool drawer (LOCATE tile).
                mapInstance = map;
                // biome-ignore lint/suspicious/noExplicitAny: dev probe (mirrors offlinev4's __v3map)
                if (dev) (window as any).__mobmap = map;
                // Restore rotation/tilt (center+zoom came in via init) and
                // start persisting the camera on every move.
                if (savedCam) applyCameraOrientation(map, savedCam);
                detachCamera = attachCameraPersistence(map);
                // WILDFIRES — on by default. The legend's fire eye can hide them
                // for a shift, but that hide EXPIRES (see FIRE_HIDE_TTL_MS): a
                // hazard layer you have to remember to switch back on is one you
                // find the day after you needed it.
                // ═══════════════════════════════════════════════════════════
                // Dynamic import: the 1,397-line fire module is fetched only
                // once the map is live, not on every load of the route.
                void import("./fireLayer").then((m) => {
                    detachFire = m.attachFireLayer(map);
                });
                // HOSPITALS — the same layer and card the offline map mounts,
                // the wall measured from the same anchors as the fires.
                detachHospitals = attachHospitalLayer(
                    map as unknown as maplibregl.Map,
                    {
                        origins: () => hospitalOrigins(map),
                        // The card's "My location" runs the LOCATE tile's action.
                        // Read at click time: initializeMap runs before
                        // <MapDrawControls> binds the ref.
                        onShowMyLocation: () => void drawControlsRef?.requestMyLocation(),
                    },
                );
                map.addControl(
                    new NiceScaleBarControl({
                        width: 200,
                        maxRangeMeters: 100_000_000,
                        minStepWidth: 23,
                        maxDepth: 4,
                        height: 10,
                        unit: "m",
                    }) as mapboxgl.IControl,
                    "bottom-left",
                );
                // Double-tap anywhere → drop a pin (zoom is two-finger only).
                // Same shared gesture as the offline map. No offline blobs to
                // identify here, so the popover shows just the GPS point (no
                // headline). A real province/ocean lookup can name it later.
                detachDblTap = attachDoubleTapToPin(map, {
                    onDrop: (lng, lat) => {
                        dropPinAt = [lng, lat];
                    },
                    onMeasureSeed: (lng, lat) => {
                        measureEvent = { lng, lat, n: measureN++ };
                    },
                    registerDismiss: (fn) => {
                        dismissDropCard = fn;
                    },
                });
                // Full-bleed container means the canvas may have been measured
                // before final layout. Force a resize so tiles fill the frame.
                // Cancelled on unmount — a backgrounded tab freezes rAF, so
                // this callback can otherwise fire AFTER map.remove() and
                // crash in mapbox's _resizeCanvas (Sentry CAPACITOR-1M).
                seedResizeRaf = requestAnimationFrame(() => map.resize());
            },
        });
    } catch (err) {
        console.error("[MobMapPage] Map init failed:", err);
        mapError =
            err instanceof Error ? err.message : "Map failed to initialize";
    }

    return () => {
        cancelAnimationFrame(seedResizeRaf);
        detachDblTap?.();
        detachCamera?.();
        detachFire?.();
        detachHospitals?.();
        detachHospitals = undefined;
        // Drop the handle too — it now outlives onMount, and a repaint through a
        // disposed layer would touch a removed map.
        detachFire = undefined;
        cleanup?.();
    };
});

// Legend fire eye → repaint. fireLayer.ts is plain TS with no runes, so the
// reactive edge lives here and calls into it. Reading the store inside the
// effect is what subscribes us.
$effect(() => {
    overlayVisibility.fires;
    detachFire?.repaint();
});
</script>

<div class="mobile-map-fill"
    class:draw-active-poly={armKind === 'polygon'}
    class:draw-active-line={armKind === 'line'}
    class:draw-active-pin={armKind === 'pin'}
>
    {#if mapError}
        <div class="map-error">
            <p>Map unavailable</p>
            <p class="map-error-detail">{mapError}</p>
        </div>
    {/if}
    <div bind:this={mapContainer} class="map-canvas"></div>

    <!-- MAP DEBUGGER — /map/debug ONLY, never the real /map.
         It is an instrument, and it was sitting on top of the product: a
         panel of run counts and heap bars covering the map on the route a
         user actually opens. Dev-only was not a narrow enough gate, because
         the whole app is dev-only while it is being built.
         `showConfig` is the same switch the config rail already uses, and it
         is the line being drawn here: OFF on /map, ON on /map/debug. The
         comparison baseline this used to argue for is still available — it is
         one route over, on the debugger, mounting this very component. -->
    {#if showConfig}
        <OfflineWorkMeter route="map" />
    {/if}

    <!-- Eye (map-only toggle) + crow (online/offline switch) — shared with
         the offline route so the two stacks are always identical. -->
    <MapTopControls
    ports={mapPorts}
        bind:mapOnly
        crowMode="online"
        onCrowToggle={() => goto(offlineHref())}
    />

    <MapDrawControls
        bind:this={drawControlsRef}
        map={mapInstance}
        locMap={locMapInstance}
        bind:armKind
        bind:dropPinAt
        bind:measureEvent
        onMeasureDrag={() => dismissDropCard?.()}
        {mapOnly}
        idleDemo={!demoShowcase}
        {demoShowcase}
        onLegend={() => (legendOpen = true)}
    />

    {#if legendOpen}
        <MapLegend
    ports={mapPorts} onClose={() => (legendOpen = false)} />
    {/if}

    {#if showConfig}
        <div class="config-rail">
            <OfflineConfigPanel layers={configLayers} />
        </div>
    {/if}

    {#if dev}
    {/if}
</div>

<!-- All PRODUCTION page CSS (full-bleed fill, draw-armed frame, map-only
     slide-away, mapbox ctrl overrides, grid plot popup, error panel) lives in
     the shared mobile.css "Full-bleed map page chrome" section — one copy
     styles BOTH this route and /mobile/offlinev4. Don't re-grow those rules
     in a component <style> here: the two pages' copies drifted once already
     (offline lost map-only mode).

     The one exception is .config-rail below: it is debug-only (showConfig,
     off by default, on only for /map/debug), so it does not belong in
     always-loaded production CSS the way the rules above do. -->
<style>
.config-rail {
    position: fixed;
    right: 0.6rem;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 9rem);
    /* .mob-drawer (MapDrawControls) sits at z-index 22 and covers a large
       part of the screen — must beat it, and the HostPill it sits above
       (9999), or the panel paints under the drawer with no visible sign
       anything is wrong. */
    z-index: 30;
    width: 16rem;
    max-height: 60vh;
    overflow-y: auto;
}
</style>
