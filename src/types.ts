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
     * `error` present always means the host changed nothing and is echoing its own
     * unchanged state, generation and row count.
     *
     * `transientRefusal` distinguishes *why*: the host refused for a reason that
     * clears on its own (an edit-session phase, a save in flight). Nothing about the
     * view changed, so the webview must not adopt the echo as the new truth —
     * neither the echoed generation nor the emptied state.
     *
     * What happens to the request then depends on where it came from, and only the
     * durable half is retried. A *persisted* transform is asked for again by the
     * restore effect once the refusing condition clears: the stored state is still
     * the answer, and the sheet would otherwise sit unsorted for the rest of the
     * session. A *user-initiated* request is dropped with a warning and deliberately
     * not queued — replaying it later would move rows under a user who has since
     * moved on — so it must fail visibly and stay failed until the user asks again.
     *
     * Absent means the refusal is terminal validation (out-of-range sheet, stale
     * source generation, schema mismatch) — the echo *is* the answer, and adopting
     * it is how an invalid saved transform gets dropped from the UI.
     */
    | { type: 'transformApplied'; sheetIndex: number; state: SheetTransformState; rowCount: number; requestId: string; generation: number; sourceGeneration: number; intent: TransformIntent; error?: string; transientRefusal?: boolean };

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
