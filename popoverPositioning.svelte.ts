// Feature popover positioning controller.
//
// Owns two pieces of reactive state used by the post-selection feature
// popover in MapDrawControls.svelte:
//
//   • `bbox`    — screen-space bbox of the currently-selected feature, used
//                 to anchor the popover. For pins this is an inflated rect
//                 around the visible icon; for polys/lines it's the
//                 projected geometry bbox.
//
//   • `panning` — true while a programmatic camera pan is in flight after
//                 selection. Callers gate popover rendering on !panning so
//                 the pin appears, the camera slides, then the popover
//                 fades in below it.
//
// The "pan to top-center" behavior uses `flyTo` with `offset` — this is
// the implementation that was tuned and approved at commit 9a864929
// (`offset: [0, targetY - h/2]`, duration 1200, curve 1.2). An earlier
// refactor swapped this for `easeTo` with `padding`, which is
// mathematically equivalent on paper but produced visually different
// pin landings in the build. Don't switch back without testing on a
// real device — the user explicitly reverted that change.

import type { Feature } from "geojson";
import type { Map as MapboxMap } from "mapbox-gl";
import { projectFeatureBbox } from "@ground-truth/getcache-onlinemap/lib/mapDraw";
import { safeFitBounds, safeFlyTo } from "@ground-truth/getcache-onlinemap/lib/safeMap";

export type FeatureBbox = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
};

// Visible pin icon footprint, in CSS pixels. Anchor is bottom-center, so
// we inflate the degenerate point bbox upward by PIN_H and outward by
// HALF_W on each side.
const PIN_HALF_W = 15;
const PIN_H = 40;

// Where on the screen we want a selected pin to land. A bit below the
// chrome strip so the map title (when it appears) doesn't cover the pin.
const PIN_TARGET_Y = 240;

export class PopoverPositioning {
    bbox: FeatureBbox | null = $state(null);
    panning = $state(false);

    private getMap: () => MapboxMap | null;
    private panTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(getMap: () => MapboxMap | null) {
        this.getMap = getMap;
    }

    /**
     * Recompute the bbox for the given feature against the current camera.
     * Call from both selection events and `move` to keep the popover
     * pinned as the user pans.
     */
    compute(feat: Feature): void {
        const map = this.getMap();
        if (!map) {
            this.bbox = null;
            return;
        }
        if (feat.geometry?.type === "Point") {
            const c = (feat.geometry as GeoJSON.Point).coordinates as [
                number,
                number,
            ];
            const p = map.project({ lng: c[0], lat: c[1] });
            // STICKY BBOX: a degenerate camera transform (NaN unproject — see the
            // map's [mapInit] "camera transform degenerate" guard) makes project()
            // return NaN for a single frame DURING the recenter flyTo. If we wrote
            // that NaN bbox, the plot popover's `bbox !== null` render gate would
            // not catch it, but downstream `selectedFeature`/index math nulls and
            // the popover unmounts → its onDestroy discards the still-uncounted
            // brand-new plot. So on a bad projection we KEEP the last good bbox and
            // skip this frame; the next clean frame updates it. This is what stops
            // the "first plot vanishes as it recenters" bug.
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
            this.bbox = {
                minX: p.x - PIN_HALF_W,
                maxX: p.x + PIN_HALF_W,
                minY: p.y - PIN_H,
                maxY: p.y,
            };
            return;
        }
        const projected = projectFeatureBbox(map, feat);
        // Same sticky guard for polygon/line features: don't null a live bbox on a
        // transient projection failure mid-animation.
        if (projected == null && this.bbox != null) return;
        this.bbox = projected;
    }

    clear(): void {
        this.bbox = null;
    }

    /**
     * Pan a Point feature so it lands near the top-center of the visible
     * map area. No-op for non-points (polygons/lines use fitBounds
     * elsewhere).
     *
     * Returns the chosen animation duration in ms (or 0 if no animation
     * ran — bad input or corrupt camera state). Callers can use the
     * returned duration to schedule follow-up state changes such as
     * unsuppressing a zoom-title overlay.
     */
    panToFeature(feat: Feature, opts?: { zoom?: number }): number {
        const map = this.getMap();
        if (!map) return 0;
        if (feat.geometry?.type !== "Point") return 0;
        const c = (feat.geometry as GeoJSON.Point).coordinates as [
            number,
            number,
        ];
        const h = map.getContainer().clientHeight;

        // Scale the pan duration (and the "gate the popover" pause) to the
        // actual screen-pixel distance from the current camera target to
        // where the pin will land. Short hops shouldn't burn 1.2s and
        // shouldn't withhold the popover — the gate was tuned for long
        // flyTos and felt broken on near-pin taps. Long flies still get
        // the full smooth ramp.
        let pixelDelta = 0;
        try {
            const curProj = map.project(map.getCenter());
            const tgtProj = map.project({ lng: c[0], lat: c[1] });
            const targetScreenY = PIN_TARGET_Y;
            const dx = tgtProj.x - curProj.x;
            const dy = tgtProj.y - (curProj.y + (targetScreenY - h / 2));
            pixelDelta = Math.hypot(dx, dy);
        } catch {
            pixelDelta = 1200; // assume far on any projection failure
        }
        const SHORT_PX = 150; // below this: skip the popover gate
        const FAR_PX = 1200;
        const t = Math.min(1, Math.max(0, pixelDelta / FAR_PX));
        const duration = Math.round(250 + t * (1200 - 250));

        if (this.panTimer) clearTimeout(this.panTimer);
        this.panning = pixelDelta >= SHORT_PX;
        // Camera math from commit 9a864929 (user-tuned, approved):
        // `offset: [0, targetY - h/2]` puts the pin in the upper
        // portion of the viewport. NaN-guards + map.stop() + clean-
        // state recovery all live in safeFlyTo.
        safeFlyTo(map, {
            center: c,
            zoom: opts?.zoom,
            offset: [0, PIN_TARGET_Y - h / 2],
            duration,
            curve: 1.2,
            essential: true,
        });

        this.panTimer = setTimeout(() => {
            this.panning = false;
        }, duration);
        return duration;
    }

    /**
     * Fit the camera to a [sw, ne] bounding box, anchored top-center
     * (same screen position as a panned-to pin). For polygons and lines
     * selected from the layers list — they should land in the same place
     * a pin would, not in the geometric center of the viewport.
     *
     * Uses the same `padding.bottom = h - 2*PIN_TARGET_Y` trick as
     * panToFeature: Mapbox fits the bounds into the unpadded rectangle,
     * whose center sits at container y = PIN_TARGET_Y.
     *
     * Returns the animation duration in ms.
     */
    panToBounds(
        sw: [number, number],
        ne: [number, number],
        opts?: { duration?: number },
    ): number {
        const map = this.getMap();
        if (!map) return 0;
        const container = map.getContainer();
        const h = container.clientHeight;
        const w = container.clientWidth;
        // During keyboard reflow / cold layout the container can be 0-sized
        // or mid-transition; fitting then makes the bottom padding exceed the
        // viewport → degenerate (NaN) zoom. Skip — the next stable tap re-pans.
        if (h <= 0 || w <= 0) return 0;
        const bottomPad = Math.max(0, h - 2 * PIN_TARGET_Y);
        const duration = opts?.duration ?? 1200;
        this.panning = true;
        if (this.panTimer) clearTimeout(this.panTimer);
        safeFitBounds(map, sw, ne, {
            padding: { top: 40, bottom: bottomPad, left: 40, right: 40 },
            duration,
            essential: true,
        });
        this.panTimer = setTimeout(() => {
            this.panning = false;
        }, duration);
        return duration;
    }

    cleanup(): void {
        if (this.panTimer) {
            clearTimeout(this.panTimer);
            this.panTimer = null;
        }
    }
}
