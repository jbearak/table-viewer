export interface WorkbookData {
    sheets: SheetData[];
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

export interface PerFileState {
    columnWidths?: Record<string, Record<number, number>>;
    rowHeights?: Record<string, Record<number, number>>;
    scrollPosition?: Record<string, { top: number; left: number }>;
    activeSheet?: string;
    tabOrientation?: 'horizontal' | 'vertical' | null;
}

/** Messages from extension host to webview */
export type HostMessage =
    | { type: 'workbookData'; data: WorkbookData; state: PerFileState; defaultTabOrientation: 'horizontal' | 'vertical' }
    | { type: 'reload'; data: WorkbookData };

/** Messages from webview to extension host */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'stateChanged'; state: PerFileState };
