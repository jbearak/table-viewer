import type {
    ExcelHeaderOverride,
    WorkbookMeta,
    RenderedCell,
} from './data-source/interface';
import type {
    SnapshotDisposition,
    WorkbookSnapshot,
    WorkbookSnapshotIdentity,
} from './viewer-snapshot';

export interface WorkbookData {
    sheets: SheetData[];
    hasFormatting: boolean;
}

export interface SheetData {
    name: string;
    rows: (CellData | null)[][];
    merges: MergeRange[];
    columnCount: number;
    rowCount: number;
}

export interface CellData {
    raw: string | number | boolean | null;
    formatted: string;
    bold: boolean;
    italic: boolean;
    rawType?: 'string' | 'number' | 'boolean' | 'date' | 'empty';
}

export interface MergeRange {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
}

/** Inclusive interval in the installed display-row coordinate space. */
export interface DisplayRowInterval {
    start: number;
    end: number;
}

export type SortDirection = 'asc' | 'desc';
export type TransformIntent = 'restore' | 'user' | 'cancel';

export interface SortKey {
    colIndex: number;
    direction: SortDirection;
}

export type FilterOperator =
    | 'contains'
    | 'notContains'
    | 'equals'
    | 'notEquals'
    | 'startsWith'
    | 'endsWith'
    | 'greaterThan'
    | 'greaterThanOrEqual'
    | 'lessThan'
    | 'lessThanOrEqual'
    | 'between'
    | 'notBetween'
    | 'isEmpty'
    | 'isNotEmpty'
    | 'isOneOf';

export type RangeFilterOperator = 'between' | 'notBetween';

export function is_range_filter_operator(
    operator: FilterOperator,
): operator is RangeFilterOperator {
    return operator === 'between' || operator === 'notBetween';
}

export interface FilterEntry {
    id: string;
    colIndex: number;
    operator: FilterOperator;
    value?: string;
    secondValue?: string;
    /** `isOneOf` only: exact raw values that must NOT match. `null` excludes
     *  blanks. Storing exclusions keeps values that appear later visible. */
    excludedValues?: (string | null)[];
    caseSensitive: boolean;
    enabled: boolean;
}

/** Checklist entries above this cap are never offered; a partial value list
 *  must not masquerade as complete. Blanks count as one entry. */
export const FILTER_DISTINCT_VALUE_LIMIT = 1_000;

export interface HistogramBin {
    lo: number;
    hi: number;
    count: number;
}

export type FilterColumnKind = 'numeric' | 'orderedText' | 'text' | 'unknown';

export interface SheetTransformState {
    sort: SortKey[];
    filters: FilterEntry[];
    /** Sorted unique canonical source-row indices excluded from the view;
     *  positional annotations (like cellHighlights) — never re-associated on
     *  content change. */
    hiddenRows?: number[];
    /** Fingerprint of sheet identity + available column names. Prevents a saved
     *  transform from silently attaching to a reordered/replaced sheet. */
    schema?: string;
}

/**
 * What an installed view was computed against. A record whose basis differs from an
 * incoming snapshot's describes rows that no longer exist.
 *
 * `generation` and `sourceGeneration` are between them sufficient: an Excel header
 * promotion reaches the view only through `PanelCore.adopt_source`, which bumps
 * both, so a changed header row cannot arrive on an unchanged basis. `schema` is not
 * redundant with them — it is the fingerprint `SheetTransformState.schema` is matched
 * against, so keeping it on the record lets one be checked against a sheet directly
 * rather than via the generations.
 */
export type ViewBasis = {
    generation: number;
    sourceGeneration: number;
    schema: string;
};

/**
 * Everything the webview needs to know about a view the host actually installed,
 * in one value. Only `transformInstalled` carries it, so holding one is proof that
 * an install happened — a refusal has no way to produce one.
 *
 * **Every field must be a fact about the rows this view contains.** That is what
 * makes the webview's same-basis retention sound: "same rows" is the only question a
 * delivery asks about a held record, so it can only license keeping fields that
 * "same rows" is evidence about. A field tracking anything else — the user's durable
 * intent, the pending-edit map, what has already been asked of the host — does not
 * belong here, because basis equality says nothing about it and the retention will
 * therefore go on holding a stale copy indefinitely, with no later delivery able to
 * correct it.
 *
 * Three review findings on this PR were that one pattern, which is why the rule is
 * now a *shape* rather than a paragraph readers have to remember. `rowCount` was
 * separately stored and could be invalidated apart from `permuted`; then
 * `hiddenEditedCellKeys` turned out to be edit-derived (fixed by the host
 * re-answering it on every delivery, not only at an install — see below); then
 * `rules` turned out to be a copy of durable intent for views that install nothing,
 * so a sibling panel's change to a *disabled* filter definition — which moves no row,
 * hence installs nothing and bumps no generation — left the copy stale, and Cancel
 * re-persisted it over the sibling's update.
 *
 * That third one was mitigated by prose specifying which reader was entitled to read
 * what, and reader discipline is exactly what had already failed twice. So the
 * discriminant does the work instead: **`permuted` is the union tag, and the two
 * row-describing fields exist only on the arm where they describe rows.** An active
 * rule set is precisely the set the host built the permutation from, and the hidden
 * keys are precisely the rows that permutation left out; when the host applied
 * nothing there is no permutation, hence no rules describing it and nothing it fails
 * to show, and a retained non-permuted record therefore has no `rules` for a later
 * reader to mistake for the user's current intent. Anything asking "what does the
 * user currently want?" reads durable state live.
 *
 * `permuted` is a sound tag for both fields and not just for `rules`: the host sets
 * it from whether it holds an index permutation at all, and it holds one exactly when
 * `compute_transform` found the rules active — a row-dropping filter and a bare
 * `hiddenRows` list included. So `permuted` means "this view drops and/or reorders
 * rows", which is the same condition under which a key can be out of sight.
 *
 * The durable-rule acknowledgement the install handler needs did not disappear with
 * the field; it moved to `transformInstalled.rules`, beside the record rather than in
 * it, because a message is read once and never retained. Anyone adding a field here
 * should expect the same question of it — and if the answer is "it is not about these
 * rows", the message is where it goes.
 *
 * The display-keyed row-height projection PR 4 added is the worked example of that last
 * sentence, and it is instructive because it looks like it belongs here. It is a fact
 * about these rows in the sense that its keys are this view's display rows. But it is a
 * *join* of the permutation with durable intent, and the durable half moves with no
 * generation bump at all — a `setRowHeights`, a sibling panel's write, an excel-header
 * plan edit — so a retained record's projection goes stale on an unchanged basis, which
 * is precisely the failure mode this shape exists to make impossible. What earned
 * `hiddenEditedCellKeys` its exemption does not transfer: those keys are correctable
 * because the webview holds a live dirty map to intersect them against, and there is no
 * live value to correct a height projection with. So it rides the deliveries instead —
 * `WorkbookSnapshot.rowHeightProjection` and `transformInstalled.rowHeights`, beside the
 * record exactly as `rules` is.
 */
export type SheetViewRecord =
    | {
        basis: ViewBasis;
        permuted: true;
        /**
         * The rules the host built this permutation from — not the durable intent,
         * which a sibling panel can change with no row movement at all. Non-optional:
         * the host writes `transform_indices` and `transform_states` in the same
         * statement pair, and only ever writes indices for a state
         * `transform_is_active` accepted, so a permutation always has rules.
         */
        rules: SheetTransformState;
        /** Effective row count, post-filter. */
        rowCount: number;
        /**
         * Canonical `"sourceRow:sourceColumn"` keys of the durable pending-edit *cells*
         * whose source row this view does not contain.
         *
         * Computed on the host because that is the only place both halves of the
         * question exist at once — the permutation and the durable dirty map.
         * Membership moves only at an install: an installed filter reads saved values
         * and deliberately never recomputes mid-session, and the user can only type
         * into rows the view is showing.
         *
         * Keys rather than a bare count, and this is the refinement worth keeping
         * straight. Membership moves only at an install, but the *count* is a function
         * of two things — membership and the set of edits — and the second moves on any
         * `pendingEditsChanged`, discard or successful save, none of which install
         * anything. A count sent from here therefore went stale the moment a
         * filtered-out edit was discarded, with no later install to correct it. Keys do
         * not: the webview intersects them with its live dirty map, which subtracts
         * every entry that left it, exactly and with no message from the host.
         *
         * Subtraction is only half of it, though, and the other half is why every
         * *delivery* carries these keys too and not only `transformInstalled` (see
         * `WorkbookSnapshot.hiddenEditedCellKeys`). "A new edit can only be typed into
         * a row the view is showing" is true of an installed view and false across an
         * install: an edit typed while a hiding transform was still computing is in no
         * durable map when the install reads one, and the install then excludes its
         * row, so that install's answer omits a genuinely hidden edit and no later
         * install will correct it. Nothing the webview holds can add it back. So the
         * host re-answers on the same-basis refresh `pendingEditsChanged` already
         * triggers, the webview takes the fresh keys onto the record it is keeping, and
         * the two directions are complete: deliveries add, the live intersection
         * subtracts. Both the number the webview renders and the acknowledgement
         * identity it derives come from that one value, which is why they cannot
         * disagree (see `stale_view_signature`).
         *
         * Unbounded in principle and deliberately uncapped: the set is a subset of the
         * dirty map's keys, and the whole dirty map — keys plus values plus bases —
         * already crosses this protocol on every persist, so this is strictly smaller
         * than traffic the design already accepts.
         *
         * `commit_transform_reconciliation` is the one other writer of a permutation,
         * and it is not an exception so much as a non-event: it publishes no record at
         * all, so a reconciliation leaves the membership half exactly as stale as the
         * `rowCount` beside it, and the same later `transformInstalled` refreshes both.
         * That is the argument for carrying this on the record rather than beside it —
         * one fact about one installed view cannot drift out of step with itself.
         *
         * Cells, not rows, because two edits in one hidden row are two pieces of
         * unsaved work the user cannot see.
         */
        hiddenEditedCellKeys: readonly string[];
    }
    | {
        basis: ViewBasis;
        permuted: false;
        /**
         * The sheet's own row count. The host applied nothing, so this is every row the
         * metadata has — which is also why this arm has no `hiddenEditedCellKeys`: a
         * view containing every row cannot fail to show an edited one.
         */
        rowCount: number;
    };

/** Allocation/persistence guard shared by webview sanitization and host plans. */
export const MAX_PERSISTED_HIDDEN_ROWS = 1_000_000;

/**
 * Cap on one sheet's durable custom row heights.
 *
 * **This bound is a deliberate behaviour regression, said plainly here because it is the
 * kind of thing a reader deserves to find at the constant rather than in a bug report.**
 * Before heights became source-keyed the webview wrote `PerFileState.rowHeights` itself
 * and nothing counted the entries, so a select-all row resize on a sheet of *any* size
 * was persisted. From this change on, a select-all resize on a sheet with more than this
 * many rows is refused outright: nothing is written, no row keeps its new height, and the
 * user is warned with the limit named (`ROW_HEIGHT_LIMIT_WARNING`, `viewer-controller`).
 * Sheets at or under the bound are unaffected.
 *
 * The refusal is the price of the projection. A row resize commits the user's whole row
 * selection, which can be select-all, so `setRowHeights` can legitimately name every row
 * of the sheet. That is intended and supported up to this bound; past it the cost is not
 * the persisted bytes but the work every later delivery does. The host allocates two
 * `Uint32Array`s the size of the request in `map_display_rows_to_source`, and then
 * re-derives the display-keyed projection once per sheet per delivery — an O(overrides)
 * walk whose `overrides` would be the row count from then on, for the life of the file.
 * An uncapped map makes every snapshot O(rows), which is the cost this renderer exists
 * to have stopped paying.
 *
 * The nearest relative is `MAX_HIGHLIGHTED_CELLS_PER_FILE` (100_000), not
 * `MAX_PERSISTED_HIDDEN_ROWS` (1_000_000). Highlights are the other durable, host-owned,
 * key/value collection built one user gesture at a time, re-counted whole on every
 * mutation, and refused as a whole with a warning that names the limit — the same shape
 * in every respect. Hidden rows are the poor comparison: a sorted integer array, consumed
 * once when a permutation is computed, produced by a gesture whose entire point is to
 * name many rows at once.
 *
 * An order of magnitude below the highlight cap because a height is re-projected on
 * *every delivery* where a highlight is not, and because ten thousand hand-resized rows
 * is already far past any real gesture except select-all on a small sheet. Select-all on
 * a large one is the case this exists to bound, and refusing it is the accepted cost.
 */
export const MAX_PERSISTED_ROW_HEIGHTS = 10_000;

export interface SheetColumnVisibilityState {
    /** Canonical visibility stores exactly one side, choosing the smaller list. */
    hiddenColumns?: number[];
    visibleColumns?: number[];
    /** Uses the same sheet identity fingerprint as transform descriptors. */
    schema?: string;
}

export const CELL_HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
export type CellHighlightColor = typeof CELL_HIGHLIGHT_COLORS[number];

/** Compact rectangular-union selection: display-row runs crossed with sorted
 * canonical source columns. Adjacent row runs must be coalesced by the sender. */
export interface CellHighlightSelection {
    displayRows: DisplayRowInterval[];
    sourceColumns: number[];
}

export type CellHighlightMutation =
    | { type: 'set'; color: CellHighlightColor }
    | { type: 'clear' };

export interface SheetCellHighlightState {
    /** Same sheet/column identity fingerprint used by transforms and visibility. */
    schema: string;
    /** Canonical `"sourceRow:sourceColumn"` keys. */
    cells: Record<string, CellHighlightColor>;
}

export interface CellHighlightState {
    /** Most recent physical file content observed for these positional annotations. */
    sourceDigest: string;
    sheets: (SheetCellHighlightState | undefined)[];
}

export const EMPTY_TRANSFORM: SheetTransformState = {
    sort: [],
    filters: [],
};

export function transform_is_active(state: SheetTransformState | undefined): boolean {
    return !!state && (
        state.sort.length > 0
        || state.filters.some((entry) => entry.enabled)
        || (state.hiddenRows?.length ?? 0) > 0
    );
}

export function transform_has_entries(state: SheetTransformState | undefined): boolean {
    return !!state && (
        state.sort.length > 0
        || state.filters.length > 0
        || (state.hiddenRows?.length ?? 0) > 0
    );
}

/**
 * Columns whose *values* the installed transform reads: sort keys plus the
 * columns of enabled filters. `hiddenRows` contributes nothing — hiding is by row
 * identity, not by value, so no edit can change whether a row is hidden.
 *
 * That exclusion is about this question only, and it is easy to mistake for a
 * general claim that `hiddenRows` never matters to the stale-view notice. It does:
 * hiding a row takes any unsaved edit in it out of sight, which is a different
 * question — not "can an edit change membership?" but "which unsaved cells is the
 * user not being shown?". `SheetViewRecord.hiddenEditedCellKeys` answers that one,
 * over `hiddenRows` and enabled filters alike, and `stale_view_signature` folds
 * both answers in. Neither belongs in the other.
 *
 * Lives here rather than in `table-transform.ts` because both bundles need it:
 * the host computes permutations from it (`needed_columns` delegates), and the
 * webview decides from it whether an edit lands in a column the displayed order
 * depends on. `table-transform.ts` is host-only.
 */
export function transform_read_columns(
    state: SheetTransformState | undefined,
): Set<number> {
    const columns = new Set<number>();
    if (!state) return columns;
    for (const key of state.sort) columns.add(key.colIndex);
    for (const entry of state.filters) {
        if (entry.enabled) columns.add(entry.colIndex);
    }
    return columns;
}

export function transform_schema_for_sheet(
    sheet: WorkbookMeta['sheets'][number],
): string {
    return JSON.stringify([
        sheet.name,
        sheet.columnCount,
        sheet.columnNames ?? null,
    ]);
}

/** Recover only the stable sheet identity from a transform fingerprint. */
export function sheet_name_from_transform_schema(schema: unknown): string | undefined {
    if (typeof schema !== 'string') return undefined;
    try {
        const parsed: unknown = JSON.parse(schema);
        return Array.isArray(parsed) && typeof parsed[0] === 'string'
            ? parsed[0]
            : undefined;
    } catch {
        return undefined;
    }
}
export interface ScrollPosition {
    top: number;
    left: number;
}

export interface PerFileState {
    columnWidths?: (Record<number, number> | undefined)[];
    /**
     * Per-sheet custom row heights in pixels, keyed by **canonical source row** —
     * the same key space as `pendingEdits` and `cellHighlights`, and deliberately
     * so.
     *
     * Source-keyed because a durable annotation has to survive everything that
     * renumbers display rows: a sort, a filter, an explicit row hide, an Excel
     * first-row-header promotion. A display-keyed map does not merely go stale
     * under those, it becomes *wrong* — it names other rows — and the previous
     * design's only defence was to stop honouring the map entirely whenever a
     * transform was installed, which is why custom heights visibly vanished on
     * sort and returned on clear. Source keys have no such failure mode: the row a
     * height belongs to is identified by what it *is* rather than by where it
     * currently sits, so every permutation is a rendering question — answered by a
     * sparse display-keyed projection the host recomputes per delivery
     * (`WorkbookSnapshot.rowHeightProjection`) and per install
     * (`transformInstalled.rowHeights`) — rather than a storage one.
     *
     * The host is the only writer, and the webview is not even a *reader*. This field
     * is absent from `LayoutStatePatch`, joining `transforms`, `columnVisibility` and
     * `cellHighlights` as state a `stateChanged` message cannot touch — see
     * `layout-state-patch.ts` — and it is absent from `NormalizedPerFileState`, so no
     * delivery carries it either. Neither absence is tidiness. The webview cannot map
     * display→source for a select-all resize (it has not loaded those rows), so if it
     * could patch this leaf its only options would be to write display keys or to write
     * nothing, and the first is the bug above; and a copy it merely *held* would be a
     * source-keyed map sitting beside the display-keyed projection it renders from,
     * which is the confusion the re-keying exists to end. Not sending it is also
     * strictly cheaper on the wire, which matters most exactly where it is largest: a
     * pre-cap legacy select-all map. Writes arrive as `setRowHeights`, which the host
     * maps and clamps.
     *
     * Existing persisted maps are *migrated*, not reinterpreted, and the
     * difference from `pendingEdits` is worth stating because the two arguments
     * look alike and only one of them closes. Both rest on "no key was ever
     * written under a row permutation", which holds here for a stronger reason
     * than it does for edits: the suppression that replaced the map with `{}`
     * under an active transform was introduced by the very commit that added
     * sorting and filtering, so no released version could write a permuted height
     * even in principle. But heights are not confined to CSV, and for XLS/XLSX the
     * *projection* can differ from the source with no permutation in sight: an
     * active first-row-header promotion removes the header row from the display
     * space and shifts everything after it up one. Keys written under one of those
     * promotions are therefore off by one, which no reinterpretation can fix.
     *
     * Hence `rowHeightsVersion`. The pass recovers what is recoverable rather than
     * discarding the user's work wholesale: for a sheet with an active promotion the
     * inverse of the display space is `source = d < h ? d : d + 1` for header row
     * `h`, so the keys are *shifted* when `h === 0` and dropped only when `h > 0`,
     * where a manual header row could have moved while the promotion stayed active
     * and the old key space is not reliably reconstructible. Sheets with no active
     * promotion are already canonical and are left alone, CSV among them —
     * `rowCount === sourceRowCount` there and no promotion exists. See
     * `plan_excel_candidate_state`, and `migrate_row_heights_for_file` for why the
     * *other* writer of `excelFirstRowHeaderActive` — `plan_excel_override_state` — has
     * to discharge the same pass rather than leave it to a later load.
     */
    rowHeights?: (Record<number, number> | undefined)[];
    scrollPosition?: (ScrollPosition | undefined)[];
    activeSheetIndex?: number;
    tabOrientation?: 'horizontal' | 'vertical' | null;
    /**
     * Durable CSV edits, keyed `"<canonical source row>:<source column>"`.
     *
     * Existing persisted maps are *reinterpreted* as source-keyed rather than
     * migrated, because no key was ever created under a row permutation, so every
     * stored key is already canonical. Three independent facts make that argument
     * complete:
     *
     *  - CSV reports `rowCount === sourceRowCount` (`CsvDataSource.meta`,
     *    data-source/csv-source.ts:139-140), so for the one editable format
     *    display rows and source rows are the same numbers whenever no transform
     *    is installed.
     *  - No version that could have written one of these keys allowed a transform
     *    to be installed while editing: the host refused it whenever an edit
     *    session existed, and the webview refused both directions independently.
     *    That is a statement about the versions that wrote the data, and it is
     *    what the reinterpretation rests on — not a live invariant. Transforms and
     *    edit sessions now coexist (see `admit_transform_for_phase` in
     *    viewer-controller.ts), which is safe for the *conclusion* below because
     *    commits resolve the canonical source row before keying, so a key written
     *    under a permutation is canonical too.
     *  - `resolve_csv_save_hydration` (webview/csv-save-lifecycle.ts) passes keys
     *    through verbatim, so a round-trip through the save lifecycle cannot
     *    rewrite one either.
     *
     * So a stored key was written either with no transform installed (where the
     * two row spaces coincide) or not at all. A migration pass would therefore
     * have nothing to change, and would need a row permutation it cannot
     * reconstruct — permutations are deliberately never persisted (see
     * `transforms` below).
     */
    pendingEdits?: Record<string, string | CsvDirtyEntry>;
    /** Explicit Excel first-row choices keyed by worksheet name. Missing = auto. */
    excelFirstRowHeaders?: Record<string, ExcelHeaderOverride>;
    /** Last effective projection by worksheet name, used to detect closed-view changes. */
    excelFirstRowHeaderActive?: Record<string, boolean>;
    /** One-time migration marker for row-addressed state created before headers. */
    excelFirstRowHeaderVersion?: 1;
    /**
     * One-time migration marker saying `rowHeights` has been reconciled with the
     * canonical source-row key space it is now documented in. Separate from
     * `excelFirstRowHeaderVersion` rather than folded into it: that marker is
     * already `1` in every file this migration needs to run on, so reusing it would
     * make the pass unreachable exactly where it is needed.
     */
    rowHeightsVersion?: 1;
    /** Per-sheet view-only sort/filter descriptors. Computed row permutations
     *  are deliberately never persisted. */
    transforms?: (SheetTransformState | undefined)[];
    /** Per-sheet hidden source columns. Display projections are derived and are
     *  deliberately never persisted. */
    columnVisibility?: (SheetColumnVisibilityState | undefined)[];
    /** Sparse annotations keyed by canonical source row and source column. */
    cellHighlights?: CellHighlightState;
}

export function sanitize_excel_header_overrides(
    value: unknown,
): Record<string, ExcelHeaderOverride> {
    const result = Object.create(null) as Record<string, ExcelHeaderOverride>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const [name, mode] of Object.entries(value)) {
        if (name.length > 0 && (mode === 'on' || mode === 'off')) {
            result[name] = mode;
        }
    }
    return result;
}

export function sanitize_excel_header_active(
    value: unknown,
): Record<string, boolean> {
    const result = Object.create(null) as Record<string, boolean>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const [name, active] of Object.entries(value)) {
        if (name.length > 0 && typeof active === 'boolean') result[name] = active;
    }
    return result;
}

export interface LegacyPerFileState {
    columnWidths?: Record<string, Record<number, number>>;
    rowHeights?: Record<string, Record<number, number>>;
    scrollPosition?: Record<string, ScrollPosition>;
    activeSheet?: string;
    tabOrientation?: 'horizontal' | 'vertical' | null;
}
export type StoredPerFileState = PerFileState | LegacyPerFileState;

/** Exact conflict-preserving entry durably owned by the CSV edit session. */
export interface CsvDirtyEntry {
    readonly value: string;
    readonly base: string;
}

export type CsvDirtyMap = Readonly<Record<string, CsvDirtyEntry>>;

/** Why the host refused a save whose bases no longer match the file. Carried on
 *  the failure result rather than a separate message so it cannot be delivered
 *  out of order relative to the lifecycle transition that restores the map.
 *
 *  Concretely: `apply_save_lifecycle` (webview/grid-shell.tsx) is revision-gated —
 *  a lifecycle at or below the already-applied revision is dropped — so a
 *  rejection sent as its own message could be applied against a dirty map that
 *  has not been restored yet, naming keys the store does not hold. One message,
 *  one ordering. */
export interface CsvSaveRejection {
    readonly reason: 'baseMismatch' | 'rowsRemoved';
    readonly keys: readonly string[];
}

/** Immutable identity and payload for one accepted CSV save operation. */
export interface CsvSaveOperation {
    readonly editSessionId: string;
    readonly saveRequestId: string;
    readonly edits: Readonly<Record<string, string>>;
    readonly dirtyEdits: CsvDirtyMap;
}

export type CsvSaveLifecycle =
    | { readonly revision: number; readonly state: 'idle' }
    | { readonly revision: number; readonly state: 'active'; readonly operation: CsvSaveOperation }
    | { readonly revision: number; readonly state: 'failed'; readonly operation: CsvSaveOperation }
    | { readonly revision: number; readonly state: 'succeeded'; readonly operation: CsvSaveOperation };

export type ActiveCsvSaveLifecycle = Extract<CsvSaveLifecycle, { state: 'active' }>;
export type TerminalCsvSaveLifecycle = Extract<
    CsvSaveLifecycle,
    { state: 'failed' | 'succeeded' }
>;

/** Messages from extension host to webview. */
export type HostMessage =
    | { type: 'fontChanged'; fontFamily: string | null; fontSize: number | null }
    // Desktop only: the native Edit menu consumes Cmd/Ctrl+C and Cmd/Ctrl+A
    // before the page sees them, so it forwards the intent instead.
    | { type: 'editCommand'; command: 'copy' | 'selectAll' }
    | { type: 'workbookSnapshot'; snapshot: WorkbookSnapshot }
    | { type: 'rowData'; sheetIndex: number; startRow: number; rows: (RenderedCell | null)[][]; sourceRows: number[]; requestId: string; generation: number }
    | { type: 'scrollToRow'; row: number }
    | { type: 'saveOperationStarted'; lifecycle: ActiveCsvSaveLifecycle }
    | { type: 'saveResult'; success: boolean; lifecycle: TerminalCsvSaveLifecycle; rejection?: CsvSaveRejection }
    | { type: 'editSessionResult'; requestId: string; granted: boolean; editSessionId?: string; pendingEdits?: PerFileState['pendingEdits'] }
    | { type: 'editSessionRevoked'; reason: 'saved'; lifecycle: Extract<TerminalCsvSaveLifecycle, { state: 'succeeded' }> }
    | { type: 'saveDialogResult'; requestId: string; editSessionId: string; choice: 'save' | 'discard' | 'cancel' }
    | { type: 'filterHistogram'; sheetIndex: number; columnIndex: number; bins: HistogramBin[]; columnKind?: FilterColumnKind; distinctValues: (string | null)[]; distinctValuesExceeded: boolean; requestId: string; generation: number; sourceGeneration: number; error?: string }
    | { type: 'cellHighlightsChanged'; sheetIndex?: number; requestId?: string; stateRevision: number; physicalRevision: number; state: CellHighlightState | undefined; sourceGeneration: number; error?: string }
    /**
     * The host installed a view. This is the *only* answer that describes one, and
     * the only message that can move the view generation, so a consumer that reads
     * `view` is by construction reading something that actually happened.
     *
     * The generation lives in `view.basis` rather than beside it, unlike the other
     * host messages: two copies of it in one message is two things that can
     * disagree, and the fold guard in the webview's install handler compares
     * against exactly the generation the record was computed on.
     *
     * `rules` is beside `view` and deliberately not in it: it is the rule set the host
     * now *holds* for the sheet, which is durable intent rather than a fact about these
     * rows, and `SheetViewRecord` is retained across same-basis refreshes while a
     * message is read once and discarded. The webview's one use is to bring its durable
     * copy into line with the host's — which is why it cannot be re-derived from the
     * request either: the recovery path that drops a saved transform the sheet can no
     * longer support acknowledges the rules already installed, not the ones asked for,
     * and persisting the request there would put the unusable rules straight back.
     * Normalized to `undefined` when the set has no entries, because rules with no
     * entries are not a view but the absence of one.
     *
     * `rowHeights` is the durable custom heights re-keyed into the display space of the
     * view just installed — see `PerFileState.rowHeights` for why only the host can
     * compute that. It sits beside `view` for the same reason `rules` does, and the
     * reason is worth stating because the projection looks even more like a fact about
     * these rows than the rules do: a record is *retained* across a same-basis refresh,
     * and durable heights move with no generation bump, so a projection stored in the
     * record would be a copy going stale on an unchanged basis. A message is read once
     * and discarded, so there is no copy to go stale. See the rule on `SheetViewRecord`.
     *
     * Required rather than belt-and-braces, and this is the part that is easy to get
     * wrong: an install bumps the view generation and posts *no snapshot*. The transform
     * persist runs `update_file_state` → `update_session_state_material` →
     * `session.update_state_snapshot(...)` with no `deliver` option, and `deliver`
     * defaults to false. So without this field the webview would render the previous
     * view's display keys against the permutation just installed until some unrelated
     * delivery happened to arrive.
     */
    | { type: 'transformInstalled'; sheetIndex: number; requestId: string; intent: TransformIntent; view: SheetViewRecord; rules: SheetTransformState | undefined; rowHeights: Readonly<Record<number, number>> }
    /**
     * The host changed nothing. It deliberately carries no `view`, no `state`, no
     * `rowCount` and no `generation`: six review rounds of this feature were each a
     * consumer adopting an echo of the host's *unchanged* state as if it were an
     * install, so the fix is to make those fields unreachable rather than to
     * remember not to read them. What the view is remains whatever the last
     * `transformInstalled` (or snapshot) said.
     *
     * `terminal` says whether the request is worth retrying, and only the durable
     * half ever is. `false` — the admission matrix refusing on an edit-session phase
     * or a save in flight — clears on its own, so the restore effect asks again for a
     * *persisted* transform once it does: the stored state is still the answer, and
     * the sheet would otherwise sit unsorted for the rest of the session. A
     * *user-initiated* request is dropped with a warning and deliberately not queued —
     * replaying it later would move rows under a user who has since moved on — so it
     * must fail visibly and stay failed until the user asks again.
     *
     * `true` is validation (out-of-range sheet, stale source generation, schema
     * mismatch, an Excel header conflict, preview mode, a failed compute or commit).
     * Retrying it would only fail again, so the webview marks the source handled
     * instead, which is how a saved transform this sheet can no longer support stops
     * being asked for.
     */
    | { type: 'transformRefused'; sheetIndex: number; requestId: string; intent: TransformIntent; reason: string; terminal: boolean };

/** Messages from webview to extension host */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'snapshotApplied'; identity: WorkbookSnapshotIdentity; disposition: SnapshotDisposition }
    | { type: 'requestRows'; sheetIndex: number; startRow: number; count: number; requestId: string; generation: number }
    | { type: 'stateChanged'; state: PerFileState; sourceGeneration: number; snapshotIdentity: WorkbookSnapshotIdentity }
    | { type: 'visibleRowChanged'; row: number }
    | { type: 'requestEditSession'; requestId: string }
    | { type: 'releaseEditSession'; editSessionId: string }
    | { type: 'discardEditSession'; editSessionId: string }
    | { type: 'saveCsv'; operation: CsvSaveOperation }
    | { type: 'showSaveDialog'; editSessionId: string; requestId: string }
    | { type: 'pendingEditsChanged'; edits: Record<string, { value: string; base: string }> | null; editSessionId: string }
    // User-facing warning raised inside the webview (e.g. a clipped copy) that
    // the host surfaces via vscode.window.showWarningMessage.
    | { type: 'showWarning'; message: string }
    | { type: 'requestFilterHistogram'; sheetIndex: number; columnIndex: number; requestId: string; generation: number; sourceGeneration: number }
    | { type: 'cancelFilterHistogram'; requestId: string }
    | { type: 'setExcelFirstRowHeader'; sheetIndex: number; sheetName: string; enabled: boolean; unhideAll?: boolean; headerRow?: number; requestId: string; generation: number; sourceGeneration: number }
    | { type: 'setTransform'; sheetIndex: number; state: SheetTransformState; requestId: string; generation: number; sourceGeneration: number; intent: TransformIntent }
    | { type: 'hideRows'; sheetIndex: number; displayRows: DisplayRowInterval[]; requestId: string; generation: number; sourceGeneration: number }
    /**
     * Set one height on every row of a completed resize, named in display space.
     *
     * Display intervals rather than source rows because a resize commits the user's
     * whole row selection, which can be select-all, and the webview cannot map
     * display→source for rows it has never loaded — the mapping lives behind
     * `PanelCore.map_display_rows_to_source`. So the request says what the user
     * dragged, in the coordinates the user was looking at, and the host resolves it
     * into the canonical source rows `PerFileState.rowHeights` is keyed by.
     *
     * `generation` and `sourceGeneration` rather than a `snapshotIdentity`, exactly as
     * `hideRows` does, and the omission is deliberate rather than an economy. Those two
     * are what make a display-row interval meaningful — they identify the permutation the
     * numbers were read off — and they are the *only* thing that does. A snapshot
     * identity would add a second, stricter currency test whose failures are not about
     * the rows at all, and the consequence of failing it is no longer what it used to be:
     * `stateChanged` can be dropped on an identity mismatch harmlessly because
     * `state_ref` still holds the height and the next debounced persist resends it, but
     * the webview no longer holds durable heights, so a dropped `setRowHeights` is the
     * resize gone for good. Narrow the test to what the request actually depends on.
     *
     * A stale generation is dropped in silence, with deliberately no refusal message and
     * deliberately no deferred replay. Replaying a resize once the view has moved would
     * resize whatever rows now occupy those display positions — the same class of mistake
     * as replaying a refused sort. And no message is needed to tell the user: the
     * delivery that moved the generation is exactly what makes the webview's generation
     * differ from the one it posted, so the optimistic overlay tagged with that
     * generation is discarded and the row visibly springs back. The user's next drag is
     * the retry, and it costs one gesture.
     *
     * One `height` for the whole request, not one per row: this is the shape a resize
     * gesture has. Clamped host-side against `MIN_ROW_HEIGHT_PX`, so a webview
     * arithmetic slip cannot durably store a zero-height row, and bounded by
     * `MAX_PERSISTED_ROW_HEIGHTS`.
     *
     * No `requestId`, unlike every other request above it. The others carry one because
     * something correlates it: an ack the webview has to match against an in-flight
     * request (`setTransform`, `hideRows`, `setExcelFirstRowHeader`), or a cancellation
     * (`cancelFilterHistogram`). A resize is acknowledged only by the delivery of a new
     * projection, which the webview reconciles by *value* — an overlay layer is dropped
     * when the delivered heights agree with it — so an id here would be a protocol field
     * nothing on either side reads.
     */
    | { type: 'setRowHeights'; sheetIndex: number; rows: DisplayRowInterval[]; height: number; generation: number; sourceGeneration: number }
    | { type: 'setColumnVisibility'; sheetIndex: number; sheetName: string; state: SheetColumnVisibilityState | undefined; sourceGeneration: number; snapshotIdentity: WorkbookSnapshotIdentity }
    | { type: 'applyCellHighlights'; sheetIndex: number; sheetName: string; selection: CellHighlightSelection; mutation: CellHighlightMutation; requestId: string; generation: number; sourceGeneration: number; snapshotIdentity: WorkbookSnapshotIdentity }
    | { type: 'clearAllCellHighlights'; requestId: string; generation: number; sourceGeneration: number; snapshotIdentity: WorkbookSnapshotIdentity };
