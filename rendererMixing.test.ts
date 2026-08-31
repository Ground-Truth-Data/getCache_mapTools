/**
 * rendererMixing.test.ts — the ONE bug that keeps coming back on /offline.
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────
 *
 * Two renderers are live in this app and they are NOT interchangeable:
 *
 *   /map      → Mapbox GL JS
 *   /offline  → MapLibre GL JS
 *
 * Shared map code (PlotLayer, pinMarkers, SnakeRuler, fireLayer, …) is used by
 * BOTH routes. Build one library's `Marker` / `Popup` and `.addTo()` the other
 * library's map and it throws from inside the class's own `addTo`, because it
 * reaches for a private method only its own Map has:
 *
 *   new mapboxgl.Marker(...).addTo(maplibreMap)
 *     → TypeError: _addMarker is not a function
 *   new mapboxgl.Popup(...).addTo(maplibreMap)
 *     → TypeError: _requestDomTask is not a function
 *
 * Both verified against the live /offline map on 2026-08-20. They are ONE root
 * cause wearing two error messages, which is exactly why reading the console
 * made it look like two unrelated bugs.
 *
 * ── WHY A TEST AND NOT JUST A FIX ────────────────────────────────────────
 *
 * This has now bitten three times: the blue dot (userLocation), the plot ghost
 * pin (PlotLayer), and latently in fireLayer's popup default. Each time the fix
 * was correct and each time the NEXT shared-map file was written with a bare
 * `new mapboxgl.Marker`, because nothing stops you.
 *
 * `$lib/mobile/map/rendererOf.ts` is the seam: `markerCtor(map)` / `popupCtor(map)`
 * ask the LIVE INSTANCE which library built it (the renderer stamps its own
 * namespaced class on the canvas container). A call site cannot forget to sniff
 * the way it can forget to thread a `library` prop through.
 *
 * So this test enforces the SEAM, not any single call site: no shared map file
 * may construct a Marker or Popup from a bare library import. Add a new shared
 * map file and get this wrong, and you get a red test instead of a black map.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

/**
 * Directories holding map code reached by BOTH routes.
 *
 * `src/routes/(getcache)/map/` is shared wholesale: /offline imports
 * MapDrawControls from it, which pulls in PlotLayer, FeatureLayer and the rest.
 */
const SHARED_DIRS = [
	join(REPO, "src", "routes", "(getcache)", "map"),
	join(REPO, "src", "lib", "mobile", "components", "mobMap"),
	join(REPO, "src", "lib", "mobile", "map"),
	// the harness's map shells are shared by BOTH routes too. Leaving this out is
	// how the hospital popup in mapInit.ts kept its hardcoded
	// `new mapboxgl.Popup(...)` — the actual source of the
	// `_requestDomTask` error seen on /offline. A guard that only watches
	// ReTreever's half of a two-repo component tree is a guard with a hole.
	join(REPO, "harness", "src", "lib", "components", "map"),
];

/**
 * Files exempt from the ban, each for a stated reason. An exemption is a
 * DECISION, so it must be written down here rather than discovered.
 */
const EXEMPT = new Set([
	// The seam itself — it is the one file whose job is to import both
	// libraries and hand back the right class.
	"src/lib/mobile/map/rendererOf.ts",
	// Instrumentation that deliberately patches BOTH libraries' prototypes.
	"src/lib/mobile/map/pinDrift.ts",
	// Sniffs the instance inline and picks the library itself (predates
	// rendererOf; equivalent behaviour, verified by the assertion below).
	"src/routes/(getcache)/map/userLocation.svelte.ts",
]);

function walk(dir: string): string[] {
	let out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			out = out.concat(walk(full));
		} else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
			out.push(full);
		}
	}
	return out;
}

function sharedMapFiles(): Array<{ rel: string; src: string }> {
	const files: Array<{ rel: string; src: string }> = [];
	for (const dir of SHARED_DIRS) {
		for (const full of walk(dir)) {
			const rel = relative(REPO, full).split("\\").join("/");
			if (EXEMPT.has(rel)) continue;
			files.push({ rel, src: readFileSync(full, "utf8") });
		}
	}
	return files;
}

/**
 * Strip comments and template/quoted strings before scanning.
 *
 * Every one of these files DISCUSSES `new mapboxgl.Marker` at length in its
 * header comment — that prose is the documentation of this very bug and must
 * not trip the test. Only real code counts.
 */
function codeOnly(src: string): string {
	// TWO ordered passes: comments first, THEN strings.
	//
	// Both simpler approaches were tried and both silently ate the very call
	// sites under test — the worst failure mode for a guard, since it turns a
	// real assertion into a vacuous one:
	//
	//  • Chained regex replaces: these files are full of prose like "the map's
	//    canvas". An apostrophe inside a comment opened a string literal that
	//    the quote-stripping regex closed hundreds of lines later.
	//  • One interleaved scan: a `"` inside a block comment was read as a
	//    string opener, swallowing lines 1146-1194 of fireLayer.ts whole.
	//
	// Stripping every comment BEFORE looking for a single quote means no quote
	// inside prose is ever mistaken for code. Comment syntax does not nest, so
	// pass one is safe on its own.
	let noComments = "";
	let i = 0;
	while (i < src.length) {
		const two = src.slice(i, i + 2);
		if (two === "/*") {
			const end = src.indexOf("*/", i + 2);
			i = end === -1 ? src.length : end + 2;
			noComments += " ";
		} else if (two === "//") {
			const end = src.indexOf("\n", i);
			i = end === -1 ? src.length : end;
			noComments += " ";
		} else if (src.startsWith("<!--", i)) {
			const end = src.indexOf("-->", i + 4);
			i = end === -1 ? src.length : end + 3;
			noComments += " ";
		} else {
			noComments += src[i];
			i++;
		}
	}

	// Pass two: blank string literals, but NEVER let one run past its own line.
	//
	// `'` is not reliably a quote even in real code — Svelte markup and JSX-ish
	// attributes aside, this repo has strings such as
	//   "[fire] could not load hotspots — showing what's cached"
	// where an apostrophe sits inside a double-quoted literal. Any desync makes
	// a quote scanner devour the rest of the file, which is how this guard
	// twice ended up asserting against an empty string and passing vacuously.
	//
	// Bounding every literal to a single line makes desync self-healing: the
	// worst case is one mangled line, never a swallowed function. Real
	// multi-line strings here are template literals used for HTML, which
	// contain no `new mapboxgl.Marker(` for us to miss.
	const out: string[] = [];
	for (const line of noComments.split("\n")) {
		let acc = "";
		let j = 0;
		while (j < line.length) {
			const ch = line[j];
			if (ch === '"' || ch === "'" || ch === "`") {
				j++;
				while (j < line.length && line[j] !== ch) {
					j += line[j] === "\\" ? 2 : 1;
				}
				j++; // closing quote (or end of line)
				acc += ch + ch;
			} else {
				acc += ch;
				j++;
			}
		}
		out.push(acc);
	}
	return out.join("\n");
}

describe("renderer mixing — shared map code must not hardcode a GL library", () => {
	it("finds the shared map files at all (guards against a silent empty sweep)", () => {
		// A path typo would make every assertion below pass vacuously — the
		// worst possible outcome for a guard test.
		const files = sharedMapFiles();
		expect(files.length).toBeGreaterThan(10);
		expect(files.map((f) => f.rel)).toContain(
			"src/routes/(getcache)/map/PlotLayer.svelte",
		);
	});

	it("never constructs a Marker or Popup from a bare library import", () => {
		const offenders: string[] = [];
		for (const { rel, src } of sharedMapFiles()) {
			const code = codeOnly(src);
			// `new mapboxgl.Marker(` / `new maplibregl.Popup(` / `new mb.Popup(`
			//
			// ONLY the namespace-qualified form is banned. A BARE `new Popup(`
			// is not evidence of anything: fireLayer destructures `Popup` from
			// its injected `loadPopupLib()`, which is the correct pattern, and
			// `new (popupCtor(map))(...)` is correct too. Flagging bare
			// constructions produced two false positives on already-correct
			// code — a guard that cries wolf gets deleted, so it stays narrow.
			const qualified =
				/\bnew\s+(?:mapboxgl|maplibregl|mapbox|maplibre|mb|ml)\s*\.\s*(Marker|Popup)\s*\(/g;
			let m: RegExpExecArray | null = qualified.exec(code);
			while (m !== null) {
				offenders.push(`${rel}: ${m[0].trim()}`);
				m = qualified.exec(code);
			}
			// The other shape of the same mistake: awaiting the library module
			// directly and pulling a Marker/Popup out of it. This is exactly
			// what PlotLayer did — `import("mapbox-gl").then(({ Marker }) => …`.
			const direct =
				/import\s*\(\s*(?:""|``|'')\s*\)[\s\S]{0,80}?\b(Marker|Popup)\b/g;
			let d: RegExpExecArray | null = direct.exec(code);
			while (d !== null) {
				// Only flag when the literal was a GL library. Strings are
				// blanked by codeOnly, so re-check the raw source nearby.
				const around = src.slice(
					Math.max(0, d.index - 40),
					d.index + d[0].length + 40,
				);
				if (/mapbox-gl|maplibre-gl/.test(around)) {
					offenders.push(`${rel}: import(gl).then({ ${d[1]} })`);
				}
				d = direct.exec(code);
			}
		}
		expect(
			offenders,
			"Use markerCtor(map) / popupCtor(map) from $lib/mobile/map/rendererOf " +
				"instead — the /offline route is MapLibre and a Mapbox Marker/Popup " +
				"throws _addMarker / _requestDomTask when attached to it.",
		).toEqual([]);
	});

	it("PlotLayer's ghost pin goes through the seam", () => {
		// The regression that started this: the ghost "Plot N" plaque was built
		// with a hardcoded `import("mapbox-gl")`, so every plot drop on /offline
		// threw mid-effect and left the plaque floating unattached.
		const src = readFileSync(
			join(REPO, "src", "routes", "(getcache)", "map", "PlotLayer.svelte"),
			"utf8",
		);
		expect(src).toContain("markerCtor");
		expect(codeOnly(src)).toContain("new (markerCtor(map))(");
	});

	it("fireLayer's popup default asks the map rather than assuming Mapbox", () => {
		// No caller has ever passed `popupLib`, so the DEFAULT is the real code
		// path. It used to hardcode mapbox-gl — a crash waiting for fires to be
		// re-enabled on /offline.
		const raw = readFileSync(
			join(REPO, "src", "routes", "(getcache)", "map", "fireLayer.ts"),
			"utf8",
		);
		const code = codeOnly(raw);
		// The seam is imported and actually called on the map instance.
		expect(code).toContain("popupCtor");
		expect(code).toMatch(/popupCtor\s*\(\s*map\s*\)/);
		// And the old hardcoded default is gone: no `import("mapbox-gl")`
		// anywhere in real code (string contents survive comment-stripping as
		// `""`, so this checks the CALL, which is what mattered).
		expect(code).not.toMatch(/popupLib\s*\?\?[\s\S]{0,300}\bimport\s*\(/);
	});

	it("userLocation's exemption is real — it sniffs the instance itself", () => {
		// An exemption that stops being true is worse than no exemption. This
		// pins the reason the file is on the list.
		const src = readFileSync(
			join(REPO, "src", "routes", "(getcache)", "map", "userLocation.svelte.ts"),
			"utf8",
		);
		expect(src).toContain("maplibregl");
		expect(src).toContain("getCanvasContainer");
	});
});
