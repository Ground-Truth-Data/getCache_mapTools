// Quality-704 plot drop.
//
// THE ONE LAW: a plot PIN is a projection of the DATABASE. A pin exists on the
// map if and only if a qaPlotTable row for it exists (with a count + a pin's
// coordinate). `mapStore.syncMaps` renders pins straight from mapFeatureTable/
// qaPlotTable — it is the SOLE creator of a plot pin. This file never paints one.
//
// So dropping a plot does NOT create a pin. It:
//   1. reserves the next map-scoped number in MEMORY (the pending drop rune —
//      no store write), and
//   2. opens the count popover at the tapped coordinate.
// You count, you swipe → the row is written to the database → syncMaps draws the
// pin. Leave before swiping → the memory rune is gone, and since nothing was ever
// written or painted, there is nothing to clean up. No transient pin, no orphan,
// no sweep, no "half-done" anything.

import type { Map as MapboxMap } from "mapbox-gl";
import { toast } from "svelte-sonner";
import type { createMapStore } from "$lib/mobile/stores/mapStore.svelte";
import {
	attachPendingDropCoord,
	clearPendingDrop,
	reserveActivePlot,
	sameSpotPlotToday,
	setActivePlotAtUserLocation,
} from "$lib/mobile/stores/quality704Plots.svelte.js";
import { adoptMapIntoActiveSurvey } from "$lib/mobile/stores/quality704Surveys.svelte.js";
import { metersBetween } from "./tracking.svelte";
import { encodePlusCode } from "$parent/siblings/getCache_OnlineMap/lib/plusCode";

type MapStore = ReturnType<typeof createMapStore>;

// What the drop needs from the host. It NO LONGER touches map features — the pin
// comes from the DB via syncMaps — so it only needs to open the popover for the
// pending drop and move the camera.
export type PlotDropDeps = {
	/** The live Mapbox map (or null before it boots). */
	getMap: () => MapboxMap | null;
	/** The map store (activeMapKey). */
	mapStore: MapStore;
	/** Open the count popover for the pending drop at [lng, lat]. */
	openPendingPopover: (lng: number, lat: number) => void;
	/** Ease the camera so the drop point sits up top, capped at the given zoom. */
	panToCoord: (lng: number, lat: number, opts: { zoom: number }) => void;
	/** The live blue-dot fix `[lng, lat]`, or null — for the 5 m proof-of-presence. */
	getUserCoord?: () => [number, number] | null;
};

// Default context zoom when a plot lands — same as a pin tap (never slams deeper).
const PLOT_LAND_ZOOM = 10;

// PROOF OF PRESENCE radius: a plot dropped within this many metres of the phone's
// live GPS fix earns the DIAMOND on the 704 sheet. Snap-to-self counts too (0 m).
const SELF_PROOF_RADIUS_M = 5;

export function createPlotDrop(deps: PlotDropDeps) {
	// One drop at a time — a rapid double-tap can't mint two numbers.
	let dropping = false;

	// Returns true when the drop opened its popover, false on any refusal (twin
	// spot today, no store) so the caller can retract a "confirmed" flash.
	function dropPlot(
		lng: number,
		lat: number,
		atSelf = false,
		plusCode: string | null = null,
	): boolean {
		if (dropping) return false;
		dropping = true;
		try {
			// MARRY the survey to THIS map (idempotent). The map IS the survey.
			const mapKey = deps.mapStore.activeMapKey ?? "";
			if (mapKey) adoptMapIntoActiveSurvey(mapKey);

			// SAME-SPOT-SAME-DAY GUARD — refuse a duplicate of a plot already thrown
			// on this spot today, before anything is reserved.
			const clash = sameSpotPlotToday(mapKey, lng, lat, plusCode);
			if (clash) {
				toast.error(
					`Plot ${clash.plotNo} was already thrown on this spot today — move over or edit that plot.`,
					{ duration: 5000 },
				);
				return false;
			}

			// EVERY plot carries an Open LoCode: a grid-snap drop carries the dot's
			// code; a free drop encodes its coordinate to an 11-char Plus Code.
			const locode = plusCode ?? encodePlusCode(lat, lng, 11);

			// Reserve the next number in MEMORY (no store write). Mints the pending
			// drop's permanent `<locode>:<epochMs>` key.
			const reserved = reserveActivePlot(mapKey, locode);
			if (!reserved) {
				console.error("[plotDrop] reserveActivePlot returned null — no store?");
				return false;
			}
			const { plotNo, rowKey } = reserved;

			// Carry the drop coordinate on the pending rune — it becomes the pin's
			// coordinate when the count is swiped and the row is written. NOTHING is
			// stored or painted yet.
			attachPendingDropCoord(rowKey, lng, lat);

			// PROVENANCE (the DIAMOND): the phone was AT the plot when it dropped —
			// snapped onto the blue dot (atSelf) or within 5 m of the live fix.
			const fix = deps.getUserCoord?.() ?? null;
			const atPlot =
				atSelf === true ||
				(fix !== null && metersBetween(fix, [lng, lat]) <= SELF_PROOF_RADIUS_M);
			setActivePlotAtUserLocation(rowKey, atPlot);

			console.log(
				`[plotDrop] reserved plot #${plotNo} on map "${mapKey}" (row ${rowKey}, memory-only) at ${lng.toFixed(5)},${lat.toFixed(5)}${atPlot ? " (AT USER LOCATION — 💎)" : ""} [${locode}] — NO pin painted; the pin appears when the count is swiped and the row is written.`,
			);

			// Open the count popover at the drop spot + recenter. The pin will appear
			// from the DB once the count is filed.
			deps.openPendingPopover(lng, lat);
			const map = deps.getMap();
			const cur = map ? map.getZoom() : Number.NaN;
			const targetZoom = Number.isFinite(cur)
				? Math.max(cur, PLOT_LAND_ZOOM)
				: PLOT_LAND_ZOOM;
			deps.panToCoord(lng, lat, { zoom: targetZoom });
			return true;
		} finally {
			dropping = false;
		}
	}

	// Abandon the in-flight (uncounted) drop: just clear the memory rune. Nothing
	// was written or painted, so there is nothing else to undo.
	function cancelPendingDrop(): void {
		clearPendingDrop();
	}

	return { dropPlot, cancelPendingDrop };
}
