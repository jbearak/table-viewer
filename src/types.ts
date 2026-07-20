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

/** Messages from extension host to webview */
export type HostMessage =
    // Paginated protocol (Phase B+). `generation` rises on every (re)load so the
    // webview can drop row windows that belong to a superseded document version.
    | { type: 'workbookSnapshot'; snapshot: WorkbookSnapshot }
    | { type: 'sheetMeta'; meta: WorkbookMeta; state: StoredPerFileState; defaultTabOrientation: 'horizontal' | 'vertical'; truncationMessage?: string; previewMode?: boolean; csvEditable?: boolean; csvEditingSupported?: boolean; generation: number; sourceGeneration: number; projectionChange?: 'excelHeader'; headerRequestId?: string; error?: string }
    | { type: 'metaReloadRecovery'; meta: WorkbookMeta; state: PerFileState; truncationMessage?: string; csvEditable?: boolean; csvEditingSupported?: boolean; projectionChange: 'excelHeader'; headerRequestId: string; generation: number; sourceGeneration: number; error?: string }
    | { type: 'metaReload'; meta: WorkbookMeta; state?: PerFileState; truncationMessage?: string; csvEditable?: boolean; csvEditingSupported?: boolean; projectionChange?: 'excelHeader'; headerRequestId?: string; generation: number; sourceGeneration: number }
    | { type: 'rowData'; sheetIndex: number; startRow: number; rows: (RenderedCell | null)[][]; requestId: string; generation: number }
    | { type: 'scrollToRow'; row: number }
    | { type: 'saveResult'; success: boolean }
    | { type: 'editSessionResult'; granted: boolean; pendingEdits?: PerFileState['pendingEdits'] }
    | { type: 'saveDialogResult'; choice: 'save' | 'discard' | 'cancel' }
    | { type: 'excelFirstRowHeaderError'; requestId: string; error: string }
    | { type: 'transformApplied'; sheetIndex: number; state: SheetTransformState; rowCount: number; requestId: string; generation: number; sourceGeneration: number; intent: TransformIntent; error?: string };

/** Messages from webview to extension host */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'snapshotApplied'; identity: WorkbookSnapshotIdentity; disposition: SnapshotDisposition }
    | { type: 'requestRows'; sheetIndex: number; startRow: number; count: number; requestId: string; generation: number }
    | { type: 'stateChanged'; state: PerFileState; sourceGeneration: number; snapshotIdentity?: WorkbookSnapshotIdentity }
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
    | { type: 'setExcelFirstRowHeader'; sheetIndex: number; sheetName: string; enabled: boolean; requestId: string; generation: number; sourceGeneration: number }
    | { type: 'setTransform'; sheetIndex: number; state: SheetTransformState; requestId: string; generation: number; sourceGeneration: number; intent: TransformIntent }
    | { type: 'setColumnVisibility'; sheetIndex: number; sheetName: string; state: SheetColumnVisibilityState | undefined; sourceGeneration: number };
