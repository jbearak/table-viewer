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
 * Everything the webview needs to know about a view the host actually installed,
 * in one value. Only `transformInstalled` carries it, so holding one is proof that
 * an install happened — a refusal has no way to produce one.
 */
export type SheetViewRecord = {
    /**
     * What the installed view was computed against. A record whose basis differs
     * from an incoming snapshot's describes rows that no longer exist.
     *
     * `generation` and `sourceGeneration` are between them sufficient: an Excel
     * header promotion reaches the view only through `PanelCore.adopt_source`,
     * which bumps both, so a changed header row cannot arrive on an unchanged
     * basis. `schema` is not redundant with them — it is the fingerprint
     * `SheetTransformState.schema` is matched against, so keeping it here lets a
     * record be checked against a sheet directly rather than via the generations.
     */
    basis: { generation: number; sourceGeneration: number; schema: string };
    /** The rules actually installed — not the durable intent. */
    rules: SheetTransformState | undefined;
    /** Effective row count, post-filter. */
    rowCount: number;
    /** Whether display order differs from source order. */
    permuted: boolean;
    /**
     * Canonical `"sourceRow:sourceColumn"` keys of the durable pending-edit *cells*
     * whose source row this view does not contain.
     *
     * Computed on the host because that is the only place both halves of the
     * question exist at once — the permutation and the durable dirty map. Membership
     * moves only at an install: an installed filter reads saved values and
     * deliberately never recomputes mid-session, and the user can only type into rows
     * the view is showing.
     *
     * Keys rather than a bare count, and this is the refinement worth keeping
     * straight. Membership moves only at an install, but the *count* is a function of
     * two things — membership and the set of edits — and the second moves on any
     * `pendingEditsChanged`, discard or successful save, none of which install
     * anything. A count sent from here therefore went stale the moment a filtered-out
     * edit was discarded, with no later install to correct it. Keys do not: the
     * webview intersects them with its live dirty map, which subtracts every entry
     * that left it, exactly and with no message from the host.
     *
     * Subtraction is only half of it, though, and the other half is why every
     * *delivery* carries these keys too and not only `transformInstalled` (see
     * `WorkbookSnapshot.hiddenEditedCellKeys`). "A new edit can only be typed into a
     * row the view is showing" is true of an installed view and false across an
     * install: an edit typed while a hiding transform was still computing is in no
     * durable map when the install reads one, and the install then excludes its row,
     * so that install's answer omits a genuinely hidden edit and no later install will
     * correct it. Nothing the webview holds can add it back. So the host re-answers on
     * the same-basis refresh `pendingEditsChanged` already triggers, the webview takes
     * the fresh keys onto the record it is keeping, and the two directions are
     * complete: deliveries add, the live intersection subtracts. Both the number the
     * webview renders and the acknowledgement identity it derives come from that one
     * value, which is why they cannot disagree (see `stale_view_signature`).
     *
     * Unbounded in principle and deliberately uncapped: the set is a subset of the
     * dirty map's keys, and the whole dirty map — keys plus values plus bases —
     * already crosses this protocol on every persist, so this is strictly smaller
     * than traffic the design already accepts.
     *
     * `commit_transform_reconciliation` is the one other writer of a permutation, and
     * it is not an exception so much as a non-event: it publishes no record at all, so
     * a reconciliation leaves the membership half exactly as stale as the `rowCount`
     * and `permuted` beside it, and the same later `transformInstalled` refreshes all
     * three. That is the argument for carrying this on the record rather than beside it
     * — one fact about one installed view cannot drift out of step with itself.
     *
     * Cells, not rows, because two edits in one hidden row are two pieces of unsaved
     * work the user cannot see.
     */
    hiddenEditedCellKeys: readonly string[];
};

/** Allocation/persistence guard shared by webview sanitization and host plans. */
export const MAX_PERSISTED_HIDDEN_ROWS = 1_000_000;

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
     */
    | { type: 'transformInstalled'; sheetIndex: number; requestId: string; intent: TransformIntent; view: SheetViewRecord }
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
    | { type: 'setColumnVisibility'; sheetIndex: number; sheetName: string; state: SheetColumnVisibilityState | undefined; sourceGeneration: number; snapshotIdentity: WorkbookSnapshotIdentity }
    | { type: 'applyCellHighlights'; sheetIndex: number; sheetName: string; selection: CellHighlightSelection; mutation: CellHighlightMutation; requestId: string; generation: number; sourceGeneration: number; snapshotIdentity: WorkbookSnapshotIdentity }
    | { type: 'clearAllCellHighlights'; requestId: string; generation: number; sourceGeneration: number; snapshotIdentity: WorkbookSnapshotIdentity };
