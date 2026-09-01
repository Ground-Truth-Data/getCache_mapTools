// Map-event wiring — the click / move / zoom / style.load lifecycle for the live
// Mapbox map, EXTRACTED from the MapDrawControls `attachedToMap` $effect (the
// last big imperative block left in that 1600-line host). Same shape as the other
// controllers in this folder (gridTile, vertexDrag, pinMarkers): a factory taking
// injected host deps, returning `attach(map)` → teardown.
//
// WHY A CONTROLLER, NOT A COMPONENT: this is pure imperative Mapbox event handling
// (m.on / m.off) with no markup — a .svelte component would be an empty template.
// Keeping it here makes the event lifecycle (and its teardown, which must survive
// the parent nulling its bindable `map`) a single testable unit.
//
// THE TEARDOWN RULE: capture the map locally in attach(); the returned teardown
// closes over THAT `m`, never the reactive prop — so if the parent nulls its map
// on route unmount before teardown fires, every m.off() still has a live handle.

import type { Feature } from "geojson";
import type { Map as MapboxMap } from "mapbox-gl";
import type { createMapStore } from "$lib/mobile/stores/mapStore.svelte";
import {
	boundaryPinAt,
	buildCentroidFC,
	buildCompletedFC,
	getAccentColor,
	hitTestCompleted,
	setupDrawSourcesAndLayers,
	setVertexHandlesForFeature,
} from "@ground-truth/getcache-onlinemap/lib/mapDraw";
import { gridDotAt } from "@ground-truth/getcache-onlinemap/lib/mapGrid";
import { isFiniteLngLat } from "@ground-truth/getcache-onlinemap/lib/safeMap";
import type { PopoverPositioning } from "./popoverPositioning.svelte";

type MapStore = ReturnType<typeof createMapStore>;

// The host wiring this needs. Kept as getters/callbacks so the controller never
// holds a stale snapshot of reactive host state (selection, zoom-title flags).
export type MapEventsDeps = {
	mapStore: MapStore;
	popoverPos: PopoverPositioning;
	// Sub-controllers whose lifecycle is co-owned by this effect.
	gridTile: {
		attach: (m: MapboxMap) => () => void;
		restoreAfterStyleLoad: (m: MapboxMap) => void;
	};
	vertexDragger: { attach: () => () => void; lastUpAt: number };
	pins: { sync: () => void; clear: () => void };
	overlayMgr: {
		bustCache: () => void;
		renderActiveMapOverlay: () => Promise<void> | void;
	};
	// Push a GeoJSON source by id (host owns the map.getSource wrapper).
	setSource: (id: string, data: ReturnType<typeof buildCompletedFC>) => void;

	// Selection (key-first; host owns the state, we read + drive it).
	getSelectedFeature: () => Feature | null;
	getSelectedFeatureIndex: () => number | null;
	getSelectedIsPlotPin: () => boolean;
	// True while an armed palette tool or an active Snake Ruler owns map taps —
	// the tap is placing geometry, so the feature hit-test must stand down.
	getToolOwnsClicks: () => boolean;
	setSelectedIndex: (idx: number | null) => void;
	// Outside-tap on an open PLOT popover routes here (PlotLayer owns the close path).
	onPlotOutsideTap: () => void;

	// Host UI state setters (zoom chip, title overlay).
	setCurrentZoom: (z: number) => void;
	getSuppressZoomTitle: () => boolean;
	showZoomTitle: () => void;
	scheduleHideZoomTitle: () => void;
	clearZoomTitleTimer: () => void;
};

export function createMapEvents(deps: MapEventsDeps) {
	// One-map guard so re-running the host effect on an unrelated reactive change
	// doesn't double-attach. Mirrors the old `attachedToMap === m` check.
	let attachedToMap: MapboxMap | null = null;

	function attach(m: MapboxMap): () => void {
		if (attachedToMap === m)
			return () => {
				/* already attached to this map — no-op detach */
			};
		attachedToMap = m;
		// `false` = skip the in-progress drawing sources. Geometry creation on
		// this route is fully owned by <SnakeRuler> (MapDrawControls.svelte:459),
		// which brings its own. The three skipped sources held an empty
		// FeatureCollection for the whole session and were never written to.
		setupDrawSourcesAndLayers(m, getAccentColor(), false);
		const detachGrid = deps.gridTile.attach(m);

		const onClick = (e: {
			lngLat: { lng: number; lat: number };
			point: { x: number; y: number };
		}) => {
			// Reject NaN lngLat at the boundary. Happens when the camera state is
			// mid-recovery or a pinch produces a degenerate transform — the click
			// then reports NaN coords that would corrupt every later render.
			if (!isFiniteLngLat(e.lngLat)) return;
			// A vertex tap/drag releases just before mapbox synthesizes this click —
			// ignore it so editing a handle doesn't also deselect the feature (which
			// would hide the very handles being used).
			if (performance.now() - deps.vertexDragger.lastUpAt < 250) return;
			// If a feature popover is open, tapping the map outside it just closes
			// the popover — never drops a pin or extends a draw.
			if (deps.getSelectedFeatureIndex() !== null) {
				// A PLOT popover obeys THE RULE: never silently leave a half-done
				// plot. An outside-tap runs the SAME close path as the × (the
				// "Keep editing / Discard" guard). PlotLayer owns that path.
				if (deps.getSelectedIsPlotPin()) {
					deps.onPlotOutsideTap();
					return;
				}
				deps.setSelectedIndex(null);
				deps.popoverPos.clear();
				return;
			}
			// A TOOL OWNS THE TAP: an armed palette tool or an active Snake
			// Ruler is placing geometry — never ALSO hit-test features (that
			// would pop a feature editor mid-draw). Mirrors the old unified
			// handler's `if (drawIntent)` early-exit.
			if (deps.getToolOwnsClicks()) return;
			// EXCLUSIVE TAP TARGETS: a tap on a grid dot belongs to the dot —
			// its layer handler opens the Plus-Code popup. Without this the
			// hit-test below ALSO opened the feature under the dot, stacking
			// the feature editor on top of the grid popup.
			if (gridDotAt(m, e.point)) return;
			// Same exclusivity for the boundary pins (the clustered centroid
			// bubbles standing in for polygons at far-out zooms): their layer
			// handler navigates — the hit-test below must not ALSO select the
			// sub-pixel polygon underneath and open its popover mid-flight.
			if (boundaryPinAt(m, e.point)) return;
			const hitIdx = hitTestCompleted(m, e.point);
			if (hitIdx !== null) {
				deps.setSelectedIndex(hitIdx);
				const feat = deps.mapStore.features[hitIdx];
				if (feat) deps.popoverPos.compute(feat);
			} else {
				deps.setSelectedIndex(null);
				deps.popoverPos.clear();
			}
		};

		const onMove = () => {
			const sel = deps.getSelectedFeature();
			if (sel) deps.popoverPos.compute(sel);
		};

		const onZoom = () => {
			deps.setCurrentZoom(m.getZoom());
		};
		// Clustering itself is NATIVE (the GL engine re-clusters continuously) —
		// this settle-time sync only reconciles the DOM single-pin markers to
		// whatever the clustered source now reports as unclustered in-viewport.
		const onMoveEnd = () => {
			if (deps.mapStore.ready) deps.pins.sync();
		};
		// Seed the initial value so the chip renders correctly before the first
		// user-driven zoom.
		deps.setCurrentZoom(m.getZoom());

		const onZoomStart = () => {
			if (deps.getSuppressZoomTitle()) return;
			deps.showZoomTitle();
		};
		const onZoomEnd = () => {
			deps.scheduleHideZoomTitle();
		};

		// Re-install custom sources/layers after ANY style change. mapbox-gl wipes
		// everything custom on setStyle (basemap swap, label filtering, hospital
		// markers, anything that mutates the style). Without this the user's drawn
		// features vanish and never come back until reload. Only re-push features
		// when the store is hydrated — pushing empty mid-load made them flicker out.
		const onStyleLoad = () => {
			console.debug("[map] style.load — reinstalling custom layers");
			// Same opt-out as attach(): a basemap swap must not re-introduce
			// the in-progress sources this route never uses.
			setupDrawSourcesAndLayers(m, getAccentColor(), false);
			deps.gridTile.restoreAfterStyleLoad(m);
			if (deps.mapStore.ready) {
				deps.setSource(
					"completed-features",
					buildCompletedFC(deps.mapStore.features),
				);
				deps.setSource(
					"completed-centroids",
					buildCentroidFC(deps.mapStore.features),
				);
			}
			// setupDrawSourcesAndLayers re-creates the vertex layers with their
			// hidden default filter — re-reveal the selected feature's handles.
			setVertexHandlesForFeature(m, deps.getSelectedFeatureIndex());
			// Re-install the native pin-cluster source/layers (setStyle wiped
			// them too) and re-push the pin data.
			if (deps.mapStore.ready) deps.pins.sync();
			// Re-add the active map's overlay — Mapbox wiped the image source along
			// with everything else custom. Bust the dedup cache so the render effect
			// actually fires (without this it sees same map + same overlay and short-circuits).
			deps.overlayMgr.bustCache();
			void deps.overlayMgr.renderActiveMapOverlay();
		};

		m.on("click", onClick);
		m.on("move", onMove);
		m.on("moveend", onMoveEnd);
		m.on("zoomstart", onZoomStart);
		m.on("zoomend", onZoomEnd);
		m.on("zoom", onZoom);
		m.on("style.load", onStyleLoad);
		const detachVertexDrag = deps.vertexDragger.attach();

		return () => {
			m.off("click", onClick);
			m.off("move", onMove);
			m.off("moveend", onMoveEnd);
			m.off("zoomstart", onZoomStart);
			m.off("zoomend", onZoomEnd);
			m.off("zoom", onZoom);
			m.off("style.load", onStyleLoad);
			detachVertexDrag();
			deps.clearZoomTitleTimer();
			detachGrid();
			deps.pins.clear();
			attachedToMap = null;
		};
	}

	return { attach };
}
