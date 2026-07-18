import type { MergeRange } from '../types';

/** Webview-facing cell. Identical shape to the old CellData so the renderer
 *  is format-agnostic. `raw` is the raw value rendered to string (numbers/bools
 *  become their string form — acceptable: copy + edit-base both String() it). */
export interface RenderedCell {
    raw: string | null;       // null = empty cell
    formatted: string;        // display text (== raw for CSV)
    bold: boolean;
    italic: boolean;
    /** Original scalar category retained for correct numeric sorting. */
    rawType?: 'string' | 'number' | 'boolean' | 'empty';
}

export interface RowWindow {
    startRow: number;                 // 0-based, absolute
    rows: (RenderedCell | null)[][];  // rows[i][col]; outer length <= requested count
}

export interface SheetMeta {
    name: string;
    rowCount: number;
    columnCount: number;
    merges: MergeRange[];             // from types.ts (rowSpan + colSpan)
    hasFormatting: boolean;
    /** Per-column header titles (CSV/TSV first row). Length === columnCount; a
     *  blank entry means "no name" and the renderer falls back to the column
     *  letter. Omitted entirely by formats without a header row (xlsx/xls), where
     *  the renderer shows spreadsheet column letters. */
    columnNames?: string[];
}

export interface WorkbookMeta {
    sheets: SheetMeta[];
    hasFormatting: boolean;
}

export interface DataSource {
    /** Workbook structure only — no cell data. Cheap; safe to call repeatedly. */
    meta(): WorkbookMeta;
    /** Materialize a window of rows for one sheet. count may overshoot rowCount. */
    read_rows(sheet_index: number, start_row: number, count: number): RowWindow;
    /** Release buffers/handles. */
    close(): void;

    // --- Optional diagnostics, read polymorphically by panel-core ---
    // Kept optional so each source only carries what applies to its format.

    /** Set when the source was truncated (e.g. CSV beyond max_rows). */
    truncationMessage?: string;
    /** Parse-time warnings to surface to the user (xlsx/xls). */
    warnings?: string[];
    /** CSV save path: per-row field counts before padding, capped to kept rows. */
    originalColumnCounts?: number[];
    /** CSV save path: the verbatim first line (header), terminator stripped, when
     *  the source consumed row 0 as column names. The save path re-prepends it so
     *  the header survives a round-trip even though it is not a grid data row. */
    headerLine?: string;
    /** CSV save path: detected line terminator, so re-serialization round-trips. */
    lineEnding?: '\r\n' | '\r' | '\n';
}
