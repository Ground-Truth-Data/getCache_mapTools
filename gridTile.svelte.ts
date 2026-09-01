// Audit-grid tile state machine. Extracted from MapDrawControls.svelte.
//
// Owns the grid on/off + fine toggle, the transient popover dismissal timer,
// the "too dense" warning, and the initial-state restore from AppState. All
// map calls are gated on `getMap()` so the factory is safe to create before
// the map is mounted.
//
// Factory (not a singleton) — each MapDrawControls instance gets independent
// state so offline/preview routes don't share grid mode with the live map.
import type { Map as MapboxMap } from "mapbox-gl";
import {
    attachGridLifecycle,
    clearGrid,
    type GridDot,
    nearestGridDot,
    setGridGlow,
    setGridVisibility,
    setupGridSourcesAndLayers,
    updateGrid,
    type GridMode,
    type GridUpdateResult,
} from "@ground-truth/getcache-onlinemap/lib/mapGrid";
import { loadAppState, updateAppState } from "$mobRoutes/db/mutators";

export type { GridMode };

// SNAP MAGNET RADIUS, in METRES on the ground. A plot seed within this of a
// grid dot snaps to it. Metres (not pixels) is deliberate: zooming in puts more
// screen-space between dots so the user can aim into the gap to drop free — the
// escape hatch. ~3m ≈ within arm's reach of the dot centre. Tweak here.
const SNAP_RADIUS_M = 3;

export interface GridTileDeps {
    getMap: () => MapboxMap | null;
    /** Fired when the user taps "Plot" inside a grid dot's popup. The host
     *  throws a Quality 704 plot at the dot, stamped with its Plus Code.
     *  Returns true only if the plot actually dropped — false = refused
     *  (the button retracts its "confirmed" flash and re-arms). */
    onPlotFromDot?: (dot: {
        lng: number;
        lat: number;
        plusCode: string;
    }) => boolean;
    /** A TOOL OWNS THE TAP: return true while a draw/measure tool is placing
     *  geometry — grid dots then ignore taps (no popup, no camera nudge). */
    suppressTaps?: () => boolean;
}

export interface GridTile {
    readonly gridMode: GridMode;
    readonly gridFine: boolean;
    readonly popoverOpen: boolean;
    readonly warningVisible: boolean;
    toggle(): void;
    toggleFine(): void;
    /** Nearest grid dot to drop on (null = grid off). Snapping is ALWAYS on when
     *  the grid is shown. Injected into SnakeRuler as its `gridSnap` dep. */
    gridSnap(lng: number, lat: number): GridDot | null;
    /** Pulse / clear the gold snap-glow ring. SnakeRuler's `setGridGlow` dep.
     *  Accepts the minimal {lng,lat,plusCode} shape SnakeRuler hands back (the
     *  glow only needs the position) — any GridDot satisfies it. */
    setGridGlow(
        dot: { lng: number; lat: number; plusCode: string } | null,
    ): void;
    armPopoverDismiss(ms?: number): void;
    /** Cancel the auto-dismiss timer while the cursor hovers the popover. */
    pauseDismiss(): void;
    /** Call from the map-wiring effect. Sets up sources + lifecycle listener.
     *  Returns teardown (clears the lifecycle subscription + popover timer). */
    attach(m: MapboxMap): () => void;
    /** Call inside the `style.load` handler to restore grid sources + visibility
     *  after a basemap swap wipes all custom layers. */
    restoreAfterStyleLoad(m: MapboxMap): void;
}

export function createGridTile(deps: GridTileDeps): GridTile {
    const { getMap, onPlotFromDot, suppressTaps } = deps;

    let gridMode = $state<GridMode>("off");
    // Fine (10/ha) defaults ON — matches the loadAppState default so the
    // pre-restore flicker shows the same state the load will confirm.
    let gridFine = $state(true);
    let popoverOpen = $state(false);
    let popoverTimer: ReturnType<typeof setTimeout> | null = null;
    let warningVisible = $state(false);
    let warningTimer: ReturnType<typeof setTimeout> | null = null;

    // Restore persisted grid state. Async: the store is ready by the time
    // the user taps anything, so the brief initial "off" is invisible.
    if (typeof window !== "undefined") {
        void loadAppState().then((state) => {
            gridMode = state.gridMode as GridMode;
            gridFine = state.gridFine;
            if (gridMode !== "off") {
                const map = getMap();
                if (map) {
                    // Lazy sources: this restore path can be the FIRST thing to
                    // need them (persisted grid = on, map already live).
                    setupGridSourcesAndLayers(map);
                    setGridVisibility(map, true, gridMode);
                    updateGrid(map, gridMode);
                }
            }
        });
    }

    function applyGridMode(next: GridMode) {
        // State + persistence first, render best-effort: a null map (mid-mount,
        // mid-style-swap) must never eat the toggle — attach() /
        // restoreAfterStyleLoad() render whatever mode is current once the map
        // is live. Gating the persist on the map was why fine-toggles
        // sometimes silently reverted on next boot.
        gridMode = next;
        void updateAppState({ gridMode: next, gridFine: gridFine });
        const map = getMap();
        if (!map) return;
        // Sources are created lazily (see attach) — so the first time the grid
        // is switched on, build them before anything tries to draw into them.
        // Idempotent, so the 2nd..Nth toggle costs nothing.
        if (next !== "off") setupGridSourcesAndLayers(map);
        setGridVisibility(map, next !== "off", next);
        if (next === "off") {
            clearGrid(map);
        } else {
            updateGrid(map, next);
        }
    }

    function armPopoverDismiss(ms = 2500) {
        if (popoverTimer) clearTimeout(popoverTimer);
        popoverTimer = setTimeout(() => {
            popoverOpen = false;
        }, ms);
    }

    function toggle() {
        if (gridMode === "off") {
            applyGridMode(gridFine ? "fine" : "standard");
            popoverOpen = true;
            armPopoverDismiss();
        } else {
            applyGridMode("off");
            popoverOpen = false;
            if (popoverTimer) clearTimeout(popoverTimer);
        }
    }

    function toggleFine() {
        gridFine = !gridFine;
        if (gridMode !== "off") {
            applyGridMode(gridFine ? "fine" : "standard");
        } else {
            void updateAppState({ gridMode, gridFine });
        }
        armPopoverDismiss();
    }

    function handleUpdate(r: GridUpdateResult) {
        if (r.tooDense) {
            warningVisible = true;
            if (warningTimer) clearTimeout(warningTimer);
            warningTimer = setTimeout(() => {
                warningVisible = false;
            }, 1500);
        }
    }

    return {
        get gridMode() {
            return gridMode;
        },
        get gridFine() {
            return gridFine;
        },
        get popoverOpen() {
            return popoverOpen;
        },
        get warningVisible() {
            return warningVisible;
        },
        toggle,
        toggleFine,
        gridSnap(lng: number, lat: number): GridDot | null {
            // Snapping is ALWAYS on when the grid is shown — only off when the
            // grid itself is off.
            if (gridMode === "off") return null;
            return nearestGridDot(lng, lat, gridMode, SNAP_RADIUS_M);
        },
        setGridGlow(dot: GridDot | null) {
            const map = getMap();
            if (map) setGridGlow(map, dot);
        },
        armPopoverDismiss,
        pauseDismiss() {
            if (popoverTimer) clearTimeout(popoverTimer);
        },

        attach(m: MapboxMap): () => void {
            // LAZY: the grid's 5 sources + 8 layers are NOT created while the
            // grid is off. Each source carries worker-side tile state and each
            // layer carries GPU buffers, and `gridMode` starts (and for most
            // sessions stays) "off" — so the default map was paying for a
            // subsystem the user had not asked for.
            //
            // Safe because `setupGridSourcesAndLayers` is idempotent (it early-
            // returns on an existing source) and EVERY path that renders the
            // grid — applyGridMode, restoreAfterStyleLoad, and the restore
            // branch below — calls it before drawing. Turning the grid on
            // therefore creates the sources at that moment, once.
            if (gridMode !== "off") setupGridSourcesAndLayers(m);
            // RACE FIX: the persisted grid mode (loadAppState above) often resolves
            // BEFORE the map exists — getMap() returns null, so that restore path
            // sets gridMode = "fine"/"standard" but never renders. The button then
            // reads ON while the map is blank, and only toggling off/on (which runs
            // updateGrid with a live map) draws it. Here the map IS live, so honour
            // whatever mode is already restored: show + render it, not a blind "off".
            setGridVisibility(m, gridMode !== "off", gridMode);
            if (gridMode !== "off") updateGrid(m, gridMode);
            const detach = attachGridLifecycle(
                m,
                () => gridMode,
                handleUpdate,
                onPlotFromDot,
                suppressTaps,
            );
            return () => {
                detach();
                if (popoverTimer) clearTimeout(popoverTimer);
            };
        },

        restoreAfterStyleLoad(m: MapboxMap): void {
            // A style swap wipes all sources/layers. Only rebuild the grid's if
            // the grid is actually on — otherwise a basemap switch would
            // re-introduce the very cost `attach` just deferred.
            if (gridMode !== "off") setupGridSourcesAndLayers(m);
            setGridVisibility(m, gridMode !== "off", gridMode);
            // REFILL, not just re-create: setStyle wiped the sources, so they come
            // back EMPTY. Without this the grid stays invisible (button ON, map
            // blank) until the next pan/zoom happens to fire the moveend lifecycle
            // — the "grid keeps disappearing after a basemap swap" bug. Mirrors
            // the identical race fix in attach().
            if (gridMode !== "off") updateGrid(m, gridMode);
        },
    };
}
