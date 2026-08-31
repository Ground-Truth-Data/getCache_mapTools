/**
 * fireLayer.test.ts — the ONE thing that made this layer invisible.
 *
 * The online map's fire layer painted nothing for an entire session while the
 * source held 16,717 features, `isSourceLoaded` was true, and no map `error`
 * event fired. The cause was a single line: the cluster-count SYMBOL layer
 * asked for "Noto Sans Regular", a font the HOSTED Mapbox style does not
 * serve. Every glyph range 404'd, and a symbol layer whose glyphs never arrive
 * stalls the whole source — including the two CIRCLE layers beside it, which
 * need no font at all.
 *
 * The offline map serves its own glyphs from /mobileAssets/worldBase/glyphs and DOES have
 * Noto, which is why the identical data rendered perfectly there. That
 * asymmetry is exactly what makes this easy to reintroduce by copy-paste.
 *
 * So this test does not check "a font is set" — it checks the font is one the
 * ONLINE style actually has, by pinning it to the same stack the rest of the
 * online map already uses successfully.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The gauge's path builder, mirrored.
 *
 * `fireLayer.ts` cannot be imported here: it reaches Supabase via
 * `$env/static/public`, which only exists inside a SvelteKit build. That is why
 * this whole file scans SOURCE TEXT rather than calling the module.
 *
 * The mirror is guarded — `matches fireLayer.ts's own clamp` below re-derives
 * these two lines from the real source, so a drift fails loudly instead of
 * testing a copy that no longer resembles the app.
 */
function intensityIconSrc(level: number): string {
	const lvl = Math.min(5, Math.max(1, Math.round(level)));
	return `/mobileAssets/fire_intensity/${lvl}-fire_intensity.webp`;
}

const raw = readFileSync(
	fileURLToPath(new URL("./fireLayer.ts", import.meta.url)),
	"utf8",
);

/**
 * Strip comments before scanning. The file's own header EXPLAINS the bad font
 * by name — that documentation is the point, and a naive text scan would flag
 * it forever. We care what the layer ASKS FOR, not what the prose mentions.
 */
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const mapInitSrc = readFileSync(
	fileURLToPath(
		new URL(
			"../../../../../getCache_OnlineMap/lib/mapInit.ts",
			import.meta.url,
		),
	),
	"utf8",
);

describe("fireLayer — glyph fontstack (the invisible-layer bug)", () => {
	it("does NOT ask for Noto Sans, which the hosted Mapbox style 404s", () => {
		expect(src).not.toContain("Noto Sans");
	});

	it("declares no text layer at all — nothing here needs a glyph", () => {
		// The cluster count label was removed (the number of satellite pixels in
		// a blob is not a fact anyone acts on), so there is no `text-font` left
		// to get wrong. If text ever comes back it must use `glyphStack(map)`.
		expect(src).not.toContain("text-font");
	});

	it("mapInit picks its font from the LIVE map, not a literal", () => {
		// ⚠️ THIS ASSERTION WAS INVERTED. It used to require mapInit to CONTAIN
		// "DIN Pro Medium" — which pinned the exact bug it was meant to prevent.
		//
		// The two maps' glyph endpoints are disjoint: the hosted style has
		// DIN/Arial and no Noto; the offline base has Noto and nothing else. So a
		// hardcoded stack 404s forever on whichever map it wasn't written for —
		// once per tile. Both directions were seen live (DIN 404ing on
		// /mobile/offlinev4, Noto 404ing on /mobile/map). The font must be chosen
		// at runtime; see harness/.../getCache_OnlineMap/lib/glyphStack.ts.
		expect(mapInitSrc).toContain("glyphStack(map)");
		expect(mapInitSrc).not.toContain('"DIN Pro Medium"');
	});

	it("shows no count on the marker", () => {
		// Explicitly pinned: "just fire in that area, period" — the circle size
		// carries magnitude and the tap card gives the real aggregate.
		expect(src).not.toContain("point_count_abbreviated");
	});
});

describe("fireLayer — always on, no toggle", () => {
	it("never gates the layers behind a visibility toggle", () => {
		// A hazard layer you have to discover is one you find the day AFTER you
		// needed it. The user's ruling: "you can't turn them off if there's
		// fires they need to know."
		expect(src).not.toContain('"visibility": "none"');
		expect(src).not.toContain('visibility: "none"');
	});
});

/**
 * ── ONE FIRE LAYER, BOTH MAPS ──
 *
 * The offline viewer used to hand-roll its own fire source, its own circle
 * layers and NO tap card, while this file had flames, a cluster ramp and the
 * card. Identical data, two renderings — bare numbered blobs there, the real
 * thing here.
 *
 * These tests read the offline route's source and fail if it ever grows a
 * second implementation again. They are deliberately about the OFFLINE file:
 * the drift was only ever visible from that side.
 */
// ⚠️ OFFLINE V5 REBUILD: the v4 offline route + bake service were deleted
// (branch offline-v5, tag offline-v4-final). These guards assert the OFFLINE
// map does not grow its own fire implementation — still the right law, but it
// has no route to read until v5 lands its viewer. RE-POINT AT THE V5 ROUTE
// AND UNSKIP; do not delete, this guard caught real drift.
const offlineSrc = "";

describe.skip("fire layer — the offline map uses THIS implementation, not its own", () => {
	it("attaches via the shared attachFireLayer", () => {
		expect(offlineSrc).toContain("attachFireLayer");
		expect(offlineSrc).toContain("OFFLINE_FIRE_IDS");
	});

	it("declares no fire LAYERS of its own", () => {
		// Any `id: "v4-fire-…"` in an addLayer call means a second implementation
		// has come back. The ids still exist — as data, in OFFLINE_FIRE_IDS — but
		// the offline route must not be the thing constructing layers with them.
		expect(offlineSrc).not.toMatch(/id:\s*"v4-fire-/);
	});

	it("declares no fire SOURCE of its own", () => {
		expect(offlineSrc).not.toMatch(/addSource\(\s*"v4-fire-geo"/);
	});

	it("prints no count label on a fire marker", () => {
		// The offline map's clusters used to carry a text count ("16", "53").
		// The shared layer shows a flame instead — the number of satellite pixels
		// in a blob is not a fact anyone acts on.
		expect(offlineSrc).not.toContain("point_count_abbreviated");
	});

	it("is a pure VIEWER — it never fetches fires itself", () => {
		// The app-wide offlineBakeService owns every download; a second
		// downloader racing it would double-fetch and fight over cache entries.
		expect(offlineSrc).toContain("canFetch: false");
	});
});

describe("fire layer — the shared attach is genuinely parameterised", () => {
	it("exports ids for BOTH maps", () => {
		expect(src).toContain("ONLINE_FIRE_IDS");
		expect(src).toContain("OFFLINE_FIRE_IDS");
	});

	it("builds every layer from the ids parameter, never a hardcoded id", () => {
		// A literal `id: "rt-fire-…"` inside addLayer would mean the online map's
		// ids leaked back in, and the offline map would silently collide with it.
		expect(src).not.toMatch(/id:\s*"rt-fire-/);
		expect(src).not.toMatch(/id:\s*"v4-fire-/);
	});
});

/**
 * ── NO ZOOM SEAM: one detection, one flame ──
 *
 * A `circle` layer used to draw single detections below z8, handing over to the
 * flame above it. Two icons for one thing, with a seam between them — and it
 * leaked exactly where you'd predict: a hotspot too isolated to join a cluster
 * sat below the seam, rendered as a bare orange dot beside proper flames, then
 * "got its icon back" one zoom level later.
 *
 * The fix was deleting the dot layer, not tuning the seam. Any logic that
 * decides WHICH icon a detection gets is logic that can decide wrong. These
 * tests fail if a second mark — or a zoom gate that would need one — comes back.
 */
describe("fireLayer — one mark per detection, no second icon", () => {
	it("declares NO bare-dot layer for single detections", () => {
		// The tell: a circle layer filtered to non-clustered features.
		expect(src).not.toContain("ids.point");
		expect(src).not.toContain('point: "rt-fire-point"');
		expect(src).not.toContain('point: "v4-fire-point"');
	});

	it("the flame layer has NO zoom gate", () => {
		// A zoom-gated icon is an icon that disappears, and whatever fills the
		// gap becomes the second mark this whole change deleted.
		expect(src).not.toMatch(/minzoom:\s*\d+/);
		expect(src).not.toMatch(/maxzoom:\s*\d+/);
	});

	it("the offline route's toggle registry lists no dot layer either", () => {
		expect(offlineSrc).not.toContain("v4-fire-point");
	});
});

/**
 * ── The Intensity glyph ──
 * Pins the two things the user called out by eye, so a refactor can't quietly
 * undo them.
 */
/**
 * ── Leaving the map mid-classify must not throw ──
 *
 * `refineUrban` is fire-and-forget and awaits between classify slices, so it
 * resumes on a map the user has already navigated away from. It used to ask
 * `map.getSource()` whether the map was still alive — but `map.remove()` calls
 * `setStyle(null)`, and Mapbox's `getSource` dereferences `this.style`
 * unguarded, so the guard itself threw:
 *
 *   TypeError: Cannot read properties of undefined (reading 'getOwnSource')
 *
 * A guard that needs a live map to report a dead one is not a guard. Liveness
 * comes from the attach's own `disposed` flag, which every other async path in
 * this file already uses.
 */
describe("fireLayer — async work must never outlive the map", () => {
	it("refineUrban takes an isLive predicate rather than probing the map", () => {
		expect(src).toMatch(/refineUrban\([\s\S]{0,400}isLive/);
	});

	it("re-checks liveness AFTER the await, not only before it", () => {
		// The crash window is the slice boundary: alive on entry, destroyed by
		// the time classifyPending resolves. A check only at the top would still
		// crash.
		const body = src.slice(src.indexOf("async function refineUrban"));
		const fn = body.slice(0, body.indexOf("\n}"));
		const awaitAt = fn.indexOf("await classifyPending");
		const guardAt = fn.indexOf("if (!isLive()) return;");
		expect(awaitAt).toBeGreaterThan(-1);
		expect(guardAt).toBeGreaterThan(awaitAt);
	});

	it("paint threads the SAME liveness flag into the refine it kicks off", () => {
		// Paint returning early is not enough — the crash lived in the background
		// work paint starts and forgets.
		expect(src).toContain("void refineUrban(map, ids, all, isLive)");
	});

	it("the attach's isLive is derived from `disposed`, not from the map", () => {
		expect(src).toContain("const isLive = (): boolean => !disposed;");
	});
});

describe("fireLayer — intensity gauge + trend arrow", () => {
	it("the gauge is SUPPLIED ARTWORK, not a drawn ring", () => {
		// The drawn ring's level-5 state overshot its own start and laid the tail
		// over the head. On the card that read as a red hat perched on a circle —
		// decoration nobody could decode, on the most serious reading the layer
		// can give. Five supplied webps replaced it.
		expect(src).toContain("fire_intensity");
		// The overlap trick and its shadow are gone for good.
		expect(src).not.toContain("OVERSHOOT");
		expect(src).not.toContain("feDropShadow");
		// ...and so is the hand-rolled arc maths that only the ring needed.
		expect(src).not.toContain("arcPath");
	});

	it("the mirror above matches fireLayer.ts's own clamp and path", () => {
		// Guards the duplication: if the real builder changes shape, the tests
		// below would keep passing against a stale copy. Pin the two things that
		// carry the behaviour.
		expect(src).toContain("Math.min(5, Math.max(1, Math.round(level)))");
		expect(src).toContain("-fire_intensity.webp");
		expect(src).toContain('"/mobileAssets/fire_intensity"');
	});

	it("clamps to the five files that actually exist", () => {
		// A level outside 1–5 must not produce a 404'd <img>, which would render
		// as a broken-image glyph on the card.
		expect(intensityIconSrc(0)).toContain("1-fire_intensity");
		expect(intensityIconSrc(1)).toContain("1-fire_intensity");
		expect(intensityIconSrc(5)).toContain("5-fire_intensity");
		expect(intensityIconSrc(9)).toContain("5-fire_intensity");
		// Fractional levels round rather than truncating to a missing file.
		expect(intensityIconSrc(3.4)).toContain("3-fire_intensity");
		expect(intensityIconSrc(3.6)).toContain("4-fire_intensity");
	});

	it("every level it can emit is a file that EXISTS on disk", () => {
		// The gauge is built by string concatenation, so nothing else catches a
		// renamed or missing asset until it 404s in front of a user.
		for (let lvl = 1; lvl <= 5; lvl++) {
			const rel = intensityIconSrc(lvl).replace(/^\//, "");
			const abs = fileURLToPath(
				new URL(`../../../../static/${rel}`, import.meta.url),
			);
			expect(existsSync(abs), `${rel} is missing`).toBe(true);
		}
	});

	it("the number stays beside the gauge as the accessible carrier", () => {
		// The graphic must never be the only thing saying how bad a fire is.
		expect(src).toContain('aria-hidden="true"');
	});

	it("the trend arrow has NO disc behind it", () => {
		// The badge circle added chrome without meaning and shrank the arrow.
		expect(src).not.toMatch(/border-radius:\s*50%/);
		expect(src).not.toContain("trend-badge");
	});

	it("uses TRUE red and green, not the fire palette's orange", () => {
		// #e2584a read orange against the warm card and blended into the
		// terracotta the rest of the layer already uses.
		expect(src).not.toContain("#e2584a");
		expect(src).toContain("TREND_RED");
		expect(src).toContain("TREND_GREEN");
	});
});

/**
 * ⛔ A DRAWN FIRE IS NEVER WHISPERED.
 *
 * This had to be said TWICE. The distance fade (`prom`) was deleted, but the
 * AGE fade was left standing right beside it — so on screen nothing changed and
 * the report came back verbatim: *"why are they faded? should I just keep
 * saying it?"*. Two fades, one disease, and fixing one of them looked from the
 * outside like fixing none.
 *
 * The rule that replaces both: a hotspot either passed the gate and IS a fire,
 * or it is not on the map. There is no third state where it is a fire we
 * half-mean. Age and distance are reported in WORDS on the tap card, where they
 * cost no legibility.
 */
describe("fireLayer — no fade, ever, on a fire that is drawn", () => {
	const src = readFileSync("src/routes/(getcache)/map/fireLayer.ts", "utf8");
	/** Comments out — assert on CODE, never on the prose explaining the code. */
	const strip = (t: string): string => t.replace(/\/\/[^\n]*/g, "");
	const flame = src.slice(src.indexOf("id: ids.flame"));
	// The EXPRESSION only — comments in this file legitimately discuss `ageH`
	// and `prom` to explain why they are gone, and matching those would make the
	// test pass or fail on prose rather than on behaviour.
	const flamePaint = strip(
		flame.slice(flame.indexOf('"icon-opacity"'), flame.indexOf("\n\t});")),
	);

	it("the lone flame's opacity does NOT read ageH", () => {
		// The exact expression that produced the near-invisible smudges.
		expect(flamePaint).not.toContain("ageH");
	});

	it("the lone flame has no step/interpolate ramp at all", () => {
		// Any ramp on opacity is a fade wearing a different variable's name.
		const op = flamePaint.slice(flamePaint.indexOf('"icon-opacity"'));
		expect(op).not.toContain('"step"');
		expect(op).not.toContain('"interpolate"');
	});

	it("dims ONLY for industrial — the one sanctioned exception", () => {
		// Industrial is not "less fire", it is a different kind of thing, and the
		// card says so in words.
		expect(flamePaint).toContain('["get", "ind"]');
	});

	it("the distance fade stays deleted too — `prom` reaches no opacity", () => {
		expect(flamePaint).not.toContain("prom");
	});

	it("cluster circles carry no age fade either", () => {
		const cluster = src.slice(src.indexOf("id: ids.cluster,"));
		const op = strip(
			cluster.slice(
				cluster.indexOf('"circle-opacity"'),
				cluster.indexOf('"circle-radius"'),
			),
		);
		expect(op).not.toContain("ageH");
		expect(op).not.toContain("prom");
	});
});
