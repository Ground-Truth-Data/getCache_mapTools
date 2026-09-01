// Camera framing + "See on map" routing. Extracted from MapDrawControls.svelte.
//
// Owns the imperative camera-travel side of framing: fit a feature, fit a whole
// map (PDF overlays included), and the URL-as-truth router that turns
// ?map=/?feature= params into a camera move. Pure geometry lives separately in
// components/mobMap/mapFraming.ts; this is the part that touches the live map,
// selection, and the popover.
//
// `framedMapKey` — the single record of "the camera has been pointed at this
// map" — lives here. It's a guard the component's auto-frame effect consults
// (via isFramed), never a reactive trigger. Seeded from localStorage so it
// SURVIVES remounts (the online↔offline route toggle, hot reloads, cold boots
// all remount the host); without the seed the auto-frame would re-fly to the
// site every mount.
//
// Routes-local (next to seeOnMapRouter / tracking) — it imports applyMapRoute
// and is bound to this route's map. Factory, not a singleton: each host wires
// its own state via the deps below.
import type { Map as MapboxMap } from "mapbox-gl";
import type { Feature } from "geojson";
import { toast } from "svelte-sonner";
import { reportSyncWarning } from "$lib/mobile/utils/reportSyncError";
import { safeFitBounds } from "@ground-truth/getcache-onlinemap/lib/safeMap";
import {
    isNullIsland,
    loadFramedMapKey,
    saveFramedMapKey,
} from "@ground-truth/getcache-offlinemap/lib/mapState/mapViewport";
import type { MapStore } from "$lib/mobile/stores/mapStore.svelte";
import {
    type LngLatBox,
    geometryBounds,
    resolveFeatureBounds,
    unionBox,
} from "@ground-truth/getcache-offlinemap/lib/mapState/mapFraming";
import { applyMapRoute } from "./seeOnMapRouter";

export interface MapFramerDeps {
    getMap: () => MapboxMap | null;
    mapStore: MapStore;
    /** Popover anchored to the framed feature (structural to avoid a routes
     *  import of PopoverPositioning). */
    popoverPos: {
        compute(feature: Feature): void;
        panToBounds(sw: [number, number], ne: [number, number]): number;
    };
    setSelectedIndex: (idx: number | null) => void;
    /** Pan a Point to top-center at a zoom (lives in the host; reused by pin
     *  drop + measure flows). */
    panPointToTop: (feat: Feature, opts?: { zoom?: number }) => void;
    /** Hold the zoom-title overlay for the duration of a programmatic move. */
    suppressTitleFor: (duration: number) => void;
    /** Zoom floor differs offline (z12) vs live (z15). */
    getOffline: () => boolean;
}

export interface MapFramer {
    /** "See on map" for ONE feature: select it + travel to it. */
    frameFeature(key: string): Promise<void>;
    /** Fit a raw axis-aligned bbox `{n,s,e,w}` — used to fly to a PDF's spot
     *  for the waiting box BEFORE any feature exists. No selection, no store
     *  read; just the camera. Opts cap the fit (e.g. a lower maxZoom keeps the
     *  waiting view wide; the overlay-landed frame then zooms the rest). */
    frameBounds(
        bounds: { n: number; s: number; e: number; w: number },
        opts?: { padding?: number; maxZoom?: number; duration?: number },
    ): void;
    /** "See on map" for a whole map: fit the combined extent of every feature
     *  (PDF overlays included). */
    frameActiveMap(): Promise<void>;
    /** "See on map" for a PLOT CLUSTER (a block's plots): fit just those
     *  pins' combined extent — the plots fill the frame, not the whole map. */
    framePlots(keys: string[]): Promise<void>;
    /** True when the camera has already been pointed at this map key — the
     *  auto-frame effect stands down so it doesn't race an explicit travel. */
    isFramed(key: string): boolean;
    /** Mark a map framed WITHOUT moving the camera. Used when another path already
     *  owns the camera for this map (e.g. a plot drop aims it itself), so the
     *  auto-frame effect records "done" and never launches a competing animation. */
    markFramed(key: string): void;
    /** Run the URL-as-truth router for ?map=/?feature=/?plots= params. */
    applyUrlRoute(
        mapKeyParam: string | null,
        featureKeyParam: string | null,
        plotKeysParam?: string[] | null,
    ): void;
    /** Bare "?lng=&lat=[&z=]" target — see-on-map to a raw coordinate. Works on
     *  BOTH routes (only the basemap differs). Exact target or nothing: missing,
     *  non-finite, or null-island coords → false and NO camera move (Number(null)
     *  is 0, so a param-less open would otherwise "fly to" (0,0) off Africa). */
    applyBareTarget(params: URLSearchParams): boolean;
}

export function createMapFramer(deps: MapFramerDeps): MapFramer {
    const { getMap, mapStore, popoverPos } = deps;
    let framedMapKey: string | null = loadFramedMapKey();

    // The ONE camera-fit call. `safeFitBounds` handles the degenerate
    // single-point case internally (delegates to a flyTo) — and the non-zero
    // duration is deliberate: the user watches the ground travel past so they
    // never feel teleported.
    function frameBox(
        box: LngLatBox,
        opts?: { padding?: number; maxZoom?: number; duration?: number },
    ): void {
        const map = getMap();
        if (!map) return;
        // A malformed feature row (e.g. an overlay with corrupt overlayBounds)
        // can yield a non-finite or reversed box. Fitting it produces a NaN zoom
        // that corrupts the camera, so reject it here at the framing source.
        const finite = [box.minLng, box.minLat, box.maxLng, box.maxLat].every(
            Number.isFinite,
        );
        const ordered = box.minLng <= box.maxLng && box.minLat <= box.maxLat;
        if (!finite || !ordered) {
            console.warn("[mapFramer] frameBox: rejected degenerate box", box);
            return;
        }
        safeFitBounds(map, [box.minLng, box.minLat], [box.maxLng, box.maxLat], {
            padding: opts?.padding ?? 60,
            maxZoom: opts?.maxZoom ?? 15,
            duration: opts?.duration ?? 1000,
            essential: true,
        });
    }

    // Resolve once the map canvas has real dimensions, or after `tries` frames.
    // On a cold open the full-bleed canvas can still be 0×0 / mid-layout, which
    // makes fitBounds' zoom math degenerate (safeFitBounds would reject it and
    // the map would never frame). Deferring a few frames lets layout settle.
    function waitForSizedCanvas(m: MapboxMap, tries = 12): Promise<void> {
        return new Promise((resolve) => {
            const check = (n: number): void => {
                const cv = m.getCanvas();
                if ((cv.clientWidth > 0 && cv.clientHeight > 0) || n <= 0) {
                    resolve();
                    return;
                }
                requestAnimationFrame(() => check(n - 1));
            };
            check(tries);
        });
    }

    // "See on map" for ONE feature. A pin flies to top-center with an auto-zoom;
    // a line/polygon fits its extent, anchored top-center so the popover clears
    // the geometry. PDF overlays have no popover — they just get framed. Keyed by
    // `mapFeatureKey`, not an array index: the index into `mapStore.features`
    // (geometry-only) and into `activeMap.features` (overlays included) differ.
    async function frameFeature(key: string): Promise<void> {
        const map = getMap();
        if (!map) return;
        const rec = mapStore.activeMap?.features.find(
            (f) => f.mapFeatureKey === key,
        );
        if (!rec) {
            // The caller (router) already confirmed this feature is on the active
            // map against fresh `allMaps`. If we still can't find it here, the two
            // views disagree — an internal inconsistency, not a user action. Report
            // to Sentry and do nothing (never frame something else).
            reportSyncWarning(
                "frameFeature-key-not-on-active-map",
                "frameFeature: key not found on active map",
                { key, activeMapKey: mapStore.activeMapKey },
            );
            return;
        }
        // Mark the active map as framed so the auto-frame effect stands down
        // — this explicit travel wins, no competing animation. Persisted so a
        // later remount of the same map doesn't re-frame.
        framedMapKey = mapStore.activeMapKey;
        saveFramedMapKey(framedMapKey);

        // selIdx indexes mapStore.features — the geometry-only array that
        // drives selection + the popover. Overlays aren't in it (selIdx = -1).
        const selIdx = mapStore.features.findIndex(
            (f) => f.properties?.mapFeatureKey === key,
        );

        // Overlay (PDF): no popover, no selection — just travel to its extent.
        if (selIdx < 0) {
            deps.setSelectedIndex(null);
            const box = await resolveFeatureBounds(rec);
            if (box && getMap()) frameBox(box, { maxZoom: 16 });
            return;
        }

        const feat = mapStore.features[selIdx];
        if (!feat) return;
        deps.setSelectedIndex(selIdx);
        popoverPos.compute(feat);

        if (feat.geometry?.type === "Point") {
            // "See on map" for ONE plot means SHOW ME THIS PLOT — a close-up, not a
            // wide survey view. This is the opposite of tapping a pin you're already
            // parked on ([[never-slam-zoom-on-pin-tap]] caps THAT at context zoom so
            // it never yanks). Here the user came from the report having explicitly
            // asked to be taken to this exact pin, and on a COLD open (nav from the
            // report) the current zoom is the map's wide default — so a "keep current
            // if past the floor" floor of 12 barely zoomed in and framed the WHOLE
            // survey (every plot in view). The floor must be a genuine single-plot
            // inspection zoom. Still only zoom IN, never out (max with current), so a
            // user already closer than the floor isn't pushed back out.
            const cur = map.getZoom();
            // Offline satellite bakes to z14 (BAKE_ZOOM) — its sharp ceiling; z15+
            // only upsamples the same pixels into blur. So offline caps at 14: the
            // most real detail on one plot without over-zooming past baked imagery.
            // Live (online) tiles keep going, so a real close-up sits at 17.
            const floor = deps.getOffline() ? 14 : 17;
            const target = Number.isFinite(cur) ? Math.max(cur, floor) : floor;
            deps.panPointToTop(feat, { zoom: target });
            return;
        }
        const box = geometryBounds(feat.geometry);
        if (!box) return;
        deps.suppressTitleFor(
            popoverPos.panToBounds(
                [box.minLng, box.minLat],
                [box.maxLng, box.maxLat],
            ),
        );
    }

    async function frameActiveMap(): Promise<void> {
        const map = getMap();
        if (!map) return;
        const feats = mapStore.activeMap?.features ?? [];
        framedMapKey = mapStore.activeMapKey;
        saveFramedMapKey(framedMapKey);
        deps.setSelectedIndex(null);
        const boxes = await Promise.all(feats.map(resolveFeatureBounds));
        const box = unionBox(boxes);
        if (!box || !getMap()) return;
        await waitForSizedCanvas(map);
        if (getMap()) frameBox(box);
    }

    // Frame a PLOT CLUSTER: the combined extent of JUST these pins, so the
    // block's plots fill the viewport instead of the whole map's extent. The
    // zoom-in cap keeps a tight cluster readable rather than slammed to max
    // (offline caps at the z14 bake ceiling — past it is upsampled blur).
    async function framePlots(keys: string[]): Promise<void> {
        const map = getMap();
        if (!map) return;
        const want = new Set(keys);
        const feats = (mapStore.activeMap?.features ?? []).filter((f) =>
            want.has(f.mapFeatureKey),
        );
        if (feats.length === 0) return;
        framedMapKey = mapStore.activeMapKey;
        saveFramedMapKey(framedMapKey);
        deps.setSelectedIndex(null);
        const boxes = await Promise.all(feats.map(resolveFeatureBounds));
        const box = unionBox(boxes);
        if (!box || !getMap()) return;
        await waitForSizedCanvas(map);
        if (getMap())
            frameBox(box, {
                padding: 70,
                maxZoom: deps.getOffline() ? 14 : 16,
            });
    }

    return {
        frameFeature,
        frameActiveMap,
        framePlots,
        frameBounds(bounds, opts) {
            frameBox(
                {
                    minLng: bounds.w,
                    minLat: bounds.s,
                    maxLng: bounds.e,
                    maxLat: bounds.n,
                },
                opts,
            );
        },
        applyBareTarget(params: URLSearchParams): boolean {
            const map = getMap();
            if (!map) return false;
            const lngRaw = params.get("lng");
            const latRaw = params.get("lat");
            if (lngRaw === null || latRaw === null) return false;
            const lng = Number(lngRaw);
            const lat = Number(latRaw);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
            if (isNullIsland(lng, lat)) return false; // never honour a (0,0) target
            const z = Number(params.get("z"));
            map.flyTo({
                center: [lng, lat],
                zoom: Number.isFinite(z) && z > 0 ? z : 14,
                duration: 1200,
            });
            return true;
        },
        isFramed(key: string) {
            return framedMapKey === key;
        },
        markFramed(key: string) {
            framedMapKey = key;
            saveFramedMapKey(framedMapKey);
        },
        // URL-as-truth router for "See on map". See `seeOnMapRouter.ts`.
        applyUrlRoute(mapKeyParam, featureKeyParam, plotKeysParam) {
            applyMapRoute({
                mapKeyParam,
                featureKeyParam,
                plotKeysParam,
                mapStore,
                frameFeature: (k) => void frameFeature(k),
                frameActiveMap: () => void frameActiveMap(),
                framePlots: (keys) => void framePlots(keys),
                // A "See on map" that can't hit its exact target is an internal
                // inconsistency (a button was offered to something that isn't
                // there), NOT a user-fixable input error. It goes to Sentry — the
                // user gets nothing and stays put, never a wrong map.
                // [[no-fallbacks-exact-target-or-sentry]]
                onMapNotFound: (key) =>
                    reportSyncWarning(
                        "seeOnMap-map-not-found",
                        "see-on-map: named map not in store",
                        {
                            key,
                            activeMapKey: mapStore.activeMapKey,
                            mapCount: mapStore.allMaps.length,
                        },
                    ),
                onFeatureNotFound: (key) =>
                    reportSyncWarning(
                        "seeOnMap-feature-not-found",
                        "see-on-map: feature not on named map",
                        {
                            want: key,
                            mapKeyParam,
                            activeMapKey: mapStore.activeMapKey,
                            activeMapTitle: mapStore.activeMap?.mapTitle,
                            activeFeatureKeys: (
                                mapStore.activeMap?.features ?? []
                            ).map((f) => f.mapFeatureKey),
                        },
                    ),
                onEmptyMapSwitch: (title) =>
                    toast(`Switched to “${title}” — no features yet.`),
            });
        },
    };
}
