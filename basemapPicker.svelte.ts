// Basemap picker state machine. Extracted from MapDrawControls.svelte.
//
// Owns: the hosted-basemap options list, currentKey persistence (localStorage),
// the popover open/close state, the "open from which side" geometry, the
// initial-sync effect (apply the persisted choice on first map availability),
// and the outside-pointerdown dismiss effect.
//
// Template stays in the host component — it reads basemapPicker.popoverOpen
// etc. directly. Factory (not a singleton) so offline/preview routes each get
// independent state via their own MapDrawControls instance.
import type { Map as MapboxMap } from "mapbox-gl";

export const BASEMAP_OPTIONS = [
    {
        key: "satellite",
        label: "Satellite",
        url: "mapbox://styles/mapbox/satellite-streets-v12",
    },
    {
        key: "streets",
        label: "Streets",
        url: "mapbox://styles/mapbox/streets-v12",
    },
] as const;

type BasemapKey = (typeof BASEMAP_OPTIONS)[number]["key"];

const BASEMAP_STORAGE_KEY = "retreever-basemap";

function loadPersistedKey(): BasemapKey {
    if (typeof localStorage === "undefined") return "satellite";
    const v = localStorage.getItem(BASEMAP_STORAGE_KEY);
    if (v && BASEMAP_OPTIONS.some((o) => o.key === v)) return v as BasemapKey;
    return "satellite";
}

export interface BasemapPickerDeps {
    getMap: () => MapboxMap | null;
    getOffline: () => boolean;
    /** The `.tile-wrap` div for the basemap tile — used to measure room
     *  above vs. below for popover placement, and to hit-test outside clicks. */
    getWrap: () => HTMLDivElement | undefined;
}

export interface BasemapPicker {
    readonly popoverOpen: boolean;
    readonly openSide: "above" | "below";
    readonly currentKey: BasemapKey;
    /** Open the popover (or close it if already open). */
    open(): void;
    /** Apply a basemap choice. No-op when offline (streaming lock). */
    select(key: BasemapKey): void;
}

export function createBasemapPicker(deps: BasemapPickerDeps): BasemapPicker {
    let popoverOpen = $state(false);
    let openSide = $state<"above" | "below">("below");
    let currentKey = $state<BasemapKey>(loadPersistedKey());
    let _synced = false;

    function open() {
        if (popoverOpen) {
            popoverOpen = false;
            return;
        }
        const wrap = deps.getWrap();
        if (wrap) {
            const body = wrap.closest(".mob-drawer-body") as HTMLElement | null;
            if (body) {
                const tileRect = wrap.getBoundingClientRect();
                const bodyRect = body.getBoundingClientRect();
                openSide =
                    tileRect.top - bodyRect.top > bodyRect.bottom - tileRect.bottom
                        ? "above"
                        : "below";
            }
        }
        popoverOpen = true;
    }

    function select(key: BasemapKey) {
        if (deps.getOffline()) return;
        const opt = BASEMAP_OPTIONS.find((o) => o.key === key);
        if (opt) {
            const map = deps.getMap();
            if (map) {
                currentKey = key;
                try {
                    localStorage.setItem(BASEMAP_STORAGE_KEY, key);
                } catch {
                    // codestyle-allow-swallow: localStorage write for basemap preference can fail if storage is full; cosmetic preference only
                }
                map.setStyle(opt.url);
            }
        }
        popoverOpen = false;
    }

    // Apply the persisted basemap on first map availability. Skipped on the
    // offline route (streaming lock). Satellite is the default so only runs
    // when a non-default choice was previously saved.
    $effect(() => {
        const map = deps.getMap();
        if (!map || _synced) return;
        _synced = true;
        if (deps.getOffline()) return;
        if (currentKey !== "satellite") select(currentKey);
    });

    // Dismiss on outside pointerdown WITHOUT swallowing the event — dragging
    // the drawer handle while the popover is open still reaches the drawer.
    $effect(() => {
        if (!popoverOpen) return;
        const onDown = (e: PointerEvent) => {
            const wrap = deps.getWrap();
            if (wrap?.contains(e.target as Node)) return;
            popoverOpen = false;
        };
        window.addEventListener("pointerdown", onDown, true);
        return () => window.removeEventListener("pointerdown", onDown, true);
    });

    return {
        get popoverOpen() {
            return popoverOpen;
        },
        get openSide() {
            return openSide;
        },
        get currentKey() {
            return currentKey;
        },
        open,
        select,
    };
}
