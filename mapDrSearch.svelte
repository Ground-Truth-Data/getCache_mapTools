<!--
    mapDrSearch — Search / geocode TOP DRAWER.
    Presented as an InputPopover top drawer (the keyboard owns the bottom of
    the screen, the drawer owns the top) so the suggestion list is never
    hidden behind the keypad — the bottom modules drawer can stay open
    beneath it. Debounced Mapbox geocoding, plus instant local recognition
    of coordinate queries (Plus Codes, decimal GPS, DMS) via parseCoordSearch.
    Parent provides map center for proximity bias and handles result selection.
-->
<script lang="ts">
import InputPopover from "$lib/mobile/components/ui/InputPopover.svelte";
import RowCard from "$lib/mobile/components/ui/RowCard.svelte";
import SearchInput from "$lib/mobile/components/ui/SearchInput.svelte";
import { parseCoordSearch } from "$lib/mobile/utils/coordSearch";
import { nearestPlaceLabel } from "$lib/mobile/utils/nearestPlace";
import { iconPath } from "$lib/mobile/utils/icons";

type SearchResult = {
    place_name: string;
    center: [number, number];
    /** Nearest-place reference for a coordinate hit, most specific
     *  first — e.g. "22 km N of Swan Hills, AB". Rendered as the row
     *  subtitle so a typed GPS point visibly resolves to a PLACE —
     *  without it the row just echoes the query and users don't
     *  realize it's a tappable result. */
    context?: string;
};

let {
    onBack,
    onSelectResult,
    getMapCenter,
}: {
    onBack: () => void;
    onSelectResult: (result: SearchResult) => void;
    getMapCenter?: () => { lng: number; lat: number } | null;
} = $props();

let searchQuery = $state("");
let searchResults = $state<SearchResult[]>([]);
let searchLoading = $state(false);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// A coordinate query (Plus Code / decimal GPS / DMS) resolves locally and
// instantly — no debounce, no network, no 4-char minimum interplay.
let coordHit = $state(false);

function onSearchInput(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    searchQuery = val;
    if (debounceTimer) clearTimeout(debounceTimer);

    const coord = parseCoordSearch(val);
    if (coord) {
        coordHit = true;
        searchLoading = false;
        searchResults = [
            { place_name: coord.label, center: [coord.lng, coord.lat] },
        ];
        // Enrich the instant local row with WHERE that point is. Debounced
        // so mid-typing coords don't churn lookups.
        debounceTimer = setTimeout(
            () => resolvePlaceContext(coord.lat, coord.lng),
            300,
        );
        return;
    }
    coordHit = false;

    if (val.length < 4) {
        searchResults = [];
        return;
    }
    searchLoading = true;
    debounceTimer = setTimeout(() => geocodeSearch(val), 300);
}

// Resolve a coordinate hit to its nearest named place — "22 km N of
// Swan Hills, AB", most specific first. Replaces the old Mapbox reverse
// geocode: containment-based reverse geocoding answers "Alberta, Canada"
// for any bush point (the only polygon containing it is the province),
// which tells someone working in Alberta nothing. nearestPlaceLabel runs
// against the bundled gazetteer, so this enrichment also works OFFLINE.
// Purely additive: the coord row is already shown and tappable; a null
// label (gazetteer unavailable, mid-ocean) just leaves the subtitle off.
// The id guard drops stale lookups when the user keeps editing.
let reverseId = 0;
async function resolvePlaceContext(lat: number, lng: number) {
    const id = ++reverseId;
    const label = await nearestPlaceLabel(lat, lng);
    if (!label || id !== reverseId) return;
    if (coordHit && searchResults.length === 1) {
        searchResults = [{ ...searchResults[0], context: label }];
    }
}

async function geocodeSearch(query: string) {
    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token) {
        searchLoading = false;
        return;
    }
    const encoded = encodeURIComponent(query);
    let url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${token}&autocomplete=true&limit=5`;
    const center = getMapCenter?.();
    if (center) {
        url += `&proximity=${center.lng},${center.lat}`;
    }
    try {
        const res = await fetch(url);
        if (!res.ok) {
            searchResults = [];
            return;
        }
        const data = await res.json();
        searchResults = (data.features ?? []).map(
            (f: { place_name: string; center: [number, number] }) => ({
                place_name: f.place_name,
                center: f.center,
            }),
        );
    } catch {
        searchResults = [];
    } finally {
        searchLoading = false;
    }
}

function handleSelect(result: SearchResult) {
    // Fly the map to the place, then close the drawer so the user lands
    // straight on the zoomed map. Deliberately DON'T refill the input with
    // the full place name — that left a ≥4-char query with no results and
    // flashed the bleak "No results" empty state on the way out.
    searchResults = [];
    onSelectResult(result);
    onBack();
}
</script>

<InputPopover drawer title="search" onClose={onBack}>
    <div class="search-body">
        <SearchInput
            bind:value={searchQuery}
            placeholder="Town, address, GPS, plus code..."
            autofocus
            oninput={onSearchInput}
            onclear={() => { searchResults = []; coordHit = false; reverseId++; }}
        />

        {#if searchLoading}
            <p class="rt-text-meta">Searching...</p>
        {/if}

        {#if searchResults.length > 0}
            <ul class="search-results">
                {#each searchResults as result (result.place_name)}
                    <li>
                        <!-- Pin glyph, not the map-app logo: every search
                             result is a POINT to fly to, and the pin makes
                             the row read as "a place on the map". -->
                        <RowCard
                            title={result.place_name}
                            subtitle={result.context ?? ""}
                            glyphSrc={iconPath("pin")}
                            showChevron={false}
                            onOpen={() => handleSelect(result)}
                        />
                    </li>
                {/each}
            </ul>
        {:else if !coordHit && searchQuery.length >= 4 && !searchLoading}
            <p class="rt-text-meta">No results</p>
        {:else if !coordHit && searchQuery.length > 0 && searchQuery.length < 4}
            <p class="rt-text-meta">Type {4 - searchQuery.length} more character{4 - searchQuery.length === 1 ? '' : 's'}...</p>
        {/if}
    </div>
</InputPopover>

<style>
    .search-body {
        display: flex;
        flex-direction: column;
        gap: var(--rt-space-2);
    }
    .search-results {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--rt-space-1);
    }
</style>
