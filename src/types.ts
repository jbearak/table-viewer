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
    | 'isNotEmpty';

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
    caseSensitive: boolean;
    enabled: boolean;
}

export interface HistogramBin {
    lo: number;
    hi: number;
    count: number;
}

export type FilterColumnKind = 'numeric' | 'orderedText' | 'text' | 'unknown';

export interface SheetTransformState {
    sort: SortKey[];
    filters: FilterEntry[];
    /** Fingerprint of sheet identity + available column names. Prevents a saved
     *  transform from silently attaching to a reordered/replaced sheet. */
    schema?: string;
}

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
    /** Physical file content to which these source-row coordinates are attached. */
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
    );
}

export function transform_has_entries(state: SheetTransformState | undefined): boolean {
    return !!state && (state.sort.length > 0 || state.filters.length > 0);
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
    | { type: 'workbookSnapshot'; snapshot: WorkbookSnapshot }
    | { type: 'rowData'; sheetIndex: number; startRow: number; rows: (RenderedCell | null)[][]; sourceRows: number[]; requestId: string; generation: number }
    | { type: 'scrollToRow'; row: number }
    | { type: 'saveOperationStarted'; lifecycle: ActiveCsvSaveLifecycle }
    | { type: 'saveResult'; success: boolean; lifecycle: TerminalCsvSaveLifecycle }
    | { type: 'editSessionResult'; requestId: string; granted: boolean; editSessionId?: string; pendingEdits?: PerFileState['pendingEdits'] }
    | { type: 'editSessionRevoked'; reason: 'saved'; lifecycle: Extract<TerminalCsvSaveLifecycle, { state: 'succeeded' }> }
    | { type: 'saveDialogResult'; requestId: string; editSessionId: string; choice: 'save' | 'discard' | 'cancel' }
    | { type: 'filterHistogram'; sheetIndex: number; columnIndex: number; bins: HistogramBin[]; columnKind?: FilterColumnKind; requestId: string; generation: number; sourceGeneration: number; error?: string }
    | { type: 'cellHighlightsChanged'; sheetIndex: number; requestId?: string; stateRevision: number; physicalRevision: number; state: CellHighlightState | undefined; sourceGeneration: number; error?: string }
    | { type: 'transformApplied'; sheetIndex: number; state: SheetTransformState; rowCount: number; requestId: string; generation: number; sourceGeneration: number; intent: TransformIntent; error?: string };

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
    | { type: 'setExcelFirstRowHeader'; sheetIndex: number; sheetName: string; enabled: boolean; requestId: string; generation: number; sourceGeneration: number }
    | { type: 'setTransform'; sheetIndex: number; state: SheetTransformState; requestId: string; generation: number; sourceGeneration: number; intent: TransformIntent }
    | { type: 'setColumnVisibility'; sheetIndex: number; sheetName: string; state: SheetColumnVisibilityState | undefined; sourceGeneration: number; snapshotIdentity: WorkbookSnapshotIdentity }
    | { type: 'applyCellHighlights'; sheetIndex: number; sheetName: string; selection: CellHighlightSelection; mutation: CellHighlightMutation; requestId: string; generation: number; sourceGeneration: number; snapshotIdentity: WorkbookSnapshotIdentity };
