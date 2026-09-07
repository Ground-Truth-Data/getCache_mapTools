/**
 * fireLayer.ts — wildfire hotspots on the ONLINE map (/mobile/map).
 *
 * ── Why this exists separately from the offline map's copy ──
 * The offline viewer (/mobile/offlinev4) paints fires from IndexedDB, because
 * out there the whole point is having them without signal. THIS map is the one
 * users actually open, and it had no fire layer at all — which is why "I've
 * never seen a single fire" was a completely accurate report while every
 * server-side test passed.
 *
 * It reads the SAME cache the bake service fills, then refreshes from the
 * Worker if that cache is empty or stale. So the two maps never disagree, and
 * this one still works with no signal (cache-first, network-second).
 *
 * ── ALWAYS ON. No toggle. ──
 * The user's ruling, and it is a safety call rather than a preference: "it's not
 * even default you can't turn them off if there's fires they need to know." An
 * opt-in hazard layer is one a planter discovers the day AFTER they needed it.
 * Restraint comes from clustering and muted styling, never from hiding.
 *
 * Lives in ReTreever/src (proprietary) rather than the harness: the harness components are
 * UI-only shells and must never carry data fetching or storage (the open-core
 * rule). It attaches via the `onMapReady` hook the harness already exposes.
 */
import type * as mapboxgl from "mapbox-gl";
import { popupCtor } from "$parent/siblings/getCache_OfflineMap/lib/shared/rendererOf";

/**
 * The map type this file works against.
 *
 * ⚠️ It is `any`, and that is a deliberate, narrow choice — read before
 * "fixing" it. This layer attaches to BOTH renderers: the online map
 * (/mobile/map) is Mapbox, the offline map (/mobile/offlinev4) is MapLibre.
 * Their `Map` classes are structurally near-identical for everything used here
 * (addSource/addLayer/getSource/getCenter/on/off/hasImage/addImage), but
 * nominally distinct, so a Mapbox-typed parameter rejects a MapLibre map.
 *
 * The obvious alternatives were tried and do not work:
 *   • `MapboxMap | MaplibreMap` — a call against a union needs one signature
 *     valid for EVERY member, and `on`/`addLayer`/`getSource` are overloaded
 *     differently in each. TypeScript reports "none of those signatures are
 *     compatible with each other" at essentially every call site.
 *   • A structural type — this file touches ~20 map methods across 7 functions,
 *     several with heavy overloads (`addLayer` alone has three). Restating them
 *     accurately for two libraries is more surface to get wrong than it buys.
 *
 * The genuinely divergent calls (`loadImage`, `getClusterLeaves`, `Popup`) are
 * each handled explicitly with a comment naming the divergence, which is where
 * the real safety lives — not in this alias.
 */
// biome-ignore lint/suspicious/noExplicitAny: two renderers, incompatible overload sets — see above
type FireMap = any;
import { kmBetween } from "$parent/siblings/getCache_OfflineMap/lib/shared/kmGeo";
import {
	peekFireArrival,
	settleFireArrival,
} from "$parent/siblings/getCache_OfflineMap/routes/fires/fireArrival";
import {
	classifyPending,
	peekUrbanVerdict,
} from "$parent/siblings/getCache_OfflineMap/routes/fires/fireClassifyCache";
import {
	buildClusterCard,
	buildHotspotCard,
	type CardRow,
} from "$parent/siblings/getCache_OfflineMap/routes/fires/fireHotspotCopy";
import { fireOutlines } from "$parent/siblings/getCache_OfflineMap/routes/fires/fireOutline";
import {
	distKm,
	fireFeatureCollection,
	HARD_CUTOFF_KM,
} from "$parent/siblings/getCache_OfflineMap/routes/fires/fireRelevance";
import type { TrendBand } from "$parent/siblings/getCache_OfflineMap/routes/fires/fireSeverity";
import { FIRE_TRIGGER_KM } from "$parent/siblings/getCache_OfflineMap/lib/shared/liveAnchor";
import {
	peekPlaces,
	setPlacesRegion,
	warmPlaces,
} from "$parent/siblings/getCache_OfflineMap/lib/places/placeIndex";
import { placeReference } from "$parent/siblings/getCache_OfflineMap/lib/places/placeReference";
import { satImageKey } from "$parent/siblings/getCache_OfflineMap/lib/onPhone/satellite/satelliteImage";
import { beginWork } from "$parent/siblings/getCache_OfflineMap/lib/shared/workMeter.svelte";
import {
	loadStaticMask,
	peekStaticMask,
	warmStaticMask,
} from "$parent/siblings/getCache_OfflineMap/routes/fires/masks/staticHeatIndex";
import { isStaticSource } from "$parent/siblings/getCache_OfflineMap/routes/fires/masks/staticHeatSources";
import { isUrban } from "$parent/siblings/getCache_OfflineMap/routes/fires/masks/urbanExclusion";
import {
	loadUrban,
	peekUrban,
	setUrbanRegion,
} from "$parent/siblings/getCache_OfflineMap/routes/fires/masks/urbanIndex";
import {
	FIRE_RADIUS_KM,
	fireCoverage,
	fireEntriesNear,
	hotspotsToGeoJSON,
	isCoverageFresh,
	unionHotspots,
	writeFireCache,
} from "$parent/siblings/getCache_OfflineMap/routes/fires/fireCache";
import { fetchAreaFires } from "$parent/siblings/getCache_OfflineMap/lib/worker/worker-local-dev/fires/fireFetch";
import { createMapStore } from "$lib/mobile/stores/mapStore.svelte";
import { overlayVisibility } from "$parent/siblings/getCache_OfflineMap/lib/mapState/overlayVisibility.svelte";
import { vlog } from "$lib/mobile/utils/verboseLog";
import { fireFollowsCamera, fireOrigins } from "./fireOrigins";

/**
 * ── ONE ATTACH, BOTH MAPS ──
 *
 * The layer ids differ per map (`rt-fire-*` online, `v4-fire-*` offline) purely
 * for history: the offline map's ids are baked into its layer-toggle registry.
 * Everything ELSE — paint, glyph, clustering, the tap card — is identical and
 * must stay that way, so it is defined once here and the ids are a parameter.
 *
 * This is the second half of the fix that started with `fireFeatureCollection`.
 * That unified the DATA; the offline map still hand-rolled its own LAYERS, so
 * it drew bare numbered circles with no flame and no tap card while the online
 * map had all three. Same disease, one layer up: presentation living in two
 * files means every visual decision has to be remembered twice.
 */
export interface FireLayerIds {
	readonly src: string;
	readonly cluster: string;
	/** The flame INSIDE a cluster circle. */
	readonly clusterIcon: string;
	/** Flame glyph over a LONE hotspot, so a single fire reads as the same thing
	 *  a cluster does — one visual language, not dots-vs-flames. */
	readonly flame: string;
	/** Thin red line around each group of detections — see fireOutline.ts. */
	readonly outlineSrc: string;
	readonly outline: string;
}

export const ONLINE_FIRE_IDS: FireLayerIds = {
	src: "rt-fire-geo",
	cluster: "rt-fire-cluster",
	clusterIcon: "rt-fire-cluster-count",
	flame: "rt-fire-flame-single",
	outlineSrc: "rt-fire-outline-geo",
	outline: "rt-fire-outline",
};

/** The offline viewer's ids — pinned by its LAYER_TOGGLES registry. */
export const OFFLINE_FIRE_IDS: FireLayerIds = {
	src: "v4-fire-geo",
	cluster: "v4-fire-cluster",
	clusterIcon: "v4-fire-cluster-count",
	flame: "v4-fire-flame-single",
	outlineSrc: "v4-fire-outline-geo",
	outline: "v4-fire-outline",
};

/**
 * Zoom at which fire outlines appear.
 *
 * ⛔ THIS IS A TREE-PLANTING APP. The outline is the single most "fire app"
 * looking thing on the map, so it gets the strictest gate of anything here.
 *
 * ⚠️ Set to `clusterMaxZoom` (11) first, on the reasoning that the line should
 * appear as soon as individual flames do. Wrong in practice: at z11 you are
 * still looking at a whole region, and a screen of scattered red polygons over
 * ground the user is not standing on reads as pollution — *"I'm zoomed out and
 * the site's polluted with these polygons"*.
 *
 * 13 is block scale — a few kilometres across, where the user is looking AT one
 * fire rather than surveying a province. That is the only zoom at which "the
 * fire is inside this line and not outside it" is a question they are actually
 * asking. Above it the flames and clusters already carry the warning.
 *
 * Nothing is lost by waiting: a fire big enough to matter still shows its dots
 * and its cluster circle at every zoom. Only the outline waits.
 */
const OUTLINE_MIN_ZOOM = 13;

/** CONTEXT accent (--palette-terracotta). Never red: in this design system red
 *  means a destructive action (the ghost/dismiss colour law), and a hotspot is
 *  information, not a button. */
const FIRE_DOT = "#b36940";
/** The hot end of the intensity ramp — terracotta-hint, an existing token.
 *  Still NOT red: red is reserved for destructive actions here. Severity is
 *  expressed as a warmer/brighter step within the same family. */
const FIRE_HOT = "#d18a5e";

/**
 * ⛔ HISTORICAL NOTE — no text layer here any more, keep it that way carelessly
 * at your peril.
 *
 * This map's glyphs come from api.mapbox.com; the offline map serves its own
 * from `/mobileAssets/worldBase/glyphs/…` and uses "Noto Sans Regular", which does NOT exist
 * upstream. Asking for it 404s every glyph range — and a symbol layer whose
 * glyphs never arrive STALLS the source it is attached to. The symptom is
 * maximally misleading: the source reports 16,717 features and
 * `isSourceLoaded: true`, yet `querySourceFeatures` returns 0 and NOTHING in
 * the whole source draws — including circle layers, which need no font at all.
 * No map `error` event is emitted either. That is exactly why this layer
 * painted perfectly offline and was invisible online for a whole session.
 *
 * The cluster count label that needed a font has since been removed, so there
 * is no `text-font` left. If you ever add text back, use the stack from
 * `mapInit.ts` / `mapDraw.ts` ("DIN Pro Medium", "Arial Unicode MS Bold") —
 * NEVER copy the offline map's font across.
 */

/** The map store, read for fire ANCHORS (which ground the user has a stake in).
 *  Module-scope `createMapStore()` is the established pattern here — the same
 *  shape `offlineBakeService` uses; every instance mirrors the one TinyBase
 *  store, so this is a view onto shared state, not a second copy of it. */
const mapStore = createMapStore();

/**
 * When we last pinged NASA for the fires on screen — the NEWEST contributing
 * `fetchedAt`, written at paint and read by the tap cards.
 *
 * NEWEST, not oldest: this row answers "when did we last go and look?", and we
 * genuinely did look at that moment. (The layer-wide staleness stamp uses the
 * OLDEST for the opposite reason — it must describe the weakest data on screen.
 * Two different questions, two different aggregations, on purpose.)
 */
let lastPingedAt: number | null = null;

const FIRE_ICON = "rt-fire-flame";
const FIRE_ICON_URL = "/mobileAssets/fire_icon.webp";

/**
 * Load the flame sprite once per style.
 *
 * ⚠️ Since the bare-dot fallback layer was deleted (one detection, one flame),
 * single detections have NOTHING to fall back to: if this image fails, they do
 * not render. Cluster circles still draw, so the layer never disappears
 * entirely, but a failure here is now genuinely load-bearing rather than
 * cosmetic — hence the loud warn. That is the accepted trade for killing the
 * icon-substitution logic, which was failing visibly and constantly; this fails
 * only when a same-origin bundled asset 404s.
 */
function ensureFireIcon(map: FireMap, isLive: () => boolean): void {
	if (map.hasImage(FIRE_ICON)) return;

	// ⚠️ TWO RENDERERS, TWO `loadImage` SHAPES. This runs on the online map
	// (Mapbox) AND the offline map (/mobile/offlinev4, MapLibre):
	//   Mapbox 3.24   loadImage(url, callback): void           (mapbox-gl.d.ts:20590)
	//   MapLibre 5.16 loadImage(url): Promise<GetResourceResponse<…>>  (:12236)
	// MapLibre dropped the callback in v4. It does not throw when you pass one —
	// it IGNORES it, so the callback never fires and the flame icon never loads,
	// silently. Per the note above, that means single detections do not render
	// at all. MapLibre also resolves a WRAPPER: the image is on `.data`.
	//
	// The `isLive()` guard applies to BOTH paths: the load is async either way,
	// so completion can land on a map that has since been removed, and
	// `hasImage`/`addImage` on a destroyed map throw the same `getOwnSource`-class
	// TypeError as `getSource` (map.remove() nulls the style out from under them).
	// Same law as `paint` — only the caller's disposed flag can answer this.
	const loaded = (img: unknown): void => {
		if (!isLive()) return;
		if (!img) {
			console.warn(
				"[fire] flame icon failed to load — single detections will NOT render (clusters still will)",
			);
			return;
		}
		// biome-ignore lint/suspicious/noExplicitAny: image type differs per renderer
		if (!map.hasImage(FIRE_ICON)) map.addImage(FIRE_ICON, img as any);
	};
	const failed = (err: unknown): void => {
		if (!isLive()) return;
		console.warn(
			"[fire] flame icon failed to load — single detections will NOT render (clusters still will)",
			err,
		);
	};

	const ret = (
		map as unknown as {
			loadImage: (
				url: string,
				cb?: (err: unknown, img: unknown) => void,
			) => Promise<{ data: unknown }> | void;
		}
	).loadImage(FIRE_ICON_URL, (err, img) => {
		if (err) failed(err);
		else loaded(img);
	});
	// MapLibre returned a promise and ignored the callback — drive it instead.
	if (ret && typeof (ret as Promise<unknown>).then === "function") {
		void (ret as Promise<{ data: unknown }>).then((r) => loaded(r?.data), failed);
	}
}

/** Add the source + layers once. Safe to call repeatedly (style reloads drop
 *  everything, so callers re-invoke on `style.load`). */
function addFireLayers(
	map: FireMap,
	ids: FireLayerIds,
	isLive: () => boolean = () => true,
): void {
	ensureFireIcon(map, isLive);
	if (map.getSource(ids.src)) return;

	// ── THE OUTLINE — a thin red line around each group of detections ──
	//
	// Added FIRST so it sits UNDER the flames: the dots are the primary mark and
	// the line is a reading aid for them, never a replacement. Its own source
	// because it is polygons, not points, and must never be clustered.
	map.addSource(ids.outlineSrc, {
		type: "geojson",
		data: { type: "FeatureCollection", features: [] },
	});
	map.addLayer({
		id: ids.outline,
		type: "line",
		source: ids.outlineSrc,
		// ⛔ ZOOMED OUT, THE OUTLINES GO AWAY. This is not a fire app.
		//
		// At regional zoom the clusters have already collapsed a province into a
		// handful of counted blobs — that is the restraint the whole layer relies
		// on. The outlines do NOT collapse: they stay one shape per fire, so at z8
		// they become dozens of red specks scattered across the map, reading as
		// clutter and prompting the obvious "why is there no fire pin there?".
		//
		// The line only means something when you can see the dots it encloses, so
		// it appears at the zoom where singles take over from clusters
		// (`clusterMaxZoom: 11`) and is absent above it. Nothing is lost: the
		// cluster circle is already saying "fire here" at those zooms.
		minzoom: OUTLINE_MIN_ZOOM,
		layout: { "line-join": "round", "line-cap": "round" },
		paint: {
			// ⚠️ RED here is deliberate and is the ONE place this layer uses it.
			// The ghost/dismiss colour law reserves red for destructive ACTIONS —
			// buttons. This is not a control; it is the convention every wildfire
			// agency draws a fire boundary in (BC Wildfire's own map included), and
			// matching it is what makes the shape legible at a glance.
			"line-color": "#d9422b",
			// Thin and unfilled: a pencil line, not a hazard zone. A filled shape
			// would read as a surveyed perimeter, which this is NOT — it is a hull
			// around satellite pixels. See fireOutline.ts.
			"line-width": [
				"interpolate",
				["linear"],
				["zoom"],
				6,
				0.8,
				10,
				1.2,
				14,
				1.6,
			],
			// Fade IN across one zoom level rather than popping into existence —
			// a shape that appears instantly reads as a glitch.
			"line-opacity": [
				"interpolate",
				["linear"],
				["zoom"],
				OUTLINE_MIN_ZOOM,
				0,
				OUTLINE_MIN_ZOOM + 1,
				0.85,
			],
		},
	});

	map.addSource(ids.src, {
		type: "geojson",
		data: { type: "FeatureCollection", features: [] },
		cluster: true,
		clusterRadius: 50,
		clusterMaxZoom: 11,
		// Clusters don't inherit properties — they must be AGGREGATED explicitly.
		// Max, never a sum:
		//   maxFrp — colour/intensity tracks the single WORST fire inside, never
		//          an average or total. Merging many mild fires must NOT make a
		//          cluster read as an inferno; that would be the map lying.
		//
		// (`prom` was aggregated here too, for the distance fade. The fade is gone
		// — see "NO DISTANCE FADE" on the flame layer — so nothing reads it.)
		clusterProperties: {
			// Industrial FRP is excluded from the cluster's heat: a flare stack
			// burning at a steady 40 MW must not colour the wildfire beside it.
			maxFrp: [
				"max",
				[
					"case",
					["==", ["coalesce", ["get", "ind"], 0], 1],
					0,
					["coalesce", ["get", "frp"], 0],
				],
			],
			// How many members are industrial — lets a cluster that is ENTIRELY
			// industrial dim itself rather than masquerade as a fire.
			indCount: ["+", ["coalesce", ["get", "ind"], 0]],
		},
	});

	// Clusters: gentle growth with count. A big cluster should read as "a lot
	// over there", NOT as a hazard banner covering the block.
	//
	// The ramp used to top out at 24 px with 0.72 opacity, which at regional
	// zoom produced 7.2k / 4.9k blobs that swallowed whole valleys — the map
	// read as a fire app rather than a planting app. Capped at 15 px and
	// dropped to 0.55: still obviously "a lot over there", but terrain, roads
	// and the user's own pins now read straight through. The COUNT carries the
	// magnitude; the circle does not have to shout it too.
	map.addLayer({
		id: ids.cluster,
		type: "circle",
		source: ids.src,
		filter: ["has", "point_count"],
		paint: {
			// Colour = the WORST fire inside, never a sum. A cluster of many mild
			// fires stays muted terracotta; one genuine monster brightens it even
			// if it's alone. Merging must never invent severity.
			"circle-color": [
				"interpolate",
				["linear"],
				["coalesce", ["get", "maxFrp"], 0],
				0,
				FIRE_DOT,
				200,
				FIRE_HOT,
			],
			// ⛔ NO DISTANCE FADE and NO AGE FADE — the ONLY thing that dims a
			// cluster is every one of its members being an industrial heat source,
			// which is a different KIND of thing rather than a lesser fire. It
			// stays visible and tappable (flag, never delete).
			"circle-opacity": [
				"case",
				[">=", ["coalesce", ["get", "indCount"], 0], ["get", "point_count"]],
				0.2,
				0.5,
			],
			"circle-radius": [
				"step",
				["get", "point_count"],
				9,
				25,
				11,
				100,
				13,
				500,
				16,
			],
			"circle-stroke-width": 1,
			"circle-stroke-color": "rgba(0,0,0,0.3)",
			"circle-stroke-opacity": 1,
		},
	});

	// The flame sits INSIDE the circle. The circle (the "halo") is what marks
	// this as a CLUSTER — a single detection deliberately has none, so the two
	// are distinguishable at a glance without reading anything.
	//
	// NO COUNT LABEL. It was tried and cut: the exact number of satellite pixels
	// in a blob is not a fact anyone acts on, and printing "1.8k" next to a
	// flame reads as scale-of-disaster when it's really scale-of-sampling. The
	// circle's size carries "how much", and tapping gives the real aggregate.
	map.addLayer({
		id: ids.clusterIcon,
		type: "symbol",
		source: ids.src,
		filter: ["has", "point_count"],
		layout: {
			"icon-image": FIRE_ICON,
			// Small enough to sit INSIDE the backing circle rather than cover it —
			// the circle is doing the magnitude work (size + intensity colour),
			// and a flame that hides it wastes both.
			"icon-size": [
				"interpolate",
				["linear"],
				["get", "point_count"],
				2,
				0.075,
				50,
				0.095,
				500,
				0.12,
			],
			"icon-allow-overlap": true,
			"icon-ignore-placement": true,
		},
		paint: {
			// ⛔ NO DISTANCE FADE — see the note on the single flame below.
			"icon-opacity": 1,
		},
	});

	// ── ONE MARK PER DETECTION: the flame. There is no second icon. ──
	//
	// A `circle` layer used to draw single detections below z8, handing over to
	// the flame above it. That was a zoom SEAM between two icons for one thing,
	// and it leaked exactly where you would expect: a hotspot too isolated to
	// join a cluster sat below the seam and rendered as a bare orange dot beside
	// proper flames, then "got its icon back" a zoom level later.
	//
	// The fix is not better seam arithmetic — it is deleting the seam. Any logic
	// that decides WHICH icon a detection gets is logic that can decide wrong,
	// and there is no reading of this layer where a plain dot is the right
	// answer. One detection, one flame, at every zoom.
	//
	// (The old dot's justification was density at regional zoom. Clustering
	// already does that job: below z11 detections collapse into counted blobs,
	// so a "field of tiny flames" was never what the alternative looked like.)
	map.addLayer({
		id: ids.flame,
		type: "symbol",
		source: ids.src,
		filter: ["!", ["has", "point_count"]],
		// NO minzoom. A zoom-gated icon is an icon that disappears, and whatever
		// fills the gap becomes a second mark for the same thing — which is the
		// bug this layer was just rebuilt to delete.
		layout: {
			"icon-image": FIRE_ICON,
			// Smaller when zoomed out so a scatter of singles stays quiet, but it
			// is always the SAME glyph — size is the restraint, never substitution.
			"icon-size": [
				"interpolate",
				["linear"],
				["zoom"],
				4,
				0.035,
				8,
				0.05,
				14,
				0.08,
			],
			"icon-allow-overlap": true,
			"icon-ignore-placement": true,
		},
		paint: {
			// ⛔ A LONE FLAME IS NEVER FADED. Not by distance, and NOT BY AGE.
			//
			// Two fades were deleted here, for the SAME reason, and the second one
			// took a second telling because the first fix left it standing:
			//
			//   1. DISTANCE (`prom`) — gone. Anchors broke the "far = less
			//      important" equivalence: fires around a pinned block rendered at
			//      ~0.3 while fires by the live fix sat at 1.0, so the same hazard
			//      looked like two different things depending on which anchor
			//      qualified it.
			//   2. AGE (`ageH` step ramp, 0.95 → 0.35 past 24 h) — gone now. Same
			//      disease, different variable. In the field it produced a screen
			//      of nearly-invisible smudges: *"why are they faded? should I just
			//      keep saying it?"* — asked twice, because deleting the first fade
			//      and leaving the second one meant nothing visibly changed.
			//
			// THE RULE: **a hotspot either passed the gate and IS a fire, or it is
			// not on the map at all.** There is no third state where it is a fire
			// we half-mean. Once drawn, it is drawn at full strength.
			//
			// Both facts already have an honest home in WORDS on the tap card —
			// `From you — 80 km E` and `Last detected — 23h ago`. Encoding them a
			// second time in opacity buys nothing and costs the only thing that
			// matters outdoors: legibility on a bright screen in sun, against
			// satellite imagery that is itself green-brown. A 14 ha flame is
			// already ~20 px; at 0.35 opacity it is gone.
			//
			// ⚠️ If a fire is too old to be worth showing, the answer is to STOP
			// SHOWING IT (drop it from the data — see the stale-disc rule), never
			// to draw a ghost of it. Whispering is not a substitute for deciding.
			//
			// The INDUSTRIAL dim stays, and is the one sanctioned exception: it
			// does not mean "less fire", it means a categorically different thing —
			// a permanent heat source that is not a wildfire at all, spelled out on
			// the card as `Source — Industrial heat source`.
			"icon-opacity": [
				"case",
				["==", ["coalesce", ["get", "ind"], 0], 1],
				0.35,
				1,
			],
		},
	});
}

/** Push whatever is cached onto the map. Returns how many hotspots painted. */
/**
 * METERED WRAPPER — every caller goes through here so the WORK panel counts
 * fire paints without touching `paintInner`'s body. Cost is two Date.now()
 * calls per paint; the real work is unchanged.
 */
async function paint(
	map: FireMap,
	ids: FireLayerIds,
	isLive: () => boolean = () => true,
): Promise<number> {
	const done = beginWork("fire paint");
	try {
		return await paintInner(map, ids, isLive);
	} catch (err) {
		done(true);
		throw err;
	} finally {
		done(); // no-op if the catch above already closed it
	}
}

async function paintInner(
	map: FireMap,
	ids: FireLayerIds,
	/** The attach's `disposed` flag, inverted — see `refineUrban`.
	 *
	 *  ⚠️ THIS FUNCTION IS NOT SYNCHRONOUS, whatever an older comment here
	 *  claimed. It awaits the IndexedDB read below, and a route change during
	 *  that await destroys the map — so the `getSource` guard taken on entry is
	 *  STALE by the time the second half runs. That is the real crash users saw:
	 *
	 *    TypeError: Cannot read properties of undefined (reading 'getOwnSource')
	 *      at paint (fireLayer.ts) → at async ensure (fireLayer.ts)
	 *
	 *  `map.remove()` calls `setStyle(null)`, and `getSource` then dereferences
	 *  `this.style` unguarded — so ASKING A DEAD MAP whether it still has a
	 *  source is itself the thing that throws. A guard that needs a live map to
	 *  report a dead one is not a guard; only `isLive` can answer this. */
	isLive: () => boolean = () => true,
): Promise<number> {
	if (!isLive()) return 0;
	const src = map.getSource(ids.src) as mapboxgl.GeoJSONSource | undefined;
	if (!src) return 0;
	// ORIGINS FIRST, so the read itself can skip discs that could never render.
	// Computing them here (rather than after the await, where they used to live)
	// is what lets `fireEntriesNear` leave far-field hotspots on disk: past
	// HARD_CUTOFF_KM they are discarded downstream anyway, so materialising them
	// was pure heap. Reading every disc measured 616 MB / 90% of the allocation
	// profile — see the note on `allFireEntries`.
	const c0 = map.getCenter();
	const origin = fireOrigins([c0.lng, c0.lat], mapStore.allMaps);
	const entries = await fireEntriesNear(origin, HARD_CUTOFF_KM);
	// RE-CHECK AFTER THE AWAIT — the map may have been torn down mid-read. Every
	// `map.*` call below this line depends on it.
	if (!isLive()) return 0;
	const { hotspots: all } = unionHotspots(entries);
	lastPingedAt = entries.length
		? entries.reduce((m, e) => Math.max(m, e.fetchedAt), 0)
		: null;
	// ⛔ THE WALL. Relevance is measured from your ANCHORS — where you are, plus
	// the ground you have touched recently — never from the screen box. At
	// continental zoom the screen IS the continent, which is why the earlier
	// viewport filter changed nothing. Past 500 km from every anchor: nothing,
	// at any size. See fireRelevance.ts and fireOrigins.ts.
	//
	// The map centre is only a LAST-RESORT fallback (no fix, no features); real
	// anchors always win, so panning the camera to Manitoba never drags the
	// layer along — but creating a feature there does, which is the point.
	// (`origin` is computed above, before the read — it now gates the read too.)
	// ONE shared builder for both maps — wall, age, prominence and the industrial
	// flag all live in fireRelevance.ts. Do not stamp properties here; that split
	// is exactly how the two maps drifted apart.
	const { fc, shown } = fireFeatureCollection({
		hotspots: all,
		origin,
		now: Date.now(),
		staticMask: peekStaticMask(),
		hidden: !overlayVisibility.fires,
		toGeoJSON: hotspotsToGeoJSON,
		isStatic: isStaticSource,
		// City rule: a hotspot in the built-up basin is industrial heat, not a
		// wildfire.
		//
		// ⚠️ READS A CACHE, never computes. `isUrban` scans 11,878 polygons —
		// measured at 17.8 ms per 1,000 hotspots, i.e. ~200 ms of blocked main
		// thread on a normal paint, on EVERY pan. Fires are an afterthought and
		// must never cost the map a frame, so paint uses only what is already
		// known and the unknowns are classified afterwards, off the critical
		// path (see `refineUrban` below).
		//
		// Unknown → NOT urban → the hotspot renders. Failing toward SHOWING is
		// the right direction for a hazard layer: a city dot that disappears a
		// moment later is a blink, a suppressed real fire is the failure this
		// layer exists to prevent.
		isUrban: (lng, lat) => peekUrbanVerdict(lng, lat) === true,
	});
	// Plain JSON across the GL worker boundary — $state proxies corrupt the
	// transfer and make features silently vanish (mapbox-boundary law).
	src.setData(JSON.parse(JSON.stringify(fc)) as GeoJSON.FeatureCollection);

	// THE OUTLINE, from the SAME `shown` list the dots come from — so the line
	// can never disagree with the flames inside it.
	//
	// ⚠️ `paint()` IS THE PAN PATH (moveend → ensure → paint), so this runs on
	// every pan, not once per data change. An earlier version of this comment
	// claimed "panning never recomputes it" — it was describing an intention, not
	// the code, and the ~52 ms hull rebuild was landing on every pan gesture.
	// `fireOutlines` now memoizes on the CELL SET, which is what makes the claim
	// actually true; do not delete that memo on the strength of this comment.
	//
	// Measured on a real 500 km disc in BC fire season: 36,489 detections →
	// 12,197 cells → 142 outlines, ~52 ms. Skipped entirely when the layer is
	// hidden, since `shown` is empty then.
	const outlineSrc = map.getSource(ids.outlineSrc) as
		| mapboxgl.GeoJSONSource
		| undefined;
	if (outlineSrc) {
		// No defensive clone here, unlike `fc` above, and the difference is real
		// rather than an oversight: `fireOutlines` constructs its rings from raw
		// numbers, so no `$state` proxy can reach this object and there is nothing
		// for the GL worker boundary to choke on (mapbox-boundary law). Cloning a
		// MEMOIZED value on every pan would also re-serialize ~16 KB to hand back
		// the same bytes — precisely the waste the memo was added to remove.
		// `all` is the MEMO KEY, not the data — the outlines are still built from
		// `shown`, so the line can never disagree with the flames inside it.
		//
		// ⚠️ `shown` cannot be its own key: it comes out of a `.filter()`, so it is
		// a new array on every pan even when nothing changed, and the memo would
		// never hit. `all` is `unionHotspots().hotspots`, which IS memoized and
		// stays reference-stable until the fire cache actually changes — which is
		// exactly when the outlines should be rebuilt.
		outlineSrc.setData(fireOutlines(shown, all));
	}
	// Learn the rest in the background, then repaint ONCE if anything changed.
	// Deliberately not awaited — the map is already drawn by this point.
	void refineUrban(map, ids, all, isLive);
	return shown.length;
}

/**
 * Classify the hotspots paint didn't know about, in frame-sized slices, then
 * repaint once.
 *
 * This is what makes the city rule free at paint time. It runs after the map is
 * on screen, yields between slices so scrolling stays smooth, and only triggers
 * a repaint when it actually learned something — so panning over ground it has
 * already seen costs nothing at all.
 *
 * ⚠️ `isLive` is REQUIRED, and it must be the caller's `disposed` flag — not a
 * probe of the map itself.
 *
 * This function is fire-and-forget and deliberately outlives its own paint: it
 * awaits between classify slices, so leaving /mobile/map mid-run resumes it on a
 * map that no longer exists. `map.getSource()` cannot be that check, because
 * `map.remove()` calls `setStyle(null)` and `getSource` dereferences
 * `this.style` unguarded — asking a destroyed map whether it still has a source
 * throws `Cannot read properties of undefined (reading 'getOwnSource')` as an
 * unhandled rejection. A guard that needs a live map to report a dead one is
 * not a guard. Every other async path in this file already checks `disposed`;
 * this one is no exception.
 */
let refining = false;
async function refineUrban(
	map: FireMap,
	ids: FireLayerIds,
	hotspots: readonly { coordinates: readonly [number, number] }[],
	isLive: () => boolean,
): Promise<void> {
	if (refining || !isLive()) return;
	const polys = peekUrban();
	// No polygons yet — `warmUrban()` is in flight and its .then() repaints.
	if (polys.length === 0) return;
	refining = true;
	try {
		const learned = await classifyPending(
			hotspots.map((h) => h.coordinates),
			(lng, lat) => isUrban(lng, lat, polys),
		);
		// Re-check AFTER the await: the map can be torn down at any slice
		// boundary, and this is the exact window the crash lived in.
		if (!isLive()) return;
		// Only repaint when a verdict actually changed, or every pan would
		// re-enter paint forever.
		if (learned && map.getSource(ids.src)) await paint(map, ids, isLive);
	} finally {
		refining = false;
	}
}

/** Escape before interpolating into the popup's HTML. Every value here comes
 *  from our own copy module or a parsed number, but the popup is built by string
 *  concatenation, so this is the boundary where that assumption gets enforced
 *  rather than assumed. */
function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * The tap card.
 *
 * Order is meaning: what it is → where/when → how strong → THEN the caveat,
 * before the reader has finished forming a conclusion. The caveat is not fine
 * print at the bottom of a wall of numbers; it is the line that decides whether
 * someone reads an orange dot as "a refinery" or "run".
 */
function hotspotPopupHtml(
	props: Record<string, unknown>,
	coordinates: [number, number],
	where: string | null,
	/** The anchor to measure "42 km NE" FROM — the nearest one, so the number
	 *  describes the fire's distance from the ground you care about rather than
	 *  from a phone that may be a province away. */
	from: readonly [number, number] | null,
): string {
	const card = buildHotspotCard(
		{
			coordinates,
			t: Number(props.t),
			frp: Number(props.frp),
			px: Number.isFinite(Number(props.px)) ? Number(props.px) : undefined,
		},
		from,
		Date.now(),
		where,
		Number(props.ind) === 1,
		lastPingedAt,
	);
	return cardHtml(card.title, card.rows);
}

/**
 * Popup options shared by the single-detection and cluster cards.
 *
 * Defined ONCE because these two cards are the same object with different
 * contents — the last time an option lived at both call sites they drifted, and
 * a card that points at its fire on one path and covers it on the other is the
 * same "two implementations" disease this file exists to cure.
 *
 * ── Why the offset, and the dotted trail ──
 * With no offset Mapbox centres the card ON the point, so the card hid the very
 * mark the user tapped: they lose the thing they were asking about at the moment
 * they ask. The card now sits clear of the fire and a DOTTED TRAIL ties the two
 * together — the same device the pin popover uses (`.rt-fmp-leader` in
 * MapPopoverShell.svelte), so "this card belongs to that mark" looks the same
 * everywhere on the map. The trail itself is CSS (`.rt-fire-popup::after`).
 *
 * `anchor` is deliberately NOT set: Mapbox flips the card below/beside the point
 * on its own when there isn't room above, and hard-coding "bottom" would push it
 * off-screen for a fire near the top edge. The offset is a POINT-MAP so every
 * anchor Mapbox may choose gets a matching trail length.
 *
 * ⚠️ The DIAGONAL offsets are deliberately ~0 (not 11px like the straight ones).
 * A diagonal anchor puts the card's CORNER nearest the mark, and a trail from a
 * corner would have to run at 45° — which a repeating-gradient can't do, so the
 * CSS draws none. Keeping the diagonal gap at zero means the corner already sits
 * on the glyph and no trail is needed to bridge it: the card never floats
 * unexplained. Straight anchors (the overwhelmingly common case) get the full
 * gap and a real trail.
 */
const FIRE_POPUP_OFFSET = 16;
// NOT `as const`: Mapbox's Offset wants mutable [number, number] tuples, and a
// readonly tuple is not assignable to PointLike.
const firePopupOptions: mapboxgl.PopupOptions = {
	closeButton: true,
	maxWidth: "280px",
	className: "rt-fire-popup",
	// Push the card clear of the glyph in whichever direction Mapbox anchors it.
	// Diagonals stay tight (see the ⚠️ above): no gap to bridge, so no trail.
	offset: {
		top: [0, FIRE_POPUP_OFFSET],
		bottom: [0, -FIRE_POPUP_OFFSET],
		left: [FIRE_POPUP_OFFSET, 0],
		right: [-FIRE_POPUP_OFFSET, 0],
		"top-left": [2, 2],
		"top-right": [-2, 2],
		"bottom-left": [2, -2],
		"bottom-right": [-2, -2],
		center: [0, 0],
	},
};

/**
 * Make the card's ✕ close on the FIRST tap.
 *
 * ── The bug ──
 * Mapbox binds its close button with `button.addEventListener("click", ...)`
 * and then calls `_focusFirstElement()` as the popup opens (mapbox-gl 3.24.0,
 * dist/mapbox-gl-dev.js:110185-110188). That focus call lands on the close
 * button itself. On the iOS WebView the first touch on a control that has just
 * been programmatically focused is consumed as a focus/scroll-into-view
 * gesture — `click` is never synthesised. The second tap works because focus
 * has settled by then. Result: "the first click never works," every time.
 *
 * ── The fix ──
 * Bind `pointerup` ourselves. Pointer events are delivered directly from the
 * input pipeline and are NOT subject to the synthesised-click suppression that
 * eats the first tap, so the card closes on touch one. `click` stays bound
 * (Mapbox's own listener) so keyboard Enter/Space still closes the card —
 * `_closedByUs` keeps the double-path from firing the close twice.
 *
 * ⚠️ Do NOT "fix" a regression here by enlarging the button or fiddling with
 * CSS — the hit area is already 44px (see the ::before pad in mobile.css). If
 * the first tap dies again, the cause is event wiring, not size.
 */
function wireCloseButton(popup: FirePopup): void {
	const btn = popup
		.getElement()
		// BOTH namespaces — Mapbox emits `mapboxgl-popup-close-button`, MapLibre
		// emits `maplibregl-popup-close-button`. Querying only the first returns
		// null on the offline map, so the first-tap fix below never wires and the
		// card needs two taps to close (the exact bug this function exists for).
		?.querySelector<HTMLButtonElement>(
			".mapboxgl-popup-close-button, .maplibregl-popup-close-button",
		);
	if (!btn) return;
	// Mapbox focuses this button on open. Blur it: the focus is what breaks the
	// first tap, and a focus ring on a control the user never chose reads as a
	// glitch. Nothing here needs keyboard focus on arrival — the card is a
	// read-only briefing.
	btn.blur();
	let closed = false;
	const close = (e: Event): void => {
		// Guard both directions: pointerup then the synthesised click, or a
		// keyboard activation after a pointer one.
		if (closed) return;
		closed = true;
		e.preventDefault();
		e.stopPropagation();
		popup.remove();
	};
	btn.addEventListener("pointerup", close);
}

/**
 * The anchor a card should measure its distance/bearing FROM: the nearest one
 * to the fire being described.
 *
 * Both cards call this rather than reading the stored fix, because "42 km NE"
 * has to mean 42 km from ground the reader cares about. Measured from a phone
 * in Vancouver, a fire beside their Manitoba block reads "1,900 km E" — true,
 * useless, and it buries the one fact that mattered.
 */
function anchorNearest(
	map: FireMap,
	at: readonly [number, number],
): readonly [number, number] | null {
	const c = map.getCenter();
	const anchors = fireOrigins([c.lng, c.lat], mapStore.allMaps);
	let best: readonly [number, number] | null = null;
	let bestKm = Number.POSITIVE_INFINITY;
	for (const a of anchors) {
		const km = distKm(a, at);
		if (km < bestKm) {
			bestKm = km;
			best = a;
		}
	}
	return best;
}

/**
 * "18 km NE of Whitecourt" for a coordinate, or null.
 *
 * Uses the gazetteer only if it is ALREADY warm — a tap must open instantly, so
 * we never block a popup on a 5 MB fetch. The load is kicked off when the layer
 * attaches, so in practice it is ready long before the first tap; if it isn't,
 * the card simply opens without the line.
 */
function whereFor(at: [number, number]): string | null {
	const places = peekPlaces();
	if (places === null || places.length === 0) return null;
	const ref = placeReference(at, places);
	// Bare coordinates add nothing the map isn't already showing.
	return ref.primary === null ? null : ref.text;
}

/**
 * One renderer for both card kinds — the two must never drift apart visually.
 *
 * Labelled rows, not sentences: someone who only wants "how far is it" jumps
 * straight to the `From you` row instead of reading six lines in order.
 *
 * The Intensity row also draws the ring + trend glyph (see below). The number
 * ("2 of 5") stays beside it, so the graphic is never the only carrier of the
 * value.
 */
function cardHtml(title: string, rows: readonly CardRow[]): string {
	const body = rows
		.map((r) => {
			const glyph =
				r.level === undefined ? "" : intensityGlyph(r.level, r.trend);
			return `<div class="rt-fire-row"><span class="rt-fire-k">${esc(r.label)}</span><span class="rt-fire-v">${esc(r.value)}${glyph}</span></div>`;
		})
		.join("");
	return `<div class="rt-fire-card"><h4>${esc(title)}</h4>${body}</div>`;
}

/**
 * The intensity gauge is a SUPPLIED ARTWORK SET, one file per level.
 *
 * `static/mobileAssets/fire_intensity/{1..5}-fire_intensity.webp` — a ring that
 * fills clockwise and walks gold → orange → red as the level climbs.
 *
 * ⚠️ This REPLACED a hand-drawn SVG ring, and the reason is worth keeping. At
 * level 5 that ring overshot its own start and laid the tail over the head to
 * say "it went all the way round and kept going". On the card it read as a red
 * hat sitting on a circle — a decoration nobody could decode, on the single most
 * serious reading the layer can report. The artwork closes the ring instead.
 *
 * Do not reintroduce a drawn ring beside these. The number ("5 of 5") is still
 * the accessible carrier; the gauge is the at-a-glance echo.
 */
const INTENSITY_ICON_BASE = "/mobileAssets/fire_intensity";

/** Artwork path for a level, clamped to the five that exist. */
export function intensityIconSrc(level: number): string {
	const lvl = Math.min(5, Math.max(1, Math.round(level)));
	return `${INTENSITY_ICON_BASE}/${lvl}-fire_intensity.webp`;
}

/**
 * The trend arrow, drawn BARE — no disc behind it.
 *
 * Sized to ~cap-height of the row's text (18 px box) rather than the 14 px the
 * badge disc allowed: the arrow is the only carrier of direction in the glyph,
 * so it has to be legible on its own. It still must not out-shout the "N of 5"
 * text beside it, which is why it stops at the text's own height.
 *
 * ── Colour: TRUE red and TRUE green, not orange ──
 * The first pass used #e2584a, which reads orange against a warm card — and
 * orange is the fire palette itself, so "growing" blended into the terracotta
 * everything else already uses. Red must be unmistakably red for the direction
 * to register at a glance. This is the ONE sanctioned red in the fire card;
 * elsewhere red still means a destructive action (ghost/dismiss colour law).
 *
 * ⚠️ Red-up / green-down is the classic colourblind confusion pair, flagged
 * deliberately by the designer. It stays because the SHAPE carries direction
 * too (▲ vs ▼) and the Status row spells it out in words directly underneath.
 * The arrow is the at-a-glance echo, never the only carrier — never delete the
 * Status row to "save space".
 *
 * `new` (one observation) renders a muted DOT rather than nothing, so the row
 * doesn't jump when a fire gains its second pass.
 */
const TREND_RED = "#e63329";
const TREND_GREEN = "#3fb95a";

function trendGlyph(trend: TrendBand | undefined): string {
	switch (trend) {
		case "growing":
			return `<svg width="18" height="18" viewBox="0 0 18 18"><polygon points="9,2.5 2,14 16,14" fill="${TREND_RED}"/></svg>`;
		case "quieter":
			return `<svg width="18" height="18" viewBox="0 0 18 18"><polygon points="9,15.5 2,4 16,4" fill="${TREND_GREEN}"/></svg>`;
		case "steady":
			return `<svg width="18" height="18" viewBox="0 0 18 18"><rect x="3" y="8" width="12" height="2.4" rx="1.2" fill="rgba(255,255,255,0.65)"/></svg>`;
		default:
			// "new" and "absent": no direction can be claimed from one reading.
			return `<svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="2.6" fill="rgba(255,255,255,0.4)"/></svg>`;
	}
}

/**
 * The Intensity row's compound glyph: the gauge artwork, then the trend arrow.
 *
 * `aria-hidden` on both — the "N of 5" text beside them is the accessible
 * carrier, and the Status row spells the trend out in words. The graphic is
 * never the only thing saying how bad a fire is.
 */
function intensityGlyph(level: number, trend: TrendBand | undefined): string {
	return (
		`<img class="rt-fire-ring" src="${intensityIconSrc(level)}" alt="" aria-hidden="true" decoding="async"/>` +
		trendBadge(trend)
	);
}

/** The trend arrow — BARE, no circle behind it.
 *
 *  The badge disc was dropped: it added chrome without meaning and shrank the
 *  arrow to the point that direction was hard to read. The arrow now stands
 *  alone at roughly the cap-height of the row's text, which is what the eye
 *  actually needs. */
function trendBadge(trend: TrendBand | undefined): string {
	return `<span class="rt-fire-trend" aria-hidden="true">${trendGlyph(trend)}</span>`;
}

/**
 * Teardown function, plus a `repaint()` the owning component calls when the
 * legend's fire toggle flips (this module is plain TS and has no runes).
 */
export interface FireLayerHandle {
	(): void;
	repaint: () => void;
}

/** Per-map differences. Everything not listed here is deliberately identical. */
export interface AttachFireOptions {
	/** Layer/source ids. Defaults to the online map's. */
	readonly ids?: FireLayerIds;
	/**
	 * May this map fetch from the Worker when the view isn't covered?
	 *
	 * `false` for the offline viewer, which is a pure VIEWER — the app-wide
	 * `offlineBakeService` owns every download, and a second downloader racing it
	 * would double-fetch and fight over the same cache entries.
	 */
	readonly canFetch?: boolean;
	/**
	 * Which library's `Popup` to build the tap card with.
	 *
	 * The online map runs on Mapbox; the offline map (/offline) runs on
	 * MapLibre. Constructing a `mapboxgl.Popup` and calling `.addTo()` on a
	 * MapLibre map THROWS from inside `addTo`:
	 *
	 *     TypeError: _requestDomTask is not a function
	 *
	 * (`_requestDomTask` is a Mapbox-private Map method MapLibre has no
	 * equivalent of — verified against the live /offline map, 2026-08-20.)
	 * An earlier version of this comment claimed the mismatch failed SILENTLY
	 * with mismatched CSS classes; that is wrong for Popup, and the wrong
	 * expectation is what let the bad default sit here unnoticed.
	 *
	 * OPTIONAL — the default now asks the live map via `popupCtor`, so the
	 * right library is used whether or not a caller passes this. Pass it only
	 * to keep the lazy import at the call site.
	 */
	readonly popupLib?: () => Promise<{ Popup: new (o: unknown) => FirePopup }>;
}

/** The slice of Popup the fire card uses. Both libraries satisfy it. */
export interface FirePopup {
	setLngLat(c: [number, number]): FirePopup;
	setHTML(html: string): FirePopup;
	addTo(map: unknown): FirePopup;
	remove(): void;
	getElement(): HTMLElement | undefined;
}

/**
 * Attach the wildfire layer to a live map.
 *
 * Cache first (instant, works offline), then top up from the Worker when there
 * is nothing fresh covering the current view. Returns a teardown function that
 * also carries `repaint()`.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔬 FIRES OFF — TEMPORARY, WHILE THE MEMORY HUNT IS ON. NOT A FIX.
 *
 * MEASURED 2026-08-11 on /mobile/map (the ONLINE map, Mapbox — so this is NOT
 * the MapLibre port): Main VM instance **831 MB climbing at 2.8 MB/s**, total
 * JS heap 871 MB, peak 2024 MB, spread 1325 MB. The map debugger's own timing
 * row read `fire paint 5 · 43ms · 10.7s` — i.e. the fire layer is the thing
 * doing sustained work while the page sits there.
 *
 * ONE flag here rather than a flag per route: there are two callers
 * (MobMapPage.svelte:229 online, offlinev4/+page.svelte:1084 offline) and the
 * previous attempt at this put a `FIRE_LAYER_ENABLED` const in only ONE of
 * them, which is why fires were "off" for weeks on one map and quietly on for
 * the other. Killing it at the entry point means neither route can start it.
 *
 * Everything below is untouched: teardown, repaint, the handle shape. Callers
 * keep working — they just get an inert handle.
 *
 * ⚠️ Known-suspicious even before this: `unionHotspots` (v4FireCache.ts) has
 * TWO FAILING TESTS on a clean tree — "scales LINEARLY in disc count" measured
 * 4.14× against a <2.5× bound, and "absorbs a realistic full cache without
 * millions of trig calls" measured 1,065,750 calls against a <147,000 bound.
 * That is the documented 119%-CPU bug, currently REGRESSED. Fix that before
 * turning this back on.
 *
 * TO RESTORE: set FIRES_ENABLED = true. The original call path is unchanged.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const FIRES_ENABLED = false;

/** An inert handle — same shape, does nothing. Lets every caller's
 *  `detachFire?.()` / `detachFire?.repaint()` keep working untouched. */
function inertFireHandle(): FireLayerHandle {
	const noop = (() => {}) as unknown as FireLayerHandle;
	(noop as unknown as { repaint: () => void }).repaint = () => {};
	return noop;
}

export function attachFireLayer(
	map: FireMap,
	opts: AttachFireOptions = {},
): FireLayerHandle {
	if (!FIRES_ENABLED) return inertFireHandle();
	const ids = opts.ids ?? ONLINE_FIRE_IDS;
	// The offline viewer is a PURE VIEWER: the app-wide bake service owns every
	// download, so this map must never fetch. Passing `canFetch: false` is what
	// keeps that true rather than a comment asking nicely.
	const canFetch = opts.canFetch !== false;
	// Popups are the ONE place this file needs the library OBJECT rather than the
	// map instance. The DEFAULT asks the live map which library built it —
	// hardcoding mapbox-gl here was a latent crash: NO caller has ever passed
	// `popupLib`, so the offline route (MapLibre) would have built a Mapbox
	// Popup and thrown `TypeError: _requestDomTask is not a function` from
	// inside addTo the moment fires were re-enabled there. Sniffing the instance
	// cannot be forgotten by a call site; a default cannot be got wrong.
	// See $lib/mobile/map/rendererOf.ts.
	const loadPopupLib =
		opts.popupLib ??
		(async () => ({
			Popup: popupCtor(map) as unknown as new (o: unknown) => FirePopup,
		}));
	let disposed = false;
	/** The ONE liveness answer, handed to every async that can outlive the map.
	 *  Never probe the map itself for this — see `refineUrban`. */
	const isLive = (): boolean => !disposed;

	/**
	 * How many hotspots the LAST paint put on screen.
	 *
	 * Kept because the coverage gate below needs "is anything actually drawn?"
	 * and a pan must be able to answer that WITHOUT repainting to find out —
	 * repainting to decide whether to repaint is the exact loop being removed.
	 * `paint()` is the only writer, so this cannot drift from what is on screen.
	 */
	let lastPainted = 0;

	const ensure = async ({
		paintFirst = true,
	}: {
		paintFirst?: boolean;
	} = {}): Promise<void> => {
		if (disposed) return;
		addFireLayers(map, ids, isLive);
		// `paintFirst: false` is the pan path for a located user: the fires on
		// screen are already correct (a camera move cannot change which are
		// relevant — see `fireFollowsCamera`), so we skip straight to the only
		// question a pan can genuinely change the answer to: coverage.
		if (paintFirst) lastPainted = await paint(map, ids, isLive);
		const painted = lastPainted;
		if (disposed) return;

		// Pure viewer: painting from disk is the whole job. The app-wide bake
		// service is the ONLY downloader, so stop before any coverage check —
		// racing it would double-fetch and fight over the same cache entries.
		if (!canFetch) return;

		// Is the CURRENT VIEW covered? Not "is there any fresh data at all" —
		// that was the bug: a fresh Ottawa disc made the map skip fetching while
		// showing a user in BC an empty layer. What matters is whether a disc
		// covers where they are LOOKING, which is exactly how someone checks on a
		// block before they drive to it.
		//
		// ⚠️ An ARRIVAL pierces this. The TTL asks "has the data aged out?", which
		// is the wrong question the moment someone drives back into signal and
		// opens the app SPECIFICALLY to check the fire: a 59-minute-old disc is
		// "fresh" and "covering", so we fetched nothing and showed them an
		// hour-old answer without ever asking. See fireArrival.ts.
		// PEEK, don't consume: three call sites race for this flag (idle boot,
		// style.load, pan debounce) and whichever won used to eat it before the
		// call that would actually fetch. Settled below, only after a real fetch.
		const onDemand = peekFireArrival("map");
		const c = map.getCenter();
		// COVERAGE ONLY — centres and times, never the hotspots. This gate asks a
		// purely geographic question, and pulling the full records to answer it
		// pinned tens of thousands of detections in memory for nothing.
		const covered = (await fireCoverage()).some(
			(e) =>
				isCoverageFresh(e) &&
				kmBetween([c.lng, c.lat], e.center) < FIRE_TRIGGER_KM,
		);
		if (covered && painted > 0 && !onDemand) {
			vlog(
				"fire",
				`${painted} hotspots painted from cache — this view is covered, not fetching`,
			);
			return;
		}
		if (typeof navigator !== "undefined" && navigator.onLine === false) {
			vlog(
				"fire",
				`offline — showing ${painted} cached hotspot(s), no fetch attempted`,
			);
			return;
		}
		vlog(
			"fire",
			`fetching around ${c.lng.toFixed(2)},${c.lat.toFixed(2)} (cache gave ${painted})`,
		);
		try {
			// The debt is discharged HERE — a fetch has genuinely been attempted,
			// so a later `ensure()` in this same arrival must not fetch again.
			settleFireArrival("map");
			const r = await fetchAreaFires(c.lng, c.lat);
			if (disposed) return;
			await writeFireCache(satImageKey([c.lng, c.lat]), {
				fetchedAt: r.fetchedAt,
				center: [c.lng, c.lat],
				radiusKm: FIRE_RADIUS_KM,
				sourcesOk: r.sourcesOk,
				hotspots: r.hotspots,
			});
			const n = await paint(map, ids, isLive);
			lastPainted = n;
			// A genuine zero must LOOK different from a broken layer. "No fires
			// near you" is the most dangerous thing this layer can say, so an
			// empty answer gets a warn, not a cheerful info line.
			if (n === 0) {
				console.warn(
					`[fire] server returned ZERO hotspots (${r.sourcesOk}/3 satellites) — either genuinely quiet, or the feed is wrong`,
				);
			} else {
				vlog("fire", `${n} hotspots on the map (${r.sourcesOk}/3 satellites)`);
			}
		} catch (err) {
			// Visible by default, never silent: an empty fire layer that failed
			// quietly is how a user ends up trusting a map that shows no fires.
			console.warn(
				"[fire] could not load hotspots — showing what's cached",
				err,
			);
		}
	};

	// ── Tap a hotspot → the honest card ──
	// A planter taps because they're anxious. What they get is distance and
	// direction from THEM, how long ago the satellite saw it, how much energy it
	// was radiating, and — always — that this is not a confirmed fire.
	let popup: FirePopup | null = null;
	const onPointClick = (
		e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] },
	): void => {
		const f = e.features?.[0];
		if (!f || f.geometry.type !== "Point") return;
		const coords = f.geometry.coordinates as [number, number];
		popup?.remove();
		// Lazy import avoids pulling the Popup class into the module graph for
		// users who never tap a dot. MUST go through loadPopupLib like the
		// cluster path below — hardcoding mapbox-gl here pulled a SECOND
		// renderer into the offline route at runtime and built a Mapbox Popup on
		// a MapLibre map (wrong DOM classes → no CSS, unreachable close button).
		void loadPopupLib().then(({ Popup }) => {
			if (disposed) return;
			popup = new Popup(firePopupOptions)
				.setLngLat(coords)
				.setHTML(
					hotspotPopupHtml(
						f.properties ?? {},
						coords,
						whereFor(coords),
						anchorNearest(map, coords),
					),
				)
				.addTo(map);
			// After addTo: the button only exists once the popup is in the DOM.
			wireCloseButton(popup);
		});
	};
	// Tapping a cluster SUMMARISES it — it does not zoom.
	//
	// Zoom-on-tap was the obvious first move and it was wrong: someone tapping a
	// blob is asking "what is that?", and answering by moving the map makes them
	// chase it down through several zoom levels before they learn anything. The
	// aggregate IS the answer — how many detections, over how much ground, how
	// recently, and how hot the worst one is. They can still pinch in if they
	// want the individuals.
	const onClusterClick = (
		e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] },
	): void => {
		const f = e.features?.[0];
		if (!f || f.geometry.type !== "Point") return;
		const centre = f.geometry.coordinates as [number, number];
		const clusterId = (f.properties as { cluster_id?: number })?.cluster_id;
		const src = map.getSource(ids.src) as mapboxgl.GeoJSONSource | undefined;
		if (clusterId === undefined || !src) return;
		const count = Number(
			(f.properties as { point_count?: number })?.point_count ?? 0,
		);
		// getClusterLeaves is the ONLY way to reach a cluster's members —
		// clusterProperties can aggregate scalars but can't hand back the rows,
		// and we need per-member px/t to sum area and find the newest sighting.
		//
		// ⚠️ Same two-renderer divergence as `loadImage` above:
		//   Mapbox 3.24   getClusterLeaves(id, limit, offset, callback): this
		//   MapLibre 5.16 getClusterLeaves(id, limit, offset): Promise<Feature[]>
		// MapLibre ignores a 4th callback argument, so the callback form never
		// fires there and the cluster tap card silently never appears.
		const withLeaves = (leaves: GeoJSON.Feature[] | null | undefined): void => {
			if (disposed) return;
			if (!leaves) {
				console.warn("[fire] could not read cluster members");
				return;
			}
			const members = leaves
				.filter((l) => l.geometry?.type === "Point")
				.map((l) => ({
					coordinates: (l.geometry as GeoJSON.Point).coordinates as [
						number,
						number,
					],
					t: Number(l.properties?.t),
					frp: Number(l.properties?.frp),
					px: Number.isFinite(Number(l.properties?.px))
						? Number(l.properties?.px)
						: undefined,
				}));
			if (members.length === 0) return;
			// The Source row appears only when the WHOLE cluster is industrial.
			// A mixed cluster is a fire that happens to include a flare, and
			// labelling it "industrial" would be the map talking someone out of
			// a real fire.
			const mask = peekStaticMask();
			const allIndustrial =
				members.length > 0 &&
				members.every((m) =>
					isStaticSource(m.coordinates[0], m.coordinates[1], mask),
				);
			const card = buildClusterCard(
				members,
				centre,
				anchorNearest(map, centre),
				Date.now(),
				whereFor(centre),
				allIndustrial,
				lastPingedAt,
			);
			popup?.remove();
			void loadPopupLib().then(({ Popup }) => {
				if (disposed) return;
				popup = new Popup(firePopupOptions)
					.setLngLat(centre)
					.setHTML(cardHtml(card.title, card.rows))
					.addTo(map);
				// After addTo: the button only exists once the popup is in the DOM.
				wireCloseButton(popup);
			});
		};

		const leaves = (
			src as unknown as {
				getClusterLeaves: (
					id: number,
					limit: number,
					offset: number,
					cb?: (err: unknown, features: GeoJSON.Feature[] | null) => void,
				) => Promise<GeoJSON.Feature[]> | unknown;
			}
		).getClusterLeaves(clusterId, count || 1000, 0, (err, features) => {
			if (err) {
				if (!disposed) console.warn("[fire] could not read cluster members", err);
				return;
			}
			withLeaves(features);
		});
		// MapLibre returned a promise and ignored the callback — drive it instead.
		if (leaves && typeof (leaves as Promise<unknown>).then === "function") {
			void (leaves as Promise<GeoJSON.Feature[]>).then(withLeaves, (err) => {
				if (!disposed) console.warn("[fire] could not read cluster members", err);
			});
		}
	};
	map.on("click", ids.flame, onPointClick);
	map.on("click", ids.cluster, onClusterClick);
	map.on("click", ids.clusterIcon, onClusterClick);

	// ── FIRES COME AFTER. THE MAP GOES FIRST. ──
	//
	// These three assets are ~10.6 MB of JSON (places-world 6.2 MB, urban 4.4 MB,
	// static-heat 0.5 KB), and `JSON.parse` on a 6 MB file is a SINGLE
	// uninterruptible main-thread task — it cannot be sliced and it cannot yield.
	// Kicked off at attach time, they land squarely on top of the map's own first
	// frames, and the map is the primary tool while fires are an overlay that
	// 95%+ of sessions never look at.
	//
	// ⚠️ The `refineUrban` slicing below protects the CLASSIFY step. It does
	// nothing for the LOAD step it depends on — that was the gap: a carefully
	// frame-sliced consumer sitting behind a monolithic parse. Deferring to idle
	// is what actually keeps the parse off the critical path.
	//
	// `requestIdleCallback` is absent on the iOS WebView, hence the timeout
	// fallback. The delay is deliberately generous: nothing here is urgent, the
	// first tap is many seconds away, and the repaint below fills the fires in
	// whenever the assets do arrive.
	const whenIdle = (fn: () => void): void => {
		const ric = (
			window as unknown as {
				requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void;
			}
		).requestIdleCallback;
		if (typeof ric === "function") ric(fn, { timeout: 4000 });
		else window.setTimeout(fn, 1200);
	};
	whenIdle(() => {
		if (disposed) return;
		// ── WINDOW BOTH WORLD ASSETS BEFORE THEY PARSE ──
		//
		// places-world.json (6.2 MB) and urban.json (4.4 MB) ship at WORLD scale
		// and were parsed whole and held for the session — roughly ~100 MB resident
		// once V8 has boxed every [lng,lat] pair, on a phone, whether or not anyone
		// ever taps a fire.
		//
		// Nothing needs the world. Both assets exist to describe HOTSPOTS, and
		// hotspots are already walled to 500 km from the user's anchors
		// (fireRelevance.ts). So the window is centred on the SAME anchor set the
		// wall uses — one source of truth for "where does this user care about" —
		// and everything outside it is dropped before it is ever retained.
		//
		// MUST run before warmPlaces()/loadUrban(): these setters only take effect
		// on the next parse, and a load already in flight keeps the whole world.
		const fc0 = map.getCenter();
		const anchors = fireOrigins([fc0.lng, fc0.lat], mapStore.allMaps);
		const windowCentre = anchors[0] ?? ([fc0.lng, fc0.lat] as const);
		setPlacesRegion([windowCentre[0], windowCentre[1]]);
		setUrbanRegion([windowCentre[0], windowCentre[1]]);
		// Start pulling the gazetteer so the first tap already has place names.
		// Deliberately not awaited: the map must never wait on it.
		warmPlaces();
		// The city rule and the industrial mask are only as good as their assets.
		// `warm*` kicks the fetch off; the REPAINT is what matters — a first paint
		// that beat the polygons would render city hotspots and then leave them
		// there, which is precisely the bug this rule exists to kill.
		warmStaticMask();
		void Promise.all([loadUrban(), loadStaticMask()]).then(() => {
			if (!disposed) void paint(map, ids, isLive);
		});
	});

	// The FIRST paint is deferred for the same reason as the assets above: it
	// reads every cached disc out of IndexedDB and unions them (measured: 24 ms
	// read + 25 ms union on a 73,225-hotspot cache), and none of that is worth a
	// single dropped frame of the map itself. A style swap re-runs it immediately
	// — by then the map is long since up, so there is nothing left to protect.
	whenIdle(() => {
		if (!disposed) void ensure();
	});
	// A style swap (satellite ↔ terrain) drops every custom source and layer, so
	// this one ALWAYS repaints — the layers themselves are gone, which is a very
	// different situation from a pan over unchanged data.
	//
	// Wrapped rather than passing `ensure` directly: Mapbox hands its listener an
	// event object, which would land in the options slot. Today that reads as
	// `paintFirst: undefined` → `true` and happens to be correct, but it is
	// correct by accident, and the next option added here would silently take a
	// Mapbox event as its value. The wrapper also keeps ONE stable reference for
	// the matching `off` below.
	const onStyleLoad = (): void => {
		void ensure();
	};
	map.on("style.load", onStyleLoad);
	// Panning to a NEW region must pull that region's fires — otherwise checking
	// on a distant block shows a confidently empty map.
	//
	// ⛔ BUT THE PAINT IS GATED, AND THAT GATE IS THE POINT.
	//
	// `ensure()` was described here as "cheap and self-gating". It is not: its
	// coverage check sits AFTER `await paint(...)`, so every settle re-entered
	// the full paint — IndexedDB read, union, relevance wall, GeoJSON build,
	// setData, outlines — before deciding it had nothing to do. Three previous
	// fixes made that paint cheaper and left this coupling standing, which is
	// why the cost kept coming back as fire features were added.
	//
	// For a user with a fix or a touched feature, a camera move cannot change
	// one thing about which fires are relevant (see `fireFollowsCamera`), so the
	// correct amount of work on pan is ZERO. Fetching is the one genuine
	// exception: a NEW region's fires still have to be pulled, and that IS a
	// camera question — so a pan into uncovered ground still calls `ensure`,
	// which now skips straight to the coverage check with `paintFirst: false`.
	let panTimer = 0;
	const onMoveEnd = (): void => {
		window.clearTimeout(panTimer);
		panTimer = window.setTimeout(() => {
			if (disposed) return;
			// Unlocated users genuinely follow the camera — they get a full pass.
			// Everyone else skips the paint and only asks "is this view covered?".
			const follows = fireFollowsCamera(mapStore.allMaps);
			void ensure({ paintFirst: follows });
		}, 600);
	};
	map.on("moveend", onMoveEnd);

	// The legend's fire eye flips a plain store, and this module is plain TS with
	// no runes, so the OWNER (MobMapPage) drives the repaint through here. Just a
	// repaint — the source and layers stay mounted whether fires are shown or
	// hidden, so coming back on is one setData rather than re-adding a layer.
	const detach = (() => {
		disposed = true;
		window.clearTimeout(panTimer);
		popup?.remove();
		map.off("click", ids.flame, onPointClick);
		map.off("click", ids.cluster, onClusterClick);
		map.off("click", ids.clusterIcon, onClusterClick);
		map.off("style.load", onStyleLoad);
		map.off("moveend", onMoveEnd);
	}) as FireLayerHandle;
	// Hiding fires must also drop any open card — leaving a "Fire detected"
	// popover floating over a map with no fires on it is the layer contradicting
	// itself on screen.
	detach.repaint = (): void => {
		if (disposed) return;
		if (!overlayVisibility.fires) popup?.remove();
		void paint(map, ids, isLive);
	};
	return detach;
}
