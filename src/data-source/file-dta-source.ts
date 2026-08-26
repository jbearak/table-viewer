import {
    DtaFile,
    apply_display_format,
    is_missing_value_object,
    missing_type_to_label_key,
    type MissingType,
    type Row,
    type RowCell,
} from '@jbearak/dta-parser/node';
import { MAX_SHEET_ROWS } from '../spreadsheet-safety';
import type {
    ColumnFilterMetadata,
    ColumnWindow,
    DataSource,
    IndexedRawColumns,
    IndexedRows,
    RawCell,
    RawColumnWindow,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from './interface';

/**
 * A wide DTA remains cheap to address because rows stay on disk, but every row
 * still crosses the host/webview boundary as one array. Keep a corruption guard
 * without applying the buffer-backed source's 50-million-materialized-cell
 * budget to a source that never materializes the full table.
 */
export const MAX_FILE_BACKED_DTA_COLUMNS = 10_000;

interface SynchronousDtaFileReader {
    _read_rows_range(
        start: number,
        count: number,
        columnStart?: number,
        columnEnd?: number,
    ): Row[];
}

function missing_label_key(cell: RowCell): number | undefined {
    return is_missing_value_object(cell)
        ? missing_type_to_label_key(cell.missing_type)
        : undefined;
}

function label_key_from_raw(raw: string): number | undefined {
    if (/^\.[a-z]?$/u.test(raw)) {
        return missing_type_to_label_key(raw as MissingType);
    }
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : undefined;
}

function raw_stata_cell(cell: RowCell): RawCell {
    if (is_missing_value_object(cell)) {
        return { raw: cell.missing_type, rawType: 'number' };
    }
    return typeof cell === 'string'
        ? { raw: cell, rawType: 'string' }
        : { raw: String(cell), rawType: 'number' };
}

async function yield_to_event_loop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Node-backed Stata source for files that cannot be represented by one host
 * `readFile()` result. DtaFile keeps its descriptor open and reads observation
 * windows on demand; metadata and value-label tables are the only eager data.
 */
export class FileDtaDataSource implements DataSource {
    private readonly reader: SynchronousDtaFileReader;
    private readonly _meta: WorkbookMeta;
    private closed = false;

    private constructor(private readonly file: DtaFile) {
        if (file.nobs > MAX_SHEET_ROWS) {
            throw new Error(
                `Worksheet has too many rows to open safely (max ${MAX_SHEET_ROWS})`,
            );
        }
        if (file.nvar > MAX_FILE_BACKED_DTA_COLUMNS) {
            throw new Error(
                `Stata dataset has too many variables to open safely `
                + `(max ${MAX_FILE_BACKED_DTA_COLUMNS.toLocaleString('en-US')})`,
            );
        }
        // DtaFile's public read_rows method is Promise-shaped so large scans can
        // opt into cancellation, but its bounded range primitive is synchronous.
        // The grid's DataSource contract is synchronous for visible pages, so use
        // that primitive here and the public metadata/value-label API everywhere
        // else. This adapter is pinned to the parser version in package-lock.json.
        this.reader = file as unknown as SynchronousDtaFileReader;
        this._meta = {
            hasFormatting: true,
            sheets: [{
                name: 'Sheet1',
                unnamedSingleSheet: true,
                rowCount: file.nobs,
                sourceRowCount: file.nobs,
                columnCount: file.nvar,
                merges: [],
                hasFormatting: true,
                columnNames: file.variables.map((variable) => variable.name),
            }],
        };
    }

    static async open(file_path: string): Promise<FileDtaDataSource> {
        let file: DtaFile | undefined;
        try {
            file = await DtaFile.open(file_path);
            return new FileDtaDataSource(file);
        } catch (error) {
            file?.close();
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not open Stata file: ${detail}`, { cause: error });
        }
    }

    meta(): WorkbookMeta {
        return this._meta;
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        const { start, count: bounded_count } = this.bounded_range(
            sheet_index, start_row, count,
        );
        return {
            startRow: start,
            rows: this.read_range(start, bounded_count, this.all_columns(), true),
        };
    }

    read_rows_indexed(sheet_index: number, row_indices: ArrayLike<number>): IndexedRows {
        this.assert_sheet(sheet_index);
        const requested = Array.from(row_indices);
        requested.forEach((row) => this.assert_row(row));
        return {
            rows: requested.map((row) =>
                this.read_range(row, 1, this.all_columns(), true)[0] ?? []),
        };
    }

    async read_rows_indexed_async(
        sheet_index: number,
        row_indices: ArrayLike<number>,
        is_cancelled: () => boolean,
    ): Promise<IndexedRows> {
        this.assert_sheet(sheet_index);
        const requested = Array.from(row_indices);
        requested.forEach((row) => this.assert_row(row));
        const rows: (RenderedCell | null)[][] = [];
        for (let position = 0; position < requested.length; position += 1) {
            this.assert_active(is_cancelled);
            rows.push(this.read_range(
                requested[position], 1, this.all_columns(), true,
            )[0] ?? []);
            if ((position + 1) % 128 === 0 && position + 1 < requested.length) {
                await yield_to_event_loop();
            }
        }
        this.assert_active(is_cancelled);
        return { rows };
    }

    read_columns(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow {
        const range = this.bounded_range(sheet_index, start_row, count);
        this.assert_columns(column_indices);
        return {
            startRow: range.start,
            rows: this.read_range(range.start, range.count, column_indices, true),
        };
    }

    read_raw_columns(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): RawColumnWindow {
        const range = this.bounded_range(sheet_index, start_row, count);
        this.assert_columns(column_indices);
        return {
            startRow: range.start,
            rows: this.read_range(range.start, range.count, column_indices, false),
        };
    }

    async read_raw_columns_async(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<RawColumnWindow> {
        this.assert_active(is_cancelled);
        const result = this.read_raw_columns(
            sheet_index, start_row, count, column_indices,
        );
        this.assert_active(is_cancelled);
        return result;
    }

    async read_raw_columns_indexed_async(
        sheet_index: number,
        row_indices: ArrayLike<number>,
        column_indices: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<IndexedRawColumns> {
        this.assert_sheet(sheet_index);
        this.assert_columns(column_indices);
        const requested = Array.from(row_indices);
        requested.forEach((row) => this.assert_row(row));
        const rows: (RawCell | null)[][] = [];
        for (let position = 0; position < requested.length; position += 1) {
            this.assert_active(is_cancelled);
            rows.push(this.read_range(
                requested[position], 1, column_indices, false,
            )[0] ?? []);
            if ((position + 1) % 128 === 0 && position + 1 < requested.length) {
                await yield_to_event_loop();
            }
        }
        this.assert_active(is_cancelled);
        return { rows };
    }

    column_filter_metadata(
        sheet_index: number,
        column_index: number,
    ): ColumnFilterMetadata | undefined {
        this.assert_sheet(sheet_index);
        this.assert_column(column_index);
        const name = this.file.variables[column_index].value_label_name;
        const labels = name ? this.file.value_label_tables.get(name) : undefined;
        if (!labels || labels.size === 0) return undefined;
        let categorical_codes = false;
        for (const key of labels.keys()) {
            // Missing-value labels describe absence, not a categorical domain.
            if (key < missing_type_to_label_key('.')) {
                categorical_codes = true;
                break;
            }
        }
        return {
            categoricalCodes: categorical_codes,
            valueLabel: (raw) => {
                const key = label_key_from_raw(raw);
                return key === undefined ? undefined : labels.get(key);
            },
        };
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.file.close();
    }

    private all_columns(): number[] {
        return Array.from({ length: this.file.nvar }, (_, index) => index);
    }

    private read_range(
        start: number,
        count: number,
        columns: readonly number[],
        rendered: true,
    ): (RenderedCell | null)[][];
    private read_range(
        start: number,
        count: number,
        columns: readonly number[],
        rendered: false,
    ): (RawCell | null)[][];
    private read_range(
        start: number,
        count: number,
        columns: readonly number[],
        rendered: boolean,
    ): (RenderedCell | RawCell | null)[][] {
        if (count === 0 || columns.length === 0) {
            return Array.from({ length: count }, () => []);
        }
        this.assert_open();
        const first = Math.min(...columns);
        const last = Math.max(...columns) + 1;
        const rows = this.reader._read_rows_range(start, count, first, last);
        return rows.map((row) => columns.map((column) => {
            const cell = row[column - first];
            return rendered
                ? this.render_cell(cell, column)
                : raw_stata_cell(cell);
        }));
    }

    private render_cell(cell: RowCell, column: number): RenderedCell {
        const raw = raw_stata_cell(cell);
        const variable = this.file.variables[column];
        const labels = variable.value_label_name
            ? this.file.value_label_tables.get(variable.value_label_name)
            : undefined;
        const label_key = missing_label_key(cell)
            ?? (typeof cell === 'number' ? cell : undefined);
        const formatted = label_key === undefined
            ? raw.raw ?? ''
            : labels?.get(label_key)
                ?? (typeof cell === 'number'
                    ? apply_display_format(cell, variable.format) ?? raw.raw ?? ''
                    : raw.raw ?? '');
        return { ...raw, formatted, bold: false, italic: false };
    }

    private bounded_range(
        sheet_index: number,
        start_row: number,
        count: number,
    ): { start: number; count: number } {
        this.assert_sheet(sheet_index);
        const start = Math.max(0, Math.min(Math.floor(start_row), this.file.nobs));
        const bounded_count = Math.min(
            Math.max(0, Math.floor(count)),
            this.file.nobs - start,
        );
        return { start, count: bounded_count };
    }

    private assert_open(): void {
        if (this.closed) throw new Error('Stata source is closed');
    }

    private assert_active(is_cancelled: () => boolean): void {
        this.assert_open();
        if (is_cancelled()) {
            const error = new Error('Stata source read was cancelled.');
            error.name = 'AbortError';
            throw error;
        }
    }

    private assert_sheet(sheet_index: number): void {
        this.assert_open();
        if (sheet_index !== 0) {
            throw new RangeError(`sheet index ${sheet_index} out of range (1 sheet)`);
        }
    }

    private assert_row(row: number): void {
        if (!Number.isInteger(row) || row < 0 || row >= this.file.nobs) {
            throw new RangeError(`row index ${row} out of range (${this.file.nobs} rows)`);
        }
    }

    private assert_column(column: number): void {
        if (!Number.isInteger(column) || column < 0 || column >= this.file.nvar) {
            throw new RangeError(
                `column index ${column} out of range (${this.file.nvar} columns)`,
            );
        }
    }

    private assert_columns(columns: readonly number[]): void {
        columns.forEach((column) => this.assert_column(column));
    }
}
