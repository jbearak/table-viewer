import {
    apply_display_format,
    build_gso_index,
    is_legacy_format,
    is_missing_value_object,
    parse_legacy_metadata,
    parse_metadata,
    parse_value_labels,
    read_rows_from_buffer,
    resolve_strl,
    type DtaMetadata,
    type Row,
    type RowCell,
    type VariableInfo,
} from '@jbearak/dta-parser';
import { assert_safe_sheet_shape, create_workbook_budget } from '../spreadsheet-safety';
import type {
    ColumnWindow,
    DataSource,
    IndexedRows,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from './interface';

const DECODE_WINDOW_ROWS = 256;
const MAX_DECODED_WINDOWS = 8;
const MAX_DECODED_CELLS = DECODE_WINDOW_ROWS * 256;

type ValueLabelTables = Map<string, Map<number, string>>;

interface CachedWindow {
    readonly rows: (RenderedCell | null)[][];
    readonly cellCount: number;
}

/** Read-only, buffer-backed Stata source with bounded lazy row decoding. */
export class DtaDataSource implements DataSource {
    private readonly _meta: WorkbookMeta;
    private readonly windows = new Map<string, CachedWindow>();
    private readonly all_columns: readonly number[];
    private readonly bytes: Uint8Array;
    private readonly pre_unicode_decoder = new TextDecoder('windows-1252');
    private value_label_tables?: ValueLabelTables;
    private gso_index?: ReturnType<typeof build_gso_index>;

    private constructor(
        private readonly buffer: ArrayBuffer,
        private readonly metadata: DtaMetadata,
    ) {
        assert_safe_sheet_shape(
            create_workbook_budget(),
            metadata.nobs,
            metadata.nvar,
            0,
        );
        const data_start = metadata.section_offsets.data
            + (is_legacy_format(metadata.format_version) ? 0 : '<data>'.length);
        const data_end = data_start + metadata.nobs * metadata.obs_length;
        if (
            !Number.isSafeInteger(data_end)
            || data_end > buffer.byteLength
            || data_end > metadata.section_offsets.strls
        ) {
            throw new Error('Corrupt .dta file: observation data is truncated');
        }
        this.all_columns = metadata.variables.map((_, index) => index);
        this.bytes = new Uint8Array(buffer);
        this._meta = {
            hasFormatting: true,
            sheets: [{
                name: 'Sheet1',
                unnamedSingleSheet: true,
                rowCount: metadata.nobs,
                sourceRowCount: metadata.nobs,
                columnCount: metadata.nvar,
                merges: [],
                hasFormatting: true,
                columnNames: metadata.variables.map((variable) => variable.name),
            }],
        };
    }

    static async create(bytes: Uint8Array): Promise<DtaDataSource> {
        const buffer = bytes.buffer instanceof ArrayBuffer
            && bytes.byteOffset === 0
            && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.slice().buffer;
        try {
            const metadata = bytes[0] === '<'.charCodeAt(0)
                ? parse_metadata(buffer)
                : parse_legacy_metadata(buffer, buffer.byteLength);
            return new DtaDataSource(buffer, metadata);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not open Stata file: ${detail}`, { cause: error });
        }
    }

    meta(): WorkbookMeta {
        return this._meta;
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        this.assert_sheet(sheet_index);
        const start = this.clamp_start(start_row);
        const end = Math.min(start + Math.max(0, count), this.metadata.nobs);
        return {
            startRow: start,
            rows: this.read_range(start, end, this.all_columns),
        };
    }

    read_rows_indexed(sheet_index: number, row_indices: ArrayLike<number>): IndexedRows {
        this.assert_sheet(sheet_index);
        const requested = Array.from(row_indices);
        for (const row of requested) this.assert_row(row);
        if (requested.length === 0) return { rows: [] };

        const materialized = new Map<number, (RenderedCell | null)[]>();
        const unique = [...new Set(requested)].sort((a, b) => a - b);
        let position = 0;
        while (position < unique.length) {
            const first = unique[position];
            let run_length = 1;
            while (
                run_length < DECODE_WINDOW_ROWS
                && position + run_length < unique.length
                && unique[position + run_length] === first + run_length
            ) run_length += 1;
            const window = this.decoded_window(first, run_length, this.all_columns);
            for (let offset = 0; offset < run_length; offset++) {
                materialized.set(first + offset, window.rows[offset]);
            }
            position += run_length;
        }
        return { rows: requested.map((row) => materialized.get(row)!) };
    }

    read_columns(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow {
        this.assert_sheet(sheet_index);
        for (const column of column_indices) this.assert_column(column);
        const start = this.clamp_start(start_row);
        const end = Math.min(start + Math.max(0, count), this.metadata.nobs);
        if (start >= end || column_indices.length === 0) {
            return { startRow: start, rows: Array.from({ length: end - start }, () => []) };
        }

        const columns = [...new Set(column_indices)].sort((a, b) => a - b);
        const positions = new Map(columns.map((column, index) => [column, index]));
        const rows = this.read_range(start, end, columns);
        return {
            startRow: start,
            rows: rows.map((row) => column_indices.map((column) => row[positions.get(column)!])),
        };
    }

    close(): void {
        this.windows.clear();
        this.value_label_tables = undefined;
        this.gso_index = undefined;
    }

    private read_range(
        start: number,
        end: number,
        columns: readonly number[],
    ): (RenderedCell | null)[][] {
        const rows: (RenderedCell | null)[][] = [];
        for (let row = start; row < end;) {
            const window_start = this.window_start(row);
            const window = this.decoded_window(
                window_start,
                Math.min(DECODE_WINDOW_ROWS, this.metadata.nobs - window_start),
                columns,
            );
            const offset = row - window_start;
            const take = Math.min(window.rows.length - offset, end - row);
            rows.push(...window.rows.slice(offset, offset + take));
            row += take;
        }
        return rows;
    }

    private decoded_window(
        start: number,
        count: number,
        columns: readonly number[],
    ): CachedWindow {
        const key = `${start}:${count}:${columns.join(',')}`;
        const cached = this.windows.get(key);
        if (cached) {
            this.windows.delete(key);
            this.windows.set(key, cached);
            return cached;
        }

        const raw_rows = this.decode_columns(start, count, columns);
        const window: CachedWindow = {
            rows: raw_rows.map((row, row_offset) => row.map((cell, index) =>
                this.render_cell(
                    cell,
                    this.metadata.variables[columns[index]],
                    start + row_offset,
                ))),
            cellCount: count * columns.length,
        };
        this.windows.set(key, window);
        let cached_cells = [...this.windows.values()]
            .reduce((total, entry) => total + entry.cellCount, 0);
        while (
            this.windows.size > 1
            && (
                this.windows.size > MAX_DECODED_WINDOWS
                || cached_cells > MAX_DECODED_CELLS
            )
        ) {
            const oldest_key = this.windows.keys().next().value!;
            const oldest = this.windows.get(oldest_key)!;
            this.windows.delete(oldest_key);
            cached_cells -= oldest.cellCount;
        }
        return window;
    }

    private decode_columns(start: number, count: number, columns: readonly number[]): Row[] {
        if (columns.length === 0) return Array.from({ length: count }, () => []);
        const rows: Row[] = Array.from({ length: count }, () => []);
        let position = 0;
        while (position < columns.length) {
            const first = columns[position];
            let length = 1;
            while (
                position + length < columns.length
                && columns[position + length] === first + length
            ) length += 1;
            const decoded = read_rows_from_buffer(
                this.buffer,
                this.metadata,
                start,
                count,
                first,
                first + length,
            );
            for (let row = 0; row < count; row++) rows[row].push(...(decoded[row] ?? []));
            position += length;
        }
        return rows;
    }

    private render_cell(
        cell: RowCell,
        variable: VariableInfo,
        row: number,
    ): RenderedCell {
        if (variable.type === 'strL') {
            const data_start = this.metadata.section_offsets.data
                + (is_legacy_format(this.metadata.format_version) ? 0 : '<data>'.length);
            const pointer_offset = data_start
                + row * this.metadata.obs_length
                + variable.byte_offset;
            this.gso_index ??= build_gso_index(this.buffer, this.metadata);
            const resolved = resolve_strl(
                this.buffer,
                this.metadata,
                this.gso_index,
                pointer_offset,
            );
            if (resolved === null) {
                throw new Error(`Stata strL cell at row ${row} has a dangling reference`);
            }
            cell = resolved;
        }
        if (
            typeof cell === 'string'
            && variable.type !== 'strL'
            && this.metadata.format_version < 118
        ) {
            const offset = this.metadata.section_offsets.data
                + row * this.metadata.obs_length
                + variable.byte_offset;
            let end = offset;
            const limit = offset + variable.byte_width;
            while (end < limit && this.bytes[end] !== 0) end += 1;
            cell = this.pre_unicode_decoder.decode(this.bytes.subarray(offset, end));
        }
        if (is_missing_value_object(cell)) {
            return {
                raw: null,
                formatted: cell.missing_type,
                bold: false,
                italic: false,
                rawType: 'empty',
            };
        }
        if (typeof cell === 'string') {
            return {
                raw: cell,
                formatted: cell,
                bold: false,
                italic: false,
                rawType: 'string',
            };
        }

        const raw = String(cell);
        const labels = variable.value_label_name
            ? this.value_labels().get(variable.value_label_name)
            : undefined;
        return {
            raw,
            formatted: labels?.get(cell) ?? apply_display_format(cell, variable.format) ?? raw,
            bold: false,
            italic: false,
            rawType: 'number',
        };
    }

    private value_labels(): ValueLabelTables {
        this.value_label_tables ??= parse_value_labels(this.buffer, this.metadata);
        return this.value_label_tables;
    }

    private window_start(row: number): number {
        return Math.floor(row / DECODE_WINDOW_ROWS) * DECODE_WINDOW_ROWS;
    }

    private clamp_start(start: number): number {
        return Math.max(0, Math.min(start, this.metadata.nobs));
    }

    private assert_sheet(sheet_index: number): void {
        if (!Number.isInteger(sheet_index) || sheet_index !== 0) {
            throw new RangeError(`sheet index ${sheet_index} out of range (1 sheet)`);
        }
    }

    private assert_row(row: number): void {
        if (!Number.isInteger(row) || row < 0 || row >= this.metadata.nobs) {
            throw new RangeError(`row index ${row} out of range (${this.metadata.nobs} rows)`);
        }
    }

    private assert_column(column: number): void {
        if (!Number.isInteger(column) || column < 0 || column >= this.metadata.nvar) {
            throw new RangeError(`column index ${column} out of range (${this.metadata.nvar} columns)`);
        }
    }
}
