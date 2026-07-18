import type { WorkbookMeta, RenderedCell } from './data-source/interface';

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
    rawType?: 'string' | 'number' | 'boolean' | 'empty';
}

export interface MergeRange {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
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
    | 'isEmpty'
    | 'isNotEmpty';

export interface FilterEntry {
    id: string;
    colIndex: number;
    operator: FilterOperator;
    value?: string;
    secondValue?: string;
    caseSensitive: boolean;
    enabled: boolean;
}

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
    pendingEdits?: Record<string, string | { value: string; base: string }>;
    /** Per-sheet view-only sort/filter descriptors. Computed row permutations
     *  are deliberately never persisted. */
    transforms?: (SheetTransformState | undefined)[];
    /** Per-sheet hidden source columns. Display projections are derived and are
     *  deliberately never persisted. */
    columnVisibility?: (SheetColumnVisibilityState | undefined)[];
}

export interface LegacyPerFileState {
    columnWidths?: Record<string, Record<number, number>>;
    rowHeights?: Record<string, Record<number, number>>;
    scrollPosition?: Record<string, ScrollPosition>;
    activeSheet?: string;
    tabOrientation?: 'horizontal' | 'vertical' | null;
}
export type StoredPerFileState = PerFileState | LegacyPerFileState;

/** Messages from extension host to webview */
export type HostMessage =
    // Paginated protocol (Phase B+). `generation` rises on every (re)load so the
    // webview can drop row windows that belong to a superseded document version.
    | { type: 'sheetMeta'; meta: WorkbookMeta; state: StoredPerFileState; defaultTabOrientation: 'horizontal' | 'vertical'; truncationMessage?: string; previewMode?: boolean; csvEditable?: boolean; csvEditingSupported?: boolean; generation: number; sourceGeneration: number }
    | { type: 'metaReload'; meta: WorkbookMeta; truncationMessage?: string; csvEditable?: boolean; csvEditingSupported?: boolean; generation: number; sourceGeneration: number }
    | { type: 'rowData'; sheetIndex: number; startRow: number; rows: (RenderedCell | null)[][]; requestId: string; generation: number }
    | { type: 'scrollToRow'; row: number }
    | { type: 'saveResult'; success: boolean }
    | { type: 'editSessionResult'; granted: boolean; pendingEdits?: PerFileState['pendingEdits'] }
    | { type: 'saveDialogResult'; choice: 'save' | 'discard' | 'cancel' }
    | { type: 'transformApplied'; sheetIndex: number; state: SheetTransformState; rowCount: number; requestId: string; generation: number; sourceGeneration: number; intent: TransformIntent; error?: string };

/** Messages from webview to extension host */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'requestRows'; sheetIndex: number; startRow: number; count: number; requestId: string; generation: number }
    | { type: 'stateChanged'; state: PerFileState }
    | { type: 'visibleRowChanged'; row: number }
    | { type: 'requestEditSession' }
    | { type: 'releaseEditSession' }
    | { type: 'discardEditSession' }
    | { type: 'saveCsv'; edits: Record<string, string> }
    | { type: 'showSaveDialog' }
    | { type: 'pendingEditsChanged'; edits: Record<string, { value: string; base: string }> | null }
    // User-facing warning raised inside the webview (e.g. a clipped copy) that
    // the host surfaces via vscode.window.showWarningMessage.
    | { type: 'showWarning'; message: string }
    | { type: 'setTransform'; sheetIndex: number; state: SheetTransformState; requestId: string; generation: number; sourceGeneration: number; intent: TransformIntent }
    | { type: 'setColumnVisibility'; sheetIndex: number; state: SheetColumnVisibilityState | undefined };
