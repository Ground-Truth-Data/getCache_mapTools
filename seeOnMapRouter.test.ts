// "See on map" routing laws. The one that motivated this file (2026-07-20,
// "zoomed way too far out"): a `plots=` param that parses to ZERO keys is a
// caller bug and must ERROR — never degrade to a whole-map frame. That silent
// fallback is what hid the inbox quality eye navigating with an empty cluster
// (the sheet read a $derived after onClose() nulled it) and framing the entire
// PDF instead of the 4 plots.
import { describe, expect, it, vi } from "vitest";
import type { MapStore } from "$lib/mobile/stores/mapStore.svelte";
import { applyMapRoute } from "./seeOnMapRouter";

const MAP_A = "map-a";
const MAP_B = "map-b";

function makeMapStore(activeMapKey: string = MAP_A): MapStore {
	const maps = [
		{
			mapKey: MAP_A,
			mapTitle: "Map A",
			features: [
				{ mapFeatureKey: "f1" },
				{ mapFeatureKey: "f2" },
				{ mapFeatureKey: "f3" },
			],
		},
		{ mapKey: MAP_B, mapTitle: "Map B", features: [{ mapFeatureKey: "g1" }] },
	];
	const store = {
		allMaps: maps,
		activeMapKey,
		get activeMap() {
			return maps.find((m) => m.mapKey === store.activeMapKey);
		},
		switchMap: vi.fn((key: string) => {
			store.activeMapKey = key;
		}),
	};
	return store as unknown as MapStore;
}

function makeArgs(mapStore: MapStore) {
	return {
		mapStore,
		frameFeature: vi.fn(),
		frameActiveMap: vi.fn(),
		framePlots: vi.fn(),
		onMapNotFound: vi.fn(),
		onFeatureNotFound: vi.fn(),
		onEmptyMapSwitch: vi.fn(),
	};
}

describe("applyMapRoute plot clusters", () => {
	it("frames the FULL cluster, not one pin and not the map", () => {
		const mapStore = makeMapStore();
		const args = makeArgs(mapStore);
		applyMapRoute({
			mapKeyParam: MAP_A,
			featureKeyParam: null,
			plotKeysParam: ["f1", "f2", "f3"],
			...args,
		});
		expect(args.framePlots).toHaveBeenCalledWith(["f1", "f2", "f3"]);
		expect(args.frameFeature).not.toHaveBeenCalled();
		expect(args.frameActiveMap).not.toHaveBeenCalled();
	});

	it("EMPTY plots= is an error — never a whole-map frame", () => {
		const mapStore = makeMapStore();
		const args = makeArgs(mapStore);
		applyMapRoute({
			mapKeyParam: MAP_A,
			featureKeyParam: null,
			plotKeysParam: [],
			...args,
		});
		expect(args.onFeatureNotFound).toHaveBeenCalled();
		expect(args.frameActiveMap).not.toHaveBeenCalled();
		expect(args.framePlots).not.toHaveBeenCalled();
		expect(mapStore.switchMap).not.toHaveBeenCalled();
	});

	it("absent plots (null) still frames the whole map", () => {
		const mapStore = makeMapStore();
		const args = makeArgs(mapStore);
		applyMapRoute({
			mapKeyParam: MAP_A,
			featureKeyParam: null,
			plotKeysParam: null,
			...args,
		});
		expect(args.frameActiveMap).toHaveBeenCalled();
		expect(args.onFeatureNotFound).not.toHaveBeenCalled();
	});

	it("drops stale keys but frames the survivors", () => {
		const mapStore = makeMapStore();
		const args = makeArgs(mapStore);
		applyMapRoute({
			mapKeyParam: MAP_A,
			featureKeyParam: null,
			plotKeysParam: ["f1", "stale-key", "f3"],
			...args,
		});
		expect(args.framePlots).toHaveBeenCalledWith(["f1", "f3"]);
		expect(args.onFeatureNotFound).not.toHaveBeenCalled();
	});

	it("ALL keys stale → error, no switch, no camera move", () => {
		const mapStore = makeMapStore(MAP_B);
		const args = makeArgs(mapStore);
		applyMapRoute({
			mapKeyParam: MAP_A,
			featureKeyParam: null,
			plotKeysParam: ["nope-1", "nope-2"],
			...args,
		});
		expect(args.onFeatureNotFound).toHaveBeenCalled();
		expect(args.framePlots).not.toHaveBeenCalled();
		expect(args.frameActiveMap).not.toHaveBeenCalled();
		expect(mapStore.switchMap).not.toHaveBeenCalled();
		expect(mapStore.activeMapKey).toBe(MAP_B);
	});

	it("switches to the cluster's map before framing", () => {
		const mapStore = makeMapStore(MAP_B);
		const args = makeArgs(mapStore);
		applyMapRoute({
			mapKeyParam: MAP_A,
			featureKeyParam: null,
			plotKeysParam: ["f1", "f2"],
			...args,
		});
		expect(mapStore.switchMap).toHaveBeenCalledWith(MAP_A);
		expect(args.framePlots).toHaveBeenCalledWith(["f1", "f2"]);
	});
});
