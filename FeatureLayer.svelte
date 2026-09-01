<!--
  FeatureLayer — the regular (non-plot) feature popover + its edits, EXTRACTED from
  MapDrawControls.svelte. Sibling of PlotLayer: where PlotLayer owns the Quality-704
  plot lifecycle, FeatureLayer owns the ordinary pin / line / polygon popover —
  name + description edit, icon swap, fill-opacity slider, share, and delete — plus
  the system "Tiles cached" pin's view-only popover.

  THE SPLIT: tap any non-plot feature → FeaturePopover (editable). The "tiles" pin
  is the one exception (a view-only TilesPinPopover). Plot pins route to PlotLayer
  instead — this component's show-gates exclude them via `selectedIsPlotPin`.

  Shared host state (selection, popover positioning, the camera, `handleShare`
  which is also used by PlotLayer + the SnakeRuler save path, and `cachedDisplayName`)
  is injected as props — FeatureLayer mutates the store directly but never owns the
  selection or the share path.
-->
<script lang="ts">
import { retreeverMapPorts } from "$lib/mobile/offline/host/retreeverMapPorts";
const mapPorts = retreeverMapPorts();
import type { Feature } from "geojson";
import type { Map as MapboxMap } from "mapbox-gl";
import type { PopoverPositioning } from "./popoverPositioning.svelte";
import type { createMapStore } from "$lib/mobile/stores/mapStore.svelte";
import FeaturePopover from "@ground-truth/getcache-offlinemap/lib/mapUi/FeatureMapPopover.svelte";
import TilesPinPopover from "$lib/mobile/components/TilesPinPopover.svelte";
import ConfirmModal from "$lib/mobile/components/ui/ConfirmModal.svelte";
import {
	defaultFeatureName,
	parseAutoFeatureName,
} from "$lib/mobile/utils/naming";
import { parseEmojiPin, parsePinKey, ALL_PINS } from "$lib/mobile/utils/icons";
import { emojiName } from "$lib/mobile/emojiData/emojiName";
import type { MapShareFormat } from "$lib/mobile/utils/kmzExport";

type MapStore = ReturnType<typeof createMapStore>;

let {
	map,
	mapStore,
	popoverPos,
	selectedFeature,
	// True iff the selected feature is a `plot:N` pin — the host derives this and
	// passes it so FeatureLayer can EXCLUDE plot pins (they belong to PlotLayer).
	selectedIsPlotPin,
	// The current block number (for auto-name re-parsing on icon swap).
	blockNumber,
	cachedDisplayName,
	// Shared host wiring.
	deselect,
	onShare,
}: {
	map: MapboxMap | null;
	mapStore: MapStore;
	popoverPos: PopoverPositioning;
	selectedFeature: Feature | null;
	selectedIsPlotPin: boolean;
	blockNumber: string | null;
	cachedDisplayName: string | null;
	deselect: () => void;
	onShare: (format?: MapShareFormat) => void;
} = $props();

// Whether the selected feature is the system 'Tiles cached' pin — that one gets a
// custom view-only popover instead of the regular editable FeatureMapPopover.
let selectedIsTilesPin = $derived(
	selectedFeature?.properties?.pinTypeKey === "tiles",
);

// Tap a feature → popover. Always. Name edit + share + delete + (for pins) pin-type
// change all live here. Tiles pins route to the separate view-only popover below;
// plot pins route to PlotLayer (excluded via selectedIsPlotPin).
let showFeaturePopover = $derived(
	selectedFeature !== null &&
		popoverPos.bbox !== null &&
		map !== null &&
		!popoverPos.panning &&
		!selectedIsTilesPin &&
		!selectedIsPlotPin,
);
let showTilesPinPopover = $derived(
	selectedFeature !== null &&
		popoverPos.bbox !== null &&
		map !== null &&
		!popoverPos.panning &&
		selectedIsTilesPin,
);

// Resolve the selected feature's index in the store (the edit handlers below
// address the store by key, but read the live feature by index first).
function selectedKey(): string | null {
	return (selectedFeature?.properties?.mapFeatureKey as string) ?? null;
}

// Update pinTypeKey and auto-rename the feature if it still carries its
// auto-generated name (detected via parseAutoFeatureName). Custom names are untouched.
function changeFeatureIcon(key: string) {
	const f = selectedFeature;
	const fkey = f?.properties?.mapFeatureKey as string | undefined;
	if (!f || !fkey) return;
	const patched: Feature = {
		...f,
		properties: { ...(f.properties ?? {}), pinTypeKey: key },
	};
	const storeFeat = mapStore.activeMap?.features.find(
		(x) => x.mapFeatureKey === fkey,
	);
	const currentName = storeFeat?.featureName ?? "";
	// Legacy: `plain_red`…`plain_purple` prefix was dropped — heal old names so they re-parse.
	const healedName = currentName.replace(
		/_plain_(red|orange|yellow|green|blue|purple)(?=_|$)/,
		"_$1",
	);
	const blockSlug = (blockNumber ?? "")
		.trim()
		.replace(/[^a-zA-Z0-9_-]/g, "")
		.toLowerCase();
	const knownAbstractions = new Set(
		["Pin", ...ALL_PINS.map((p) => p.name)].map((s) => s.toLowerCase()),
	);
	if (blockSlug) knownAbstractions.add(blockSlug);
	const parsed = parseAutoFeatureName(healedName, knownAbstractions);
	const isAutoName = parsed !== null;
	let nextName: string | undefined;
	if (isAutoName) {
		// An emoji pin names the feature after the emoji's WORD, not the glyph
		// — filenames are `[A-Za-z0-9_-]` only (defaultFeatureName strips the
		// rest), so 🌲 would otherwise vanish and leave a bare "Pin". Falling
		// back to "Pin" here was the difference between `260730EvergreenTree_
		// GTUser` and a nameless `260730Pin_GTUser`.
		const emojiChar = parseEmojiPin(key);
		const newAbs = emojiChar
			? (emojiName(emojiChar) ?? "Pin")
			: (parsePinKey(key) ?? "Pin");
		nextName = defaultFeatureName("point", cachedDisplayName, newAbs);
	}
	mapStore.updateFeature(fkey, {
		geometry: patched,
		lastEditedBy: cachedDisplayName ?? undefined,
		...(nextName ? { name: nextName } : {}),
	});
}

// Slider drags arrive throttled from FillOpacitySlider; each write lands in the
// geometry JSON and the host's completed-features $effect repaints the fill — live
// feedback while the popover stays open.
function handleFillOpacity(v: number) {
	const key = selectedKey();
	if (!key) return;
	mapStore.updateFeature(key, { fillOpacity: v });
}

function handleEditSave(name: string, featureDesc: string, featureData: string) {
	const key = selectedKey();
	if (!key) return;
	mapStore.updateFeature(key, {
		name: name || "",
		// Always send desc + data (incl. "") — updateFeature skips undefined,
		// so `|| undefined` would make a cleared note silently unclearable.
		featureDesc,
		featureData,
		lastEditedBy: cachedDisplayName ?? undefined,
	});
}

// Assign contacts from the popover's CONTACTS picker. Quality plots inside
// a contact-tagged polygon inherit these (plotContacts.ts).
function handleContacts(keys: string[]) {
	const key = selectedKey();
	if (!key) return;
	mapStore.updateFeature(key, { contacts: keys });
}

// Tag a polygon with its block number from the popover's BLOCK picker.
function handleBlock(block: string) {
	const key = selectedKey();
	if (!key) return;
	mapStore.updateFeature(key, { blockNumber: block });
}

// Delete a regular feature (pin / line / polygon) from its popover's garbage can.
// Confirm first (it's destructive + can't be undone), then remove from the store
// and close the popover.
let pendingDeleteFeatureKey = $state<string | null>(null);
function requestDeleteFeature() {
	const fkey = selectedKey();
	if (fkey) pendingDeleteFeatureKey = fkey;
}
function confirmDeleteFeature() {
	const fkey = pendingDeleteFeatureKey;
	pendingDeleteFeatureKey = null;
	if (fkey) mapStore.deleteFeature(fkey);
	deselect();
}
function cancelDeleteFeature() {
	pendingDeleteFeatureKey = null;
}
</script>

{#if showFeaturePopover && selectedFeature && popoverPos.bbox && map}
	<FeaturePopover
    ports={mapPorts}
		feature={selectedFeature}
		bbox={popoverPos.bbox}
		containerWidth={map.getContainer().clientWidth}
		containerHeight={map.getContainer().clientHeight}
		onShare={onShare}
		onSave={handleEditSave}
		onClose={deselect}
		onChangeIcon={selectedFeature.geometry?.type === "Point"
			? changeFeatureIcon
			: undefined}
		onFillOpacity={handleFillOpacity}
		onDelete={requestDeleteFeature}
		onContacts={handleContacts}
		onBlock={handleBlock}
	/>
{:else if showTilesPinPopover && selectedFeature && popoverPos.bbox && map}
	<TilesPinPopover
		feature={selectedFeature}
		bbox={popoverPos.bbox}
		containerWidth={map.getContainer().clientWidth}
		containerHeight={map.getContainer().clientHeight}
		onClose={deselect}
	/>
{/if}

<!-- Delete a pin / line / polygon (the popover garbage can). Destructive + can't
     be undone, so confirm first. -->
<ConfirmModal
	open={pendingDeleteFeatureKey !== null}
	title="Delete this?"
	body="This removes the pin, line, or shape from the map. This can't be undone."
	confirmLabel="Delete"
	cancelLabel="Cancel"
	confirmVariant="danger"
	onCancel={cancelDeleteFeature}
	onConfirm={confirmDeleteFeature}
/>
