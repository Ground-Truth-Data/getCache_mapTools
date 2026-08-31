// dullStreamingRoads.ts — knock the brightness off the stock Mapbox road net.
//
// The hosted `satellite-streets-v12` / `streets-v12` styles paint motorways and
// primaries in a bright tan/gold that the user finds too loud over the satellite
// imagery ("they're too bright … make them dull"). We can't edit Mapbox's hosted
// style JSON, so we re-tint the road LINE layers after the style loads.
//
// Approach (future-proof, no hardcoded layer list): walk every layer in the live
// style and, for any LINE layer that belongs to the road network (id starts with
// road/bridge/tunnel, or its source-layer is `road`), drop its `line-opacity` so
// the roads recede toward the basemap instead of glowing. Opacity (not colour) is
// used deliberately — it dulls EVERY road class uniformly without us having to
// know each layer's exact paint expression, and it leaves Mapbox's own width /
// casing hierarchy intact (just quieter).
//
// Fires on `styledata`, so it re-applies on the initial load AND after every
// basemap switch (`setStyle`). Idempotent — re-running just re-sets the same
// opacity, so repeated styledata events are harmless.
import type { Map as MapboxMap } from "mapbox-gl";

// How much of each road layer's paint to keep. 1 = Mapbox default (bright),
// 0 = invisible. 0.45 pulls the gold well back into the imagery while the roads
// stay readable for navigation.
const ROAD_LINE_OPACITY = 0.45;
// Road NAME labels (the text) get dulled a touch less — names stay useful.
const ROAD_LABEL_OPACITY = 0.6;

/** True when a style layer is part of the streamed road network. */
function isRoadLayer(layer: { id: string; "source-layer"?: string }): boolean {
    const id = layer.id;
    if (id.startsWith("road") || id.startsWith("bridge") || id.startsWith("tunnel")) {
        return true;
    }
    return layer["source-layer"] === "road";
}

/**
 * Dull every road LINE (and ease back road labels) in the current style.
 * Safe to call repeatedly; safe to call before the style is fully ready (it
 * just skips layers that aren't there yet — the next `styledata` re-runs it).
 */
export function dullStreamingRoads(map: MapboxMap): void {
    let style: ReturnType<MapboxMap["getStyle"]>;
    try {
        style = map.getStyle();
    } catch {
        return; // style not ready
    }
    if (!style?.layers) return;

    for (const layer of style.layers) {
        if (!isRoadLayer(layer)) continue;
        try {
            if (layer.type === "line") {
                map.setPaintProperty(layer.id, "line-opacity", ROAD_LINE_OPACITY);
            } else if (layer.type === "symbol" && layer.id.includes("label")) {
                map.setPaintProperty(layer.id, "text-opacity", ROAD_LABEL_OPACITY);
            }
        } catch {
            // codestyle-allow-swallow: a layer can disappear between getStyle() and
            // setPaintProperty() during a style swap; the next styledata re-applies.
        }
    }
}

/**
 * Attach the dulling pass to a map so it survives every style change. Returns a
 * teardown that removes the listener. Call once when the map becomes available.
 */
export function attachRoadDulling(map: MapboxMap): () => void {
    // ── WHY THIS IS GATED, AND NOT JUST `map.on("styledata", run)` ──
    //
    // `styledata` is NOT "the style changed". Mapbox fires it constantly —
    // while tiles stream in, while sources load, many times per second during
    // a pan. The naive binding therefore ran, per event:
    //     • `map.getStyle()` — a FULL serialization of the hosted style
    //       (satellite-streets-v12 ships 100+ layers), allocating a fresh
    //       object graph every single time
    //     • a walk of every one of those layers
    //     • `setPaintProperty` on each road layer, re-setting values that
    //       were ALREADY that value
    //
    // The paint values are two constants. Once they are applied to a style,
    // re-applying them is guaranteed to be a no-op — so all of that work
    // produced nothing but garbage. The only moment it must re-run is a real
    // basemap SWITCH, which is exactly what `style.load` means.
    //
    // `style.load` fires once per actual style; `styledata` fires whenever any
    // style-adjacent data arrives. Using the former turns "hundreds of full
    // style serializations per pan" into "one per basemap change".
    const run = () => dullStreamingRoads(map);
    map.on("style.load", run);
    run(); // the style may already be loaded by the time we attach
    return () => map.off("style.load", run);
}
