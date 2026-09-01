<!--
  PlotLayer — the ENTIRE Quality-704 plot lifecycle on the map, EXTRACTED from
  MapDrawControls.svelte (which had ballooned past 1600 lines). One component owns
  the whole feature so the drop/guard/popover/sweep logic stops being tangled in
  among the draw tools, basemap picker, search, import, etc.

  WHAT LIVES HERE:
    • The drop sequence (delegated to ./plotDrop.ts — the duplicate-proof core).
    • The boot pass: sweep orphan/duplicate PINS (real garbage) + re-CONFRONT any
      leftover half-done plot by reopening its popover.
    • The close gate ("swipe to file OR cancel plot") — the ONLY discard path.
    • The plot popover (PlotMapPopoverV2) + the discard modal.
    • The plot-pin :global CSS (the gold "Plot N" plaque, status bulbs contract,
      selected pill + dotted leader).

  WHAT STAYS IN THE HOST: selection (key-first), popover positioning, the camera
  pan, and "see on map" framing — those are shared by every feature kind, not just
  plots, so they're injected as deps. The host calls `dropPlot(...)` (from the
  SnakeRuler onPlot + the grid-dot Plot button) and renders the popover via the
  selection state it already owns; PlotLayer reads that selection through props.

  THE TWO RULES (both absolute, and they point the same way — fail LOUD):
    1. A plot is NEVER silently discarded. No unmount fail-safe, no timer, no
       sweep may delete a plot row. The ONLY discard is the user tapping
       "cancel plot" in the Unfinished-plot gate. (Every automatic-discard
       scheme we tried eventually ate the first plot of the day.)
    2. A half-done plot is NEVER left sitting closed-up on the map. Closing an
       uncounted plot (X, outside-tap, selection stolen by another feature)
       pops the gate: finish it or cancel it. A leftover that slips through
       anyway (crash, route change) gets its popover REOPENED on the next map
       boot — confronted, not deleted.
  Plus the DB-style primary key: on one map, (mapKey, plotNo) is UNIQUE.
-->
<script lang="ts">
import { retreeverMapPorts } from "$lib/mobile/offline/host/retreeverMapPorts";
const mapPorts = retreeverMapPorts();
	import { isVerbose } from "$lib/mobile/utils/verboseLog";
import type { Feature } from "geojson";
import type { Map as MapboxMap } from "mapbox-gl";
import { onDestroy } from "svelte";
import { goto } from "$app/navigation";
import type { PopoverPositioning } from "./popoverPositioning.svelte";
import type { createMapStore } from "$lib/mobile/stores/mapStore.svelte";
import { createPlotDrop } from "./plotDrop";
import { surveyKeyForFeature } from "$lib/mobile/stores/quality704Surveys.svelte.js";
import { getHandle } from "$lib/mobile/stores/quality704Core.svelte.js";
import {
	discardPendingDrop,
	pendingDropPlotNo,
	pendingDropRowKey,
	rekeyPlotRowsToLocodeKeys,
} from "$lib/mobile/stores/quality704Plots.svelte.js";
import PlotMapPopover from "@ground-truth/getcache-offlinemap/lib/mapUi/PlotMapPopoverV2.svelte";
import { locodeFromPlotKey } from "$lib/mobile/stores/plotKey";
import { markerCtor } from "@ground-truth/getcache-offlinemap/lib/shared/rendererOf";

type MapStore = ReturnType<typeof createMapStore>;

let {
	map,
	mapStore,
	popoverPos,
	selectedFeature,
	// True iff the selected feature is a `plot:N` pin — the host derives this and
	// passes it so PlotLayer doesn't duplicate the pinTypeKey-sniffing logic.
	selectedIsPlotPin,
	// Shared host wiring (every feature kind uses these — not plot-specific).
	panPointToTop,
	deselect,
	onShare,
	// The live blue-dot fix, for the drop's 5 m proof-of-presence (DIAMOND) check.
	getUserCoord,
}: {
	map: MapboxMap | null;
	mapStore: MapStore;
	popoverPos: PopoverPositioning;
	selectedFeature: Feature | null;
	selectedIsPlotPin: boolean;
	panPointToTop: (feat: Feature, opts?: { zoom?: number }) => void;
	deselect: () => void;
	onShare: () => void;
	getUserCoord?: () => [number, number] | null;
} = $props();

// ── TWO popover modes ──────────────────────────────────────────────────────
// VIEW: an existing, counted plot pin is selected → its popover shows read-only
//   data (the pin is a real DB row). Positioned by the host's popoverPos.
// CREATE: a plot was just dropped → a pending drop lives in MEMORY (no pin, no
//   row). We show the count popover positioned at the drop coordinate. There is
//   NO map feature: the pin does not exist until the count is swiped + written,
//   at which point mapStore.syncMaps draws it from the database.

// The in-flight drop's screen state — its number (for the popover) and the
// coordinate to anchor the popover at. Null when no drop is in flight.
let pendingPlotNo = $state<number | null>(null);
let pendingCoord = $state<{ lng: number; lat: number } | null>(null);
// The pending popover's on-screen box, recomputed from its coordinate as the
// camera moves (the map projects lng/lat → pixels).
let pendingBbox = $state<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);

function computePendingBbox(): void {
	if (!map || !pendingCoord) {
		pendingBbox = null;
		return;
	}
	const p = map.project([pendingCoord.lng, pendingCoord.lat]);
	pendingBbox = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
}

// Recompute the pending popover's box whenever the camera moves, so the create
// popover glides with its spot exactly like a selected pin's popover.
$effect(() => {
	if (!map) return;
	const onMove = () => computePendingBbox();
	map.on("move", onMove);
	return () => {
		map?.off("move", onMove);
	};
});

// TEMPORARY (GHOST) PLOT MARKER — a MEMORY-ONLY twin of the real plot pin.
//
// THE TWO ARE DELIBERATELY SEPARATE THINGS (the hard lesson of the pin saga):
//   • REAL pin  = `.map-pin-plot`, built by pinMarkers.ts from a mapFeatureTable
//     DB ROW. Permanent. Exists IFF the plot is in the database (Law 3).
//   • GHOST pin = `.map-pin-plot.map-pin-plot--ghost`, built HERE from the
//     `pendingDrop` MEMORY rune (pendingCoord + pendingPlotNo). It shows WHERE
//     and WHICH plot you're currently throwing, so you don't lose your place.
//     It is NEVER a DB row, never persisted, and it is torn down the instant the
//     drop is swiped (→ the real DB pin takes over) or abandoned.
// They copy the same LOOK (so it feels consistent) but share NO state and NO code
// path — a ghost can never be mistaken for or become a real pin (Law 4 by
// construction). The `--ghost` class dims it so it reads as "placing, not saved".
// Type-only reference to Mapbox's Marker: the two libraries' Markers are
// structurally identical for everything used here, and markerCtor() is typed
// to return the Mapbox class, so this annotation covers BOTH renderers.
let ghostMarker: import("mapbox-gl").Marker | null = null;
$effect(() => {
	const coord = pendingCoord;
	const no = pendingPlotNo;
	// filedClosing: the swipe landed — the REAL pin is rendering from the DB and
	// the popover is playing its TV-off into it. The ghost's job is over; keeping
	// it would double the pin under the collapse.
	if (!map || !coord || no === null || filedClosing) {
		ghostMarker?.remove();
		ghostMarker = null;
		return;
	}
	// Same markup contract as the REAL plot pin (pinMarkers.ts buildPinElement),
	// plus the --ghost modifier. Memory-sourced number, no data-feature-key.
	const el = document.createElement("div");
	el.className = "map-pin-marker map-pin-plot map-pin-plot--ghost";
	el.setAttribute("aria-hidden", "true");
	el.innerHTML =
		`<span class="map-pin-plot__inner">` +
		`<span class="map-pin-plot__num">Plot ${no}</span>` +
		`</span>`;
	// ⛔ RENDERER-CORRECT Marker, via markerCtor(map) — NEVER a bare
	// `new mapboxgl.Marker`. The offline route (/offline) hands this same
	// component a MAPLIBRE map; a Mapbox Marker attached to it throws
	// `TypeError: _addMarker is not a function` from inside addTo, which killed
	// every plot drop on that route. markerCtor asks the live instance which
	// library built it. See $lib/mobile/map/rendererOf.ts.
	ghostMarker?.remove();
	ghostMarker = new (markerCtor(map))({ element: el, anchor: "bottom" })
		.setLngLat([coord.lng, coord.lat])
		.addTo(map);
	return () => {
		ghostMarker?.remove();
		ghostMarker = null;
	};
});

// VIEW popover: a counted plot pin is selected + positioned.
let showViewPopover = $derived(
	selectedFeature !== null &&
		popoverPos.bbox !== null &&
		map !== null &&
		selectedIsPlotPin &&
		pendingPlotNo === null,
);
// CREATE popover: a drop is in flight.
let showCreatePopover = $derived(
	pendingPlotNo !== null && pendingBbox !== null && map !== null,
);

// The drop sequence lives in ./plotDrop.ts — it reserves the number in MEMORY
// and hands us back the coordinate to open the count popover at. NO pin is
// painted; the pin comes from the DB when the count is swiped.
const plotDrop = createPlotDrop({
	getMap: () => map,
	mapStore,
	openPendingPopover: (lng, lat) => {
		// ONE pending drop at a time. A new drop SUPERSEDES any prior un-swiped one —
		// you finish (swipe) a plot before starting the next. The prior drop was
		// memory-only and never saved, so it simply evaporates: clear its placement
		// marker + popover before showing the new one, so two never coexist on screen.
		// (reserveActivePlot inside plotDrop already overwrote the pending rune; this
		// clears the SCREEN state that mirrors it.)
		deselect();
		pendingCoord = { lng, lat }; // new value → placement-marker effect re-runs, dropping the old marker
		pendingPlotNo = pendingDropPlotNo();
		computePendingBbox();
	},
	panToCoord: (lng, lat, opts) => {
		// Reuse the host's point-to-top pan via a throwaway Point feature.
		panPointToTop(
			{
				type: "Feature",
				geometry: { type: "Point", coordinates: [lng, lat] },
				properties: {},
			},
			opts,
		);
	},
	getUserCoord,
});

// MEMORY DISAPPEARS ON LEAVE. The pending drop is memory-only and must never
// survive leaving the map — a stale rune is exactly the "ghost half-thought
// memory" we refuse to keep. When PlotLayer unmounts (route change away from the
// map, HMR, teardown), discard it. A full reload already wipes it (the module
// reloads); this covers client-side navigation where the module persists.
onDestroy(() => {
	discardPendingDrop();
});

// Public: drop a Quality 704 plot. Called by the host's SnakeRuler onPlot + the
// grid-dot Plot button. `atSelf` = snapped onto the user's blue dot (proof of
// presence). `plusCode` = the snapped audit-grid dot's id (null = dropped free).
// Returns true when the drop opened its count popover. A pin is NOT created here
// — it appears from the database once the count is swiped.
export function dropPlot(
	lng: number,
	lat: number,
	atSelf = false,
	plusCode: string | null = null,
): boolean {
	// A prior in-flight drop is abandoned by starting a new one — it was only
	// memory (no pin, no row), nothing to clean up. plotDrop overwrites the rune
	// and calls openPendingPopover, which sets pendingPlotNo/coord.
	return plotDrop.dropPlot(lng, lat, atSelf, plusCode);
}

// Public: outside-tap while a PLOT popover is open. Closes it. Returns true if
// handled (host stands down). A deck editor open → stand down (it handles itself).
export function handleOutsideTap(): boolean {
	if (
		document.querySelector(
			".deck-overlays .cache-popover-card, .deck-overlays .sheet",
		)
	) {
		return true;
	}
	if (filedClosing) {
		// Mid TV-off — the popover is already on its way out; don't cut the exit.
		return true;
	}
	if (pendingPlotNo !== null) {
		closeCreatePopover();
		return true;
	}
	deselect();
	return true;
}

// Public: the boot pass — now PURELY legacy migrations, no landmine cleanup.
// There are no orphan/duplicate pins to sweep and no leftover half-done plot to
// confront, because a plot pin can no longer exist without its counted row: the
// pin row and the plot row are born TOGETHER in one transaction at swipe (see
// updateActivePlot's promotion) and an uncounted plot is memory-only, wiped by
// any reload. The old orphan-sweep + boot-confront machinery guarded a state
// that can no longer occur; legacy `-1` rows already on the device are disposed
// once by purgeHalfDoneOnDisk at tinyStore boot, not here.
export function bootSweep(): void {
	// Upgrade any legacy row id to the permanent `<locode>:<bornMs>` plot key
	// (plotKey.ts), encoding the locode from the row's pin. Idempotent — a no-op
	// once every row is keyed. (This used to be two passes: a backfill that wrote
	// the `open_locode` cell, then a rekey that read it back. The cell is gone —
	// the key's prefix IS the code — so it is one pass now.)
	rekeyPlotRowsToLocodeKeys();
	// Gated (not forced) — the reactive $effect below also fires on boot, and a
	// forced call here printed the same receipt twice. The gate lets whichever
	// runs first print; rtPlots() stays the forced-reprint path.
	logPlotAudit();
}

// (The orphan + duplicate plot-pin sweep lived here. It's GONE: a plot pin can no
// longer exist without its counted row — the pin row and plot row are born in one
// transaction at swipe, and an uncounted plot is memory-only (wiped by any reload).
// So there is nothing to orphan and nothing to duplicate on disk. That whack-a-mole
// only existed because old code wrote a fake pin ahead of its row; the writers are
// gone, so the whacker is too.)

// ── PLOT AUDIT LOG — the "why do I only see 14?" receipt ──────────────────
// PIN-CENTRIC on purpose: if the globe draws 14 plot pins, the SHOWING table
// has exactly 14 lines — one per pin, in the label the marker actually wears
// (the live displayNo). Rows that back each pin are folded into two columns
// (plotRows count + the plot numbers), never exploded into their own lines.
// Everything NOT on this map is counts only:
//   OTHER MAPS — one line per map: how many pins + plot rows it holds.
//   NO GPS     — plot rows with no pin anywhere (can never render) — listed,
//                since these are the ones worth hunting down.
//   DANGLING   — rows pointing at a deleted pin feature (real garbage) — listed.
// Fires on the boot pass and again whenever its shape changes (map switch,
// drop, delete); the signature gate keeps it from spamming the console.
// `force` skips the gate — rtPlots() (registered below) uses it so the user
// can reprint the receipt anytime, even after a console clear.
let plotAuditSig = "";
function logPlotAudit(force = false): void {
	const h = getHandle();
	if (!h) return;
	const activeKey = mapStore.activeMapKey ?? "";
	const featTable = h.getTable("mapFeatureTable") as Record<
		string,
		Record<string, unknown>
	>;
	const mapTable = h.getTable("mapTable") as Record<
		string,
		Record<string, unknown>
	>;
	const rowEntries = Object.entries(h.getTable("qaPlotTable")) as [
		string,
		Record<string, unknown>,
	][];
	// The pins the globe is drawing RIGHT NOW (active map's plot: features).
	const renderedPins = mapStore.features.filter(
		(f) =>
			typeof f.properties?.pinTypeKey === "string" &&
			(f.properties.pinTypeKey as string).startsWith("plot:"),
	);
	// ONE LINE PER PLOT on the active map, real column names only. Plots that
	// share a gpsFeatureKey share a marker (different surveys thrown at the
	// same spot) — sorting by gpsFeatureKey groups those stacks together and
	// the qaSurveyKey column says WHICH survey each one belongs to.
	type PlotLine = {
		plotNo: unknown;
		planted: unknown;
		open_locode: string;
		qaSurveyKey: string;
		gpsFeatureKey: string;
	};
	const activePlots: PlotLine[] = [];
	const noGps: { plotNo: string; rowId: string }[] = [];
	const dangling: { plotNo: string; rowId: string }[] = [];
	const plotsByOtherMap = new Map<string, number>();
	for (const [id, r] of rowEntries) {
		const gk = (r.gpsFeatureKey as string) ?? "";
		if (!gk) {
			noGps.push({ plotNo: String(r.plotNo ?? "—"), rowId: id.slice(0, 8) });
			continue;
		}
		const feat = featTable[gk];
		if (!feat) {
			dangling.push({ plotNo: String(r.plotNo ?? "—"), rowId: id.slice(0, 8) });
			continue;
		}
		const mk = (feat.mapKey as string) ?? "";
		if (mk === activeKey) {
			activePlots.push({
				plotNo: r.plotNo ?? "—",
				planted: r.planted ?? "",
				open_locode: locodeFromPlotKey(id) || "—",
				qaSurveyKey: (r.qaSurveyKey as string) ?? "",
				gpsFeatureKey: gk.slice(0, 8),
			});
		} else {
			plotsByOtherMap.set(mk, (plotsByOtherMap.get(mk) ?? 0) + 1);
		}
	}
	activePlots.sort(
		(a, b) =>
			a.gpsFeatureKey.localeCompare(b.gpsFeatureKey) ||
			(Number(a.plotNo) || 0) - (Number(b.plotNo) || 0),
	);
	const pad = (v: unknown, w: number) => String(v ?? "").padEnd(w);
	const header = `  ${pad("plotNo", 8)}${pad("planted", 9)}${pad("open_locode", 14)}${pad("qaSurveyKey", 26)}gpsFeatureKey`;
	const lines = activePlots.map(
		(p) =>
			`  ${pad(p.plotNo, 8)}${pad(p.planted, 9)}${pad(p.open_locode, 14)}${pad(p.qaSurveyKey, 26)}${p.gpsFeatureKey}`,
	);
	const elsewhere = [...plotsByOtherMap.entries()].map(
		([mk, n]) => `${(mapTable[mk]?.mapTitle as string) ?? mk}: ${n} plots`,
	);
	const activeTitle = (mapTable[activeKey]?.mapTitle as string) ?? "(no active map)";
	const sig = `${activeKey}|${rowEntries.length}|${activePlots.length}|${renderedPins.length}|${elsewhere.length}|${noGps.length}|${dangling.length}`;
	if (!force && sig === plotAuditSig) return;
	plotAuditSig = sig;
	// Chatty per-mount audit: opt in with localStorage.rtVerbose='plots'.
	// `force` = the user typed rtPlots(), which always prints.
	if (!force && !isVerbose("plots")) return;
	console.log(
		`[plots] qaPlotTable: ${rowEntries.length} plots total · ` +
			`${activePlots.length} plots on map "${activeTitle}" · ` +
			`drawn as ${renderedPins.length} markers (plots sharing a gpsFeatureKey share a marker)\n` +
			`${header}\n${lines.join("\n")}\n` +
			`[plots] plots with NO gpsFeatureKey (never render): ${noGps.length}` +
			(noGps.length
				? ` → ${noGps.map((n) => `plotNo ${n.plotNo} (${n.rowId})`).join(", ")}`
				: "") +
			(dangling.length
				? `\n[plots] plots whose gpsFeatureKey no longer exists: ${dangling.length} → ${dangling.map((d) => `plotNo ${d.plotNo} (${d.rowId})`).join(", ")}`
				: "") +
			`\n[plots] plots on other maps: ${elsewhere.join(" · ") || "none"}` +
			`\n[plots] type rtPlots() here to print this again anytime`,
	);
}

// Re-audit whenever the active map's feature set changes (map switch, plot
// drop, delete). The signature gate above makes repeat runs silent.
$effect(() => {
	void mapStore.features;
	logPlotAudit();
});

// rtPlots() — console command. The boot log scrolls away or dies to a console
// clear; typing rtPlots() in DevTools reprints the receipt fresh, any time.
if (typeof window !== "undefined") {
	(window as unknown as Record<string, unknown>).rtPlots = () =>
		logPlotAudit(true);
}

// Close the CREATE popover. An uncounted drop is memory-only (no pin, no row), so
// closing it = discarding the pending rune. Leaving the map does the same thing by
// itself — there is nothing on disk to survive. No gate, no whack-a-mole: the drop
// is a fleeting thing that simply ceases to exist.
function closeCreatePopover() {
	discardPendingDrop();
	pendingPlotNo = null;
	pendingCoord = null;
	pendingBbox = null;
}

// Close the VIEW popover (a counted plot) — just deselect. Nothing is discarded;
// the pin is a real DB row and stays.
function closeViewPopover() {
	deselect();
}

// When the count is swiped, the promotion writes the row + mints the pin and
// clears the pending drop. Watch for that: once the rune is gone while our create
// popover is up, the real pin now renders from the DB — close the create popover
// (its job is done). This is the ONLY automatic close, and it fires on SUCCESS
// (a write happened), never on abandonment.
//
// THE CLOSE IS A PAYOFF, not a vanish: instead of unmounting on the spot (which
// read as "wait, what happened?"), the popover plays an old-TV power-off — the
// gold just-filed pill gets its beat, then the surface collapses to a bright
// line and sucks into the new pin's exact point, where a little gold star pops.
$effect(() => {
	void mapStore.features; // re-check after each store change
	if (pendingPlotNo !== null && pendingDropRowKey() === null && !filedClosing) {
		filedClosing = true;
		void runFiledClose();
	}
});

// ── TV-OFF close — the swipe-to-file payoff ────────────────────────────────
// True while the filed popover is playing its exit. Holds the pending screen
// state (popover stays mounted for the animation) but kills the ghost marker
// immediately (the REAL pin is already rendering — the collapse lands on it).
let filedClosing = $state(false);

function finishFiledClose(): void {
	pendingPlotNo = null;
	pendingCoord = null;
	pendingBbox = null;
	filedClosing = false;
}

async function runFiledClose(): Promise<void> {
	const m = map;
	const coord = pendingCoord;
	const container = m?.getContainer() ?? null;
	// The popover surface is NOT a DOM child of the map container (it mounts in
	// the route tree, positioned to overlay the map) — find it document-wide.
	// NO prefers-reduced-motion gate: this close IS the feedback that the swipe
	// filed the plot (macOS Reduce Motion is commonly on and was silently killing
	// the whole payoff); reduced-motion only trims decorative loops in this app.
	const node = document.querySelector<HTMLElement>(".rt-fmp");
	if (!m || !coord || !container || !node) {
		finishFiledClose();
		return;
	}
	// The popover is now a pure exit animation — no more taps land on it.
	node.style.pointerEvents = "none";
	// GOLD BEAT: let the just-filed pill's retract (350ms) + gold flash read
	// before the collapse starts (mirrors the popover's own 650ms justFiledHold).
	await new Promise((r) => setTimeout(r, 620));
	// Torn down during the beat (route change / map removed) — just finish.
	if (!node.isConnected) {
		finishFiledClose();
		return;
	}
	// Re-project at collapse time — the camera may have drifted during the beat.
	// map.project gives map-container coords; go through the container's client
	// rect to viewport coords so the maths hold regardless of the popover's
	// offsetParent (it is NOT inside the map container).
	const pin = m.project([coord.lng, coord.lat]);
	const crect = container.getBoundingClientRect();
	const pinClientX = crect.left + pin.x;
	const pinClientY = crect.top + pin.y;
	// Transform-origin AT THE PIN (relative to the popover's own box — it sits
	// above, so origin-y goes negative): every scale pulls the surface INTO the
	// pin's point, so the TV-off lands exactly where the new pin stands.
	const rect = node.getBoundingClientRect();
	const ox = pinClientX - rect.left;
	const oy = pinClientY - rect.top;
	document
		.querySelector<SVGElement>(".rt-fmp-leader")
		?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" });
	node.style.transformOrigin = `${ox}px ${oy}px`;
	const anim = node.animate(
		[
			{ transform: "scale(1, 1)", filter: "brightness(1)", opacity: 1 },
			// Vertical collapse toward the pin — the picture squashes…
			{ transform: "scale(1.04, 0.35)", filter: "brightness(1.5)", opacity: 1, offset: 0.45 },
			// …into a thin bright scanline at the pin's height…
			{ transform: "scale(1.06, 0.02)", filter: "brightness(2.2)", opacity: 1, offset: 0.62 },
			{ transform: "scale(0.5, 0.015)", filter: "brightness(2.5)", opacity: 1, offset: 0.85 },
			// …then the line snuffs into the point itself.
			{ transform: "scale(0.02, 0.02)", filter: "brightness(3)", opacity: 0.85 },
		],
		{ duration: 430, easing: "cubic-bezier(0.6, 0.05, 0.8, 0.5)", fill: "forwards" },
	);
	// Race a timeout so a frozen WAAPI clock (backgrounded tab) can't strand the
	// popover mid-collapse forever.
	await Promise.race([
		// codestyle-allow-swallow: anim.finished rejects when the animation is
		// cancelled (element removed mid-run); the timeout race below is the
		// real completion guard, so the rejection carries no signal.
		anim.finished.catch(() => {}),
		new Promise((r) => setTimeout(r, 900)),
	]);
	spawnPinStar(container, pin.x, pin.y);
	finishFiledClose();
}

// The star pop at the pin — the last spark of the TV-off. A one-shot DOM
// element in the map container (same coordinate space as the pins), removed
// when its pop keyframe ends.
function spawnPinStar(container: HTMLElement, x: number, y: number): void {
	const star = document.createElement("div");
	star.className = "plot-file-star";
	star.style.left = `${x}px`;
	star.style.top = `${y}px`;
	star.setAttribute("aria-hidden", "true");
	star.innerHTML =
		`<svg viewBox="-24 -24 48 48">` +
		`<g stroke="#f4d03f" stroke-width="3" stroke-linecap="round">` +
		`<line x1="0" y1="-10" x2="0" y2="-21"/>` +
		`<line x1="0" y1="10" x2="0" y2="21"/>` +
		`<line x1="-10" y1="0" x2="-21" y2="0"/>` +
		`<line x1="10" y1="0" x2="21" y2="0"/>` +
		`<line x1="7" y1="-7" x2="13.5" y2="-13.5"/>` +
		`<line x1="-7" y1="-7" x2="-13.5" y2="-13.5"/>` +
		`<line x1="7" y1="7" x2="13.5" y2="13.5"/>` +
		`<line x1="-7" y1="7" x2="-13.5" y2="13.5"/>` +
		`</g>` +
		`<circle r="4" fill="#fff8dc"/>` +
		`</svg>`;
	container.appendChild(star);
	setTimeout(() => star.remove(), 600);
}
</script>

{#if showCreatePopover && pendingPlotNo !== null && pendingBbox && map}
	<!-- CREATE: the count popover for the in-flight drop. NO feature — the pin does
	     not exist until the count is swiped and the row is written; then it renders
	     from the database via mapStore.syncMaps. -->
	<PlotMapPopover
    ports={mapPorts}
		pendingPlotNo={pendingPlotNo}
		bbox={pendingBbox}
		containerWidth={map.getContainer().clientWidth}
		containerHeight={map.getContainer().clientHeight}
		onShare={onShare}
		onClose={closeCreatePopover}
		onOpenInForm={(plotNo) => {
			// Sanctioned exit to the form. The pending drop is memory-only; leaving
			// discards it (the form owns the count from here). Navigate to the active
			// survey's plot.
			discardPendingDrop();
			pendingPlotNo = null;
			pendingCoord = null;
			pendingBbox = null;
			goto(`/quality704?focusPlot=${plotNo}`);
		}}
	/>
{/if}

<!-- (The temporary placement marker is a Mapbox Marker managed in the $effect
     above — memory-only, never a mapFeatureTable feature.) -->

{#if showViewPopover && selectedFeature && popoverPos.bbox && map}
	<!-- VIEW: an existing, counted plot pin (a real DB row). -->
	<PlotMapPopover
    ports={mapPorts}
		feature={selectedFeature}
		bbox={popoverPos.bbox}
		containerWidth={map.getContainer().clientWidth}
		containerHeight={map.getContainer().clientHeight}
		onShare={onShare}
		onClose={closeViewPopover}
		onOpenInForm={(plotNo) => {
			// Navigate BY SURVEY, not by bare plotNo. Resolve which survey this pin
			// belongs to (stamped surveyKey, else reverse-lookup) so the form activates
			// the RIGHT survey then focuses the plot.
			const sk = surveyKeyForFeature(
				(selectedFeature?.properties?.mapFeatureKey as string) ?? "",
			);
			deselect();
			const q = sk
				? `survey=${encodeURIComponent(sk)}&focusPlot=${plotNo}`
				: `focusPlot=${plotNo}`;
			goto(`/quality704?${q}`);
		}}
	/>
{/if}

<style>
	/* GHOST (temporary) plot marker — a memory-only twin of the real plot pin,
	   shown while a drop is in flight so the user knows which plot they're
	   throwing. Copies the real pin's look (via the shared :global .map-pin-plot
	   rules below) but the --ghost modifier dims it + gives a dashed edge so it
	   clearly reads as "placing, not saved". Non-interactive; torn down on swipe
	   or abandon. It is NEVER a database row. */
	:global(.map-pin-plot--ghost) {
		opacity: 0.72;
		pointer-events: none;
		filter: saturate(0.8);
		animation: ghost-plot-pulse 1.2s ease-in-out infinite;
	}
	:global(.map-pin-plot--ghost .map-pin-plot__inner) {
		border-style: dashed !important;
	}
	@keyframes ghost-plot-pulse {
		0%,
		100% {
			opacity: 0.6;
		}
		50% {
			opacity: 0.9;
		}
	}

	/* The TV-off star — the spark that pops at the pin the instant the filed
	   popover's collapse lands on it (spawnPinStar). A zero-size anchor at the
	   pin's map-container coords; the SVG centers itself on it and plays one
	   pop-and-fade, then the element is removed. */
	:global(.plot-file-star) {
		position: absolute;
		z-index: 19; /* one over the popover surface (18) — the finale reads on top */
		width: 0;
		height: 0;
		pointer-events: none;
	}
	:global(.plot-file-star svg) {
		position: absolute;
		left: -34px;
		top: -34px;
		width: 68px;
		height: 68px;
		animation: plot-star-pop 0.5s cubic-bezier(0.2, 0.9, 0.3, 1) forwards;
	}
	@keyframes plot-star-pop {
		0% {
			transform: scale(0.1) rotate(-20deg);
			opacity: 0;
		}
		25% {
			opacity: 1;
		}
		55% {
			transform: scale(1.15) rotate(8deg);
			opacity: 1;
		}
		100% {
			transform: scale(1.35) rotate(14deg);
			opacity: 0;
		}
	}

	/* Quality-plot marker — a small black/gold numbered plaque (the classic
	   forester's plot marker), in place of the teardrop pin. Auto-sizes to the
	   number; the dynamic DOM is built in pinMarkers.ts so styles are :global. */
	:global(.map-pin-marker.map-pin-plot) {
		/* DO NOT set position here. Mapbox positions every marker via the
		   `.mapboxgl-marker` class (position:absolute + an inline transform). This
		   selector has TWO classes (specificity 0,2,0) and would OVERRIDE Mapbox's
		   one-class `.mapboxgl-marker` (0,1,0) — setting `position: relative` here
		   made the pin ignore Mapbox's absolute anchoring and DRIFT across the map
		   on zoom (the "pins zooming across city blocks" bug). The status-dot
		   cluster gets its positioning context from `.map-pin-plot__inner` instead. */
		width: auto;
		height: auto;
		min-width: 17px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 1.5px 5px;
		background: #1a1a1a;
		border: 1.25px solid var(--rt-yellow, #ffd700);
		border-radius: 5.5px;
		box-sizing: border-box;
		overflow: visible;
	}
	/* The dots' positioned ancestor — an inner wrapper, NOT the Mapbox-owned root.
	   It hugs the number tightly so the cluster still perches at the pin's corner. */
	:global(.map-pin-plot .map-pin-plot__inner) {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	:global(.map-pin-plot__num) {
		font-family: var(--rt-font-display), sans-serif;
		font-size: 10.5px;
		font-weight: 700;
		line-height: 1;
		color: var(--rt-yellow, #ffd700);
		pointer-events: none;
		text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.9);
	}
	/* The plot-pin STATUS BULBS (rose −, teal +, red dot) live in their own
	   component — StatusDots.svelte (imported in the host so its :global CSS ships
	   with this route). The map pin emits StatusDots' class contract via innerHTML
	   (pinMarkers.ts); sync() toggles --under/--over/--fault on the button. No badge
	   CSS here — it's all in StatusDots. */
	/* SELECTED plot marker (popover open) → gold "Plot N" pill + a dotted connector
	   tail dropping toward the popover below it, so the pin and its popover read as
	   one linked thing. */
	:global(.map-pin-marker.map-pin-plot.map-pin-plot--selected) {
		background: linear-gradient(180deg, var(--rt-gold-1, #f5d565) 0%, var(--rt-gold-2, #e8b923) 100%);
		border-color: var(--rt-gold-1, #f5d565);
		padding: 3px 10px;
		box-shadow:
			0 3px 10px rgba(0, 0, 0, 0.5),
			0 0 0 3px rgba(240, 192, 64, 0.22);
	}
	:global(.map-pin-plot--selected .map-pin-plot__num) {
		color: #2e2206;
		font-size: 13px;
		text-shadow: none;
	}
	/* Dotted leader: a vertical run of dots from the pill's bottom edge down toward
	   the popover. Centered under the pill; pointer-transparent. */
	:global(.map-pin-plot--selected::after) {
		content: "";
		position: absolute;
		top: 100%;
		left: 50%;
		transform: translateX(-50%);
		width: 3px;
		height: 60px;
		background-image: radial-gradient(circle, var(--rt-gold-1, #f5d565) 1.4px, transparent 1.6px);
		background-size: 3px 9px;
		background-repeat: repeat-y;
		pointer-events: none;
	}

	/* ── COINCIDENT-PLOT STACKS (spiderfy — pinMarkers.layoutStacks) ─────────
	   Plots thrown on the exact same spot collapse into ONE representative
	   plaque wearing a count chip; the rest hide until the fan opens. */
	:global(.map-pin-plot--stack-hidden) {
		display: none;
	}
	/* The count chip — gold coin on the plaque's shoulder, same voice as the
	   cluster bubble's count. */
	:global(.map-pin-plot__stackn) {
		position: absolute;
		top: -9px;
		right: -11px;
		min-width: 14px;
		height: 14px;
		padding: 0 3px;
		border-radius: 999px;
		background: var(--rt-yellow, #ffd700);
		color: #1a1a1a;
		font-size: 9.5px;
		font-weight: 800;
		line-height: 14px;
		text-align: center;
		box-shadow: 0 0 0 1.5px #1a1a1a;
		pointer-events: none;
	}
	/* The leader leg on a fanned plaque — a thin gold line from the plaque's
	   tip back to the true spot (rotation + length set inline by
	   pinMarkers.setStackLeg). Top-anchored at the plaque's bottom-center. */
	:global(.map-pin-stack-leg) {
		position: absolute;
		top: 100%;
		left: 50%;
		width: 2px;
		margin-left: -1px;
		transform-origin: top center;
		background: linear-gradient(
			180deg,
			var(--rt-yellow, #ffd700) 0%,
			rgba(240, 192, 64, 0.25) 100%
		);
		pointer-events: none;
	}
	/* Fanned plaques ride above neighbouring markers so the fan reads as one
	   opened hand, legs underneath. */
	:global(.map-pin-marker.map-pin-plot--stack-out) {
		z-index: 3;
	}
</style>
