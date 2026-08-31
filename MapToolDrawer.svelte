<!--
  MapToolDrawer — the 3×2 tool tile grid that lives inside the map's MobDrawer:
  DRAW · FEATURES · BASEMAP · LOCATE · GRID · TRACKS · SEARCH · NEW MAP · LEGEND.

  Extracted from MapDrawControls so that file isn't carrying ~160 lines of tile
  markup + its CSS. Pure presentational glue: every tile is a <Card> wired to a
  host-owned handler or a host-owned tile-state object (gridTile / basemapPicker /
  tracking). The host still owns all the logic; this just lays the tiles out and
  routes clicks. The BASEMAP + GRID tiles carry their own anchored <Popover>.
-->
<script lang="ts">
import { BASEMAP_OPTIONS } from "./basemapPicker.svelte";
import type { createBasemapPicker } from "./basemapPicker.svelte";
import type { createGridTile } from "./gridTile.svelte";
import { tracking } from "./tracking.svelte";
import Card from "$lib/mobile/components/ui/Card.svelte";
import FadedDivider from "$lib/mobile/components/ui/FadedDivider.svelte";
import IconBox from "$lib/mobile/components/ui/IconBox.svelte";
import Icon from "$lib/core/icon/Icon.svelte";
import MaskedIcon from "$lib/mobile/components/ui/MaskedIcon.svelte";
import Popover from "$lib/mobile/components/ui/Popover.svelte";
import PopoverOption from "$lib/mobile/components/ui/PopoverOption.svelte";
import Checkbox from "$lib/mobile/components/ui/Checkbox.svelte";

let {
	// Per-instance tile-state objects (host-owned).
	gridTile,
	basemapPicker,
	// Scalar tile state.
	editActive,
	locating,
	offline,
	offlineBasemapLayers,
	// Tile handlers.
	toggleDrawMode,
	openLayersPanel,
	locateMe,
	toggleTracking,
	openSearchPanel,
	newMap,
	onLegend,
	// bind:this passthrough so the host can anchor the basemap popover dismissal.
	basemapTileWrap = $bindable(),
}: {
	gridTile: ReturnType<typeof createGridTile>;
	basemapPicker: ReturnType<typeof createBasemapPicker>;
	editActive: boolean;
	locating: boolean;
	offline: boolean;
	offlineBasemapLayers?: Array<{ key: string; label: string; on: boolean; toggle: () => void }>;
	toggleDrawMode: () => void;
	openLayersPanel: () => void;
	locateMe: () => void;
	toggleTracking: () => void;
	openSearchPanel: () => void;
	newMap: () => void;
	onLegend?: () => void;
	basemapTileWrap?: HTMLElement;
} = $props();
</script>

<div class="map-drawer-home">
<!-- Rails above + below the grid — the ONE shared FadedDivider (gold,
     fading out to the sides — identical to the stats page's). -->
<FadedDivider />

<div class="mapModule-grid">
	<div class="tile-wrap" data-tour="map-tool-draw">
	<Card variant={editActive ? "active" : "default"} onclick={toggleDrawMode}>
		{#snippet icon()}
			<IconBox>
				<Icon name="edit" size={32} />
			</IconBox>
		{/snippet}
		<span class="rt-text-pill">DRAW</span>
	</Card>
	</div>

	<div class="tile-wrap" data-tour="map-tool-layers">
	<Card onclick={openLayersPanel}>
		{#snippet icon()}
			<IconBox>
				<Icon name="layers" size={32} />
			</IconBox>
		{/snippet}
		<span class="rt-text-pill layers-label">FEATURES<small class="layers-sub">(PDFMAPS)</small></span>
	</Card>
	</div>

	{#if !offline || offlineBasemapLayers}
	<div class="tile-wrap" data-tour="map-tool-basemap" bind:this={basemapTileWrap}>
		<Card variant={basemapPicker.popoverOpen ? "selected" : "default"} onclick={basemapPicker.open}>
			{#snippet icon()}
				<IconBox>
					<Icon name="globe" size={36} />
				</IconBox>
			{/snippet}
			<span class="rt-text-pill">BASEMAP</span>
		</Card>

		{#if basemapPicker.popoverOpen}
			<Popover side={basemapPicker.openSide} title="Basemap">
				{#if offline && offlineBasemapLayers}
					{#each offlineBasemapLayers as L (L.key)}
						<PopoverOption active={L.on} onclick={L.toggle}>
							{L.label}
						</PopoverOption>
					{/each}
				{:else}
					{#each BASEMAP_OPTIONS as opt (opt.key)}
						<PopoverOption
							active={basemapPicker.currentKey === opt.key}
							onclick={() => basemapPicker.select(opt.key)}
						>
							{opt.label}
						</PopoverOption>
					{/each}
				{/if}
			</Popover>
		{/if}
	</div>
	{/if}

	<div class="tile-wrap" data-tour="map-tool-locate">
	<Card variant={locating ? "active" : "default"} disabled={locating} onclick={locateMe}>
		{#snippet icon()}
			<IconBox>
				<Icon name="navigation" size={32} />
			</IconBox>
		{/snippet}
		<span class="rt-text-pill">{locating ? "…" : "LOCATE"}</span>
	</Card>
	</div>

	<div class="tile-wrap" data-tour="map-tool-grid">
		<Card variant={gridTile.gridMode !== 'off' ? "active" : "default"} onclick={gridTile.toggle}>
			{#snippet icon()}
				<IconBox>
					<img src="/mobileAssets/gridIcon.webp" alt="" class="tile-img-icon tile-img-icon--grid" />
				</IconBox>
			{/snippet}
			<span class="rt-text-pill">GRID</span>
		</Card>

		{#if gridTile.popoverOpen && gridTile.gridMode !== 'off'}
			<div
				class="grid-fine-toggle"
				onpointerenter={() => gridTile.pauseDismiss()}
				onpointerleave={() => gridTile.armPopoverDismiss(1200)}
			>
				<Popover side="above">
					<!-- 10-per-hectare (fine) sub-dots on/off -->
					<span
						role="switch"
						aria-checked={gridTile.gridFine}
						aria-label="Toggle fine grid"
						tabindex="0"
						class="grid-fine-row grid-fine-row--tap"
						onclick={(e) => { e.stopPropagation(); gridTile.toggleFine(); }}
						onkeydown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); gridTile.toggleFine(); } }}
					>
						<Checkbox checked={gridTile.gridFine} accent="rust" />
						<span class="rt-text-meta">10/ha</span>
					</span>
				</Popover>
			</div>
		{/if}
	</div>

	<div class="tile-wrap" data-tour="map-tool-tracks">
	<Card variant={tracking.active ? "active" : "default"} onclick={toggleTracking}>
		{#snippet icon()}
			<IconBox>
				<MaskedIcon src="/mobileAssets/tracks_goldV3.webp" size={34} />
			</IconBox>
		{/snippet}
		<span class="rt-text-pill">TRACKS</span>
	</Card>
	</div>

	<div class="tile-wrap" data-tour="map-tool-search">
	<Card onclick={openSearchPanel}>
		{#snippet icon()}
			<IconBox>
				<Icon name="search" size={32} />
			</IconBox>
		{/snippet}
		<span class="rt-text-pill">SEARCH</span>
	</Card>
	</div>

	<div class="tile-wrap" data-tour="map-tool-new">
	<Card onclick={newMap}>
		{#snippet icon()}
			<IconBox>
				<Icon name="plus" size={34} />
			</IconBox>
		{/snippet}
		<span class="rt-text-pill">NEW MAP</span>
	</Card>
	</div>

	{#if onLegend}
	<div class="tile-wrap" data-tour="map-tool-legend">
	<Card onclick={onLegend}>
		{#snippet icon()}
			<IconBox>
				<Icon name="legend" size={32} />
			</IconBox>
		{/snippet}
		<span class="rt-text-pill">LEGEND</span>
	</Card>
	</div>
	{/if}

</div>
<FadedDivider />
</div>

<style>
	.map-drawer-home {
		padding: 26px 14px 10px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	/* 3 × 2 tile grid. On the standard 390px frame this lands each tile at
	   ~112px wide — room for a chunky icon plus a short label. */
	.mapModule-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
	}

	/* Wrapper that owns the grid cell so popovers (basemap, grid-fine) can
	   anchor to a tile. The inner Card fills the cell. */
	.tile-wrap {
		position: relative;
		aspect-ratio: 1 / 1;
	}
	.tile-wrap > :global(.rt-card) {
		width: 100%;
		height: 100%;
	}
	/* Pre-styled webp icons (gridIcon, tilesIcon) — display at the same
	   size the SVG icons used. Don't recolor with a CSS mask; assets are
	   already on the yellow-on-black tile. */
	.tile-img-icon {
		width: 32px;
		height: 32px;
		object-fit: contain;
		display: block;
	}
	/* Grid asset's bounding box is tighter than tilesIcon — pad it down so
	   the two read at the same optical size in the tile grid. */
	.tile-img-icon--grid {
		width: 28px;
		height: 28px;
	}

	/* LAYERS tile: stack a small "(pdfMaps)" hint below the pill label
	   without changing the tile's square aspect-ratio. */
	.layers-label {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		line-height: 1.05;
	}
	.layers-sub {
		font-family: var(--rt-font-display);
		font-size: 0.62rem;
		letter-spacing: var(--rt-ls-pill);
		color: var(--rt-fg);
		margin-top: 2px;
	}

	/* Grid-fine toggle wraps Popover so we can attach pointer/click handlers
	   at the wrapper level (the popover content is the visual surface). */
	.grid-fine-toggle {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		cursor: pointer;
		z-index: 65;
	}
	.grid-fine-row {
		display: flex;
		align-items: center;
		gap: var(--rt-space-2);
		padding: 0.15rem 0.4rem;
	}
	/* "10/ha" label — white for legibility on the dark grid popover (overrides the
	   dim shared .rt-text-meta hue). */
	.grid-fine-row :global(.rt-text-meta) {
		color: var(--rt-fg, #f3ead6);
	}
	/* Grid popover border — brighter gold so the little toggle reads as a
	   first-class surface instead of a faint dark-on-dark card. */
	.grid-fine-toggle :global(.rt-popover) {
		border-color: var(--rt-yellow, #ffd700);
	}
	/* Two stacked tappable rows (10/ha + snap) in the grid popover. */
	.grid-fine-row--tap {
		cursor: pointer;
		border-radius: 6px;
		min-height: 28px; /* comfortable touch target */
	}
	.grid-fine-row--tap:active {
		background: rgba(255, 255, 255, 0.08);
	}
</style>
