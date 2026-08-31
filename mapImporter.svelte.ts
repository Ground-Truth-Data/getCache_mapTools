// Map-import state machine. Extracted from MapDrawControls.svelte.
//
// Owns the "Import a file" modal open/close, the `mapsImporting` busy flag,
// the stage/elapsed progress ticker, and the `handleFile` async callback.
// All three import kinds (PDF → overlay, KML/KMZ → gdal screen, .retreever →
// inbox) are handled here; the only chrome effects left are closing the drawer
// and layers panel on a successful PDF import — passed in as deps.
//
// The $effect progress ticker lives here (a .svelte.ts rune so reactivity
// works outside a .svelte component). Factory per instance so preview/offline
// routes get independent state.
import { goto } from "$app/navigation";
import { toast } from "svelte-sonner";
import { importRouter } from "$lib/mobile/import/importRouter";
import { showImportProblem } from "$lib/mobile/stores/topShelfNotice.svelte";
import { reportImportError } from "$lib/mobile/utils/reportImportError";

/** Structural dep: the camera framer. `frameFeature` frames a finished
 *  feature; `frameBounds` frames a raw bbox (used for the waiting box before
 *  any feature exists). */
interface FramerRef {
    frameFeature(key: string): Promise<void>;
    frameBounds?(
        bounds: { n: number; s: number; e: number; w: number },
        opts?: { padding?: number; maxZoom?: number; duration?: number },
    ): void;
}
/** Structural dep: the MobDrawer. Only `close` is used. */
interface DrawerRef {
    close(): void;
}
/** Structural dep: the overlay manager's waiting-box controls. */
interface WaitingRef {
    showWaiting(
        corners: readonly [
            readonly [number, number],
            readonly [number, number],
            readonly [number, number],
            readonly [number, number],
        ],
    ): void;
    hideWaiting(): void;
}

export interface MapImporterDeps {
    framer: FramerRef;
    getShowLayersPanel: () => boolean;
    closeLayersPanel: () => void;
    getDrawerOpen: () => boolean;
    getMobDrawer: () => DrawerRef | undefined;
    /** Overlay manager's waiting-box controls. Optional so preview/offline
     *  routes that don't mount an overlay manager still construct. */
    waiting?: WaitingRef;
}

export interface MapImporter {
    readonly importing: boolean;
    /** True while the import's wait is LOCATED on the map (waiting box shown
     *  at the PDF's true footprint). The full-screen splash must NOT mount
     *  then — the map itself is the waiting screen. */
    readonly located: boolean;
    readonly open: boolean;
    readonly stage: "uploading" | "converting" | "downloading" | "extracting";
    readonly fileName: string;
    readonly elapsed: number;
    openModal(): void;
    closeModal(): void;
    handleFile(file: File): Promise<void>;
}

type CornerQuad = readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
];

function isPdfFile(file: File): boolean {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
}

/** Read the PDF's georef corners ON-DEVICE (no server) for the waiting box.
 *  geoPdfBounds returns an axis-aligned {n,s,e,w}; we hand back the 4 corners
 *  in [TL,TR,BR,BL] order. null when the PDF has no readable on-device georef
 *  (rare — then the box just isn't shown and the normal path runs). */
async function pdfCornersOnDevice(file: File): Promise<CornerQuad | null> {
    try {
        const { extractGeoPdfBounds } = await import(
            "$lib/mobile/utils/geoPdfBounds"
        );
        const bytes = new Uint8Array(await file.arrayBuffer());
        const b = await extractGeoPdfBounds(bytes);
        if (!b) return null;
        return [
            [b.w, b.n],
            [b.e, b.n],
            [b.e, b.s],
            [b.w, b.s],
        ];
    } catch {
        return null;
    }
}

function cornersToBounds(
    corners: CornerQuad,
): { n: number; s: number; e: number; w: number } {
    const lngs = corners.map((c) => c[0]);
    const lats = corners.map((c) => c[1]);
    return {
        n: Math.max(...lats),
        s: Math.min(...lats),
        // codestyle-allow-spread: CornerQuad is exactly 4 corners
        e: Math.max(...lngs),
        w: Math.min(...lngs),
    };
}

export function createMapImporter(deps: MapImporterDeps): MapImporter {
    let importing = $state(false);
    let located = $state(false);
    let open = $state(false);
    let stage = $state<"uploading" | "converting" | "downloading" | "extracting">("uploading");
    let fileName = $state("");
    let elapsed = $state(0);

    // Sustained progress feedback per [[feedback-sustained-spinner]].
    // Resets on import end; advances stage labels at fixed intervals that
    // match the real server-side durations for PDF → GDAL → WebP (~20-30s).
    $effect(() => {
        if (!importing) {
            stage = "uploading";
            elapsed = 0;
            return;
        }
        const start = performance.now();
        const id = setInterval(() => {
            const secs = Math.floor((performance.now() - start) / 1000);
            elapsed = secs;
            if (secs < 4) stage = "uploading";
            else if (secs < 25) stage = "converting";
            else stage = "extracting";
        }, 500);
        return () => clearInterval(id);
    });

    async function handleFile(file: File): Promise<void> {
        open = false;
        fileName = file.name;
        importing = true;
        // For a raw PDF that will round-trip the cloud converter, drop the
        // on-map WAITING BOX at the true spot NOW — before the ~20-30s convert
        // — so the user sees "it's coming, right here" instead of a blank wait.
        // We read the corners on-device (geoPdfBounds, no server) and place a
        // slate/white-border box + the cleanCache animation there. The real
        // overlay render tears it down (gap-free); on any failure we hide it in
        // the finally below. A PDF that renders instantly on-device swaps in
        // fast, so the box (if shown) is replaced almost immediately.
        //
        // `located` suppresses the full-screen ImportProgress splash: when the
        // wait is anchored on the map, the MAP is the waiting screen — the
        // splash would paint an opaque #0a0a0a sheet over the box and the user
        // would never see it (the original "I never see the slate" bug). Set
        // optimistically for PDFs so the splash can't flash during the ~100ms
        // corner parse; cleared if the PDF turns out to have no readable
        // georef (then the splash is the honest blind wait, as before).
        let waitingShown = false;
        try {
            if (deps.waiting && isPdfFile(file)) {
                located = true;
                const corners = await pdfCornersOnDevice(file);
                if (corners) {
                    deps.waiting.showWaiting(corners);
                    waitingShown = true;
                    // Fly to the spot so the animation is on screen — but stay
                    // WIDE (zoom-in #1). The overlay-landed frameFeature below
                    // is zoom-in #2, so the camera settles in two steps: wide
                    // while waiting, close once the real map has painted.
                    deps.framer.frameBounds?.(cornersToBounds(corners), {
                        maxZoom: 12,
                    });
                } else {
                    located = false;
                }
            }
        } catch {
            // The waiting box is pure reassurance — never let its setup fail
            // the import. Fall through to the normal path with no box.
            located = false;
        }
        let pdfOverlayLanded = false;
        try {
            const outcome = await importRouter(file);
            if (!outcome.ok) {
                // Server-authored copy wins per MAP_IMPORTS_UNIFIED.md §6.
                // Severity picks the STYLING: a user-fixable fact about their
                // file (not a georeferenced map, too big) is gold — the app is
                // telling them something, not confessing a crash. Red is
                // reserved for "the computer actually broke".
                showImportProblem(outcome);
                return;
            }
            if (outcome.kind === "gdal-handoff") {
                await goto("/map/gdal");
                return;
            }
            if (outcome.kind === "pdf") {
                // The overlay feature now exists → the overlay manager will
                // render it and tear the waiting box down gap-free. Mark it so
                // the finally below DOESN'T also hide it (which could flash the
                // basemap before the real WebP paints).
                pdfOverlayLanded = true;
                // Get chrome out of the way so the user sees the overlay.
                if (deps.getShowLayersPanel()) deps.closeLayersPanel();
                if (deps.getDrawerOpen()) deps.getMobDrawer()?.close();
                // Frame the freshly imported PDF — the only place a PDF
                // import should move the camera.
                void deps.framer.frameFeature(outcome.mapFeatureKey);
                toast.success(`Added "${outcome.featureName}" to this map.`, {
                    duration: 3000,
                });
            } else if (outcome.merged) {
                // featureName is optional on merged outcomes — fall back to the
                // file name rather than toasting `Added "undefined"`.
                toast.success(
                    `Added "${outcome.featureName ?? outcome.fileName}" to this map.`,
                    {
                        duration: 3500,
                    },
                );
            } else {
                toast.success(`Saved "${outcome.fileName}" to your inbox.`, {
                    duration: 3500,
                });
            }
        } catch (err) {
            // NEVER `err.message` — that's how a raw `RuntimeError(...)` /
            // worker-URL parse failure reaches a planter in a cutblock.
            // reportImportError ships the stack to Sentry and hands back one
            // plain line. See its docstring.
            toast.error("Couldn't open that file", {
                description: reportImportError(err, file.name),
                duration: 6000,
            });
        } finally {
            importing = false;
            located = false;
            // Hide the waiting box unless a PDF overlay actually landed — in
            // that case the overlay render owns the (gap-free) teardown. On any
            // failure / non-PDF outcome, clear it here so it never strands.
            if (waitingShown && !pdfOverlayLanded) deps.waiting?.hideWaiting();
        }
    }

    return {
        get importing() {
            return importing;
        },
        get located() {
            return located;
        },
        get open() {
            return open;
        },
        get stage() {
            return stage;
        },
        get fileName() {
            return fileName;
        },
        get elapsed() {
            return elapsed;
        },
        openModal() {
            open = true;
        },
        closeModal() {
            open = false;
        },
        handleFile,
    };
}
