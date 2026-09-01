<!--
    Mobile map draw controls — single "TOOLS" section, 3×2 icon grid.

    ⚠ NO LOCAL CSS FOR SHARED PATTERNS.
    Use primitives from $lib/mobile/components/ (see README).
    Local CSS is allowed ONLY for layout glue (grid, gap, position) unique
    to this screen. If you're styling colors, borders, radii, typography,
    or surfaces — stop and use a primitive or extend mobile.css.
    Migration target: convert the 9-tile mapModule .tile grid → <Card layout="tile">.
-->
<script lang="ts">
import { retreeverMapPorts } from "$lib/mobile/offline/host/retreeverMapPorts";
const mapPorts = retreeverMapPorts();
import type { Feature } from "geojson";
import type { Map as MapboxMap } from "mapbox-gl";
import { goto } from "$app/navigation";
import { createUserLocator } from "./userLocation.svelte";
import { tracking } from "./tracking.svelte";
import { createLocationInsist } from "$lib/mobile/utils/locationInsist.svelte";
import LocationInsist from "$lib/mobile/components/ui/LocationInsist.svelte";
import { PopoverPositioning } from "./popoverPositioning.svelte";
import {
    POPOVER_TOP_RESERVE,
    POPOVER_BOTTOM_RESERVE,
} from "@ground-truth/getcache-offlinemap/lib/panels/MapPopoverShell.svelte";
import { createMapFramer } from "./mapFramer";
import { shareFeatureKML, type MapShareFormat } from "$lib/mobile/utils/kmzExport";
import { IMPORTABLE_ACCEPT } from "$lib/mobile/import/importRouter";
import {
    safeEaseTo,
    safeFlyTo,
} from "@ground-truth/getcache-onlinemap/lib/safeMap";
import { ensureUsername } from "$lib/mobile/utils/ensureUsername.svelte";
import { loadUserProfile } from "$mobRoutes/db/index";
import MapDrawDemo from "./MapDrawDemo.svelte";
import {
	createMapDemoScheduler,
	type MapDemoKey,
} from "./mapDemoScheduler.svelte";
import { RETREEVER_STAMP } from "$mobRoutes/db/tinySchema";
import SnakeRuler from "@ground-truth/getcache-offlinemap/lib/mapUi/SnakeRuler.svelte";
import SelfCoordPill from "@ground-truth/getcache-offlinemap/lib/mapUi/SelfCoordPill.svelte";
import { type ShareFormat } from "$lib/mobile/components/ui/SharePicker.svelte";
import { copyToClipboard } from "$lib/mobile/utils/copyToClipboard";
import DrawPalette from "@ground-truth/getcache-offlinemap/lib/mapUi/DrawPalette.svelte";
import TrackingStrip from "@ground-truth/getcache-offlinemap/lib/mapUi/TrackingStrip.svelte";
import { createOverlayManager } from "@ground-truth/getcache-offlinemap/lib/mapState/overlayManager.svelte.js";
import { createVertexDrag } from "@ground-truth/getcache-offlinemap/lib/mapState/vertexDrag";
import { createPinMarkers } from "@ground-truth/getcache-offlinemap/lib/mapState/pinMarkers";
// Imported for its :global badge CSS — the plot pins (built imperatively in
// pinMarkers.ts) emit StatusDots' class contract, so this ships the bulb styles.
import StatusDots from "$lib/mobile/components/quality704/StatusDots.svelte";
import { createBasemapPicker } from "./basemapPicker.svelte";
import { attachRoadDulling } from "./dullStreamingRoads";
import { createGridTile } from "./gridTile.svelte";
import { createMapImporter } from "./mapImporter.svelte";
import ImportProgress from "$lib/mobile/components/ImportProgress.svelte";
import MobDrawer from "$lib/mobile/components/ui/MobDrawer.svelte";
import Chip from "$lib/mobile/components/ui/Chip.svelte";
import MapToolDrawer from "./MapToolDrawer.svelte";
import ImportSourceModal from "$lib/mobile/components/ui/ImportSourceModal.svelte";
import MapsLayersPanel from "./MapsLayersPanel2.svelte";
import MapDrSearch from "./mapDrSearch.svelte";
import { onMount } from "svelte";
import { page } from "$app/state";
import { createCacheStore } from "$lib/mobile/stores/cacheStore.svelte";
import { createMapStore } from "$lib/mobile/stores/mapStore.svelte";
import { overlayVisibility } from "@ground-truth/getcache-offlinemap/lib/mapState/overlayVisibility.svelte.js";
import { polygonOpacity } from "@ground-truth/getcache-offlinemap/lib/mapState/overlayOpacity.svelte.js";
import PlotLayer from "./PlotLayer.svelte";
import FeatureLayer from "./FeatureLayer.svelte";
import { createMapEvents } from "./mapEvents.svelte";
import { defaultMapTitle } from "$lib/mobile/utils/naming";
import {
    type Lnglat,
    applyPolygonFillOpacity,
    buildCentroidFC,
    buildCompletedFC,
    buildDrawEdgesFC,
    clearInProgressSources,
    finalizeFeature,
    getAccentColor,
    setVertexHandlesForFeature,
    setupDrawSourcesAndLayers,
    wireBoundaryPinNavigation,
} from "@ground-truth/getcache-onlinemap/lib/mapDraw";
import {
    setSelectedAreaLabel,
    syncAreaLabels,
} from "@ground-truth/getcache-onlinemap/lib/areaLabels";

let {
    map = $bindable(null),
    locMap = null,
    mapOnly = false,
    idleDemo = false,
    demoShowcase = null,
    noAutoFrame = false,
    offline = false,
    offlineBasemapLayers = undefined,
    dropPinAt = $bindable(null),
    measureEvent = $bindable(null),
    armKind = $bindable(null),
    onMeasureDrag = undefined,
    onLegend = undefined,
}: {
    map: MapboxMap | null;
    // EARLY MAP HANDLE — the same mapboxgl.Map, but delivered at CONSTRUCTION
    // time (initializeMap's onMapCreated), before the style loads. ONLY the
    // location layer (blue dot) reads it: mapboxgl.Marker is a DOM overlay
    // that works on a bare map, so on a weak signal — hosted style fetch
    // hanging for minutes, `map` still null — the dot still rides pure GPS.
    // Everything else keeps gating on `map` (set on onMapReady) unchanged.
    locMap?: MapboxMap | null;
    mapOnly?: boolean;
    // Run the idle teaching-hand demo. ONLY the real /mobile/map (MobMapPage)
    // opts in — the offline + preview routes reuse this component but must NOT
    // show the hand.
    idleDemo?: boolean;
    // Dev showcase: loop ONE demo in isolation (the anime/<key> routes). When
    // set, the idle scheduler is bypassed entirely.
    demoShowcase?: MapDemoKey | null;
    // Suppress the cold-open / first-feature auto-frame. The offline map (V3)
    // opts in: it manages its own camera (saved viewport), and auto-framing a
    // freshly-dropped first pin slams the zoom to ~z15. With this on, dropping a
    // pin just PANS (keeps the current zoom), matching the live map's already-
    // framed feel.
    noAutoFrame?: boolean;
    // OFFLINE LOCK. The shared basemap switcher swaps to hosted Mapbox styles
    // (`mapbox://.../streets-v12` etc.) via `setStyle` — those STREAM tiles and
    // wipe the airgapped offline base. The offline route (V3) passes `offline`
    // so the switcher is hidden AND can never apply a streaming style (no
    // setStyle to a mapbox:// URL, not even the persisted choice). Offline rule
    // #1: only show data that lives on the phone.
    offline?: boolean;
    // OFFLINE BASEMAP TOGGLES. On the offline route the streaming Satellite/Streets
    // switcher is hidden (it would stream). Instead the route passes its on-device
    // layer toggles here and the BASEMAP card renders them as independent on/off
    // switches in the SAME grid slot + popover style. Each `toggle` flips one layer.
    offlineBasemapLayers?:
        | { key: string; label: string; on: boolean; toggle: () => void }[]
        | undefined;
    // Programmatic pin drop. The offline route's click-to-identify popover sets
    // `[lng, lat]` here to "create a pin at this spot" — we run the SAME create +
    // select + open-editor flow as a drawn pin, then clear it back to null.
    dropPinAt?: [number, number] | null;
    // Snake Ruler seed: double-tapping the map plants the first ruler node here
    // so it's immediately grabbable. Dragging from any node (the gesture) is
    // handled by Mapbox `measure-nodes` layer events below. `n` is a monotonic
    // counter so a repeat coordinate still re-fires the effect.
    measureEvent?: { lng: number; lat: number; n: number } | null;
    // Which palette tool is armed (drives the Snake Ruler). Bindable so a parent
    // can reflect "draw-active" styling. Replaces the old `drawIntent` prop.
    armKind?: "line" | "polygon" | "pin" | null;
    // Fired the instant a ruler END node is grabbed to drag — the host tears
    // down the stale double-tap "Drop a pin" card (it's a line now, not a pin).
    onMeasureDrag?: (() => void) | undefined;
    // Optional LEGEND tile. Only the offline route passes this — it opens the
    // map's colour-key card. When undefined (the live /map), no LEGEND tile renders.
    onLegend?: (() => void) | undefined;
} = $props();

// ── User-location (blue dot) ────────────────────────────────────────────
// All geolocation logic lives in ./userLocation.svelte.ts. The locator reads
// the ready `map` when it exists, else the construction-time `locMap` — same
// instance, just earlier — so the dot never waits on the style fetch.
// Second arg: tapping the blue dot floats the coordinate pill above it — the
// THIRD door onto the same one action (LOCATE tile, hospital popup's "My
// location", and now the dot itself). It reads the fix already in memory, so it
// never prompts and never moves the camera; `showSelfCoord` is hoisted.
const userLocator = createUserLocator(() => map ?? locMap, () => showSelfCoord());

$effect(() => {
    if (!map) return;
    return userLocator.attachGeolocateControl();
});

// THE ALWAYS-ON DOT — the blue dot shows on plain map-open, Google-Maps
// style, with NO tap. One permission check on mount: already granted → the
// watch starts and the dot appears (instantly at last-known, then live);
// not granted → nothing happens (no prompt, no listener — the location
// gate owns prompting via location-needing taps, and a gated LOCATE tap
// starts this watch through locate() anyway). Never moves the camera.
// Latched per mount: a route re-entry is a fresh component instance, so
// the unmount cleanup below and this pair re-arm correctly.
let dotAutoStarted = false;
$effect(() => {
    if (dotAutoStarted || !(map ?? locMap)) return;
    dotAutoStarted = true;
    void userLocator.autoStart();
});

// App resume / tab visible again → re-arm. iOS suspends geolocation watches
// in the background, and a dead-but-still-registered watch would freeze the
// dot forever. autoStart re-checks permission each time and RESTARTS the one
// watch (single-owner: startWatch/stopWatch latch on one id). Lives here in
// the map/location code — not the global layout — so it only runs while a
// map route is actually mounted.
$effect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
        if (document.visibilityState !== "visible") return;
        if (map ?? locMap) void userLocator.autoStart();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
});

// While a TRACKING session runs, keep the blue dot live on the map — it rides
// the head of the growing track, so the user can SEE it's working between the
// sparse breadcrumb points (the track itself only grows every ~8 m). Without
// this the dot only existed after a LOCATE tap; a session started cold showed
// nothing moving. Idempotent — LOCATE's own watch and this share one marker.
$effect(() => {
    if (!(map ?? locMap) || !tracking.active) return;
    userLocator.watch();
});

// Dull the stock Mapbox road net (bright tan/gold over satellite is too loud).
// Live map only — the offline route never streams a hosted style. Re-applies on
// every basemap switch via the `styledata` listener inside attachRoadDulling.
$effect(() => {
    if (!map || offline) return;
    return attachRoadDulling(map);
});

let basemapTileWrap: HTMLDivElement | undefined = $state();
const basemapPicker = createBasemapPicker({
    getMap: () => map,
    getOffline: () => offline,
    getWrap: () => basemapTileWrap,
});

$effect(() => () => userLocator.cleanup());

$effect(() => () => popoverPos.cleanup());

// When the eye toggle hides UI chrome, also hide the drawer + side sheet so
// the map is truly map-only.
$effect(() => {
    if (mapOnly) {
        if (drawerOpen) mobDrawerRef?.close();
        setSelectedIndex(null);
        popoverPos.clear();
    }
});

// ── Layers / Maps combined panel (inline in drawer) ──────────
let showLayersPanel = $state(false);

// ── Search panel ────────────────────────────────────────────
let showSearchPanel = $state(false);

function openSearchPanel() {
    // Reaching for search = the human is busy → abort a teaching demo mid-play
    // (same rule as picking a draw tool). A demo that started during pre-search
    // stillness would otherwise finish its script AFTER the search lands and
    // roll the drawer up over the freshly planted ruler seed.
    cancelMapDemo();
    showSearchPanel = true;
}

// NEW MAP tile — start a fresh, empty map and make it active (the map analog of
// "new cache"). createMap sets it active + auto-titles it; close the drawer so
// the user lands on the clean canvas ready to draw / import.
function newMap() {
    mapStore.createMap();
    mobDrawerRef?.close();
}
function closeSearchPanel() {
    showSearchPanel = false;
}

// Monotonic seed counter for search-planted ruler nodes (same contract as
// the host's double-tap `n` — any new object re-fires SnakeRuler's effect).
let searchSeedN = 0;

function handleSearchResult(result: {
    place_name: string;
    center: [number, number];
}) {
    if (!map) return;
    // Close the modules drawer too — the user searched to GO somewhere, so
    // land them on the unobstructed map as it flies.
    mobDrawerRef?.close();
    const [lng, lat] = result.center;
    // MARK the spot, don't just look at it: once the fly lands, plant a
    // snake-ruler node on the searched point — the same seed the double-tap
    // gesture fires. The user gets a grabbable bullseye right where they
    // searched (measure from it, Save it as a pin, or drop a plot), instead
    // of a bare patch of map they have to find again. Seeded on `moveend`
    // (not immediately) so the node's card doesn't ride over the flight.
    // Listener attaches BEFORE the fly starts: under reduced motion flyTo
    // degrades to an instant jump whose moveend fires synchronously inside
    // the call — attach-after would miss it and the seed would never plant.
    map.once("moveend", () => {
        measureEvent = { lng, lat, n: ++searchSeedN };
    });
    safeFlyTo(map, { center: result.center, zoom: 12, duration: 2000 });
}

const cache = createCacheStore();
const mapStore = createMapStore();
const overlayMgr = createOverlayManager(() => map, mapStore, mapPorts);

let cachedDisplayName = $state<string | null>(null);

if (typeof window !== "undefined") {
    loadUserProfile().then((p) => {
        cachedDisplayName = p.displayName || null;
    });
}

// Invariant: the user is always in a map. As soon as the store is hydrated,
// auto-create one if none exists, named per the canonical convention.
//
// SELF-LIMITING — never loop. ensureActiveMap WRITES the very state this effect
// READS (activeMapKey / allMaps), so if a create ever fails to produce a
// resolvable activeMap (e.g. the store write drops during a boot race), a naive
// effect re-runs, creates again, re-runs… → `effect_update_depth_exceeded` (the
// 500). The `autoCreateAttempted` latch makes us try AT MOST ONCE per "no active
// map" condition: we attempt once, and only re-arm after we've actually observed
// an active map. So a dropped write leaves us armed-but-waiting, not looping.
let autoCreateAttempted = false;
$effect(() => {
    if (!mapStore.ready) return;
    if (mapStore.activeMap) {
        autoCreateAttempted = false; // an active map exists → re-arm for next time it's cleared
        return;
    }
    if (autoCreateAttempted) return; // already kicked off a create; don't spin
    autoCreateAttempted = true;
    mapStore.ensureActiveMap(
        defaultMapTitle(cachedDisplayName, cache.blockNumber),
    );
});

let layersTitle = $derived(mapStore.activeMap?.mapTitle ?? "");
let completedFeatures = $derived(mapStore.features);

function openLayersPanel() {
    // The human opened the maps panel themselves → abort a demo if mid-play.
    cancelMapDemo();
    showLayersPanel = true;
}

function closeLayersPanel() {
    showLayersPanel = false;
}

$effect(() => {
	if (!map) return;
	return overlayMgr.attachOpacity();
});

// The Legend's Polygon-row slider — blanket fill-opacity over every drawn
// polygon. Applier pattern, same as the PDF overlay slider above: fires once
// on register (so a fresh map catches up with the slider) and on every drag.
// The slider RESTS AT CENTRE: its 0–1 value doubles into a 0–2 multiplier,
// so centre = 1 = the designed look, right of centre boosts fills.
// [[cross-module-state-use-applier-pattern]]
$effect(() => {
	const m = map;
	if (!m) return;
	return polygonOpacity.register((opacity) => {
		applyPolygonFillOpacity(m, opacity * 2);
	});
});

$effect(() => {
	if (!map) return;
	return overlayMgr.attachActiveMapDispatch();
});

// The Legend's "PDF map" toggle — reading overlayVisibility.pdf here re-runs
// this effect on every flip; the manager pushes it onto the mounted layers.
$effect(() => {
	overlayVisibility.pdf;
	if (!map) return;
	overlayMgr.applyPdfVisibility();
});

// The regular feature popover + its edits (name/desc save, icon swap, fill-opacity,
// delete) and the tiles-pin view-only popover now live in <FeatureLayer> (bound
// below). The host keeps only selection, share, and the camera.

let zoomTitleVisible = $state(false);
let zoomTitleTimer: ReturnType<typeof setTimeout> | null = null;
let currentZoom = $state<number | null>(null);
const HOME_ZOOM = 6;
function homeZoom() {
    if (!map) return;
    const c = map.getCenter();
    safeFlyTo(map, {
        center: [c.lng, c.lat],
        zoom: HOME_ZOOM,
        duration: 700,
    });
}
// Suppresses the title during pin-selection zooms so it doesn't cover the pin.
let suppressZoomTitle = false;
const popoverPos = new PopoverPositioning(() => map);

let drawerOpen = $state(false);
let mobDrawerRef: import("$lib/mobile/components/ui/MobDrawer.svelte").default;

// WAAPI instead of CSS: MobDrawer's opacity transition shadows the transform,
// so the CSS rollup jumps. WAAPI bypasses CSS entirely — reliable, GSAP-quality.
const TOUR_DRAWER_MS = 1500;
onMount(() => {
    const handler = () => {
        // Force closed first — the tour is now a single step, so the drawer
        // may already be open from prior session state. Snap shut, then
        // animate up so the rollup is always visible.
        mobDrawerRef?.close();
        // Drives drawerOffset per-frame inside MobDrawer — guaranteed slow
        // rollup that no CSS transition rule can shadow.
        mobDrawerRef?.tourAnimateOpen(TOUR_DRAWER_MS);
    };
    window.addEventListener("intro:drawer-rollup", handler);

    // Tour hook: snap the drawer closed before the map intro starts so the
    // first map step shows the actual map, not whatever was open last visit.
    const onRolldown = () => {
        mobDrawerRef?.close();
    };
    window.addEventListener("intro:drawer-rolldown", onRolldown);

    // Map demo hooks: when the IntroTour plays a gesture demo on the map,
    // also drive the real map so the user sees actual motion, not just a
    // floating finger. Listeners check `e.detail.target` so other targets
    // (e.g. stats-chart elsewhere) don't accidentally trigger map motion.
    const onPinchOut = (e: Event) => {
        const t = (e as CustomEvent).detail?.target;
        if (t !== "map-canvas" || !map) return;
        safeEaseTo(map, { zoom: map.getZoom() + 1.5, duration: 1100 });
    };
    const onPinchIn = (e: Event) => {
        const t = (e as CustomEvent).detail?.target;
        if (t !== "map-canvas" || !map) return;
        safeEaseTo(map, {
            zoom: Math.max(2, map.getZoom() - 1.5),
            duration: 1100,
        });
    };
    const onDrag = (e: Event) => {
        const t = (e as CustomEvent).detail?.target;
        if (t !== "map-canvas" || !map) return;
        const cur = map.getCenter();
        if (!Number.isFinite(cur.lng) || !Number.isFinite(cur.lat)) return;
        // Pan a bit east to mirror the finger drag direction.
        map.panBy([-120, 0], { duration: 900 });
    };
    window.addEventListener("intro:demo:pinch-out", onPinchOut);
    window.addEventListener("intro:demo:pinch-in", onPinchIn);
    window.addEventListener("intro:demo:drag", onDrag);

    return () => {
        window.removeEventListener("intro:drawer-rollup", handler);
        window.removeEventListener("intro:drawer-rolldown", onRolldown);
        window.removeEventListener("intro:demo:pinch-out", onPinchOut);
        window.removeEventListener("intro:demo:pinch-in", onPinchIn);
        window.removeEventListener("intro:demo:drag", onDrag);
    };
});

let editMode = $state(false);
// Geometry creation is fully owned by <SnakeRuler> (armed via `armKind`); it calls
// persistMeasure() below to save. This component no longer holds draw vertices.

// SELECTION IS KEY-FIRST, NOT INDEX-FIRST. The source of truth for "what's
// selected" is a stable mapFeatureKey — NOT a positional index into
// mapStore.features. The instant a plot is dropped, the snake-ruler/grid commit
// (and any syncMaps) REBUILDS that array; a positional index then points at a
// DIFFERENT feature or undefined → `selectedFeature` nulls → the plot popover's
// `{#if}` unmounts it → its onDestroy discards the brand-new uncounted plot.
// Anchoring on the key makes selection RIDE the rebuild: the feature is found by
// identity wherever it landed, so the popover never blinks out from under a drop.
// `selectedFeatureIndex` is kept as a DERIVED convenience for the handful of
// callers that still want a position (vertex handles, etc.).
let selectedFeatureKey = $state<string | null>(null);

let selectedFeature = $derived(
    selectedFeatureKey !== null
        ? (completedFeatures.find(
              (f) =>
                  (f?.properties?.mapFeatureKey as string | undefined) ===
                  selectedFeatureKey,
          ) ?? null)
        : null,
);

let selectedFeatureIndex = $derived(
    selectedFeatureKey !== null
        ? (() => {
              const i = completedFeatures.findIndex(
                  (f) =>
                      (f?.properties?.mapFeatureKey as string | undefined) ===
                      selectedFeatureKey,
              );
              return i >= 0 ? i : null;
          })()
        : null,
);

// Existing callsites assign a numeric index (e.g. `selectedFeatureIndex = idx`).
// Route those through a setter that resolves the index → its stable key, so the
// key stays the source of truth. null clears the selection.
function setSelectedIndex(idx: number | null): void {
    if (idx === null) {
        selectedFeatureKey = null;
        return;
    }
    const f = completedFeatures[idx];
    const k = f?.properties?.mapFeatureKey as string | undefined;
    selectedFeatureKey = k ?? null;
}

// Vertex handles (the white-haloed dots) are an editing affordance — they
// render only for the feature currently selected for editing, never for
// every completed feature at once. Reveal the selected feature's handles;
// hide them all on deselect. Re-applied after style swaps in `onStyleLoad`.
$effect(() => {
    if (!map) return;
    setVertexHandlesForFeature(map, selectedFeatureIndex);
});

// The selected area is forced to the front of the label budget — its chip
// floods with the area colour and lifts while the popover is open.
$effect(() => {
    if (!map) return;
    setSelectedAreaLabel(map, selectedFeatureKey);
});

// THE DIM VEIL — single owner. While ANY feature is selected (pin, plot,
// area, line), a translucent veil drops into the marker container; the
// selected marker/chip z-lifts above it (z 5 beats the veil's 4).
// pointer-events: none, so tapping "empty map" still reaches the canvas
// and clears the selection through the normal map-click path.
let dimEl: HTMLDivElement | null = null;
$effect(() => {
    if (!map) return;
    if (selectedFeatureKey !== null) {
        if (!dimEl) {
            dimEl = document.createElement("div");
            dimEl.className = "rt-map-dim";
        }
        const container = map.getCanvasContainer();
        if (dimEl.parentElement !== container) container.appendChild(dimEl);
    } else {
        dimEl?.remove();
    }
    return () => dimEl?.remove();
});

// --- CAMERA FREEZE while a popover is open -----------------------------------
// A popover is anchored to the feature's SCREEN position, so every pan/pinch
// drags the card across the screen. Freeze the camera instead of fighting it.
// This is the dim veil's twin: same trigger, same lifetime.
//
// Gated on popoverPos.bbox, NOT selectedFeatureKey alone, so the freeze can
// never disagree with the popovers' own render gates (FeatureLayer / PlotLayer
// both gate on `bbox !== null && !panning`). It also hands the map back to
// vertex-drag for free — vertexDrag.ts calls popoverPos.clear() while keeping
// the feature selected.
//
// Programmatic moves (flyTo / panBy / fitBounds) are UNAFFECTED by disabling
// handlers, so panToFeature and the ensure-room pan still work while frozen.
let camFrozen = $state(false);
$effect(() => {
	if (!map) return;
	const m = map;
	const freeze = selectedFeatureKey !== null && popoverPos.bbox !== null;
	if (freeze === camFrozen) return;
	camFrozen = freeze;
	if (freeze) {
		m.dragPan.disable();
		m.scrollZoom.disable();
		m.touchZoomRotate.disable();
		m.doubleClickZoom.disable();
	} else {
		m.dragPan.enable();
		m.scrollZoom.enable();
		m.touchZoomRotate.enable();
		m.touchZoomRotate.disableRotation(); // restore the app-wide no-rotate rule
		m.doubleClickZoom.enable();
	}
});

// Never leave the camera frozen behind us.
$effect(() => () => {
	if (!camFrozen || !map) return;
	map.dragPan.enable();
	map.scrollZoom.enable();
	map.touchZoomRotate.enable();
	map.touchZoomRotate.disableRotation();
	map.doubleClickZoom.enable();
	camFrozen = false;
});

// Vertex dragging on completed lines/polygons — logic in ./mobMap/vertexDrag.
// Segment-length labels belong to the Snake Ruler only; a SAVED feature stays
// clean (no measurement legs) while you edit its vertices.
const vertexDragger = createVertexDrag({
    getMap: () => map,
    mapStore,
    popoverPos,
    getDrawIntent: () => armKind, // don't vertex-edit a saved feature while a tool is armed
    setSelectedIndex: (idx) => {
        setSelectedIndex(idx);
    },
});

// A Quality 704 plot pin (pinTypeKey `plot:N`) gets its OWN popover (PlotLayer).
// The host derives this to route the map-click close path AND to tell both layers
// which one owns the selection: FeatureLayer excludes plot pins, PlotLayer claims them.
let selectedIsPlotPin = $derived(
    typeof selectedFeature?.properties?.pinTypeKey === "string" &&
        (selectedFeature.properties.pinTypeKey as string).startsWith("plot:"),
);

// The feature popover (regular pins/lines/polys + the tiles pin) lives in
// <FeatureLayer>; the plot popover lives in <PlotLayer>. Each derives its own
// show-gate from the selection + `selectedIsPlotPin`.

// NO auto-switch on tap. THE RULE: tapping an EXISTING plot pin is VIEW-ONLY —
// the popover reads that plot's data directly (plotByGpsKey) without disturbing
// the live workspace, so merely looking never yanks you onto another survey. The
// survey switch happens ONLY when you commit to editing: the popover's "Edit"
// button navigates to /mobile/quality704?survey=<key>&focusPlot=N, and the page
// activates that survey there (switchActiveSurvey on mount). A freshly-dropped
// (uncounted) plot is already on the active survey, so create-mode needs no
// switch either.

// Pan a Point feature to top-center, suppressing the zoom-title overlay
// for the duration of the slide so the title doesn't pop up over the pin.
function panPointToTop(feat: Feature, opts?: { zoom?: number }) {
    suppressTitleFor(popoverPos.panToFeature(feat, opts));
}

function suppressTitleFor(duration: number) {
    suppressZoomTitle = true;
    if (zoomTitleTimer) clearTimeout(zoomTitleTimer);
    zoomTitleVisible = false;
    if (duration > 0) {
        setTimeout(() => {
            suppressZoomTitle = false;
        }, duration + 100);
    } else {
        suppressZoomTitle = false;
    }
}

// ENSURE ROOM — a popover cut off by the bottom of the screen means the MAP
// moves up in the viewport, not that the user lives with a clipped card.
// Pins already fly to top-center (panToFeature); this is the same idea for
// polygons/lines selected by tap: if neither side of the feature's bbox has
// ROOM_IDEAL px for the popover (same reserves the shell positions with),
// pan the map up just enough — capped so the feature's top edge never goes
// under the top chrome (a screen-filling polygon pans little or not at all;
// its popover overlays it with full height, which no pan can improve).
// Runs once per selected feature key, so the user's own panning afterwards
// is never fought.
const ROOM_IDEAL = 420;
const ROOM_OFFSET = 15; // MapPopoverShell's anchor OFFSET
let roomEnsuredKey: string | null = null;
$effect(() => {
    const feat = selectedFeature;
    const bbox = popoverPos.bbox;
    if (!feat || !bbox) {
        roomEnsuredKey = null;
        return;
    }
    if (!map || selectedIsPlotPin || feat.geometry?.type === "Point") return;
    const key = (feat.properties?.mapFeatureKey as string) ?? "";
    if (!key || key === roomEnsuredKey) return;
    roomEnsuredKey = key;
    const h = map.getContainer().clientHeight;
    if (h <= 0) return;
    const usableBottom = h - POPOVER_BOTTOM_RESERVE;
    const roomBelow = usableBottom - (bbox.maxY + ROOM_OFFSET);
    const roomAbove = bbox.minY - ROOM_OFFSET - POPOVER_TOP_RESERVE;
    if (Math.max(roomBelow, roomAbove) >= ROOM_IDEAL) return;
    const dy = Math.min(
        ROOM_IDEAL - roomBelow,
        bbox.minY - POPOVER_TOP_RESERVE,
    );
    if (dy <= 8 || !Number.isFinite(dy)) return;
    const duration = 500;
    suppressTitleFor(duration);
    // panBy(+y) moves the camera down → the feature slides UP the screen.
    map.panBy([0, dy], { duration, essential: true });
});

// "See on map" camera framing + URL router — logic in ./mapFramer.
const framer = createMapFramer({
    getMap: () => map,
    mapStore,
    popoverPos,
    setSelectedIndex: (idx) => {
        setSelectedIndex(idx);
    },
    panPointToTop,
    suppressTitleFor,
    getOffline: () => offline,
});

// URL-as-truth router for "See on map" (?map= / ?feature= / ?plots=, or a
// bare ?lng=&lat=[&z=] coordinate). The reactive read of page.url lives here; the
// routing logic is in the framer. After a map/feature route we strip the params
// so the URL stays clean AND a re-click re-fires this effect. Bare-coordinate
// params are left in place: the offline route's audit-blob effect keys off them
// reactively (stripping would immediately clear the blob it just mounted), and
// with no strip there's no goto → this effect runs once per navigation.
$effect(() => {
    if (!map || !mapStore.ready) return;
    const params = page.url.searchParams;
    const mapKeyParam = params.get("map");
    const featureKeyParam = params.get("feature");
    // `plots=<fk1>,<fk2>,...` — a block's plot CLUSTER (stats history eye):
    // the framer fits just those pins instead of the whole map. null when the
    // param is absent — the router treats a PRESENT-but-empty plots= as a
    // caller bug (error), never a whole-map frame.
    const plotsRaw = params.get("plots");
    const plotKeysParam =
        plotsRaw === null
            ? null
            : plotsRaw
                  .split(",")
                  .map((k) => k.trim())
                  .filter(Boolean);
    if (!mapKeyParam && !featureKeyParam) {
        framer.applyBareTarget(params);
        return;
    }
    // If the inbox drawer is open (user clicked See-on-map from inside it),
    // close it so the camera move is actually visible.
    if (showLayersPanel) closeLayersPanel();
    framer.applyUrlRoute(mapKeyParam, featureKeyParam, plotKeysParam);
    const url = new URL(page.url);
    url.searchParams.delete("map");
    url.searchParams.delete("feature");
    url.searchParams.delete("plots");
    goto(url.pathname + url.search, { replaceState: true, noScroll: true });
});

// File import state machine — modal, busy flag, progress ticker, handler.
const importer = createMapImporter({
    framer,
    getShowLayersPanel: () => showLayersPanel,
    closeLayersPanel,
    getDrawerOpen: () => drawerOpen,
    getMobDrawer: () => mobDrawerRef,
    // The overlay manager owns the on-map waiting box (black/white-border
    // placeholder + cleanCache animation) shown while a raw PDF converts.
    waiting: overlayMgr,
});

// Inbox / drag-drop → map PDF hand-off. A PDF picked elsewhere parks the File
// and routes here with `?importPdf=1` (a File can't ride a URL). We take it back
// and run it through the SAME importer the map's own picker uses — so it flies
// to the spot and plays the on-map waiting box (the "movie screen in the
// woods" flow), instead of a bare pill. The full-screen splash only mounts
// for blind waits — see the ImportProgress gate below.
//
// The one-shot guard is the FLAG ITSELF: we strip it immediately, so the effect
// can't re-consume this navigation, but a SECOND import (fresh `?importPdf=1`)
// still fires. (An earlier permanent boolean latched after the first import and
// silently swallowed every import after it — the "I don't see it" bug.)
$effect(() => {
    if (!map || !mapStore.ready) return;
    if (page.url.searchParams.get("importPdf") !== "1") return;
    const url = new URL(page.url);
    url.searchParams.delete("importPdf");
    goto(url.pathname + url.search, { replaceState: true, noScroll: true });
    void import("$lib/mobile/import/pending").then(({ takePendingImport }) => {
        const file = takePendingImport();
        if (file) void importer.handleFile(file);
    });
});

function setSource(id: string, data: ReturnType<typeof buildDrawEdgesFC>) {
    if (!map) return;
    const src = map.getSource(id);
    if (src && "setData" in src) {
        (src as unknown as { setData: (d: typeof data) => void }).setData(data);
    }
}

function clearDrawingSources() {
    if (map) clearInProgressSources(map);
}

// Auto-sync map source whenever persisted features change.
// Gate on `ready`: during initial load (cold start, HMR, sql.js reload)
// `mapStore.features` is briefly empty before the on-disk data hydrates.
// Pushing that empty FC blanks out every feature until hydration finishes
// — that's the "they were there, then gone" flicker. Wait for ready.
// Self-heal: if a hidden setStyle wiped the source between renders, re-add
// sources/layers before pushing rather than silently no-oping.
$effect(() => {
    if (!map) return;
    if (!mapStore.ready) return;
    const feats = mapStore.features;
    if (!map.getSource("completed-features")) {
        // Same opt-out as the other two call sites on this route — see
        // mapEvents.svelte.ts. This self-heal must not be the one path that
        // quietly re-adds the unused in-progress sources.
        setupDrawSourcesAndLayers(map, getAccentColor(), false);
    }
    // The "shapes" overlay toggle (Legend / Basemap popover) hides drawn lines +
    // polygons. The completed-features layers ONLY render non-Point geometry (pins
    // + plots are DOM markers, toggled in pinMarkers), so dropping non-Point feats
    // from the pushed FC hides every drawn shape. Reading overlayVisibility.shapes
    // here re-runs this effect on toggle.
    const visible = overlayVisibility.shapes
        ? feats
        : feats.filter((f) => f.geometry?.type === "Point");
    setSource("completed-features", buildCompletedFC(visible));
    // Boundary pins mirror the same visible set — hiding shapes hides them.
    setSource("completed-centroids", buildCentroidFC(visible));
    // Area chips/dots + track labels are DOM markers, reconciled from the
    // same visible set — hiding shapes removes them too. A tap on a chip or
    // dot toggles selection, same as tapping the polygon body.
    syncAreaLabels(map, visible, {
        onSelect: (key) => {
            if (selectedFeatureKey === key) {
                setSelectedIndex(null);
                return;
            }
            const idx = mapStore.features.findIndex(
                (f) => (f.properties?.mapFeatureKey as string) === key,
            );
            if (idx < 0) return;
            setSelectedIndex(idx);
            const feat = mapStore.features[idx];
            if (feat) popoverPos.compute(feat);
        },
    });
    // Armed tool OR an active Snake Ruler = the tap is placing geometry,
    // never flying the camera.
    wireBoundaryPinNavigation(
        map,
        () => armKind === null && !(rulerRef?.isMeasuring() ?? false),
    );
});

const pins = createPinMarkers({
    getMap: () => map,
    mapStore,
    ports: mapPorts,
    getOffline: () => offline,
    getSelectedKey: () =>
        (selectedFeature?.properties?.mapFeatureKey as string) ?? null,
    popoverPos,
    setSelectedIndex: (idx) => {
        setSelectedIndex(idx);
    },
    panPointToTop,
});
// Re-sync the DOM pin/plot markers whenever the data they draw from changes.
// READ both reactive deps so this effect re-runs on EITHER:
//   • selectedFeatureIndex — repaints the selected plot as the gold "Plot N" pill.
//   • mapStore.features    — a plot/pin was dropped, moved, or deleted. Without
//     this read, a freshly-dropped plot had NO marker until some OTHER event
//     (map move, grid toggle) happened to fire sync() — the "no-show plot" bug.
// The GeoJSON-source effect below pushes line/polygon geometry; plots + pins are
// DOM markers reconciled ONLY in sync(), so sync() must track features too.
$effect(() => {
    selectedFeatureIndex;
    mapStore.features;
    if (!map || !mapStore.ready) return;
    pins.sync();
});

// Auto-frame: point the camera at the active map when it becomes active and
// nothing has explicitly framed it yet — a cold map open, or a switchMap that
// wasn't driven by "See on map". `framer.isFramed` is the single record of "the
// camera has been pointed at this map" (frameActiveMap/frameFeature both set
// it), so an explicit "See on map" suppresses this effect instead of racing a
// second animation. Skipped while a ?map=/?feature= deep-link is pending — that
// path frames the target. Re-fires only on activeMapKey change / first feature
// load, never on a feature mutation (which would jerk the camera on every pin).
$effect(() => {
    if (!map || noAutoFrame) return;
    const key = mapStore.activeMapKey;
    if (!key || framer.isFramed(key)) return;
    // The URL-as-truth router above handles framing when `map` or
    // `feature` params are present — stand down so the two effects
    // don't race-animate the camera.
    if (
        page.url.searchParams.has("feature") ||
        page.url.searchParams.has("map")
    ) {
        return;
    }
    if ((mapStore.activeMap?.features.length ?? 0) === 0) return;
    // DON'T auto-frame a map whose first feature is freshly created AND selected.
    // Every creation path (plot drop, pin drop — SnakeRuler tap-to-place AND the
    // palette PIN direct-drop both land in dropPinAtPoint — and a drawn line/
    // polygon via persistMeasure) selects the new feature and aims the camera
    // itself (panPointToTop). On the FIRST feature of a NEW map, the map became
    // active AND gained its first feature in the same tick — so this effect
    // re-fires and frameActiveMap() launches a SECOND, competing camera animation
    // on top of the creation's pan, AND its setSelectedIndex(null) nukes the
    // selection — closing the just-opened editor popover. For plots that thrash
    // destroyed the popover's owning effect mid-flight (the `derived_inert`
    // warning) → its onDestroy discarded the brand-new uncounted plot ("first
    // plot of a new map vanishes"); for pins it suppressed the editor until a
    // re-tap. A created feature is selected the instant it lands, so
    // `selectedFeature` non-null here = a creation (or an explicit selection
    // that already aimed the camera) is in flight — stand down and let it own
    // the camera. Mark the map framed so we don't retry. (`selectedFeature`, not
    // `selectedFeatureKey`: the derived resolves the key against the ACTIVE
    // map's features, so a stale key left over from a previous map can't
    // suppress framing of a newly-switched-to map.)
    if (selectedFeature !== null) {
        console.log(
            `[autoFrame] STOOD DOWN for map "${key}" — a selected feature owns the camera (${selectedIsPlotPin ? "plot drop" : "pin/feature create or select"}). Marking framed, NOT calling frameActiveMap.`,
        );
        framer.markFramed(key);
        return;
    }
    console.log(`[autoFrame] frameActiveMap() for map "${key}" (no plot drop in flight).`);
    void framer.frameActiveMap();
});

function closeDrawer() {
    mobDrawerRef?.close();
}

function handleDrawerClose() {
    showLayersPanel = false;
}


// PlotLayer owns the whole Quality-704 plot lifecycle (drop, guards, popover,
// sweeps). Bound below; we call into it for the grid-dot Plot button + SnakeRuler.
let plotLayer: import("./PlotLayer.svelte").default | undefined = $state();

const gridTile = createGridTile({
    getMap: () => map,
    // "Plot" button inside a grid dot's popup → throw a Quality 704 plot dead-
    // centre on that dot, stamped with its Plus Code. Returns whether the drop
    // actually took, so the button only keeps its gold "confirmed" flash for a
    // real drop (a refusal retracts it — see mapGrid's Plot handler).
    onPlotFromDot: (dot) => {
        armKind = null;
        return plotLayer?.dropPlot(dot.lng, dot.lat, false, dot.plusCode) ?? false;
    },
    // A TOOL OWNS THE TAP (same gate as wireBoundaryPinNavigation): while a
    // palette tool is armed or the Snake Ruler is mid-measure, taps are placing
    // geometry — a grid dot must never steal one (Plus-Code popup + camera
    // nudge mid-polygon was the "can't draw near the grid" complaint).
    suppressTaps: () => armKind !== null || (rulerRef?.isMeasuring() ?? false),
});

// ── Locate ──────────────────────────────────────────────────────────────
// THE LOCATION GATE, dead simple: LOCATE either pans to you (location on) or
// pops the one shared "Turn on Location Services" pop-up. A granted locate()
// still routes failures (timeout, no-fix) through its own toast, so the tile
// never silently does nothing. The desktop-web GeolocateControl is still
// attached (hidden) but no longer driven by this tile.
let locating = $state(false);
// The shared gate controller (utils/locationInsist.svelte.ts). The LOCATE tile
// just calls loc.insist(runLocate); <LocationInsist controller={loc}/> renders
// the pop-up. No hand-rolled state machine here.
const loc = createLocationInsist();

// LOCATE tapped → location on runs straight through; off pops the pop-up and
// runs after Enable.
async function locateMe() {
    // locMap counts: the dot + flyTo work on a bare (pre-style) map, so a
    // hanging style fetch must not dead-arm the LOCATE tile.
    if (!(map ?? locMap) || locating) return;
    await loc.insist(runLocate);
}

// The actual pan-to-me + start-watch. Split out so both the granted fast-path
// and the "Turn on location" priming button can drive it.
async function runLocate() {
    if (!(map ?? locMap) || locating) return;
    locating = true;
    try {
        const ok = await userLocator.locate();
        // Only close the drawer after we have a fix — otherwise the drawer
        // slams shut on a silent failure and the user sees nothing happen.
        // Small delay lets the flyTo start so the close eases with the camera
        // motion instead of jumping ahead of it.
        if (ok) {
            setTimeout(() => closeDrawer(), 250);
            showSelfCoord();
        }
    } finally {
        locating = false;
    }
}

// ── THE "WHERE AM I" ACTION ────────────────────────────────────────────────
// Pan to the blue dot, then float the coordinate above it in a pill you can
// READ with your eyes and SHARE five ways. This is the ONE action behind both
// doors: the LOCATE tile (above) and the hospital popup's "Your GPS loc."
// button (handed into the harness as `onShowMyLocation` — see mapInit.ts).
//
// Why it lives here and not in the popup: the fix is ALREADY in memory
// (userLocator.getUserCoord(), fed by the always-on watch). The hospital popup
// used to re-fetch it with its own raw navigator.geolocation call — a second
// location path that skipped THE LOCATION GATE and dead-ended on denial. There
// is now exactly one path, and it reads the fix we already have.
let selfCoord = $state<{ lng: number; lat: number } | null>(null);

function showSelfCoord(): void {
    const c = userLocator.getUserCoord();
    // No LIVE fix yet → show nothing rather than a stale or invented number.
    // getUserCoord() deliberately returns null until a real fix lands.
    selfCoord = c ? { lng: c[0], lat: c[1] } : null;
}

// Location asked for from OUTSIDE the tool drawer (the hospital popup). Runs
// the same gate → same pan → same pill. Exported to the map shell, which hands
// it to initializeMap so the harness never touches geolocation itself.
export async function requestMyLocation(): Promise<void> {
    await loc.insist(runLocate);
}

// The pill's share menu. Full precision here — the pill's own text is rounded
// to 3 dp for calm reading, but everything you can SEND carries all of it.
const selfCoordFormats = $derived.by<ShareFormat[]>(() => {
    const c = selfCoord;
    if (!c) return [];
    const lat = c.lat.toFixed(5);
    const lng = c.lng.toFixed(5);
    // A real GeoJSON point, so the file exports reuse the SAME builder every
    // other share on this map uses — no parallel export path for "my location".
    const feature: Feature = {
        type: "Feature",
        properties: { name: "My location", isRetreever: RETREEVER_STAMP },
        geometry: { type: "Point", coordinates: [c.lng, c.lat] },
    };
    return [
        {
            ext: "getcache",
            run: () =>
                shareFeatureKML(feature, cachedDisplayName ?? "", "getcache"),
        },
        {
            ext: "kmz",
            run: () => shareFeatureKML(feature, cachedDisplayName ?? "", "kmz"),
        },
        {
            ext: "gps",
            label: "gps",
            icon: "copy",
            run: () => void copyToClipboard(`${lat}, ${lng}`),
        },
    ];
});

// TRACKS tile: start/stop a sparse GPS breadcrumb. The session lives in the
// `tracking` singleton (so MobMapPage can paint the in-tracking-mode border
// from the same flag); it appends one fix every ~10s to a "track" feature on
// the active map. Close the drawer on start so the yellow border is visible.
// Starting is location-gated like every other location-needing tap: location
// on → start now; off → the pop-up. (Ungated, a session with location off
// recorded NOTHING, silently — "tracking doesn't work".)
function toggleTracking() {
    if (tracking.active) {
        tracking.stop();
        return;
    }
    void loc.insist(() => {
        tracking.start(mapStore, cachedDisplayName);
        setTimeout(() => closeDrawer(), 250);
    });
}

// A tracking session is deliberately allowed to OUTLIVE the map route. The
// breadcrumb writes to the singleton mapStore (which survives navigation) and
// samples on a plain interval, so it keeps recording while the planter is in
// Stats / Cache / Inbox. The global TrackingIndicator (gold frame + pulsing
// "TRACKING" pill, painted by the layout shell on every page) is the standing
// reminder; the only way to stop is to come back here and tap TRACKS off.

function toggleDrawMode() {
    // The human reached for draw on their own → abort a demo if it's mid-play.
    cancelMapDemo();
    if (editMode) {
        exitDrawMode();
    } else {
        editMode = true;
    }
}

function exitDrawMode() {
    editMode = false;
    armKind = null;
    clearDrawingSources();
}

// ── Snake Ruler bridge ────────────────────────────────────────────
// The ruler lives in <SnakeRuler>. When it Saves/Shares it hands us the finished
// geometry; we run the SAME create + select (+ share) flow as a drawn feature.
function persistMeasure(
    kind: "line" | "polygon",
    verts: Lnglat[],
    share: boolean,
    format?: MapShareFormat,
) {
    const feature = finalizeFeature(kind, verts);
    mapStore.addFeature(
        feature,
        undefined,
        cachedDisplayName ?? undefined,
        cachedDisplayName ?? null,
        kind,
        { isRetreever: RETREEVER_STAMP },
    );
    const idx = mapStore.features.length - 1;
    setSelectedIndex(idx);
    const feat = mapStore.features[idx];
    if (feat) {
        popoverPos.compute(feat);
        panPointToTop(feat);
    }
    if (share) handleShare(format);
    // Tool is done — disarm so the ruler doesn't instantly re-arm for another
    // shape (which would leave a stray readout pill over the feature editor).
    armKind = null;
}
// Starting the ruler deselects any open feature (the ruler owns the screen).
function onRulerActivate() {
    setSelectedIndex(null);
    popoverPos.clear();
}


function setDrawMode(mode: "draw_polygon" | "draw_line_string" | "draw_pin") {
    // Picking a real tool = the human is drawing → abort a demo if mid-play.
    cancelMapDemo();
    const target: "polygon" | "line" | "pin" =
        mode === "draw_polygon" ? "polygon" : mode === "draw_pin" ? "pin" : "line";
    // Arm the unified Snake Ruler in that mode (tapping the active tool toggles
    // off). The ruler itself owns the geometry, tape, ticks, total + Save/✕.
    armKind = armKind === target ? null : target;
    setSelectedIndex(null);
    popoverPos.clear();
}

// `armKind` (the armed palette tool) is a bindable prop — see the props block.
let rulerRef: { undoLast: () => void; isMeasuring: () => boolean } | undefined =
    $state();
let editActive = $derived(editMode || armKind !== null);

// ── Guided draw demo (idle nudge) — logic in ./mapDemoScheduler ───────────
// The hand cursor (MapDrawDemo, bound below) plays a short scripted lesson
// when the user sits idle on the real /mobile/map; the anime/<key> routes
// loop one in isolation. cancelMapDemo (→ mapDemo.cancel) aborts it the
// instant the human reaches for a tool the hand was about to demonstrate.
let drawDemoRef: import("./MapDrawDemo.svelte").default | undefined;

const mapDemo = createMapDemoScheduler({
	getMap: () => map,
	getDrawDemo: () => drawDemoRef,
	getDrawer: () => mobDrawerRef,
	setEditMode: (on) => {
		editMode = on;
	},
	setDrawIntent: (v) => {
		armKind = v; // demo only clears (null) -> disarm
	},
	setShowLayersPanel: (on) => {
		showLayersPanel = on;
	},
	isEditActive: () => editActive,
	isDrawerOpen: () => drawerOpen,
	isShowLayersPanel: () => showLayersPanel,
	isMeasuring: () => rulerRef?.isMeasuring() ?? false,
	idleDemo,
	demoShowcase,
});
const cancelMapDemo = () => mapDemo.cancel();

onMount(() => mapDemo.start());

// BOOT PASS — on the first ready frame, PlotLayer sweeps orphan/duplicate plot
// PINS (no backing row = garbage) and re-CONFRONTS any leftover half-done plot
// by reopening its popover — never deleting it (full logic in
// PlotLayer.bootSweep). Runs once.
let sweptOnce = false;
$effect(() => {
    if (sweptOnce || !mapStore.ready) return;
    sweptOnce = true;
    plotLayer?.bootSweep();
});

// Programmatic pin drop (offline "Drop" button): create a stamped pin at a point
// and OPEN ITS EDITOR — the exact tail of commitDraw, so it names / selects /
// shares identically to a hand-drawn pin.
function dropPinAtPoint(lng: number, lat: number): void {
    const feature: Feature = {
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: {},
    };
    mapStore.addFeature(
        feature,
        undefined,
        cachedDisplayName ?? undefined,
        cachedDisplayName ?? null,
        "Pin",
        { isRetreever: RETREEVER_STAMP },
    );
    const idx = mapStore.features.length - 1;
    setSelectedIndex(idx);
    const feat = mapStore.features[idx];
    if (feat) {
        popoverPos.compute(feat);
        panPointToTop(feat);
    }
}
$effect(() => {
    if (!dropPinAt) return;
    const [lng, lat] = dropPinAt;
    dropPinAt = null; // consume (clears on the parent too)
    dropPinAtPoint(lng, lat);
});


function handleDeselect() {
    setSelectedIndex(null);
    popoverPos.clear();
}

// The whole Quality-704 plot lifecycle (drop, close-guard, deferred-abandon,
// popover, boot sweeps) now lives in <PlotLayer> (bound to `plotLayer`). The host
// calls plotLayer.dropPlot(...) from the SnakeRuler onPlot + grid-dot Plot button,
// and plotLayer.handleOutsideTap() from the map-click handler.

// handleShare stays in the host: it's shared by FeatureLayer, PlotLayer, AND the
// SnakeRuler save path (persistMeasure). Feature edit/delete moved to FeatureLayer.
function handleShare(format: MapShareFormat = "getcache") {
    if (!selectedFeature) return;
    // SYNCHRONOUS path: (format-pick click) → shareFeatureKML →
    // navigator.share. Any `await` between the click and share() burns
    // user activation and Brave throws AbortError. cachedDisplayName is
    // loaded eagerly on mount — if it's not ready, get the name FIRST and
    // re-enter: the drawer's "Save & Share" tap is itself a fresh user
    // activation, so the share goes out on that same flow instead of
    // demanding a second tap.
    if (!cachedDisplayName) {
        ensureUsername().then((name) => {
            if (!name) return;
            cachedDisplayName = name;
            handleShare(format);
        });
        return;
    }
    // One name, one truth. shareFeatureKML uses feature.properties.name
    // as the filename stem — no caller-side template. `format` is the
    // SharePicker choice: .getcache (default) · .kmz · .kml.
    shareFeatureKML(selectedFeature, cachedDisplayName, format);
}

// Zoom-title overlay helpers — small wrappers so the map-event controller can
// drive the host's title state without owning the timer.
function showZoomTitle() {
    if (zoomTitleTimer) clearTimeout(zoomTitleTimer);
    zoomTitleVisible = true;
}
function scheduleHideZoomTitle() {
    if (zoomTitleTimer) clearTimeout(zoomTitleTimer);
    zoomTitleTimer = setTimeout(() => {
        zoomTitleVisible = false;
    }, 500);
}
function clearZoomTitleTimer() {
    if (zoomTitleTimer) clearTimeout(zoomTitleTimer);
}

// The whole click / move / zoom / style.load lifecycle lives in ./mapEvents. The
// teardown captures the map locally so it survives the parent nulling its bindable
// `map` on route unmount (see the controller's THE TEARDOWN RULE).
const mapEvents = createMapEvents({
    mapStore,
    popoverPos,
    gridTile,
    vertexDragger,
    pins,
    overlayMgr,
    setSource,
    getSelectedFeature: () => selectedFeature,
    getSelectedFeatureIndex: () => selectedFeatureIndex,
    getSelectedIsPlotPin: () => selectedIsPlotPin,
    // An armed palette tool or an active Snake Ruler owns map taps — the click
    // handler must place geometry, never ALSO hit-test/select a feature.
    getToolOwnsClicks: () =>
        armKind !== null || (rulerRef?.isMeasuring() ?? false),
    setSelectedIndex: (idx) => setSelectedIndex(idx),
    onPlotOutsideTap: () => plotLayer?.handleOutsideTap(),
    setCurrentZoom: (z) => {
        currentZoom = z;
    },
    getSuppressZoomTitle: () => suppressZoomTitle,
    showZoomTitle,
    scheduleHideZoomTitle,
    clearZoomTitleTimer,
});
$effect(() => {
    if (!map) return;
    return mapEvents.attach(map);
});
</script>

<!-- Hidden instance so StatusDots' :global bulb CSS ships with this route — the
     plot pins are built imperatively (pinMarkers.ts) and only borrow its classes,
     so without a real instance the styles would tree-shake away. -->
<div style="display:none" aria-hidden="true"><StatusDots /></div>

{#if importer.importing && !importer.located}
	<!-- Shared splash for BLIND waits only (no readable on-device georef).
	     A located PDF import shows the on-map waiting box instead — mounting
	     this opaque splash over it would hide the box entirely.
	     Spec: MAP_IMPORTS_UNIFIED.md §5. -->
	<ImportProgress
		state="working"
		fileName={importer.fileName}
		stage={importer.stage}
		elapsedSec={importer.elapsed}
	/>
{/if}

<MobDrawer
    bind:this={mobDrawerRef}
    bind:open={drawerOpen}
    tour="map-drawer"
    showScrim
    closedHint={editActive ? undefined : "PULL FOR MODULES"}
    ariaLabel="Drag to show modules"
    height="clamp(calc((100% - 5rem - 3.5rem - env(safe-area-inset-bottom)) * 0.55 + 30px), 490px, calc((100% - 5rem - 3.5rem - env(safe-area-inset-bottom)) * 0.7 + 30px))"
    bodyClass=""
    onClose={handleDrawerClose}
>
        <ImportSourceModal
            open={importer.open}
            accept={IMPORTABLE_ACCEPT}
            title="Import from"
            multiple={true}
            onCancel={importer.closeModal}
            onFile={importer.handleFile}
        />

        {#if showLayersPanel}
            <MapsLayersPanel
                {mapStore}
                onClose={closeLayersPanel}
                onImport={importer.openModal}
                overlayActive={overlayMgr.activeOverlay !== null}
            />
        {:else}
        <MapToolDrawer
            {gridTile}
            {basemapPicker}
            {editActive}
            {locating}
            {offline}
            {offlineBasemapLayers}
            {toggleDrawMode}
            {openLayersPanel}
            {locateMe}
            {toggleTracking}
            {openSearchPanel}
            {newMap}
            onLegend={onLegend
                ? () => {
                    // The legend is a stay-down top drawer — collapse the modules
                    // drawer as it opens so the user watches the eye toggles and
                    // PDF opacity slider hit the live map underneath.
                    mobDrawerRef?.close();
                    onLegend();
                }
                : undefined}
            bind:basemapTileWrap
        />
        {/if}
</MobDrawer>

<!-- Search lives in a TOP drawer (typing surface — the keyboard owns the
     bottom, the drawer owns the top, suggestions stay visible). The modules
     drawer stays open beneath it; deliberate, not a bug. -->
{#if showSearchPanel}
    <MapDrSearch
        onBack={closeSearchPanel}
        onSelectResult={handleSearchResult}
        getMapCenter={() => map ? { lng: map.getCenter().lng, lat: map.getCenter().lat } : null}
    />
{/if}

<!-- Only show the warning chip when the viewport is too wide to render the
     grid. The "it's on, I can see the pins" state doesn't need narration.
     Warning is transient - shows for 3 seconds when tooDense becomes true. -->
{#if gridTile.gridMode !== 'off' && gridTile.warningVisible && !drawerOpen}
    <div class="grid-chip-pos"><Chip variant="accent">zoom to see grid</Chip></div>
{/if}

{#if layersTitle}
    <div class="map-title-pos" class:map-title-pos--visible={zoomTitleVisible}>
        <Chip mono>{layersTitle}</Chip>
    </div>
{/if}

{#if currentZoom !== null && !mapOnly}
    <button
        class="map-zoom-pos"
        class:map-zoom-pos--visible={zoomTitleVisible}
        onclick={homeZoom}
        title="Zoom out to {HOME_ZOOM}"
        aria-label="Zoom out to level {HOME_ZOOM}"
    >
        <Chip mono>{currentZoom.toFixed(1)}z</Chip>
    </button>
{/if}

<!-- LINE/POLY/PIN strip (presentational). The armed Snake Ruler owns all geometry
     + finishing via its own Save/✕; `activeTool` just highlights the chosen button. -->
<!-- Standing "tracking is ON" control — the draw strip's chrome, one slot
     below it, present for the whole session (no blinking). Tapping it stops
     tracking (ceremonious toast as usual). -->
<TrackingStrip
    ports={mapPorts} active={tracking.active} onStop={() => tracking.stop()} />

<DrawPalette
    ports={mapPorts}
    {editActive}
    activeTool={armKind}
    onMode={setDrawMode}
    onUndo={() => rulerRef?.undoLast()}
    onExit={() => {
        armKind = null;
        exitDrawMode();
    }}
/>

<!-- Guided draw-tour hand cursor (idle nudge). Driven imperatively by
     ./mapDemoScheduler; invisible until it plays. -->
<MapDrawDemo bind:this={drawDemoRef} />

<!-- Snake Ruler — a separate feature with its own state; renders its own ruler
     layers, grab hands and readout, and saves via persistMeasure(). -->
<SnakeRuler
    ports={mapPorts}
    {map}
    bind:this={rulerRef}
    bind:measureEvent
    bind:armKind
    {onMeasureDrag}
    userCoord={() => userLocator.getUserCoord()}
    onSnapSelf={() => userLocator.pulseSelf()}
    onPersist={persistMeasure}
    onSavePoint={(lng, lat) => {
        armKind = null;
        dropPinAtPoint(lng, lat);
    }}
    onPlot={(lng, lat, atSelf, plusCode) => {
        // Drop a Quality 704 plot here. The whole duplicate-proof lifecycle lives
        // in <PlotLayer>. `atSelf` = seed snapped onto the user's blue dot
        // (proof-of-presence). `plusCode` = snapped grid dot's id (null = free drop).
        armKind = null;
        plotLayer?.dropPlot(lng, lat, atSelf, plusCode);
    }}
    gridSnap={(lng, lat) => gridTile.gridSnap(lng, lat)}
    setGridGlow={(dot) => gridTile.setGridGlow(dot)}
    onActivate={onRulerActivate}
/>



<!-- The regular feature popover (pins / lines / polygons + the tiles pin) and its
     edits — name/desc save, icon swap, fill-opacity, delete (with confirm). Plot
     pins are excluded (they route to <PlotLayer>). -->
<FeatureLayer
    {map}
    {mapStore}
    {popoverPos}
    {selectedFeature}
    {selectedIsPlotPin}
    blockNumber={cache.blockNumber}
    {cachedDisplayName}
    deselect={handleDeselect}
    onShare={handleShare}
/>

<!-- The Quality-704 plot lifecycle: the drop sequence (memory-only, NO pin), the
     CREATE count popover, and the VIEW popover for an existing (DB-backed) plot
     pin. THE LAW: a plot pin is a database row — mapStore.syncMaps is the sole
     creator; PlotLayer never paints one. The host calls plotLayer.dropPlot() /
     .handleOutsideTap() / .bootSweep(). VIEW mode reads the host's selection
     through {selectedFeature} + {selectedIsPlotPin}; CREATE mode is driven
     entirely by PlotLayer's own pending-drop state. -->
<PlotLayer
    bind:this={plotLayer}
    {map}
    {mapStore}
    {popoverPos}
    {selectedFeature}
    {selectedIsPlotPin}
    panPointToTop={(feat, opts) => panPointToTop(feat, opts)}
    deselect={handleDeselect}
    onShare={handleShare}
    getUserCoord={() => userLocator.getUserCoord()}
/>

<!-- ── "You are here" + the number ──────────────────────────────────────
     Floats above the blue dot after LOCATE (or the hospital popup's GPS
     button) with the coordinate readable by eye and a share button. -->
<SelfCoordPill
    ports={mapPorts}
    map={map ?? locMap}
    coord={selfCoord}
    formats={selfCoordFormats}
    onClose={() => (selfCoord = null)}
/>

<!-- ── The location pop-up (shown when a gated tap finds location off) ──
     The shared insist controller drives it; Enable fires the OS request then
     runs the pending action (locate / start tracking). -->
<LocationInsist controller={loc} />

<style>
    /* Sonner toast viewport fix: the global <Toaster mobileOffset> applies the
       same inset to all four sides; on narrow phones this pushes the toast right
       of the viewport edge. Clamp to 1rem so it stays on-screen. */
    :global([data-sonner-toaster][data-x-position="center"]) {
        --mobile-offset-left: 1rem !important;
        --mobile-offset-right: 1rem !important;
    }

    /* Pin marker DOM — global so rules apply to document.createElement elements
       (Svelte scoping can't reach them). Width/height are load-bearing: library
       pins (<img> with no inline size) render at natural pixels without them.
       Lives here NOT in mobile.css: moving these to the global stylesheet broke
       pin sizing on native iOS (Vite/Capacitor CSS bundling order differs between
       component :global() and @import'd stylesheets). Don't move without a native build test. */
    /* Cluster bubbles are NATIVE Mapbox layers (pinMarkers.ts, cluster:true on
       the source) — no DOM, no CSS. Only the single-pin markers live here. */
    :global(.map-pin-marker) {
        display: block;
        width: 30px;
        height: 40px;
        padding: 0;
        margin: 0;
        background: transparent;
        border: 0;
        cursor: pointer;
        line-height: 0;
        -webkit-tap-highlight-color: transparent;
        filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5));
        touch-action: manipulation;
    }
    :global(.map-pin-marker > svg),
    :global(.map-pin-marker > img) {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
        pointer-events: none;
    }
    /* Press-feedback shrink. */
    :global(.map-pin-marker:active) { transform: scale(0.92); }

    /* EMOJI PIN — no styles needed. The plate and the glyph are baked into ONE
       image by emojiPinImage(), so an emoji pin is just an <img> like every
       other pin and inherits `.map-pin-marker > img` above. This block used to
       hold the glyph's position/size (and a matching pair in FeatureDetail);
       baking the composite removed the alignment problem instead of managing
       it. */

    /* TIER-2 PIN CAPTION — the pin's name as small neutral-white halo text
       below the marker (pinMarkers.ts placeCaptions decides which show).
       Deliberately quieter than the coloured tier-1 area names so the eye
       ranks area > pin instantly. No pill, no box — halo text only. */
    :global(.map-pin-caption) {
        position: absolute;
        top: calc(100% + 2px);
        left: 50%;
        transform: translateX(-50%);
        font-family: "Baloo 2", var(--rt-font-display, sans-serif);
        font-weight: 700;
        font-size: 12.5px;
        line-height: 1.14;
        color: #f2f3ea;
        text-align: center;
        white-space: nowrap;
        pointer-events: none;
        text-shadow:
            0 0 2px #000, 0 1px 2px #000, 0 0 5px rgba(0, 0, 0, 0.92),
            1px 0 0 rgba(0, 0, 0, 0.8), -1px 0 0 rgba(0, 0, 0, 0.8);
    }
    /* SELECTED PIN — lifted above the dim veil (z 5 beats the veil's 4; the
       veil beats unselected markers at z auto and area names at z 3). The
       root transform is owned by Mapbox (inline), so the lift scales the
       ICON child; plot plaques keep their own gold-pill selected style
       (PlotLayer.svelte). */
    :global(.map-pin-marker--selected) {
        z-index: 5;
        filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.7));
    }
    :global(.map-pin-marker--selected > img) {
        transform: scale(1.15);
        transform-origin: bottom center;
    }
    /* The dim veil pinMarkers.ts drops into the marker container while a pin
       is selected. pointer-events: none — taps pass through to the canvas so
       "tap empty map" still clears the selection. */
    :global(.rt-map-dim) {
        position: absolute;
        inset: 0;
        z-index: 4;
        background: rgba(0, 0, 0, 0.38);
        pointer-events: none;
    }

    /* The Quality-plot marker CSS (the gold "Plot N" plaque, selected pill, dotted
       leader) moved to PlotLayer.svelte along with the rest of the plot lifecycle. */

    /* Position-only glue. Visuals come from <Chip>, <Popover>, <Checkbox>,
       <SearchInput>, <RowCard>. */
    .grid-chip-pos {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        top: calc(5rem + env(safe-area-inset-top) + var(--rt-space-2));
        z-index: 17;
        pointer-events: none;
    }
    /* Two-row bottom chrome: title+zoom (top row) sit 30px above the Mapbox
       logo+scale-bar row. bottom values mirror .nice-scale-bar in MobMapPage.svelte.
       z-index: 16 keeps these below the drawer (z-index: 22) — no JS gating needed. */
    .map-title-pos {
        position: absolute;
        bottom: calc(env(safe-area-inset-bottom) + 1.25rem + 56px + 15px + 30px);
        left: 0.75rem;
        z-index: 16;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.6s ease;
    }
    .map-title-pos--visible { opacity: 1; }
    .map-zoom-pos {
        position: absolute;
        bottom: calc(env(safe-area-inset-bottom) + 1.25rem + 56px + 15px + 30px);
        right: 0.75rem;
        z-index: 16;
        background: transparent;
        border: 0;
        padding: 0;
        margin: 0;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
        opacity: 0;
        transition: opacity 0.6s ease;
    }
    .map-zoom-pos--visible { opacity: 1; }
    .map-zoom-pos:active { transform: scale(0.95); }

</style>

