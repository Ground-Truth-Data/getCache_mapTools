/**
 * fireOrigins.test.ts — which ground counts as "yours" for the fire wall.
 *
 * The policy math is tested in fireRelevance.test.ts. This file covers the part
 * that reads real app data: turning features into anchor candidates, and the
 * recency rule that decides which ones survive the cap.
 */
import { describe, expect, it } from "vitest";
import {
	ANCHOR_MAX_AGE_MS,
	anchorCandidates,
	fireFollowsCamera,
} from "./fireOrigins";

const NOW = Date.parse("2026-08-08T16:00:00.000Z");

const point = (lng: number, lat: number, lastTouched: string) => ({
	geometry: {
		type: "Feature" as const,
		geometry: { type: "Point" as const, coordinates: [lng, lat] },
		properties: {},
	},
	overlayBounds: null,
	lastTouched,
});

describe("anchorCandidates — features become stakes", () => {
	it("turns a freshly created feature into a candidate", () => {
		// The watermelon: created minutes ago, 1,900 km from the user.
		const maps = [
			{ features: [point(-99.6, 52.4, "2026-08-08T15:58:00.000Z")] },
		];
		const got = anchorCandidates(maps, NOW);
		expect(got).toHaveLength(1);
		expect(got[0].at).toEqual([-99.6, 52.4]);
	});

	it("drops ground you abandoned last season", () => {
		// Without a window, a feature from two years ago holds an anchor slot
		// forever and the fires it pulls are nobody's business any more.
		const old = new Date(NOW - ANCHOR_MAX_AGE_MS - 86_400_000).toISOString();
		const maps = [{ features: [point(-99.6, 52.4, old)] }];
		expect(anchorCandidates(maps, NOW)).toHaveLength(0);
	});

	it("keeps ground touched just inside the window", () => {
		const recent = new Date(NOW - ANCHOR_MAX_AGE_MS + 86_400_000).toISOString();
		const maps = [{ features: [point(-99.6, 52.4, recent)] }];
		expect(anchorCandidates(maps, NOW)).toHaveLength(1);
	});

	it("ignores a feature with no geometry and no bounds", () => {
		// A row mid-import has neither. It must not become an anchor at undefined.
		const maps = [
			{
				features: [
					{
						geometry: null,
						overlayBounds: null,
						lastTouched: "2026-08-08T15:58:00.000Z",
					},
				],
			},
		];
		expect(anchorCandidates(maps, NOW)).toHaveLength(0);
	});

	it("ignores an unparseable lastTouched rather than treating it as ancient", () => {
		const maps = [{ features: [point(-99.6, 52.4, "not-a-date")] }];
		expect(anchorCandidates(maps, NOW)).toHaveLength(0);
	});

	it("gives a POLYGON one candidate at its centroid, not one per vertex", () => {
		// A block is one place. Left unchecked, a polygon's vertices would each
		// become a candidate and a single field could spend every anchor slot.
		const maps = [
			{
				features: [
					{
						geometry: {
							type: "Feature" as const,
							geometry: {
								type: "Polygon" as const,
								coordinates: [
									[
										[-99.7, 52.3],
										[-99.5, 52.3],
										[-99.5, 52.5],
										[-99.7, 52.5],
										[-99.7, 52.3],
									],
								],
							},
							properties: {},
						},
						overlayBounds: null,
						lastTouched: "2026-08-08T15:58:00.000Z",
					},
				],
			},
		];
		const got = anchorCandidates(maps, NOW);
		expect(got).toHaveLength(1);
		expect(got[0].at[0]).toBeCloseTo(-99.6, 1);
		expect(got[0].at[1]).toBeCloseTo(52.4, 1);
	});

	it("gives a LINE one candidate, not one per sampled step", () => {
		// anchorsOf samples a line into a ribbon of blobs for offline coverage —
		// correct there, wrong here. For the fire wall a line is one place.
		const maps = [
			{
				features: [
					{
						geometry: {
							type: "Feature" as const,
							geometry: {
								type: "LineString" as const,
								coordinates: [
									[-99.6, 52.4],
									[-99.0, 52.9],
									[-98.4, 53.4],
								],
							},
							properties: {},
						},
						overlayBounds: null,
						lastTouched: "2026-08-08T15:58:00.000Z",
					},
				],
			},
		];
		expect(anchorCandidates(maps, NOW)).toHaveLength(1);
	});

	it("collects across every map, not just the active one", () => {
		// You can be working a block whose map isn't the one on screen. The fires
		// there are still your business.
		const maps = [
			{ features: [point(-123.1, 49.28, "2026-08-08T15:00:00.000Z")] },
			{ features: [point(-99.6, 52.4, "2026-08-08T15:58:00.000Z")] },
		];
		expect(anchorCandidates(maps, NOW)).toHaveLength(2);
	});
});

/**
 * ── THE CAMERA WALL ──
 *
 * The fire layer was wired to `moveend`, so every pan re-entered the full paint
 * (IndexedDB read → union → relevance wall → GeoJSON → outline hulls). Three
 * fixes made that path cheaper and left the coupling standing, so the cost
 * returned each time fire work grew. `fireFollowsCamera` is the gate that
 * removes the work instead of shrinking it.
 *
 * The load-bearing case is the LAST one: an unlocated user genuinely does
 * follow the camera, and suppressing their repaint would show a brand-new
 * install an empty layer — "no fires near you", the most dangerous thing this
 * layer can say. The gate must stay a question about the DATA, never a
 * throttle.
 */
describe("fireFollowsCamera — when a pan can change nothing", () => {
	const withStoredFix = <T,>(value: string | null, run: () => T): T => {
		const g = globalThis as { localStorage?: Storage };
		const had = "localStorage" in g;
		const prev = g.localStorage;
		g.localStorage = {
			getItem: (k: string) => (k === "rt-last-fix" ? value : null),
		} as unknown as Storage;
		try {
			return run();
		} finally {
			if (had) g.localStorage = prev;
			else delete g.localStorage;
		}
	};

	it("does NOT follow the camera when a live fix exists", () => {
		const fix = JSON.stringify({ lng: -123.1, lat: 49.2, ts: NOW - 60_000 });
		expect(withStoredFix(fix, () => fireFollowsCamera([], NOW))).toBe(false);
	});

	it("does NOT follow the camera when a touched feature exists", () => {
		// No fix, but the user has ground they care about — panning away from it
		// must not re-derive anything.
		const maps = [
			{ features: [point(-99.6, 52.4, "2026-08-08T15:58:00.000Z")] },
		];
		expect(fireFollowsCamera(maps, NOW)).toBe(false);
	});

	it("ignores features too old to be a stake", () => {
		// An abandoned feature is not an anchor, so such a user IS unlocated and
		// must keep following the camera. Mirrors anchorCandidates' window.
		const old = new Date(NOW - ANCHOR_MAX_AGE_MS - 86_400_000).toISOString();
		expect(fireFollowsCamera([{ features: [point(-99.6, 52.4, old)] }], NOW)).toBe(
			true,
		);
	});

	it("⛔ DOES follow the camera with no fix and no features (fresh install)", () => {
		// Never suppress this one. The map centre is their only origin, so a pan
		// genuinely changes which fires are relevant.
		expect(fireFollowsCamera([], NOW)).toBe(true);
	});
});
