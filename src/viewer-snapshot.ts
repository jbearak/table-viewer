import type { WorkbookMeta } from './data-source/interface';
import type { SheetPairStatus, SheetPairing } from './diff-compare/compare-source';
import type {
    AuthorityCommitReceiptBase,
    FileAuthoritySnapshot,
} from './file-coordinator';
import type { GitLfsFailureReason } from './host-ports';
import type { FileStateSnapshot } from './state';
import { deep_clone_and_freeze } from './immutable';
import { project_renderable_cell_highlight_state } from './cell-highlights';
import {
    sanitize_excel_header_active,
    sanitize_excel_header_overrides,
    transform_schema_for_sheet,
    type CellHighlightState,
    type CsvSaveLifecycle,
    type PerFileState,
    type ScrollPosition,
    type StoredPerFileState,
    type WorksheetIdentityInput,
} from './types';
import { sanitize_column_visibility_state } from './webview/column-projection';
import {
    normalize_per_file_state,
    sanitize_transform_state,
} from './webview/sheet-state';

/**
 * Opaque file-global authority identity. `fileId` identifies one logical file;
 * `revision` must increase whenever any authoritative snapshot input changes.
 */
export interface SnapshotAuthorityIdentity {
    readonly fileId: string;
    readonly revision: number;
}

/** Structured source basis reserved for the physical/projection coordinators. */
export interface SnapshotSourceBasis {
    readonly physicalRevision: number;
    readonly projectionRevision: number;
}

/** Exact identity echoed by snapshotApplied and corrective stateChanged. */
export interface WorkbookSnapshotIdentity {
    /** Monotonic within one panel's host-to-webview delivery stream. */
    readonly deliveryId: number;
    readonly authority: SnapshotAuthorityIdentity;
    /** Semantic FileStateStore revision from the Phase 1 CAS protocol. */
    readonly stateRevision: number;
    readonly sourceBasis: SnapshotSourceBasis;
}

export type WorkbookSnapshotReason =
    | 'ready'
    | 'fileReload'
    | 'excelHeader'
    | 'recovery'
    | 'save'
    | 'retry'
    | 'other';

export interface ExcelHeaderSnapshotResult {
    readonly type: 'excelFirstRowHeader';
    readonly requestId: string;
    readonly outcome: 'applied' | 'recovered' | 'rejected';
    readonly error?: string;
}

export type RetainedSnapshotCommandResult = ExcelHeaderSnapshotResult;

/** Git compare mode payload delivered with every snapshot when active. */
export interface WorkbookSnapshotCompare {
    /** Sheet pairing between the git original and the working-tree file. */
    readonly pairings: readonly SheetPairing[];
    /** Pair status per grid sheet, positionally matching `meta.sheets` — the
     *  compare source's sheet ordering stated as data, so the webview never
     *  re-derives sheet positions from `pairings`. */
    readonly sheetStatuses: readonly SheetPairStatus[];
    /** Changed promoted column headers per modified sheet, positionally
     *  matching `meta.sheets`; empty for sheets without header changes. */
    readonly changedColumnNames: readonly (readonly { col: number; base: string }[])[];
    /**
     * The two sides, for display. Paths rather than names: two files being
     * compared often share a basename (the same report from two quarters), and
     * a strip that showed only the names could not tell them apart.
     */
    readonly sides?: {
        readonly originalPath: string;
        readonly modifiedPath: string;
    };
    /** Whole-comparison change totals, for the compare window's counts. */
    readonly counts: {
        readonly addedRows: number;
        readonly deletedRows: number;
        readonly movedRows: number;
        readonly changedCells: number;
    };
    /**
     * The rows could not be matched up — the aligner hit its effort cap and
     * compared by position instead. The renderer must say so: an all-changed
     * grid produced this way is not a finding about the files.
     */
    readonly degraded: boolean;
    /**
     * Some moved rows are still reported as a deletion plus an addition: the
     * sheet had more unpaired rows than the move search will score. Distinct
     * from `degraded`, which invalidates the whole alignment — here the
     * alignment stands and only the move annotation is incomplete.
     */
    readonly moveSearchTruncated: boolean;
}

/**
 * A side of this panel is a Git LFS pointer whose object is not available
 * locally, so the bytes behind it were never read.
 *
 * `side` names which one, and the distinction is the whole reason this is a
 * structure rather than a boolean. `file` means the file the user opened is
 * itself a pointer and the grid below is empty. `original` means the file
 * opened fine but the revision it is being compared against is a pointer, so
 * the grid holds real data and only the diff is missing.
 */
export interface UnresolvedLfsObject {
    readonly side: 'file' | 'original';
    readonly oid: string;
    /** Byte length of the real object, per the pointer — for "resolve 40 MB?". */
    readonly size: number;
    /** Whether the host can actually fetch it. False on a host with no
     *  git-lfs port, where the notice stands but there is no button. */
    readonly resolvable: boolean;
    /** Set once a resolve has been tried and failed, so the banner can explain
     *  rather than silently do nothing on the next click. */
    readonly failure?: {
        readonly reason: GitLfsFailureReason;
        readonly detail?: string;
    };
}

/** Fully explicit configuration and capabilities; absence is not overloaded. */
export interface WorkbookSnapshotConfiguration {
    readonly defaultTabOrientation: 'horizontal' | 'vertical';
    readonly previewMode: boolean;
    readonly diffOnByDefault: boolean;
    /** Present exactly when the panel is a read-only git compare session. */
    readonly gitCompare?: WorkbookSnapshotCompare;
    /**
     * Present exactly while a side of this panel is an unfetched Git LFS
     * object. Configuration rather than a diagnostic because it is the
     * controller's state, not the source's: `gitCompare` beside it is the
     * precedent, and the same reasoning applies — a failed resolve has to be
     * able to change this without the adopted source changing at all.
     */
    readonly unresolvedLfs?: UnresolvedLfsObject;
}

export interface WorkbookSnapshotCapabilities {
    readonly csvEditable: boolean;
    readonly csvEditingSupported: boolean;
    /**
     * The held edit session, which covers the whole workbook. Which sheets carry
     * restored edits is read from the snapshot's per-sheet `pendingEdits` slots,
     * not from a capability: the session has no single sheet to name.
     */
    readonly csvEditSessionId?: string;
    /** Monotonic host projection for the complete panel save lifecycle. */
    readonly csvSaveLifecycle: CsvSaveLifecycle;
    /**
     * How cell text is edited: 'markdown' for xlsx (styled runs serialize to
     * inline markup in the edit field and parse back on commit), 'plain' for
     * everything else. Absent reads as 'plain' — older hosts never sent it,
     * and a plain editor is always safe.
     */
    readonly editSyntax?: 'plain' | 'markdown';
}

/**
 * Durable per-file state with every layout/view leaf the protocol requires filled in.
 *
 * `rowHeights` is the one `PerFileState` field this shape deliberately **removes** rather
 * than completes, and the `Omit` is load-bearing: it is what makes "the webview is not
 * sent durable heights" a type error to undo instead of a convention. Two readers use
 * this shape and neither wants the map. `WorkbookSnapshot.state` is what crosses to the
 * webview, which renders from `rowHeightProjection` and never reads the durable map —
 * sending it would be a source-keyed map sitting beside a display-keyed one, which is
 * exactly the confusion this PR exists to end, and for a pre-cap legacy select-all map it
 * would be hundreds of thousands of entries structured-cloned across the bridge on every
 * delivery. `derive_layout_state_patch`'s basis/incoming pair is the other, and
 * `LayoutStatePatch` has no `rowHeights` leaf to derive, so it never looks.
 *
 * The durable map itself is unaffected: the host reads and writes it through
 * `PerFileState` (`normalize_host_state`, `update_file_state`), which keeps the field.
 */
export interface NormalizedPerFileState extends Omit<PerFileState, 'rowHeights'> {
    columnWidths: (Record<number, number> | undefined)[];
    scrollPosition: (ScrollPosition | undefined)[];
    activeSheetIndex: number;
    tabOrientation: 'horizontal' | 'vertical' | null;
    transforms: NonNullable<PerFileState['transforms']>;
    columnVisibility: NonNullable<PerFileState['columnVisibility']>;
    cellHighlights?: CellHighlightState;
}

export interface WorkbookSnapshot {
    readonly identity: WorkbookSnapshotIdentity;
    readonly generation: number;
    readonly sourceGeneration: number;
    readonly presentation: 'initial' | 'refresh';
    readonly reason: WorkbookSnapshotReason;
    readonly meta: WorkbookMeta;
    /**
     * Which durable pending-edit cells the host's installed view of each sheet does
     * not show, positionally matching `meta.sheets`.
     *
     * Every delivery carries this, not only `transformInstalled`, because the set has
     * two halves that move at different times. Membership moves only at an install,
     * and the record the webview holds is refreshed then. The *edits* move on their
     * own, and one of those moves cannot be reconstructed from anything the webview
     * has: an edit typed while a hiding transform was computing reaches the durable
     * map only after the install that excluded its row, so the install's own answer
     * omits it permanently. Narrowing the held keys to the live dirty map subtracts;
     * only a fresh answer from the host can add, and `pendingEditsChanged` already
     * triggers a same-basis refresh for the capabilities it re-projects.
     *
     * A snapshot field rather than a capability because `create_desired` samples the
     * core live for every delivery while capabilities are sampled only when something
     * re-projects them — so this arrives with the generation it agrees with, and can
     * never name a permutation other than the one the same delivery's generation
     * identifies.
     */
    readonly hiddenEditedCellKeys: readonly (readonly string[])[];
    /**
     * The durable custom row heights re-keyed into the display space of the view the
     * host holds for each sheet, positionally matching `meta.sheets`. Sparse — an absent
     * key is the default height — and `undefined` for a sheet with no custom heights at
     * all, which is the overwhelmingly common case and so worth not sending as `{}`.
     *
     * This is what the webview renders from. It cannot compute it: durable heights are
     * keyed by canonical source row (`PerFileState.rowHeights`) and the permutation plus
     * the source→projected mapping that invert one into the other live only on the host.
     *
     * Sampled beside `hiddenEditedCellKeys` for the identical reason, and the argument
     * transfers verbatim because both values are meaningless except against one specific
     * permutation. `create_desired` samples the core live and synchronously for every
     * delivery, so this and `generation` above are read in the same instant and cannot
     * name different permutations — whereas a value carried on the projected
     * capabilities is sampled only when something re-projects them, and could describe a
     * permutation two installs old. Applied to the wrong permutation a display-keyed
     * height map is not stale but *wrong*: every height renders against a different row,
     * which is the exact bug source-keyed durable heights exist to end.
     *
     * Every delivery, and not only the ones that moved a row, because both halves of
     * this join move independently. The permutation moves at an install; the durable
     * heights move on a `setRowHeights`, a sibling panel's write, or an excel-header plan
     * edit, none of which install anything or bump a generation. So there is no event
     * that can be relied on to be the last word, and the answer is simply recomputed
     * whenever anything is delivered. The install case is the one gap a delivery does not
     * cover — an install posts no snapshot — and `transformInstalled.rowHeights` covers
     * it.
     */
    readonly rowHeightProjection: readonly (Readonly<Record<number, number>> | undefined)[];
    /**
     * Per sheet, positionally matching `meta.sheets`, the value `generation` took when
     * *that sheet's* display→source mapping last moved — `ViewerPanelCore.mapping_generation`
     * serialised, and produced by calling it so the two cannot disagree.
     *
     * `generation` is core-wide; a permutation is per sheet. So a display-keyed value the
     * webview holds — the optimistic row-height overlay — cannot be judged against
     * `generation` alone without discarding it every time some *other* sheet moves, which
     * a background sort finishing or a saved transform restoring on a background sheet
     * both do. The rule this field exists to make expressible is the host's own:
     * an overlay created at generation `G` for sheet `S` is still valid iff
     * `mappingGenerations[S] <= G`. Below or equal, no display row on `S` has moved since
     * `G`; above, its rows were rearranged and its keys name other rows now.
     *
     * Sampled beside `generation` and `rowHeightProjection` in the same statement, for the
     * reason given on those: a permutation-relative answer read at any other instant can
     * describe a permutation the delivery's own generation does not name.
     *
     * Read once and never retained, which is what keeps it out of the stale-copy class
     * `SheetViewRecord` exists to police — see `ViewerPanelCore.mapping_generations_by_sheet`
     * for the full argument, including why the local `sourceGeneration` heuristic that
     * would have avoided this field is unsound.
     */
    readonly mappingGenerations: readonly number[];
    readonly state: NormalizedPerFileState;
    readonly configuration: WorkbookSnapshotConfiguration;
    readonly capabilities: WorkbookSnapshotCapabilities;
    readonly truncationMessage: string | null;
    readonly commandResult?: RetainedSnapshotCommandResult;
}

export interface WorkbookSnapshotCoreMaterial<Meta extends WorkbookMeta = WorkbookMeta> {
    readonly generation: number;
    readonly sourceGeneration: number;
    readonly meta: Meta;
    /**
     * `SheetViewRecord.hiddenEditedCellKeys` for the view this core holds right now,
     * one entry per sheet, positionally matching `meta.sheets`.
     *
     * Sampled with the generation beside it, which is what makes it usable: the
     * webview keeps a held record when the generation still matches, and a matching
     * generation means the permutation these keys were computed against is the one
     * that record describes. See `WorkbookSnapshot.hiddenEditedCellKeys`.
     */
    readonly hiddenEditedCellKeys: readonly (readonly string[])[];
    /**
     * The display-keyed row-height projection for the view this core holds right now,
     * one entry per sheet. Sampled in the same statement as the generation and the keys
     * above, for the same reason. See `WorkbookSnapshot.rowHeightProjection`.
     */
    readonly rowHeightProjection: readonly (Readonly<Record<number, number>> | undefined)[];
    /**
     * Per sheet, the generation at which that sheet's display→source mapping last moved.
     * Sampled in the same statement as the generation and the two values above, and for
     * the same reason. See `WorkbookSnapshot.mappingGenerations`.
     */
    readonly mappingGenerations: readonly number[];
}

export interface WorkbookSnapshotDiagnostics {
    readonly truncationMessage: string | null;
}

interface BuildWorkbookSnapshotCommonInput<Meta extends WorkbookMeta> {
    readonly deliveryId: number;
    readonly canonicalFileId: string;
    readonly core: WorkbookSnapshotCoreMaterial<Meta>;
    readonly presentation: WorkbookSnapshot['presentation'];
    readonly reason: WorkbookSnapshotReason;
    readonly configuration: WorkbookSnapshotConfiguration;
    readonly capabilities: WorkbookSnapshotCapabilities;
    readonly diagnostics: WorkbookSnapshotDiagnostics;
    readonly commandResult?: RetainedSnapshotCommandResult;
}

export type BuildWorkbookSnapshotInput<Meta extends WorkbookMeta = WorkbookMeta> =
    BuildWorkbookSnapshotCommonInput<Meta> & (
        | {
            readonly source: 'commitReceipt';
            readonly receipt: AuthorityCommitReceiptBase;
        }
        | {
            readonly source: 'observed';
            readonly authority: FileAuthoritySnapshot;
            readonly state_snapshot: FileStateSnapshot;
        }
    );

export type SnapshotDisposition = 'applied' | 'duplicate' | 'stale';

/** Build one complete, immutable host delivery without mutating source material. */
export function build_workbook_snapshot<Meta extends WorkbookMeta>(
    input: BuildWorkbookSnapshotInput<Meta>,
): WorkbookSnapshot {
    const authority = input.source === 'commitReceipt'
        ? input.receipt.resultingBasis
        : input.authority;
    const state_snapshot = input.source === 'commitReceipt'
        ? input.receipt.stateSnapshot
        : input.state_snapshot;
    // Lifted out of the `deep_clone_and_freeze` below and re-attached after it. The core
    // freezes this value at its source (`compute_row_height_projection` freezes each map,
    // `row_height_projection_by_sheet` the array) precisely so it can be shared, and
    // `snapshot_material` already shares it — cloning it here would put the copy the memo
    // exists to avoid straight back on the delivery path, once for a legacy select-all map
    // that can hold hundreds of thousands of entries. Guarded rather than assumed: a
    // caller whose material is not already frozen gets the clone, so no mutable object can
    // escape into an immutable snapshot. The check is O(sheets) and reads only the two
    // levels that exist — the leaf values are numbers.
    const row_height_projection = Object.isFrozen(input.core.rowHeightProjection)
        && input.core.rowHeightProjection.every(
            (entry) => entry === undefined || Object.isFrozen(entry),
        )
        ? input.core.rowHeightProjection
        : deep_clone_and_freeze(input.core.rowHeightProjection);
    const snapshot: Omit<WorkbookSnapshot, 'rowHeightProjection'> = {
        identity: {
            deliveryId: input.deliveryId,
            authority: {
                fileId: input.canonicalFileId,
                revision: authority.authorityRevision,
            },
            stateRevision: state_snapshot.revision,
            sourceBasis: {
                physicalRevision: authority.physicalRevision,
                projectionRevision: authority.projectionRevision,
            },
        },
        generation: input.core.generation,
        sourceGeneration: input.core.sourceGeneration,
        presentation: input.presentation,
        reason: input.reason,
        meta: input.core.meta,
        hiddenEditedCellKeys: input.core.hiddenEditedCellKeys,
        mappingGenerations: input.core.mappingGenerations,
        state: normalize_workbook_snapshot_state(
            state_snapshot.state,
            input.core.meta,
            authority.physicalDigest ?? null,
        ),
        configuration: input.configuration,
        capabilities: input.capabilities,
        truncationMessage: input.diagnostics.truncationMessage,
        ...(input.commandResult === undefined
            ? {}
            : { commandResult: input.commandResult }),
    };
    // `rowHeightProjection` is attached after the clone rather than carried through it, for
    // the reason given where it is sampled above — it is never a member of the object
    // handed to `structuredClone`. Everything else keeps the clone-and-freeze contract
    // exactly.
    return Object.freeze({
        ...deep_clone_and_freeze(snapshot),
        rowHeightProjection: row_height_projection,
    });
}

/**
 * Compare a received snapshot with the last applied authority. Same-file
 * authority and semantic revisions are primary; panel delivery order fences
 * file changes and intentionally new same-basis receiver epochs.
 */
export function classify_snapshot(
    incoming: WorkbookSnapshotIdentity,
    applied: WorkbookSnapshotIdentity | null,
): SnapshotDisposition {
    if (!applied) return 'applied';
    if (incoming.deliveryId === applied.deliveryId) return 'duplicate';
    if (incoming.authority.fileId !== applied.authority.fileId) {
        return incoming.deliveryId > applied.deliveryId ? 'applied' : 'stale';
    }
    if (incoming.authority.revision !== applied.authority.revision) {
        return incoming.authority.revision > applied.authority.revision
            ? 'applied'
            : 'stale';
    }

    const incoming_basis = [
        incoming.stateRevision,
        incoming.sourceBasis.physicalRevision,
        incoming.sourceBasis.projectionRevision,
    ] as const;
    const applied_basis = [
        applied.stateRevision,
        applied.sourceBasis.physicalRevision,
        applied.sourceBasis.projectionRevision,
    ] as const;
    if (incoming_basis.some((value, index) => value < applied_basis[index])) {
        return 'stale';
    }
    if (incoming_basis.some((value, index) => value > applied_basis[index])) {
        return 'applied';
    }
    return incoming.deliveryId > applied.deliveryId ? 'applied' : 'stale';
}

/** Normalize legacy/current state while retaining host-owned Excel fields. */
export function normalize_complete_per_file_state(
    stored: StoredPerFileState,
    sheets: readonly WorksheetIdentityInput[],
): PerFileState {
    const normalized = normalize_per_file_state(stored, sheets);
    if ('excelFirstRowHeaders' in stored) {
        normalized.excelFirstRowHeaders = sanitize_excel_header_overrides(
            stored.excelFirstRowHeaders,
        );
    }
    if ('excelFirstRowHeaderActive' in stored) {
        normalized.excelFirstRowHeaderActive = sanitize_excel_header_active(
            stored.excelFirstRowHeaderActive,
        );
    }
    if (
        'excelFirstRowHeaderVersion' in stored
        && stored.excelFirstRowHeaderVersion === 1
    ) {
        normalized.excelFirstRowHeaderVersion = 1;
    }
    // Same shape and the same reason as the marker above: a migration marker is only
    // ever exactly `1`, so anything else on disk — a truncated write, a hand edit, a
    // future version's `2` read by this one — must normalize to "not migrated" and let
    // the pass run again rather than be trusted as "already done". Carried through here
    // rather than in `normalize_per_file_state` because, like the Excel markers, it is
    // host-owned: no webview state ever names it, so the webview's normalizer has no
    // business preserving it.
    if ('rowHeightsVersion' in stored && stored.rowHeightsVersion === 1) {
        normalized.rowHeightsVersion = 1;
    }
    return normalized;
}

/** Fill every layout/view field required by the snapshot wire shape. */
export function complete_normalized_per_file_state(
    stored: StoredPerFileState,
    sheets: readonly WorksheetIdentityInput[],
): NormalizedPerFileState {
    // Dropped, not completed — see `NormalizedPerFileState`. Destructured away rather than
    // simply left out of the literal, because the spread below would otherwise carry the
    // normalizer's copy straight through.
    const { rowHeights: _drop_row_heights, ...normalized } =
        normalize_complete_per_file_state(stored, sheets);
    return {
        ...normalized,
        columnWidths: normalized.columnWidths ?? [],
        scrollPosition: normalized.scrollPosition ?? [],
        activeSheetIndex: normalized.activeSheetIndex ?? 0,
        tabOrientation: normalized.tabOrientation ?? null,
        transforms: normalized.transforms ?? [],
        columnVisibility: normalized.columnVisibility ?? [],
    };
}

/** Canonical runtime normalization used by snapshot producers and consumers. */
export function normalize_workbook_snapshot_state(
    stored: StoredPerFileState,
    meta: WorkbookMeta,
    expected_digest?: string | null,
): NormalizedPerFileState {
    const normalized = complete_normalized_per_file_state(stored, meta.sheets);
    const transforms = meta.sheets.map((sheet, index) =>
        sanitize_transform_state(
            normalized.transforms?.[index],
            sheet.columnCount,
            transform_schema_for_sheet(sheet),
            sheet.sourceRowCount,
        ));
    const column_visibility = meta.sheets.map((sheet, index) =>
        sanitize_column_visibility_state(
            normalized.columnVisibility?.[index],
            sheet.columnCount,
            transform_schema_for_sheet(sheet),
        ));
    const cell_highlights = project_renderable_cell_highlight_state(
        normalized.cellHighlights,
        meta,
        expected_digest,
    );
    return {
        ...normalized,
        transforms,
        columnVisibility: column_visibility,
        cellHighlights: cell_highlights,
    };
}
