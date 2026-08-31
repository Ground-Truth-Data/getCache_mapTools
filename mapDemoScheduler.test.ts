// The frozen-hand leak (reported 2026-07-19, "DOUBLE HANDS"): cancelling the
// idle draw-tour mid-play must actually END it. The demo script is an async
// chain of tweens and plain `wait()` timeouts — a cancel that lands inside a
// wait() gap must not let the continuation re-show the hand (`place()` →
// visible) and then bail through an early return that skips the fade-out,
// stranding a full-opacity hand on the map forever.
//
// The stub hand resolves every motion instantly, which is exactly the worst
// case: the post-cancel continuation sprints through the whole drawer-drag
// unless the scheduler's liveness checks stop it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMapDemoScheduler,
	type MapDemoDeps,
} from "./mapDemoScheduler.svelte";

type StubHand = {
	visible: boolean;
	placeCalls: number;
	place: (x: number, y: number, r?: number) => void;
	fadeIn: () => Promise<void>;
	fadeOut: () => Promise<void>;
	moveTo: () => Promise<void>;
	tap: () => Promise<void>;
	cancel: () => void;
};

function makeHand(): StubHand {
	return {
		visible: false,
		placeCalls: 0,
		place() {
			this.placeCalls++;
			this.visible = true;
		},
		fadeIn: () => Promise.resolve(),
		fadeOut: () => Promise.resolve(),
		moveTo: () => Promise.resolve(),
		tap: () => Promise.resolve(),
		cancel() {
			this.visible = false;
		},
	};
}

// Minimal DOM: the scheduler only measures elements — feed it laid-out fakes
// for every selector the drawToolPan lesson touches.
function fakeEl(left: number, top: number, w: number, h: number) {
	return {
		getBoundingClientRect: () => ({ left, top, width: w, height: h }),
		closest: () => null,
	};
}
const FAKE_DOC = {
	querySelector: (sel: string) => {
		if (sel === ".mob-drawer-pullbar") return fakeEl(140, 700, 110, 40);
		if (sel === '[data-tour="map-tool-draw"]') return fakeEl(60, 560, 80, 80);
		if (sel === ".draw-strip") return fakeEl(20, 640, 180, 48);
		return null; // .mobile-map-fill / frame → viewport-origin fallback
	},
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
};

function makeDeps(hand: StubHand): MapDemoDeps {
	return {
		getMap: () => null,
		getDrawDemo: () => hand,
		getDrawer: () => ({
			close: () => undefined,
			tourAnimateOpen: () => undefined,
			tourAnimateClose: () => undefined,
		}),
		setEditMode: () => undefined,
		setDrawIntent: () => undefined,
		setShowLayersPanel: () => undefined,
		isEditActive: () => false,
		isDrawerOpen: () => false,
		isShowLayersPanel: () => false,
		isMeasuring: () => false,
		idleDemo: false,
		// Showcase mode drives the lesson directly — no idle budget, no
		// document listeners — so the test controls exactly when it plays.
		demoShowcase: "drawToolPan",
	};
}

describe("mapDemoScheduler — cancel mid-play must strike the hand from the stage", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("document", FAKE_DOC);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("a cancel landing inside the opening wait() gap ends the run hidden", async () => {
		const hand = makeHand();
		const sched = createMapDemoScheduler(makeDeps(hand));
		const stop = sched.start();

		// showcase loop: wait(900) settle → reset → wait(700) → lesson starts
		// with drawer.close() + wait(450). Land the cancel inside that 450ms.
		await vi.advanceTimersByTimeAsync(900 + 700 + 200);
		sched.cancel(); // the user tapped — the hand must never fight them
		stop(); // and no NEW showcase replays — only the cancelled run's ghost remains

		// Let every timer and instantly-resolving tween continuation play out.
		await vi.advanceTimersByTimeAsync(60_000);

		expect(hand.placeCalls).toBe(0); // never re-shown after the cancel
		expect(hand.visible).toBe(false); // and nothing left standing on the map
	});

	it("an uninterrupted run still ends with the hand off stage", async () => {
		const hand = makeHand();
		const sched = createMapDemoScheduler(makeDeps(hand));
		const stop = sched.start();

		await vi.advanceTimersByTimeAsync(60_000); // full lessons, no interruption
		stop();
		await vi.advanceTimersByTimeAsync(30_000); // drain any in-flight run

		expect(hand.placeCalls).toBeGreaterThan(0); // it actually played
		expect(hand.visible).toBe(false); // and cleaned up after itself
	});
});
