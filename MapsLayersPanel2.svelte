<!--
  MapsLayersPanel2 — slim map-drawer rebuild per
  /Users/chrisharris/DEV/fetch/ReTreever/src/lib/mobile/docs/INBOX_SPEC.md.

  The drawer is a filtered view of the one inbox. No DrawerTabHeader,
  no parallel selection state, no pre-scoping. Inbox2 owns the chrome.

  Compare: MapsLayersPanel.svelte is ~680 lines. This is ~50 — and the
  difference is everything the spec says shouldn't exist on a drawer
  surface.
-->
<script lang="ts">
    import { onMount } from "svelte";
    import SubDrawer from "$lib/mobile/components/ui/SubDrawer.svelte";
    import PeopleButton from "$lib/mobile/components/ui/PeopleButton.svelte";
    import Inbox2 from "$lib/mobile/components/Inbox2.svelte";
    import type { InboxItem } from "$lib/mobile/components/inboxTypes";
    import { buildInboxItems } from "$lib/mobile/utils/buildInboxItems";
    import { senderLabelSync } from "$lib/mobile/utils/senderLabel";
    import { savedQualityPlots } from "$lib/mobile/stores/quality704Surveys.svelte.js";
    import { timestampForInsert } from "$lib/mobile/utils/reorderTimestamp";
    import {
        applyReorder,
        bulkShare as inboxBulkShare,
        bulkDelete as inboxBulkDelete,
    } from "$lib/mobile/utils/inboxBulk";
    import type { MapStore } from "$lib/mobile/stores/mapStore.svelte";
    import {
        loadInboundPackages,
        loadUserProfile,
        setInboundPackageReceivedAt,
        type InboundPackage as Package,
    } from "$mobRoutes/db/index";

    import { overlayOpacity } from "@ground-truth/getcache-offlinemap/lib/mapState/overlayOpacity.svelte.js";

    let {
        mapStore,
        onClose,
        onImport,
        overlayActive = false,
    }: {
        mapStore: MapStore;
        onClose: () => void;
        onImport?: () => void;
        /** True when the active map has an overlay currently rendered.
         *  Drives whether the opacity slider is shown. */
        overlayActive?: boolean;
    } = $props();

    let inbound = $state<Package[]>([]);
    // Username for share filenames. Loaded once on mount — same field
    // (`displayName`) the inbox route reads. Drawer used to hardcode
    // "" here, which made every drawer-export filename fall back to
    // "SET_USERNAME" even when the user had a username.
    let cachedDisplayName = $state("");
    onMount(async () => {
        inbound = await loadInboundPackages();
        cachedDisplayName = (await loadUserProfile()).displayName ?? "";
    });

    // Same items array every surface sees — Inbox2's filter does the
    // scoping. No pre-filtering here.
    const items = $derived(
        buildInboxItems(inbound, mapStore, savedQualityPlots(), senderLabelSync()),
    );

    // Same shared applier the inbox route uses (INBOX_SPEC: no divergent
    // copies). The drawer never shows package rows, but wiring the setter
    // keeps the two surfaces byte-for-byte equivalent if it ever does.
    function handleReorder(
        itemId: string,
        newIndex: number,
        siblings: InboxItem[],
    ) {
        void applyReorder(itemId, newIndex, siblings, {
            mapStore,
            setPackageReceivedAt: setInboundPackageReceivedAt,
            refresh: async () => {
                inbound = await loadInboundPackages();
            },
        });
    }
</script>

<SubDrawer onBack={onClose} title="Inbox" headerScrolls>
    {#snippet actions()}
        <PeopleButton />
    {/snippet}
    {#if overlayActive}
        <!-- Map-overlay opacity slider. Visible only when the active
             map has an overlay currently rendered (see
             [[no-user-facing-sync-toasts]] for the no-noise rule —
             this control IS user-facing because it adjusts what the
             user sees). 0 = invisible, 100 = full opacity. Ticks at
             0/50/100 per user spec; no numeric label. -->
        <div class="overlay-opacity">
            <label class="overlay-opacity__label" for="overlay-opacity-slider">
                Map opacity
            </label>
            <input
                id="overlay-opacity-slider"
                type="range"
                min="0"
                max="100"
                step="1"
                list="overlay-opacity-ticks"
                value={overlayOpacity.percent}
                oninput={(e) => {
                    const v = Number((e.currentTarget as HTMLInputElement).value);
                    overlayOpacity.setPercent(v);
                }}
                aria-label="Map overlay opacity"
            />
            <datalist id="overlay-opacity-ticks">
                <option value="0"></option>
                <option value="50"></option>
                <option value="100"></option>
            </datalist>
        </div>
    {/if}
    <Inbox2
        items={items}
        kinds={["feature", "map"]}
        initialFilter="feature"
        inDrawer
        {mapStore}
        emptyText="No features in this map yet — draw something."
        onNewMap={() => {
            // Already on /mobile/map — create the map (it materialises
            // at the top of the drawer's inbox immediately because the
            // active map renders even when empty), let the user see it
            // land for a beat, then close the drawer to reveal the
            // fresh map underneath.
            mapStore.createMap();
            // Brief beat so the user sees the new map land at the top of the
            // drawer before it slides shut to reveal the canvas underneath.
            const NEW_MAP_LAND_BEAT_MS = 2000;
            setTimeout(onClose, NEW_MAP_LAND_BEAT_MS);
        }}
        {onImport}
        onReorder={handleReorder}
        onShare={(item, format) =>
            inboxBulkShare(
                [item.id],
                {
                    mapStore,
                    displayName: cachedDisplayName,
                    inbound,
                },
                format,
            )}
        onMoveFeature={(featureKey, newMapKey, dropIndex, destSiblings) => {
            // Drop position drives the feature's lastTouched — user can
            // drop a feature into the PAST by releasing it low in the
            // dest list.
            const featureTs = timestampForInsert(destSiblings, dropIndex);
            mapStore.moveFeatureToMap(featureKey, newMapKey, featureTs);
        }}
        onBulkShare={(ids, format) =>
            inboxBulkShare(
                ids,
                {
                    mapStore,
                    displayName: cachedDisplayName,
                    inbound,
                },
                format,
            )}
        onBulkDelete={(ids) =>
            inboxBulkDelete(ids, {
                mapStore,
                displayName: cachedDisplayName,
                inbound,
                // Drawer never renders package rows, so no trashPackage
                // callback. inboxBulkDelete logs a warning if a pkg id
                // somehow reaches it.
            })}
    />
</SubDrawer>

<style>
    .overlay-opacity {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 12px 16px 4px;
    }
    .overlay-opacity__label {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--rt-fg-dim);
    }
    .overlay-opacity input[type="range"] {
        width: 100%;
        accent-color: var(--accent-gold, #f5d04a);
    }
</style>
