// Guided teaching-hand demos + idle scheduler. Extracted from
// MapDrawControls.svelte.
//
// A hand-cursor (MapDrawDemo) plays a short scripted lesson — slide in, tap the
// DRAW (or FEATURES) tile, peek the panel, drag the drawer back down, exit —
// the FIRST time the user sits idle on the real /mobile/map each day, on their
// first 10 days, then never again (budget: engagementTiming.ts → mapDrawHint).
// The anime/<key> showcase routes loop ONE lesson forever.
//
// Lives next to its routes-local siblings (tracking, userLocation,
// popoverPositioning) because it's bound to MapDrawDemo + the anime routes +
// the map drawer DOM. Factory (not a singleton): each component instance wires
// its own state via the deps below. Same shape as createUserLocator(() => map).
import { isVerbose } from "$lib/mobile/utils/verboseLog";
import type { Map as MapboxMap } from "mapbox-gl";
import { mapDrawHint } from "$lib/utils/engagementTiming";
import { markMotion, stillForMs } from "$lib/mobile/stores/insistActivity";

// The teaching-hand demo catalogue used to live in ./anime/mapDemos (now
// removed along with the anime showcase routes). Keep the keys local so the
// idle scheduler + MapDrawControls/MobMapPage props still type-check.
export type MapDemoKey = "drawToolPan" | "mapsPanelPeek";
export const IDLE_DEMO_KEY: MapDemoKey = "drawToolPan";

// markMotion / stillForMs come from THE shared stillness clock
// ($lib/mobile/stores/insistActivity) — the same one Get Cache and Quality 704
// use. This file used to stub them locally ("the clock was removed"), which was
// never true: the module was live the whole time. The stub made markMotion a
// no-op, so five calls below silently did nothing and the map's hand could
// talk over an animation that was already playing. One clock or none.

/** The teaching-hand cursor (MapDrawDemo.svelte) — structural to avoid
 *  importing the component class. */
interface DrawDemoRef {
    place(x: number, y: number, r?: number): void;
    fadeIn(duration?: number): Promise<void>;
    fadeOut(duration?: number): Promise<void>;
    moveTo(
        x: number,
        y: number,
        opts?: { curve?: number; rot?: number; duration?: number; ease?: string },
    ): Promise<void>;
    tap(): Promise<void>;
    cancel(): void;
}
/** The map drawer (MobDrawer.svelte) — only the tour methods are used. */
interface DrawerRef {
    close(): void;
    tourAnimateOpen(ms: number): void;
    tourAnimateClose(ms: number): void;
}

export interface MapDemoDeps {
    getMap: () => MapboxMap | null;
    getDrawDemo: () => DrawDemoRef | undefined;
    getDrawer: () => DrawerRef | undefined;
    setEditMode: (on: boolean) => void;
    setDrawIntent: (v: null) => void;
    setShowLayersPanel: (on: boolean) => void;
    isEditActive: () => boolean;
    isDrawerOpen: () => boolean;
    isShowLayersPanel: () => boolean;
    /** A live Snake Ruler (seeded point or mid-measure) owns the screen —
     *  the teaching hand must never roll the drawer up over it. */
    isMeasuring: () => boolean;
    /** Real /mobile/map opts into the idle hand; offline/preview routes don't. */
    idleDemo: boolean;
    /** anime/<key> showcase: loop ONE demo in isolation. */
    demoShowcase: MapDemoKey | null;
}

export interface MapDemoScheduler {
    /** Arm the scheduler (or showcase loop). Returns teardown. Call from
     *  the component's onMount. */
    start(): () => void;
    /** Abort a demo mid-play — called when the human reaches for a tool the
     *  hand was about to demonstrate, so it never fights the user. */
    cancel(): void;
}

const DRAW_DEMO_IDLE_MS = 3000;
// Once today's teaching-hand budget is spent, there's no point re-checking
// every 3s — drop to a slow heartbeat so a new calendar day can re-arm it.
const MAP_HINT_RECHECK_MS = 5 * 60 * 1000;

export function createMapDemoScheduler(deps: MapDemoDeps): MapDemoScheduler {
    let running = false;
    let drawIdleTimer: ReturnType<typeof setTimeout> | null = null;
    // Liveness token. A cancel (or a newer run) bumps it; every await in a demo
    // script re-checks its captured generation afterwards. Without this, a
    // cancel landing inside a plain wait() gap let the continuation re-show the
    // hand (place() → visible) and bail through an early return with no fade-
    // out — the frozen-hand-on-the-map leak.
    let runGen = 0;

    // Dev-only tracing: why the demo did / didn't fire, which lesson,
    // start/end. Filter the console for "mapDemo".
    // Was DEV-only, which still meant it printed on EVERY dev page load.
    // Opt in with localStorage.rtVerbose='mapDemo'.
    const DEMO_DEBUG = import.meta.env.DEV && isVerbose("mapDemo");
    const dlog = (...args: unknown[]): void => {
        if (DEMO_DEBUG)
            console.log("%c[mapDemo]", "color:#eab308;font-weight:700", ...args);
    };

    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // Frame-local origin: position:fixed resolves to .mobile-preview-frame on
    // dt-web (it has `contain: layout`) and to the viewport on device. Subtract
    // the frame rect so getBoundingClientRect()-derived targets line up with the
    // fixed-positioned hand.
    function demoFrameOrigin(): { left: number; top: number } {
        const frame =
            (document
                .querySelector(".mobile-map-fill")
                ?.closest(".mobile-preview-frame") as HTMLElement | null) ?? null;
        const r = frame?.getBoundingClientRect();
        return { left: r?.left ?? 0, top: r?.top ?? 0 };
    }

    // Frame-local anchor of a DOM element. `at: "top"` returns the top-center
    // (for tickling the top of a tool icon); default is the element center.
    function demoAnchor(
        selector: string,
        at: "center" | "top" = "center",
    ): { x: number; y: number } | null {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const o = demoFrameOrigin();
        return {
            x: r.left - o.left + r.width / 2,
            y: r.top - o.top + (at === "top" ? 6 : r.height / 2),
        };
    }

    function cancelMapDemo(): void {
        runGen++; // strand every in-flight continuation
        deps.getDrawDemo()?.cancel();
        running = false;
    }

    // The hand DRIVES the drawer open: slide in from the left, grab the
    // pull-bar with the fingertip, and drag it up in sync with
    // tourAnimateOpen — the mirror of the drag-close both lessons already do.
    // Returns true when the hand is on-stage (visible at the pull-bar)
    // afterwards; false = the pull-bar wasn't found and the drawer was opened
    // without the hand (caller then does its own place + fadeIn).
    const DRAWER_DRAG_PX = 230; // same ride distance as the drag-close
    async function handDragDrawerOpen(
        hand: DrawDemoRef | undefined,
        drawer: DrawerRef | undefined,
        alive: () => boolean,
    ): Promise<boolean> {
        drawer?.close();
        await wait(450); // let the close settle so the pull-bar measures true
        if (!alive()) return false; // cancelled during the settle — never place the hand
        const grab = demoAnchor(".mob-drawer-pullbar");
        if (!grab) {
            drawer?.tourAnimateOpen(1200);
            await wait(1350);
            return false;
        }
        hand?.place(-90, grab.y + 40, -14);
        await hand?.fadeIn(0.3);
        if (!alive()) return true;
        await hand?.moveTo(grab.x, grab.y, { curve: 60, rot: -2, duration: 0.9 });
        if (!alive()) return true;
        drawer?.tourAnimateOpen(1200);
        await hand?.moveTo(grab.x, grab.y - DRAWER_DRAG_PX, {
            curve: 0,
            duration: 1.2,
            ease: "power1.out",
        });
        await wait(150);
        return true;
    }

    async function runDrawDemo(): Promise<void> {
        if (running || deps.isEditActive() || deps.isDrawerOpen() || deps.isMeasuring()) {
            dlog("runDrawDemo SKIP — blocked", {
                running,
                editActive: deps.isEditActive(),
                drawerOpen: deps.isDrawerOpen(),
                measuring: deps.isMeasuring(),
            });
            return;
        }
        dlog("▶ runDrawDemo START");
        running = true;
        // This run's liveness: a cancel (or newer run) bumps runGen, and every
        // await below re-checks. The finally is the wall — no exit path may
        // leave the hand on stage.
        const gen = ++runGen;
        const alive = () => runGen === gen;
        // Hold the stillness clock for the whole demo so the scheduler can't
        // re-fire mid-play; reset to "now" in the finally.
        markMotion(60000);
        const hand = deps.getDrawDemo();
        const drawer = deps.getDrawer();
        try {
            // 1) the hand grabs the pull-bar and DRAGS the drawer open
            //    (glow behind the shovel handle)
            const handOn = await handDragDrawerOpen(hand, drawer, alive);
            if (!alive()) return;

            // 2–4) hand curves onward to the DRAW tile (only place + fade if the
            // pull-bar grab fell back to the auto-open)
            const draw = demoAnchor('[data-tour="map-tool-draw"]');
            if (!draw) throw new Error("draw tile not found");
            if (!handOn) {
                hand?.place(-90, draw.y + 70, -14);
                await hand?.fadeIn(0.3);
                if (!alive()) return;
            }
            await hand?.moveTo(draw.x, draw.y, { curve: 80, rot: -4, duration: 1.1 });
            if (!alive()) return;

            // 5) tap → open draw mode (palette appears). Set editMode directly so
            // this doesn't count as the human using draw.
            await hand?.tap();
            deps.setEditMode(true);
            await wait(280);
            if (!alive()) return;

            // 6) grab the drawer handle and drag it back down (glow turns off)
            const handle = demoAnchor(".mob-drawer-pullbar");
            if (handle) {
                await hand?.moveTo(handle.x, handle.y, { curve: 48, rot: 2, duration: 0.7 });
                if (!alive()) return;
                drawer?.tourAnimateClose(1000);
                await hand?.moveTo(handle.x, handle.y + 230, {
                    curve: 0,
                    duration: 1.0,
                    ease: "power1.in",
                });
            } else {
                drawer?.tourAnimateClose(1000);
            }
            await wait(200);
            if (!alive()) return;

            // 7–8) slide up to the palette and hover ONCE across its full width
            // (the strip is ~180px long), then exit left.
            const stripEl = document.querySelector(".draw-strip") as HTMLElement | null;
            let exitY = draw.y + 80;
            if (stripEl) {
                const o = demoFrameOrigin();
                const r = stripEl.getBoundingClientRect();
                const top = r.top - o.top + 26; // glide just below the palette's top edge (+20px lower)
                const left = r.left - o.left + 8;
                const right = r.left - o.left + r.width - 8;
                exitY = top + 70;
                // approach the right end, then a single slow hover sweep to the left
                await hand?.moveTo(right, top, { curve: 70, rot: -10, duration: 0.9 });
                if (!alive()) return;
                await hand?.moveTo(left, top, {
                    curve: 0,
                    rot: -10,
                    duration: 1.1,
                    ease: "sine.inOut",
                });
                if (!alive()) return;
            }

            // 9) slide off-screen to the left, leaving the user in draw mode
            await hand?.moveTo(-110, exitY, {
                curve: 40,
                duration: 0.7,
                ease: "power1.in",
            });
            await hand?.fadeOut(0.2);
            dlog("✓ runDrawDemo DONE");
        } catch (e) {
            dlog("✗ runDrawDemo ERROR", e);
        } finally {
            // THE WALL: whatever path ended this run — done, error, or a
            // liveness bail — the hand leaves the stage. Skip only when a
            // NEWER run owns the hand now (cancelling would strike ITS hand;
            // the cancel that made us stale already hid ours).
            if (alive()) {
                hand?.cancel();
                running = false;
            }
            markMotion(0); // restart the stillness clock from now
        }
    }

    // Second lesson: open the drawer, tap the FEATURES (PDFMAPS) tile to REVEAL
    // the maps panel, just show it for a beat, then drag the drawer back down —
    // no clicking anything inside the panel.
    async function runMapsPanelDemo(): Promise<void> {
        if (
            running ||
            deps.isEditActive() ||
            deps.isDrawerOpen() ||
            deps.isShowLayersPanel() ||
            deps.isMeasuring()
        ) {
            dlog("runMapsPanelDemo SKIP — blocked", {
                running,
                editActive: deps.isEditActive(),
                drawerOpen: deps.isDrawerOpen(),
                showLayersPanel: deps.isShowLayersPanel(),
                measuring: deps.isMeasuring(),
            });
            return;
        }
        dlog("▶ runMapsPanelDemo START");
        running = true;
        // Same liveness token + finally wall as runDrawDemo — see there.
        const gen = ++runGen;
        const alive = () => runGen === gen;
        markMotion(60000);
        const hand = deps.getDrawDemo();
        const drawer = deps.getDrawer();
        try {
            // 1) the hand grabs the pull-bar and DRAGS the drawer open
            //    (glow behind the shovel handle)
            const handOn = await handDragDrawerOpen(hand, drawer, alive);
            if (!alive()) return;

            // 2) hand curves onward to the FEATURES (PDFMAPS) tile (only place +
            // fade if the pull-bar grab fell back to the auto-open)
            const tile = demoAnchor('[data-tour="map-tool-layers"]');
            if (!tile) throw new Error("layers tile not found");
            if (!handOn) {
                hand?.place(-90, tile.y + 70, -14);
                await hand?.fadeIn(0.3);
                if (!alive()) return;
            }
            await hand?.moveTo(tile.x, tile.y, { curve: 80, rot: -4, duration: 1.1 });
            if (!alive()) return;

            // 3) tap → reveal the panel. Set the state directly so this doesn't
            // count as the human opening it.
            await hand?.tap();
            deps.setShowLayersPanel(true);
            await wait(400);
            if (!alive()) return;

            // 4) just SHOW the panel — drift down over it, then hold a beat
            const panel = demoAnchor(".mob-drawer-body", "top");
            if (panel) {
                await hand?.moveTo(panel.x, panel.y + 50, {
                    curve: 28,
                    rot: 0,
                    duration: 0.7,
                });
            }
            await wait(1500);
            if (!alive()) return;

            // 5) grab the drawer handle and drag it back down (glow turns off)
            const handle = demoAnchor(".mob-drawer-pullbar");
            if (handle) {
                await hand?.moveTo(handle.x, handle.y, { curve: 48, rot: 2, duration: 0.7 });
                if (!alive()) return;
                drawer?.tourAnimateClose(1000);
                await hand?.moveTo(handle.x, handle.y + 230, {
                    curve: 0,
                    duration: 1.0,
                    ease: "power1.in",
                });
            } else {
                drawer?.tourAnimateClose(1000);
            }
            await wait(200);
            if (!alive()) return;

            // 6) hand slides off-screen; reset the panel back to the home grid
            await hand?.moveTo(-110, (handle?.y ?? tile.y) + 80, {
                curve: 40,
                duration: 0.6,
                ease: "power1.in",
            });
            await hand?.fadeOut(0.2);
            deps.setShowLayersPanel(false);
            dlog("✓ runMapsPanelDemo DONE");
        } catch (e) {
            dlog("✗ runMapsPanelDemo ERROR", e);
        } finally {
            if (alive()) {
                hand?.cancel();
                running = false;
            }
            markMotion(0);
        }
    }

    // Every map demo, keyed. The idle nudge fires IDLE_DEMO_KEY; the showcase
    // routes (anime/<key>) loop whichever key they're given. Source of truth for
    // keys + routes + descriptions: ./anime/mapDemos.ts.
    const MAP_DEMO_FNS: Record<MapDemoKey, () => Promise<void>> = {
        drawToolPan: runDrawDemo,
        mapsPanelPeek: runMapsPanelDemo,
    };

    // Activity beacon: any interaction bumps it (and cancels a demo in flight so
    // the hand never fights the user).
    function bumpDrawIdle(): void {
        markMotion();
        if (running) cancelMapDemo();
    }
    // The demo never butts in while the user is busy. Crucially the draw demo ENDS
    // in draw mode, so editActive stays true afterwards — that's what stops it
    // re-firing until the user exits the draw tool. (That IS the "don't do it if
    // the draw tool is already open" rule, for free.)
    function demoBlocked(): boolean {
        return (
            running ||
            deps.isEditActive() ||
            deps.isDrawerOpen() ||
            deps.isShowLayersPanel() ||
            deps.isMeasuring()
        );
    }

    // Idle scheduler (real /mobile/map): after 3s of stillness, play the draw-tool
    // pan — unless the draw tool / a drawer is already open. Re-armed forever, but
    // the guard means it only actually fires when idle AND draw is closed.
    async function drawIdleTick(): Promise<void> {
        if (!mapDrawHint.shouldShow()) {
            drawIdleTimer = setTimeout(drawIdleTick, MAP_HINT_RECHECK_MS);
            return;
        }
        const quiet = stillForMs();
        if (quiet < DRAW_DEMO_IDLE_MS) {
            drawIdleTimer = setTimeout(drawIdleTick, DRAW_DEMO_IDLE_MS - quiet);
            return;
        }
        if (demoBlocked()) {
            drawIdleTimer = setTimeout(drawIdleTick, DRAW_DEMO_IDLE_MS);
            return;
        }
        dlog("idle reached → firing", IDLE_DEMO_KEY);
        // Count this calendar day BEFORE the (awaited) play so an interrupted demo
        // still uses up today's slot — once a day means once a day, shown or not.
        mapDrawHint.recordShown();
        await MAP_DEMO_FNS[IDLE_DEMO_KEY]();
        drawIdleTimer = setTimeout(drawIdleTick, MAP_HINT_RECHECK_MS);
    }

    // Showcase loop (the anime/<key> routes): replay one demo forever, resetting
    // to a neutral state between runs so it always plays from the top.
    let showcaseStop = false;
    async function runShowcaseLoop(key: MapDemoKey): Promise<void> {
        const fn = MAP_DEMO_FNS[key];
        if (!fn) return;
        await wait(900); // let the map + drawer DOM settle before the first run
        while (!showcaseStop) {
            deps.setEditMode(false);
            deps.setDrawIntent(null);
            deps.setShowLayersPanel(false);
            deps.getDrawer()?.close();
            await wait(700);
            if (showcaseStop) break;
            dlog("showcase ▶", key);
            await fn();
            await wait(2200);
        }
    }

    return {
        cancel: cancelMapDemo,
        start(): () => void {
            // Showcase route: loop ONE demo in isolation, nothing else.
            if (deps.demoShowcase) {
                void runShowcaseLoop(deps.demoShowcase);
                return () => {
                    showcaseStop = true;
                    cancelMapDemo();
                };
            }

            // Only the real /mobile/map opts into the idle teaching hand. Offline +
            // preview routes reuse this component but must stay quiet.
            if (!deps.idleDemo)
                return () => {
                    /* idle demo not enabled here — no-op detach */
                };

            const onInput = () => bumpDrawIdle();
            document.addEventListener("pointerdown", onInput, true);
            document.addEventListener("wheel", onInput, {
                passive: true,
                capture: true,
            });
            document.addEventListener("touchstart", onInput, {
                passive: true,
                capture: true,
            });
            document.addEventListener("keydown", onInput, true);
            markMotion();
            drawIdleTimer = setTimeout(drawIdleTick, DRAW_DEMO_IDLE_MS);
            dlog(
                "armed — idle scheduler running. Fires",
                IDLE_DEMO_KEY,
                "after 3s still while draw is closed.",
            );

            // Map camera motion also counts as activity (pan/zoom while idle-watching).
            let mapWired: MapboxMap | null = null;
            const wireMap = () => {
                const map = deps.getMap();
                if (mapWired || !map) return;
                mapWired = map;
                map.on("movestart", bumpDrawIdle);
            };
            wireMap();
            const wireInterval = setInterval(wireMap, 500);

            // Dev escape hatch: trigger any demo on demand from the console.
            if (import.meta.env.DEV) {
                (window as unknown as { drawDemo?: () => void }).drawDemo = () =>
                    void runDrawDemo();
                (window as unknown as { mapsDemo?: () => void }).mapsDemo = () =>
                    void runMapsPanelDemo();
            }

            return () => {
                document.removeEventListener("pointerdown", onInput, true);
                document.removeEventListener("wheel", onInput, true);
                document.removeEventListener("touchstart", onInput, true);
                document.removeEventListener("keydown", onInput, true);
                if (drawIdleTimer) clearTimeout(drawIdleTimer);
                clearInterval(wireInterval);
                mapWired?.off("movestart", bumpDrawIdle);
                cancelMapDemo();
            };
        },
    };
}
