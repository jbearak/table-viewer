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
}

export interface MergeRange {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
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
    pendingEdits?: Record<string, string>;
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
    | { type: 'workbookData'; data: WorkbookData; state: StoredPerFileState; defaultTabOrientation: 'horizontal' | 'vertical'; truncationMessage?: string; previewMode?: boolean; csvEditable?: boolean }
    | { type: 'reload'; data: WorkbookData; truncationMessage?: string }
    | { type: 'scrollToRow'; row: number }
    | { type: 'saveResult'; success: boolean }
    | { type: 'saveDialogResult'; choice: 'save' | 'discard' | 'cancel' };

/** Messages from webview to extension host */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'stateChanged'; state: PerFileState }
    | { type: 'visibleRowChanged'; row: number }
    | { type: 'saveCsv'; edits: Record<string, string> }
    | { type: 'showSaveDialog' }
    | { type: 'pendingEditsChanged'; edits: Record<string, string> | null };
