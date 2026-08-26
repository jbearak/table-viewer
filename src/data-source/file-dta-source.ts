import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
    DtaFile,
    apply_display_format,
    is_missing_value_object,
    missing_type_to_label_key,
    type DtaMetadata,
    type LegacyFormatVersion,
    type MissingType,
    type Row,
    type RowCell,
} from '@jbearak/dta-parser/node';
import {
    legacy_metadata_buffer_size,
    parse_legacy_metadata,
    parse_metadata,
} from '@jbearak/dta-parser';
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
const MAX_FILE_BACKED_DTA_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BACKED_DTA_VALUE_LABEL_BYTES = 16 * 1024 * 1024;
const MAX_WHOLE_FILE_READ_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const FILE_DIGEST_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_ASYNC_READ_BYTES = 8 * 1024 * 1024;
const MAX_ASYNC_READ_CELLS = 64 * 1024;
const MAX_ASYNC_READ_ROWS = 128;

export interface ObservedFileDtaSource {
    readonly source: FileDtaDataSource;
    readonly digest: string;
    readonly size: number;
    readonly mtime: number;
}

interface SynchronousDtaFileReader {
    readonly _fd: number | null;
    readonly _metadata: DtaMetadata;
    _read_rows_range(
        start: number,
        count: number,
        columnStart?: number,
        columnEnd?: number,
    ): Row[];
}

const LEGACY_RELEASES = new Set<number>([105, 108, 110, 111, 113, 114, 115]);

function read_prefix(fd: number, file_size: number, requested: number): ArrayBuffer {
    const length = Math.min(file_size, requested);
    const bytes = Buffer.allocUnsafe(length);
    let position = 0;
    while (position < length) {
        const read = fs.readSync(fd, bytes, position, length - position, position);
        if (read === 0) throw new Error('Unexpected EOF while reading Stata metadata');
        position += read;
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function preflight_metadata(file_path: string): DtaMetadata {
    const fd = fs.openSync(file_path, 'r');
    try {
        const file_size = fs.fstatSync(fd).size;
        const header = new Uint8Array(read_prefix(fd, file_size, 10));
        if (header.length < 1) throw new Error('Not a valid .dta file: file is empty');
        const release = header[0];
        let size: number;
        let parse: (buffer: ArrayBuffer) => DtaMetadata;
        if (LEGACY_RELEASES.has(release)) {
            if (header.length < 10 || (header[1] !== 1 && header[1] !== 2)) {
                throw new Error('Invalid legacy Stata header');
            }
            const nvar = new DataView(
                header.buffer, header.byteOffset, header.byteLength,
            ).getUint16(4, header[1] === 2);
            size = Math.min(
                file_size,
                legacy_metadata_buffer_size(nvar, release as LegacyFormatVersion),
            );
            parse = (buffer) => parse_legacy_metadata(buffer, file_size);
        } else {
            size = Math.min(file_size, 64 * 1024);
            parse = parse_metadata;
        }
        let last_error: unknown;
        while (size <= Math.min(file_size, MAX_FILE_BACKED_DTA_METADATA_BYTES)) {
            try {
                return parse(read_prefix(fd, file_size, size));
            } catch (error) {
                last_error = error;
                if (size === file_size || size === MAX_FILE_BACKED_DTA_METADATA_BYTES) break;
                size = Math.min(
                    file_size,
                    MAX_FILE_BACKED_DTA_METADATA_BYTES,
                    size * 2,
                );
            }
        }
        throw new Error(
            `Stata metadata could not be parsed within the `
            + `${MAX_FILE_BACKED_DTA_METADATA_BYTES / 1024 / 1024} MiB safety limit`,
            { cause: last_error },
        );
    } finally {
        fs.closeSync(fd);
    }
}

async function digest_descriptor(fd: number, size: number): Promise<string> {
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(FILE_DIGEST_CHUNK_BYTES, Math.max(1, size)));
    let position = 0;
    while (position < size) {
        const length = Math.min(chunk.byteLength, size - position);
        const bytes_read = await new Promise<number>((resolve, reject) => {
            fs.read(fd, chunk, 0, length, position, (error, read) => {
                if (error) reject(error);
                else resolve(read);
            });
        });
        if (bytes_read === 0) throw new Error('Unexpected EOF while hashing Stata file');
        digest.update(chunk.subarray(0, bytes_read));
        position += bytes_read;
    }
    return digest.digest('hex');
}

function same_descriptor(
    left: fs.Stats,
    right: fs.Stats,
): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs;
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
    private readonly all_column_indices: readonly number[];
    private closed = false;

    private constructor(
        private readonly file: DtaFile,
        private readonly file_path: string,
    ) {
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
        this.all_column_indices = file.variables.map((_, index) => index);
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
        return (await FileDtaDataSource.open_observed(file_path, false)).source;
    }

    static async open_observed(
        file_path: string,
        include_digest = true,
    ): Promise<ObservedFileDtaSource> {
        let file: DtaFile | undefined;
        try {
            const metadata = preflight_metadata(file_path);
            if (
                fs.statSync(file_path).size > MAX_WHOLE_FILE_READ_BYTES
                && metadata.variables.some((variable) => variable.type === 'strL')
            ) {
                throw new Error(
                    'Stata files larger than 2 GiB that contain strL variables '
                    + 'are not supported yet.',
                );
            }
            const value_label_bytes = metadata.section_offsets.end_of_file
                - metadata.section_offsets.value_labels;
            if (value_label_bytes > MAX_FILE_BACKED_DTA_VALUE_LABEL_BYTES) {
                throw new Error(
                    `Stata value-label data exceeds the `
                    + `${MAX_FILE_BACKED_DTA_VALUE_LABEL_BYTES / 1024 / 1024} MiB safety limit`,
                );
            }
            file = await DtaFile.open(file_path);
            const source = new FileDtaDataSource(file, file_path);
            file = undefined;
            if (!include_digest) {
                const stat = fs.statSync(file_path);
                return {
                    source,
                    digest: '',
                    size: stat.size,
                    mtime: stat.mtimeMs,
                };
            }
            try {
                return await source.observe_file();
            } catch (error) {
                source.close();
                throw error;
            }
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
        const rows_per_yield = Math.max(1, Math.min(
            MAX_ASYNC_READ_ROWS,
            Math.floor(MAX_ASYNC_READ_CELLS / Math.max(1, this.file.nvar)),
        ));
        for (let position = 0; position < requested.length; position += 1) {
            this.assert_active(is_cancelled);
            rows.push(this.read_range(
                requested[position], 1, this.all_columns(), true,
            )[0] ?? []);
            if ((position + 1) % rows_per_yield === 0 && position + 1 < requested.length) {
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
        const range = this.bounded_range(sheet_index, start_row, count);
        this.assert_columns(column_indices);
        const rows_per_chunk = Math.max(1, Math.min(
            MAX_ASYNC_READ_ROWS,
            Math.floor(
                MAX_ASYNC_READ_BYTES / Math.max(1, this.reader._metadata.obs_length),
            ),
            Math.floor(MAX_ASYNC_READ_CELLS / Math.max(1, column_indices.length)),
        ));
        const rows: (RawCell | null)[][] = [];
        for (let offset = 0; offset < range.count; offset += rows_per_chunk) {
            this.assert_active(is_cancelled);
            const chunk_count = Math.min(rows_per_chunk, range.count - offset);
            rows.push(...this.read_range(
                range.start + offset,
                chunk_count,
                column_indices,
                false,
            ));
            if (offset + chunk_count < range.count) await yield_to_event_loop();
        }
        this.assert_active(is_cancelled);
        return { startRow: range.start, rows };
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
        const rows_per_yield = Math.max(1, Math.min(
            MAX_ASYNC_READ_ROWS,
            Math.floor(MAX_ASYNC_READ_CELLS / Math.max(1, column_indices.length)),
        ));
        for (let position = 0; position < requested.length; position += 1) {
            this.assert_active(is_cancelled);
            rows.push(this.read_range(
                requested[position], 1, column_indices, false,
            )[0] ?? []);
            if ((position + 1) % rows_per_yield === 0 && position + 1 < requested.length) {
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

    private all_columns(): readonly number[] {
        return this.all_column_indices;
    }

    private async observe_file(): Promise<ObservedFileDtaSource> {
        const fd = this.reader._fd;
        if (fd === null) throw new Error('Stata source is closed');
        const before = fs.fstatSync(fd);
        const digest = await digest_descriptor(fd, before.size);
        const after = fs.fstatSync(fd);
        const path_stat = fs.statSync(this.file_path);
        if (!same_descriptor(before, after) || !same_descriptor(after, path_stat)) {
            throw new Error('The file changed while it was being opened.');
        }
        return {
            source: this,
            digest,
            size: after.size,
            mtime: after.mtimeMs,
        };
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
        const positions = new Map<number, number[]>();
        columns.forEach((column, position) => {
            const existing = positions.get(column);
            if (existing) existing.push(position);
            else positions.set(column, [position]);
        });
        const unique = [...positions.keys()].sort((left, right) => left - right);
        const output: (RenderedCell | RawCell | null)[][] = Array.from(
            { length: count },
            () => new Array<RenderedCell | RawCell | null>(columns.length),
        );
        let run_start = 0;
        while (run_start < unique.length) {
            let run_end = run_start + 1;
            while (
                run_end < unique.length
                && unique[run_end] === unique[run_end - 1] + 1
            ) run_end += 1;
            const first = unique[run_start];
            const last = unique[run_end - 1] + 1;
            const rows = this.reader._read_rows_range(start, count, first, last);
            rows.forEach((row, row_index) => {
                for (let column = first; column < last; column += 1) {
                    const cell = row[column - first];
                    const value = rendered
                        ? this.render_cell(cell, column)
                        : raw_stata_cell(cell);
                    for (const position of positions.get(column)!) {
                        output[row_index][position] = value;
                    }
                }
            });
            run_start = run_end;
        }
        return output;
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
