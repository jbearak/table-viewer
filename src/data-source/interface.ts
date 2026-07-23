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
    rawType?: 'string' | 'number' | 'boolean' | 'date' | 'empty';
}

export interface RowWindow {
    startRow: number;                 // 0-based, absolute
    rows: (RenderedCell | null)[][];  // rows[i][col]; outer length <= requested count
}

/** Full rendered rows selected by absolute source index. Rows are returned in
 * exactly the requested order; repeated indices produce repeated rows. */
export interface IndexedRows {
    rows: (RenderedCell | null)[][];
}

/** A compact projection of a row window onto caller-selected columns.
 * `rows[i][j]` is the cell from `column_indices[j]`; cells from other columns
 * are never materialized. */
export interface ColumnWindow {
    startRow: number;
    rows: (RenderedCell | null)[][];
}

export type ExcelHeaderOverride = 'on' | 'off';

export interface ExcelFirstRowHeaderMeta {
    /** `auto` means the detector decides; explicit modes are persisted overrides. */
    mode: 'auto' | ExcelHeaderOverride;
    detected: boolean;
    active: boolean;
    /** Whether the physical sheet currently has a first row that can be promoted. */
    available: boolean;
    /** Canonical source row currently promoted. Present only while active. */
    sourceRow?: number;
}

export interface SheetMeta {
    name: string;
    /** Rows exposed by this DataSource after logical projections such as headers. */
    rowCount: number;
    /** Size of the stable canonical row space in the underlying physical source. */
    sourceRowCount: number;
    columnCount: number;
    merges: MergeRange[];             // from types.ts (rowSpan + colSpan)
    hasFormatting: boolean;
    /** Per-column header titles. Length === columnCount; a blank entry means
     *  "no name" and the renderer falls back to the column letter. */
    columnNames?: string[];
    /** Present only for Excel sheets that support first-row header projection. */
    excelFirstRowHeader?: ExcelFirstRowHeaderMeta;
}

export interface WorkbookMeta {
    sheets: SheetMeta[];
    hasFormatting: boolean;
}

export interface DataSource {
    /** Workbook structure only — no cell data. Cheap; safe to call repeatedly. */
    meta(): WorkbookMeta;
    /** Map projected rows exposed by this DataSource to canonical source rows.
     * Optional identity default for sources without a row projection. */
    source_row_indices?(
        sheet_index: number,
        projected_rows: ArrayLike<number>,
    ): Uint32Array;
    /** Map one canonical source row back into this DataSource's projected row
     * space. Returns undefined when the source row is excluded by the projection. */
    projected_row_index?(
        sheet_index: number,
        source_row: number,
    ): number | undefined;
    /** Materialize a window of rows for one sheet. count may overshoot rowCount. */
    read_rows(sheet_index: number, start_row: number, count: number): RowWindow;
    /** Materialize arbitrary absolute rows in requested order without reading
     * the sparse span between them. Optional for third-party/test sources;
     * callers use read_source_rows_indexed for a compatibility fallback. */
    read_rows_indexed?(
        sheet_index: number,
        row_indices: ArrayLike<number>,
    ): IndexedRows;
    /** Materialize only the requested columns, in the supplied order. Optional
     *  for third-party/test sources; callers use read_source_columns for a
     *  compatibility fallback. */
    read_columns?(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow;
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

/** Map projected DataSource rows to canonical source rows. Identity sources
 * need not implement source_row_indices explicitly. */
export function read_source_row_indices(
    source: DataSource,
    sheet_index: number,
    projected_rows: ArrayLike<number>,
): Uint32Array {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) throw new RangeError(`sheet index ${sheet_index} out of range`);
    for (let position = 0; position < projected_rows.length; position++) {
        const row = projected_rows[position];
        if (!Number.isInteger(row) || row < 0 || row >= sheet.rowCount) {
            throw new RangeError(`row index ${row} out of range (${sheet.rowCount} rows)`);
        }
    }
    const source_rows = source.source_row_indices
        ? source.source_row_indices(sheet_index, projected_rows)
        : Uint32Array.from(projected_rows);
    if (source_rows.length !== projected_rows.length) {
        throw new RangeError('source row mapping length does not match projected rows');
    }
    for (const row of source_rows) {
        if (!Number.isInteger(row) || row < 0 || row >= sheet.sourceRowCount) {
            throw new RangeError(
                `source row ${row} out of range (${sheet.sourceRowCount} rows)`,
            );
        }
    }
    return source_rows;
}

/** Map one canonical source row into the DataSource's projected row space. */
export function projected_row_for_source(
    source: DataSource,
    sheet_index: number,
    source_row: number,
): number | undefined {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) throw new RangeError(`sheet index ${sheet_index} out of range`);
    if (
        !Number.isInteger(source_row)
        || source_row < 0
        || source_row >= sheet.sourceRowCount
    ) return undefined;
    const projected = source.projected_row_index
        ? source.projected_row_index(sheet_index, source_row)
        : source_row < sheet.rowCount ? source_row : undefined;
    if (projected === undefined) return undefined;
    if (!Number.isInteger(projected) || projected < 0 || projected >= sheet.rowCount) {
        throw new RangeError(`projected row ${projected} out of range (${sheet.rowCount} rows)`);
    }
    return projected;
}

/** Read arbitrary rows in requested order. Legacy sources are read as adjacent
 * ascending runs: this may make several small read_rows calls, but never reads
 * across gaps merely to reduce the call count. */
export function read_source_rows_indexed(
    source: DataSource,
    sheet_index: number,
    row_indices: ArrayLike<number>,
): IndexedRows {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) {
        throw new RangeError(`sheet index ${sheet_index} out of range`);
    }
    for (let position = 0; position < row_indices.length; position++) {
        const row = row_indices[position];
        if (!Number.isInteger(row) || row < 0 || row >= sheet.rowCount) {
            throw new RangeError(`row index ${row} out of range (${sheet.rowCount} rows)`);
        }
    }
    if (row_indices.length === 0) return { rows: [] };
    if (source.read_rows_indexed) {
        return source.read_rows_indexed(sheet_index, row_indices);
    }

    const rows: (RenderedCell | null)[][] = [];
    let position = 0;
    while (position < row_indices.length) {
        const source_start = row_indices[position];
        let run_length = 1;
        while (
            position + run_length < row_indices.length
            && row_indices[position + run_length] === source_start + run_length
        ) {
            run_length += 1;
        }
        const run = source.read_rows(sheet_index, source_start, run_length).rows;
        for (let offset = 0; offset < run_length; offset++) {
            rows.push(run[offset] ?? []);
        }
        position += run_length;
    }
    return { rows };
}

/** Read a compact column projection, falling back to full rows for legacy
 * DataSource implementations. Concrete built-in sources implement the
 * selective path so transforms do not materialize unrelated cells. */
export function read_source_columns(
    source: DataSource,
    sheet_index: number,
    start_row: number,
    count: number,
    column_indices: readonly number[],
): ColumnWindow {
    if (source.read_columns) {
        return source.read_columns(
            sheet_index,
            start_row,
            count,
            column_indices,
        );
    }
    const window = source.read_rows(sheet_index, start_row, count);
    return {
        startRow: window.startRow,
        rows: window.rows.map((row) => column_indices.map((column) => row[column] ?? null)),
    };
}
