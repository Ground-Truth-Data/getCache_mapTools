// URL-as-truth router for "See on map".
//
// One function. The URL says where to go; this puts the view there.
// Every "See on map" button writes `?map=...&feature=...` (or
// `?map=...&plots=<fk1>,<fk2>,...` for a plot cluster) and navigates;
// the map page's $effect reads those params and calls applyMapRoute.
//
// Lives in its own file so the routing surface is small and findable
// instead of hiding inside MapDrawControls' ~2500-line wall.

import type { MapStore } from "$lib/mobile/stores/mapStore.svelte";

export type ApplyMapRouteArgs = {
	mapKeyParam: string | null;
	featureKeyParam: string | null;
	/** `plots=<fk1>,<fk2>,...` — frame a CLUSTER of plot pins (the stats
	 *  history's block eye). Requires `map=`; keys not on that map are
	 *  dropped, and zero survivors is treated like a feature-not-found. */
	plotKeysParam?: string[] | null;
	mapStore: MapStore;
	frameFeature: (key: string) => void;
	frameActiveMap: () => void;
	framePlots?: (keys: string[]) => void;
	/** URL named a `map=<key>` that isn't in mapStore. Caller surfaces
	 *  the error (toast). Per spec: NEVER fall back to a different map. */
	onMapNotFound?: (key: string) => void;
	/** URL named a `feature=<key>` that isn't on the active map. Caller
	 *  surfaces the error. NEVER fall back to framing something else. */
	onFeatureNotFound?: (key: string) => void;
	/** Switched to a map that has no features. Caller surfaces this
	 *  so the user knows the switch happened (camera won't move). */
	onEmptyMapSwitch?: (mapTitle: string) => void;
};

export function applyMapRoute(args: ApplyMapRouteArgs): void {
	const {
		mapKeyParam,
		featureKeyParam,
		plotKeysParam,
		mapStore,
		frameFeature,
		frameActiveMap,
		framePlots,
		onMapNotFound,
		onFeatureNotFound,
		onEmptyMapSwitch,
	} = args;

	// INVARIANT: "See on map" lands on the EXACT map+feature requested, or on
	// nothing at all. We must never switch maps (or move the camera) until the
	// requested feature is confirmed present on the named map. A switch-then-
	// validate ordering is what dumped the user onto the wrong PDF: it moved
	// first and only errored after. So we validate against the target map —
	// looked up by key, NOT by switching — and only commit the switch once the
	// pair checks out. Mismatch → error, no switch, no camera move, no fallback.

	const targetMapKey = mapKeyParam;
	// The plot keys confirmed present on the validated target map (the
	// cluster to frame). Filled during validation below.
	let plotsOnTarget: string[] = [];

	if (mapKeyParam) {
		const target = mapStore.allMaps.find((m) => m.mapKey === mapKeyParam);
		if (!target) {
			onMapNotFound?.(mapKeyParam);
			return;
		}
		// If a feature is also named, it MUST live on this exact map. Check
		// before any switch so a stale/duplicate feature key can never drag
		// the user onto a different map.
		if (featureKeyParam) {
			const hasFeature = target.features.some(
				(f) => f.mapFeatureKey === featureKeyParam,
			);
			if (!hasFeature) {
				onFeatureNotFound?.(featureKeyParam);
				return;
			}
		}
		// A `plots=` param that parsed to ZERO keys is a caller bug (a button
		// built an empty cluster). Error, don't degrade to a whole-map frame —
		// that silent fallback is exactly what masked the empty-plots bug.
		if (plotKeysParam && plotKeysParam.length === 0) {
			onFeatureNotFound?.("(empty plots= param)");
			return;
		}
		// A plot CLUSTER: keep only keys actually on this map (a stale key
		// must never drag the frame elsewhere); ALL of them stale → same
		// treatment as a missing feature — error, no switch, no camera move.
		if (plotKeysParam?.length) {
			const present = new Set(target.features.map((f) => f.mapFeatureKey));
			plotsOnTarget = plotKeysParam.filter((k) => present.has(k));
			if (plotsOnTarget.length === 0) {
				onFeatureNotFound?.(plotKeysParam.join(","));
				return;
			}
		}
		// Pair validated (map-only, or map+feature confirmed). Safe to switch.
		if (mapKeyParam !== mapStore.activeMapKey) {
			mapStore.switchMap(mapKeyParam);
		}
	} else if (featureKeyParam) {
		// A feature with NO map param has no exact target. We do NOT scan the
		// store for "a map that happens to contain this key" — that crawl is
		// the mechanism that lands you on the wrong element. Every "See on
		// map" button passes the (map, feature) pair from its own row, so a
		// bare feature param means a caller bug: error, don't guess.
		onFeatureNotFound?.(featureKeyParam);
		return;
	}

	// Active map is now the validated target. Frame the feature, the plot
	// cluster, or the map.
	if (featureKeyParam) {
		frameFeature(featureKeyParam);
		return;
	}
	if (plotsOnTarget.length > 0 && framePlots) {
		framePlots(plotsOnTarget);
		return;
	}
	if (targetMapKey) {
		if ((mapStore.activeMap?.features.length ?? 0) === 0) {
			onEmptyMapSwitch?.(mapStore.activeMap?.mapTitle ?? "map");
		} else {
			frameActiveMap();
		}
	}
}
