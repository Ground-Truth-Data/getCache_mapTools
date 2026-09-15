// Basemap picker state machine. Extracted from MapDrawControls.svelte.
//
// Owns: the hosted-basemap options list, currentKey persistence (localStorage),
// the popover open/close state, the "open from which side" geometry, and the
// outside-pointerdown dismiss effect. The persisted choice is read at
// CONSTRUCTION via persistedBasemapStyleUrl — never re-applied to a live map.
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

/**
 * The style the map should be BUILT with — pass to `initializeMap`'s `style`.
 *
 * A saved non-default basemap used to be applied after construction, by a
 * `setStyle` from the sync effect below: the map started loading satellite,
 * then threw it away mid-flight for streets. Every boot did a style swap, and
 * a swap leaves a window where the style will not accept sources — which the
 * draw layers' own $effect fell straight into, putting "Style is not done
 * loading" on screen. Only users who had ever picked a non-default basemap saw
 * it, which is what made it look like a browser difference.
 */
export function persistedBasemapStyleUrl(): string {
    const key = loadPersistedKey();
    return (
        BASEMAP_OPTIONS.find((o) => o.key === key) ?? BASEMAP_OPTIONS[0]
    ).url;
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
                // diff:false — two basemaps never share a sprite, so the differ
                // always bails at `setSprite` ("Unimplemented") and rebuilds
                // from scratch regardless. Asking for the diff only buys a
                // console warning per switch.
                map.setStyle(opt.url, {
                    diff: false,
                    // Mapbox types both of these as REQUIRED on SetStyleOptions
                    // though the implementation treats them as optional;
                    // undefined is what omitting the options object passes.
                    localFontFamily: undefined,
                    localIdeographFontFamily: undefined,
                });
            }
        }
        popoverOpen = false;
    }

    // NO BOOT-TIME setStyle. The persisted choice is the map's INITIAL style
    // (persistedBasemapStyleUrl, passed to initializeMap), so there is nothing
    // to correct once the map exists. Re-applying it here is what crashed the
    // page: it swapped a style that was still loading, and the draw layers
    // added sources into that gap.

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
