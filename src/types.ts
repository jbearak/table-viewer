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

const FILTER_OPERATORS = [
    'contains', 'notContains', 'equals', 'notEquals', 'startsWith', 'endsWith',
    'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'between',
    'notBetween', 'isEmpty', 'isNotEmpty', 'isOneOf',
] as const;

export type FilterOperator = typeof FILTER_OPERATORS[number];

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
     *
     * ---
     *
     * **Worksheet scoping.** The map above describes one sheet's edits. Since
     * .xlsx worksheets became editable the leaf is a *positional array* of those
     * maps, indexed by sheet, because the unit of editing is the worksheet: each
     * sheet has its own Edit button, its own dirty state and its own save.
     *
     * Each slot also carries the `sheetName` it was written against.  A bare
     * positional array is not sufficient on its own: nothing stops the workbook
     * being reordered in Excel between sessions, and a slot reattached by
     * position alone would then hand one sheet's unsaved edits to a different
     * sheet — silently, and keyed to rows that mean something else. On load a
     * slot whose name does not match the workbook is dropped rather than
     * reattached, which loses a draft only in the case where honouring it would
     * corrupt the wrong worksheet.
     *
     * Legacy flat maps migrate to slot 0 with no name recorded (see
     * `decode_stored_per_file_state`). That is exactly right for the data that
     * exists: only CSV was ever editable, CSV is single-sheet, so slot 0 *is* the
     * sheet, and an absent name is treated as "matches whatever is there".
     */
    pendingEdits?: (WorksheetPendingEdits | undefined)[];
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

function is_plain_record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function is_non_negative_integer(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function is_finite_number(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function invalid_leaf(name: string): never {
    throw new TypeError(`Persisted file state ${name} is invalid.`);
}

function validate_number_record(value: unknown, name: string): void {
    if (!is_plain_record(value)) invalid_leaf(name);
    for (const [key, entry] of Object.entries(value)) {
        if (!/^\d+$/.test(key) || !is_finite_number(entry)) invalid_leaf(name);
    }
}

function validate_number_record_collection(value: unknown, name: string): void {
    if (Array.isArray(value)) {
        for (const entry of value) {
            if (entry !== null && entry !== undefined) validate_number_record(entry, name);
        }
        return;
    }
    if (is_plain_record(value)) {
        for (const entry of Object.values(value)) validate_number_record(entry, name);
        return;
    }
    invalid_leaf(name);
}

function validate_scroll_position(value: unknown, name: string): void {
    if (
        !is_plain_record(value)
        || !is_finite_number(value.top)
        || !is_finite_number(value.left)
    ) invalid_leaf(name);
}

function validate_scroll_positions(value: unknown): void {
    if (Array.isArray(value)) {
        for (const entry of value) {
            if (entry !== null && entry !== undefined) validate_scroll_position(entry, 'scrollPosition');
        }
        return;
    }
    if (is_plain_record(value)) {
        for (const entry of Object.values(value)) validate_scroll_position(entry, 'scrollPosition');
        return;
    }
    invalid_leaf('scrollPosition');
}

function validate_integer_array(value: unknown, name: string): void {
    if (!Array.isArray(value) || value.some((entry) => !is_non_negative_integer(entry))) {
        invalid_leaf(name);
    }
}

const FILTER_OPERATOR_SET = new Set<unknown>(FILTER_OPERATORS);

function validate_transforms(value: unknown): void {
    if (!Array.isArray(value)) invalid_leaf('transforms');
    for (const transform of value) {
        if (transform === null || transform === undefined) continue;
        if (!is_plain_record(transform) || !Array.isArray(transform.sort) || !Array.isArray(transform.filters)) {
            invalid_leaf('transforms');
        }
        for (const sort of transform.sort) {
            if (!is_plain_record(sort) || !is_non_negative_integer(sort.colIndex)
                || (sort.direction !== 'asc' && sort.direction !== 'desc')) invalid_leaf('transforms');
        }
        for (const filter of transform.filters) {
            if (!is_plain_record(filter) || typeof filter.id !== 'string'
                || !is_non_negative_integer(filter.colIndex) || !FILTER_OPERATOR_SET.has(filter.operator)
                || typeof filter.caseSensitive !== 'boolean' || typeof filter.enabled !== 'boolean'
                || (filter.value !== undefined && typeof filter.value !== 'string')
                || (filter.secondValue !== undefined && typeof filter.secondValue !== 'string')
                || (filter.excludedValues !== undefined && (!Array.isArray(filter.excludedValues)
                    || filter.excludedValues.some((entry) => entry !== null && typeof entry !== 'string')))) {
                invalid_leaf('transforms');
            }
        }
        if (transform.hiddenRows !== undefined) validate_integer_array(transform.hiddenRows, 'transforms');
        if (transform.schema !== undefined && typeof transform.schema !== 'string') invalid_leaf('transforms');
    }
}

function validate_column_visibility(value: unknown): void {
    if (!Array.isArray(value)) invalid_leaf('columnVisibility');
    for (const visibility of value) {
        if (visibility === null || visibility === undefined) continue;
        if (!is_plain_record(visibility)) invalid_leaf('columnVisibility');
        if (visibility.hiddenColumns !== undefined) {
            validate_integer_array(visibility.hiddenColumns, 'columnVisibility');
        }
        if (visibility.visibleColumns !== undefined) {
            validate_integer_array(visibility.visibleColumns, 'columnVisibility');
        }
        if (visibility.schema !== undefined && typeof visibility.schema !== 'string') {
            invalid_leaf('columnVisibility');
        }
    }
}

function is_canonical_cell_key(value: string): boolean {
    const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(value);
    return match !== null
        && Number.isSafeInteger(Number(match[1]))
        && Number.isSafeInteger(Number(match[2]));
}

function validate_cell_highlights(value: unknown): void {
    if (!is_plain_record(value) || typeof value.sourceDigest !== 'string' || !Array.isArray(value.sheets)) {
        invalid_leaf('cellHighlights');
    }
    for (const sheet of value.sheets) {
        if (sheet === null || sheet === undefined) continue;
        if (!is_plain_record(sheet) || typeof sheet.schema !== 'string' || !is_plain_record(sheet.cells)) {
            invalid_leaf('cellHighlights');
        }
        for (const [key, color] of Object.entries(sheet.cells)) {
            if (!is_canonical_cell_key(key)
                || !(CELL_HIGHLIGHT_COLORS as readonly unknown[]).includes(color)) {
                invalid_leaf('cellHighlights');
            }
        }
    }
}

/** Validate one sheet's cell map, rejecting the whole leaf on any malformed entry. */
function validate_edit_cells(value: unknown): Record<string, string | CsvDirtyEntry> {
    if (!is_plain_record(value)) invalid_leaf('pendingEdits');
    for (const [key, entry] of Object.entries(value)) {
        if (!is_canonical_cell_key(key)) invalid_leaf('pendingEdits');
        if (typeof entry === 'string') continue;
        if (!is_plain_record(entry) || typeof entry.value !== 'string' || typeof entry.base !== 'string') {
            invalid_leaf('pendingEdits');
        }
    }
    return value as Record<string, string | CsvDirtyEntry>;
}

/**
 * Decode `pendingEdits` in either shape, migrating the legacy flat map.
 *
 * A plain object is a pre-worksheet map of one CSV's edits and becomes slot 0
 * with no `sheetName` — see the `pendingEdits` doc comment for why that is the
 * correct reading rather than a lossy guess. An array is already worksheet-scoped.
 * Returns `undefined` when nothing survives, so the caller can drop the leaf.
 */
function decode_pending_edits(value: unknown): (WorksheetPendingEdits | undefined)[] | undefined {
    if (is_plain_record(value)) {
        const cells = validate_edit_cells(value);
        return Object.keys(cells).length === 0 ? undefined : [{ cells }];
    }
    if (!Array.isArray(value)) invalid_leaf('pendingEdits');

    const slots: (WorksheetPendingEdits | undefined)[] = value.map((slot) => {
        if (slot === undefined || slot === null) return undefined;
        if (!is_plain_record(slot)) invalid_leaf('pendingEdits');
        if (slot.sheetName !== undefined && typeof slot.sheetName !== 'string') {
            invalid_leaf('pendingEdits');
        }
        const cells = validate_edit_cells(slot.cells);
        if (Object.keys(cells).length === 0) return undefined;
        return slot.sheetName === undefined
            ? { cells }
            : { sheetName: slot.sheetName, cells };
    });

    // Trailing empties carry no information; trimming keeps the persisted array
    // from growing once and never shrinking as sheets are saved.
    while (slots.length > 0 && slots[slots.length - 1] === undefined) slots.pop();
    return slots.length === 0 ? undefined : slots;
}

/** Validate known leaves while preserving unknown top-level leaves verbatim. */
export function decode_stored_per_file_state(value: unknown): StoredPerFileState {
    if (!is_plain_record(value)) throw new TypeError('Persisted file state must be an object.');
    const state = structuredClone(value);
    if (state.columnWidths !== undefined) validate_number_record_collection(state.columnWidths, 'columnWidths');
    if (state.rowHeights !== undefined) validate_number_record_collection(state.rowHeights, 'rowHeights');
    if (state.scrollPosition !== undefined) validate_scroll_positions(state.scrollPosition);
    if (state.transforms !== undefined) validate_transforms(state.transforms);
    if (state.columnVisibility !== undefined) validate_column_visibility(state.columnVisibility);
    if (state.cellHighlights !== undefined) validate_cell_highlights(state.cellHighlights);

    if (state.activeSheetIndex !== undefined && !is_non_negative_integer(state.activeSheetIndex)) {
        invalid_leaf('activeSheetIndex');
    }
    if (state.activeSheet !== undefined && typeof state.activeSheet !== 'string') invalid_leaf('activeSheet');
    if (state.tabOrientation !== undefined && state.tabOrientation !== null
        && state.tabOrientation !== 'horizontal' && state.tabOrientation !== 'vertical') {
        invalid_leaf('tabOrientation');
    }
    for (const marker of ['excelFirstRowHeaderVersion', 'rowHeightsVersion'] as const) {
        if (state[marker] !== undefined && state[marker] !== 1) invalid_leaf(marker);
    }
    if (state.excelFirstRowHeaders !== undefined) {
        if (!is_plain_record(state.excelFirstRowHeaders)
            || Object.values(state.excelFirstRowHeaders).some((entry) => entry !== 'on' && entry !== 'off')) {
            invalid_leaf('excelFirstRowHeaders');
        }
    }
    if (state.excelFirstRowHeaderActive !== undefined) {
        if (!is_plain_record(state.excelFirstRowHeaderActive)
            || Object.values(state.excelFirstRowHeaderActive).some((entry) => typeof entry !== 'boolean')) {
            invalid_leaf('excelFirstRowHeaderActive');
        }
    }
    if (state.pendingEdits !== undefined) {
        state.pendingEdits = decode_pending_edits(state.pendingEdits);
        if (state.pendingEdits === undefined) delete state.pendingEdits;
    }
    return state as unknown as StoredPerFileState;
}

/**
 * One worksheet's durable pending edits, plus the sheet name they were written
 * against so a workbook reordered externally cannot reattach them to the wrong
 * sheet. See the `pendingEdits` doc comment for why the name is load-bearing.
 *
 * `sheetName` is absent only for edits migrated from the pre-worksheet flat map,
 * where the file was necessarily single-sheet CSV.
 */
export interface WorksheetPendingEdits {
    readonly sheetName?: string;
    readonly cells: SheetPendingEditCells;
}

/**
 * One worksheet's pending cell edits, keyed `"<canonical source row>:<source
 * column>"`. This is the unit the edit session and the save lifecycle work in —
 * both are worksheet-scoped — so functions there take this rather than the
 * whole-workbook leaf.
 */
export type SheetPendingEditCells = Record<string, string | CsvDirtyEntry>;

/** One sheet's cell map out of the worksheet-scoped leaf, or undefined. */
export function pending_edits_for_sheet(
    pending: PerFileState['pendingEdits'],
    sheet_index: number,
    // The worksheet actually at `sheet_index`, when the caller knows it.
    sheet_name?: string,
): Record<string, string | CsvDirtyEntry> | undefined {
    const slot = pending?.[sheet_index];
    if (!slot) return undefined;
    // Position alone is not proof of ownership. Reconciliation cannot place two
    // same-named slots at one index, so a slot tagged for a *different* worksheet
    // can be sitting here — and handing its draft to a session on this sheet
    // leaked one worksheet's edits into another, keyed to rows that mean something
    // else. An untagged slot predates tagging and is single-sheet CSV by
    // construction, so it keeps the positional answer.
    if (sheet_name !== undefined && slot.sheetName !== undefined
        && slot.sheetName !== sheet_name) {
        return undefined;
    }
    return Object.keys(slot.cells).length > 0 ? slot.cells : undefined;
}

/**
 * The worksheet a restored edit map belongs to, when nothing else names it.
 *
 * A snapshot that carries edits but no live session — a reload, a restored
 * window — still says which sheet they are for, because the slot's index *is* the
 * sheet. Only one sheet can hold edits at a time (a session is worksheet-scoped
 * and there is one at a time), so the first occupied slot is the whole answer;
 * `undefined` means there is nothing to attribute.
 */
export function sheet_index_with_pending_edits(
    pending: PerFileState['pendingEdits'],
): number | undefined {
    if (!pending) return undefined;
    for (let i = 0; i < pending.length; i++) {
        if (pending_edits_for_sheet(pending, i)) return i;
    }
    return undefined;
}

/**
 * Replace one sheet's slot, preserving the others.
 *
 * Passing `undefined` cells clears that sheet — which is what a save or discard
 * does, and why it must not disturb the neighbouring sheets' unsaved work.
 * Returns `undefined` when no slot has any edits left, so callers can drop the
 * leaf entirely rather than persist an array of holes.
 *
 * A slot already sitting at `sheet_index` under some *other* worksheet's name is
 * a displaced duplicate, not this sheet's old draft: reconciliation seats only
 * one of two same-named slots at their sheet's own index and leaves the other
 * wherever a free position happens to be. Overwriting it deleted unsaved work
 * that no message ever asked to discard — and it is recoverable, since the loser
 * moves back to its own index as soon as the winner clears — so the incumbent is
 * moved to a free slot rather than dropped.
 */
export function with_pending_edits_for_sheet(
    pending: PerFileState['pendingEdits'],
    sheet_index: number,
    cells: Record<string, string | CsvDirtyEntry> | undefined,
    sheet_name?: string,
): PerFileState['pendingEdits'] {
    const next = pending ? [...pending] : [];
    while (next.length <= sheet_index) next.push(undefined);
    const incumbent = next[sheet_index];
    const foreign = sheet_name !== undefined
        && incumbent !== undefined
        && incumbent.sheetName !== undefined
        && incumbent.sheetName !== sheet_name;
    // Nothing of this worksheet's is here to clear. A slot tagged for another
    // worksheet at this index is a displaced draft, and an empty replacement is
    // this worksheet saying it has no draft — so emptying the slot would delete
    // someone else's unsaved work in the name of removing our own, which was never
    // there. The write path below relocates such an incumbent; a clear must simply
    // leave it alone, or discarding a session that never published a durable map
    // silently dropped the other worksheet's draft.
    if (foreign && !(cells && Object.keys(cells).length > 0)) return pending;
    const displaced = foreign ? incumbent : undefined;
    next[sheet_index] = cells && Object.keys(cells).length > 0
        ? (sheet_name === undefined ? { cells } : { sheetName: sheet_name, cells })
        : undefined;
    if (displaced && next[sheet_index] !== undefined) {
        let free = next.findIndex((slot, index) => index !== sheet_index && slot === undefined);
        if (free === -1) free = next.push(undefined) - 1;
        next[free] = displaced;
    }
    while (next.length > 0 && next[next.length - 1] === undefined) next.pop();
    return next.length === 0 ? undefined : next;
}

/** True when any sheet holds pending edits. */
export function has_any_pending_edits(pending: PerFileState['pendingEdits']): boolean {
    return !!pending?.some((slot) => slot && Object.keys(slot.cells).length > 0);
}

/**
 * Reattach slots to the workbook as loaded, by name where one was recorded.
 *
 * Guards the one case a positional array cannot: the workbook was reordered
 * externally, so slot *i* no longer describes sheet *i*. Reattaching by position
 * would apply a draft to the wrong worksheet, keyed to rows that mean something
 * else there — silent corruption.
 *
 * Worksheet names are unique within a workbook, so a reorder is not ambiguous:
 * the draft moves to wherever its sheet went, and only a sheet that is gone
 * entirely (deleted, or renamed outside this app) loses its draft. Dropping is
 * the last resort rather than the answer to any mismatch, because the draft is
 * the user's only copy of that work.
 *
 * "Loses its draft" is scoped to what this workbook shows: the drop is applied to
 * the snapshot a panel is projected from, and deliberately *not* written back to
 * durable state. So a name that comes back — the file restored from a backup, a
 * rename undone in Excel, a branch switched under the editor — brings its draft
 * with it. The alternative is deleting unsaved work the first time a sheet is
 * missing, with no undo and nothing shown to the user; a draft that reappears
 * alongside its worksheet is visible and dismissable, which is the recoverable
 * direction to be wrong in. (A slot only truly goes when some later write to this
 * file commits state that no longer carries it.)
 *
 * Slots with no recorded name are legacy CSV migrations (single-sheet by
 * construction) and stay where they are.
 *
 * The name is the only identity there is, and it is not a strong one: delete
 * `Inventory` elsewhere, rename another worksheet to `Inventory`, and this
 * function reattaches the draft to a sheet that merely inherited the label. The
 * save's base check is what stands between that and corruption, and it holds
 * unless the targeted cell happens to hold the same value — so the failure needs
 * an external delete, a name reuse, *and* a coincident base.
 *
 * Not fixed here, deliberately. A real identity means a stable per-worksheet key
 * (`sheetId` from `xl/workbook.xml` survives renames and changes on recreate)
 * persisted alongside the name — a durable-schema change, with a migration for
 * every slot already written without one, threaded through reconciliation and
 * rehydration both. That is a larger design than this branch's remit, and the
 * cheap version is worse than nothing: keying on the name *and* refusing when it
 * cannot prove identity would delete a draft on every ordinary rename, which is
 * the far likelier event and the loss this function exists to prevent.
 */
export function reconcile_pending_edit_sheets(
    pending: PerFileState['pendingEdits'],
    sheet_names: readonly string[],
): PerFileState['pendingEdits'] {
    if (!pending) return undefined;
    // No names is "we don't know", not "the workbook has no sheets". A save or
    // cleanup can outlive its panel, and a disposed panel has no source to name
    // them; treating that as a total mismatch would drop every tagged slot —
    // silently discarding the user's unsaved work on the way past.
    if (sheet_names.length === 0) return pending;

    const index_of_name = new Map<string, number>();
    sheet_names.forEach((name, index) => {
        if (!index_of_name.has(name)) index_of_name.set(name, index);
    });

    let changed = false;
    const next: (WorksheetPendingEdits | undefined)[] = [];
    // Unnamed slots first, so a named slot positively identified by the workbook
    // wins the position over one that only ever held it by assumption.
    pending.forEach((slot, index) => {
        if (!slot || slot.sheetName) return;
        while (next.length <= index) next.push(undefined);
        next[index] = slot;
    });
    // Names are unique *within a workbook*, but two slots can still carry the same
    // tag: a sheet renamed externally onto a name another slot already recorded
    // leaves both tagged alike until the next write. Only one can have the named
    // position, and the other's draft must not simply be overwritten — that is the
    // silent deletion this whole function exists to prevent.
    //
    // The slot *already sitting* at the named position keeps it, and only if none
    // is does the first in order claim it. Picking the first unconditionally made
    // the two swap places on every reconciliation and never settle: the winner was
    // pulled to the named index and the loser fell into the one it vacated, so the
    // next pass did the same in reverse. Preferring the incumbent is a fixed point.
    const claimant = new Map<number, number>();
    pending.forEach((slot, index) => {
        if (!slot?.sheetName) return;
        const moved_to = index_of_name.get(slot.sheetName);
        if (moved_to === undefined) return;
        const held = claimant.get(moved_to);
        if (held === undefined || (held !== moved_to && index === moved_to)) {
            claimant.set(moved_to, index);
        }
    });
    pending.forEach((slot, index) => {
        if (!slot?.sheetName) return;
        const moved_to = index_of_name.get(slot.sheetName);
        if (moved_to === undefined) {
            // The name is not in this workbook — and nothing here can tell why. A
            // worksheet deleted and a worksheet *renamed* look identical from this
            // side: both are a tag that no longer resolves. Dropping the slot was
            // therefore not "forgetting a deleted sheet's draft", it was deleting
            // unsaved work every time someone renamed a sheet in Excel while the
            // file was open — and durably, so renaming it back recovered nothing.
            //
            // So the slot is parked at its own index instead. Its draft stays
            // attached to a worksheet that may not be its own, exactly like the
            // duplicate-tag loser below: visible and dismissable, which is the
            // recoverable direction to be wrong in. A genuinely deleted sheet leaves
            // a draft the user can discard; a renamed one leaves the work intact.
            while (next.length <= index) next.push(undefined);
            let parked = next[index] === undefined ? index : next.indexOf(undefined);
            if (parked === -1) parked = next.length;
            next[parked] = slot;
            if (parked !== index) changed = true;
            return;
        }
        while (next.length <= moved_to) next.push(undefined);
        if (claimant.get(moved_to) !== index || next[moved_to] !== undefined) {
            // A loser keeps its own index when that is free, so a reconciliation
            // that changes nothing else moves nothing. Its draft stays attached to
            // a worksheet that may not be its own — visible and dismissable, which
            // is the recoverable direction to be wrong in.
            while (next.length <= index) next.push(undefined);
            let landing = next[index] === undefined ? index : next.indexOf(undefined);
            if (landing === -1) landing = next.length;
            next[landing] = slot;
            if (landing !== index) changed = true;
            return;
        }
        if (moved_to !== index) changed = true;
        next[moved_to] = slot;
    });
    if (!changed) return pending;
    while (next.length > 0 && next[next.length - 1] === undefined) next.pop();
    return next.length === 0 ? undefined : next;
}

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

/**
 * Immutable identity and payload for one accepted save operation.
 *
 * `sheetIndex` is part of the identity, not a parameter: a save writes exactly
 * one worksheet's edits, and every consumer that reconciles an operation against
 * durable state (tombstone cleanup, hydration, revocation) has to know which
 * sheet's slot it is talking about, or it will strip a neighbouring sheet's
 * unsaved work.
 */
export interface CsvSaveOperation {
    readonly editSessionId: string;
    /** Worksheet this save writes. Part of the operation's identity: a tombstone
     *  or cleanup for one sheet must never touch another's slot. */
    readonly sheetIndex: number;
    readonly saveRequestId: string;
    readonly edits: Readonly<Record<string, string>>;
    readonly dirtyEdits: CsvDirtyMap;
}

/** A save as the webview posts it. `sheetIndex` is optional on the wire for the
 *  same reason it is on the edit-session messages: a single-sheet source has
 *  only sheet 0 to name. The host normalizes it before the operation becomes an
 *  identity anything is compared against. */
export type CsvSaveOperationRequest =
    Omit<CsvSaveOperation, 'sheetIndex'> & { readonly sheetIndex?: number };

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
    // `sheetIndex` mirrors the request's: optional, defaulting to the only sheet
    // a single-sheet source has. Every host answer echoes back the sheet it was
    // asked about, so the webview can route a grant to the right worksheet store.
    | { type: 'editSessionResult'; requestId: string; granted: boolean; editSessionId?: string; sheetIndex?: number; pendingEdits?: SheetPendingEditCells }
    | { type: 'editSessionRevoked'; reason: 'saved'; sheetIndex: number; lifecycle: Extract<TerminalCsvSaveLifecycle, { state: 'succeeded' }> }
    | { type: 'saveDialogResult'; requestId: string; editSessionId: string; choice: 'save' | 'discard' | 'cancel' }
    /** The current state backend accepted a pending-edit full map through this sequence. */
    | { type: 'pendingEditsAcknowledged'; editSessionId: string; sequence: number }
    /** Stop accepting edits and report the highest full-map sequence produced. */
    | { type: 'requestPendingEditsFlush'; requestId: string }
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
    // `mappingGeneration` is this sheet's `mapping_generation` at the moment of the
    // install, which is *not* always `view.basis.generation`: an install that changes the
    // rules without producing a permutation — a filter added but left disabled — moves the
    // core-wide generation and leaves the mapping generation where it was, because display
    // row `r` is still source row `r`. The webview needs the same fact the host admits
    // resizes by, or the two disagree: the host accepts the old-generation write while the
    // webview, reading the bumped view generation as a mapping change, has already thrown
    // the optimistic layer away. Same fact `WorkbookSnapshot.mappingGenerations` carries,
    // delivered on the one message that reports an install.
    | { type: 'transformInstalled'; sheetIndex: number; requestId: string; intent: TransformIntent; view: SheetViewRecord; rules: SheetTransformState | undefined; rowHeights: Readonly<Record<number, number>>; mappingGeneration: number }
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
    // `sheetIndex` is optional so a single-sheet source can omit it; the host
    // reads a missing field as sheet 0, which is the only sheet such a source has.
    | { type: 'requestEditSession'; requestId: string; sheetIndex?: number }
    | { type: 'releaseEditSession'; editSessionId: string }
    | { type: 'discardEditSession'; editSessionId: string }
    | { type: 'saveCsv'; operation: CsvSaveOperationRequest }
    | { type: 'showSaveDialog'; editSessionId: string; requestId: string }
    | { type: 'pendingEditsChanged'; edits: Record<string, { value: string; base: string }> | null; editSessionId: string; sequence: number }
    /** Renderer close/reload barrier response; zero means no map was produced. */
    | { type: 'pendingEditsFlush'; requestId: string; editSessionId?: string; highestProducedSequence: number }
    /** The renderer could not establish the requested close/reload barrier. */
    | { type: 'pendingEditsFlushFailed'; requestId: string }
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
