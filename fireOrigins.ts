/**
 * fireOrigins.ts — WHERE the fire layer measures relevance from.
 *
 * The policy ("relevance is proximity to ground you have a stake in", the cap,
 * the merge distance) lives in `fireRelevance.ts` as pure functions. This file
 * is only the part that has to know about THIS app: reading `mapStore` and the
 * stored GPS fix and turning them into candidate anchors.
 *
 * ── The bug it fixes ──
 * A user in Vancouver created a feature in Manitoba. The bake service had
 * already downloaded the fires around it — `refreshFires()` bakes a 500 km disc
 * around every feature anchor, and has since it was written. But the render
 * path collapsed the origin to ONE point (`readStoredFix() ?? mapCentre`), so
 * every one of those hotspots failed the 500 km wall and the map drew nothing
 * on the one piece of ground the user had just said they cared about.
 *
 * So this is deliberately a RENDER-side fix. Nothing new is downloaded, no new
 * battery is spent, no permission is asked: the data was already on the phone
 * and the layer was throwing it away.
 *
 * ⚠️ Uses feature `lastTouched`, NOT map `lastTouched`. A map's stamp moves when
 * anything inside it changes (switchMap, reorder, an import) — it answers "which
 * map did you look at", where the anchor question is "which GROUND did you
 * touch". Sorting maps would let opening an old map for a second outrank the
 * block you just drew.
 */
import { anchorsOf, isBlobAnchor } from "@ground-truth/getcache-offlinemap/lib/shared/anchors";
import {
	type FireAnchorInput,
	fireAnchors,
} from "@ground-truth/getcache-offlinemap/routes/fires/fireRelevance";
import { readStoredFix } from "@ground-truth/getcache-offlinemap/lib/shared/liveFix";

/**
 * How far back a touched feature still counts as ground you have a stake in.
 *
 * Thirty days. Generous on purpose: a block you set up last week is exactly the
 * thing you want fire news about, and the recency SORT plus the anchor cap
 * already keep the set small. This window's only job is to stop a feature you
 * abandoned last season from permanently holding one of three anchor slots.
 */
export const ANCHOR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Candidate anchors, newest-touched first, before the cap and merge.
 *
 * Split out from `fireOrigins` so a test can inspect the raw candidate list
 * without a live store.
 */
export function anchorCandidates(
	maps: ReadonlyArray<{
		features: ReadonlyArray<{
			geometry: GeoJSON.Feature | null;
			overlayBounds: [number, number, number, number] | null;
			lastTouched: string;
		}>;
	}>,
	now: number,
): FireAnchorInput[] {
	const out: FireAnchorInput[] = [];
	for (const m of maps) {
		for (const f of m.features) {
			if (!isBlobAnchor(f)) continue;
			const touchedAt = Date.parse(f.lastTouched);
			if (!Number.isFinite(touchedAt)) continue;
			if (now - touchedAt > ANCHOR_MAX_AGE_MS) continue;
			// A line samples to many anchors and a PDF to four corners; for the fire
			// wall they are ONE place, and the 200 km merge would collapse them
			// anyway. Taking the first keeps the candidate list small.
			const [at] = anchorsOf(f);
			if (at) out.push({ at, touchedAt });
		}
	}
	return out;
}

/** The shape `fireOrigins` needs from a map — structural, so a test can supply
 *  plain objects and this module never imports the store. */
export interface AnchorSourceMap {
	readonly features: ReadonlyArray<{
		geometry: GeoJSON.Feature | null;
		overlayBounds: [number, number, number, number] | null;
		lastTouched: string;
	}>;
}

/**
 * THE anchor set the fire layer measures from.
 *
 * `mapCentre` is the last-resort fallback for a user with no fix and no
 * features — without it a brand-new install would draw an empty layer, which
 * reads as "no fires near you", the most dangerous thing this layer can say.
 *
 * `maps` is passed IN rather than read from `mapStore` here: importing the
 * store pulls the Supabase client and `$env/static/public` into this module's
 * graph, which puts a network client behind a geometry calculation. The one
 * caller that has a store reads it (see `fireLayer.ts`).
 */
export function fireOrigins(
	mapCentre: readonly [number, number],
	maps: ReadonlyArray<AnchorSourceMap>,
	now: number = Date.now(),
): Array<readonly [number, number]> {
	const fix = readStoredFix(now);
	const candidates: FireAnchorInput[] = [
		// The live fix outranks everything — it is where you ARE, and its slot is
		// never spent by a feature you touched a moment ago.
		...(fix ? [{ at: fix, touchedAt: Number.POSITIVE_INFINITY }] : []),
		...anchorCandidates(maps, now),
	];
	const anchors = fireAnchors(candidates);
	return anchors.length > 0 ? anchors : [mapCentre];
}

/**
 * ⛔ THE CAMERA WALL — does moving the map change which fires are relevant?
 *
 * Almost always NO, and that is the whole point. `fireOrigins` falls back to
 * `mapCentre` ONLY when there is no stored fix AND no recently-touched feature
 * (see the `anchors.length > 0` line directly above — this predicate is that
 * condition, named). For everyone else the anchors are where they ARE and the
 * ground they have touched, neither of which a pan can move.
 *
 * ── Why this exists as a GATE rather than another optimisation ──
 * The fire layer was wired to `moveend`, so every pan and zoom re-entered the
 * paint path. Three separate fixes made that path cheaper — a union memo, an
 * outline memo, an idle-defer — and each one left the coupling itself intact,
 * so the cost came back the moment new fire work was added. Making the wrong
 * work fast is not the same as not doing it.
 *
 * This is the deepest layer the fix fits at: not inside `paint()` (which by
 * then has already been called), but at the decision to call it at all. A
 * located user now does ZERO fire work on pan — not less, none.
 *
 * ⚠️ It must stay a QUESTION ABOUT THE DATA, never a throttle or a zoom test.
 * The unlocated case genuinely does follow the camera, and suppressing it would
 * show a brand-new install an empty layer — "no fires near you", the most
 * dangerous thing this layer can say.
 */
export function fireFollowsCamera(
	maps: ReadonlyArray<AnchorSourceMap>,
	now: number = Date.now(),
): boolean {
	if (readStoredFix(now) !== null) return false;
	return anchorCandidates(maps, now).length === 0;
}
