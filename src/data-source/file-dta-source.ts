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
    parse_value_labels,
} from '@jbearak/dta-parser';
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
// Paging avoids retaining every cell, but transforms and variable row heights
// still keep or visit row-count-sized structures. Two million admits the DHS
// dataset that motivated this source while bounding each typed row-index array
// to 8 MiB and keeping those whole-sheet passes finite.
export const MAX_FILE_BACKED_DTA_ROWS = 2_000_000;
const MAX_FILE_BACKED_DTA_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BACKED_DTA_VALUE_LABEL_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BACKED_DTA_VALUE_LABEL_ENTRIES = 65_536;
const MAX_FILE_BACKED_DTA_OBSERVATION_BYTES = 1024 * 1024;
const MAX_WHOLE_FILE_READ_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const FILE_DIGEST_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_ASYNC_READ_BYTES = 8 * 1024 * 1024;
const MAX_ASYNC_READ_CELLS = 64 * 1024;
const MAX_ASYNC_READ_ROWS = 128;
const MAX_COLUMN_RUNS_PER_READ = 8;

interface PreflightDta {
    readonly fd: number;
    readonly metadata: DtaMetadata;
    readonly stat: fs.Stats;
    readonly value_label_bytes: Buffer;
}

export interface ObservedFileDtaSource {
    readonly source: FileDtaDataSource;
    readonly digest: string;
    readonly size: number;
    readonly mtime: number;
}

export function assert_file_backed_dta_row_size(metadata: DtaMetadata): void {
    if (metadata.obs_length > MAX_FILE_BACKED_DTA_OBSERVATION_BYTES) {
        throw new Error(
            `Stata observations exceed the `
            + `${MAX_FILE_BACKED_DTA_OBSERVATION_BYTES / 1024 / 1024} MiB per-row safety limit`,
        );
    }
}

/** Enforce file-backed limits that depend only on parsed metadata and file size. */
export function assert_file_backed_dta_layout(
    metadata: DtaMetadata,
    file_size: number,
): void {
    if (
        file_size > MAX_WHOLE_FILE_READ_BYTES
        && metadata.variables.some((variable) => variable.type === 'strL')
    ) {
        throw new Error(
            'Stata files larger than 2 GiB that contain strL variables '
            + 'are not supported yet.',
        );
    }
    assert_file_backed_dta_row_size(metadata);
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

function require_synchronous_dta_file_reader(file: DtaFile): SynchronousDtaFileReader {
    const candidate = file as unknown as {
        readonly _fd?: unknown;
        readonly _metadata?: unknown;
        readonly _read_rows_range?: unknown;
    };
    const metadata = candidate._metadata;
    if (
        typeof candidate._fd !== 'number'
        || !Number.isSafeInteger(candidate._fd)
        || candidate._fd < 0
        || metadata === null
        || typeof metadata !== 'object'
        || !('obs_length' in metadata)
        || typeof metadata.obs_length !== 'number'
        || !Number.isSafeInteger(metadata.obs_length)
        || metadata.obs_length < 0
        || typeof candidate._read_rows_range !== 'function'
    ) {
        throw new Error(
            'Installed @jbearak/dta-parser does not expose the required '
            + 'random-access file interface.',
        );
    }
    return candidate as unknown as SynchronousDtaFileReader;
}

interface OwnedDtaFileConstructor {
    new (
        fd: number,
        metadata: DtaMetadata,
        value_label_tables: Map<string, Map<number, string>>,
    ): DtaFile;
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

function read_slice(fd: number, file_size: number, offset: number, requested: number): Buffer {
    const length = Math.min(Math.max(0, file_size - offset), requested);
    const bytes = Buffer.allocUnsafe(length);
    let read_position = 0;
    while (read_position < length) {
        const read = fs.readSync(
            fd, bytes, read_position, length - read_position, offset + read_position,
        );
        if (read === 0) throw new Error('Unexpected EOF while reading Stata file');
        read_position += read;
    }
    return bytes;
}

function assert_value_label_entry_limits(
    fd: number,
    metadata: DtaMetadata,
): Buffer {
    const start = metadata.section_offsets.value_labels;
    const length = metadata.section_offsets.end_of_file - start;
    if (length <= 0) return Buffer.alloc(0);
    const buffer = read_slice(fd, fs.fstatSync(fd).size, start, length);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const little_endian = metadata.byte_order === 'LSF';
    const assert_total = (total: number): void => {
        if (total > MAX_FILE_BACKED_DTA_VALUE_LABEL_ENTRIES) {
            throw new Error(
                `Stata value-label data exceeds the `
                + `${MAX_FILE_BACKED_DTA_VALUE_LABEL_ENTRIES.toLocaleString('en-US')} entry safety limit`,
            );
        }
    };
    const all_zero_from = (position: number): boolean => {
        for (let index = position; index < buffer.length; index++) {
            if (buffer[index] !== 0) return false;
        }
        return true;
    };

    if (metadata.format_version < 117) {
        const scan_offset_tables = (name_width: number): number | undefined => {
            let position = 0;
            let total = 0;
            while (position < buffer.length) {
                if (all_zero_from(position)) return total;
                const payload = position + 4 + name_width + 3;
                if (payload + 8 > buffer.length) return undefined;
                const table_length = view.getInt32(position, little_endian);
                const entries = view.getInt32(payload, little_endian);
                const text_bytes = view.getInt32(payload + 4, little_endian);
                if (table_length <= 0 || entries < 0 || text_bytes < 0) return undefined;
                const payload_length = 8 + entries * 8 + text_bytes;
                if (payload_length !== table_length) return undefined;
                const next = payload + payload_length;
                if (!Number.isSafeInteger(next) || next <= position || next > buffer.length) {
                    return undefined;
                }
                total += entries;
                position = next;
            }
            return total;
        };
        const scan_fixed8 = (name_width: number): number => {
            let position = 0;
            let total = 0;
            while (position < buffer.length) {
                if (all_zero_from(position)) return total;
                const header_width = 2 + name_width + 1;
                if (position + header_width > buffer.length) {
                    throw new Error('Truncated legacy Stata value-label table');
                }
                const entries = view.getUint16(position, little_endian);
                const next = position + header_width + entries * 10;
                if (!Number.isSafeInteger(next) || next <= position || next > buffer.length) {
                    throw new Error('Invalid legacy Stata value-label table bounds');
                }
                total += entries;
                position = next;
            }
            assert_total(total);
            return total;
        };
        if (metadata.format_version === 105) {
            const offset_entries = scan_offset_tables(33);
            if (offset_entries === undefined) scan_fixed8(9);
            else assert_total(offset_entries);
        } else if (metadata.format_version === 108) {
            const entries = scan_offset_tables(9) ?? scan_offset_tables(33);
            if (entries === undefined) {
                throw new Error('Invalid legacy Stata value-label framing');
            }
            assert_total(entries);
        } else {
            const entries = scan_offset_tables(33);
            if (entries === undefined) {
                throw new Error('Invalid legacy Stata value-label framing');
            }
            assert_total(entries);
        }
        return buffer;
    }

    const name_width = metadata.format_version === 117 ? 33 : 129;
    const open_tag = Buffer.from('<value_labels>');
    const table_tag = Buffer.from('<lbl>');
    const table_close_tag = Buffer.from('</lbl>');
    const close_tag = Buffer.from('</value_labels>');
    if (!buffer.subarray(0, open_tag.length).equals(open_tag)) {
        throw new Error('Invalid Stata value-label section opener');
    }
    let position = open_tag.length;
    let total_entries = 0;
    while (position + table_tag.length <= buffer.length) {
        if (!buffer.subarray(position, position + table_tag.length).equals(table_tag)) break;
        position += table_tag.length;
        const declared_length = view.getInt32(position, little_endian);
        const payload = position + 4 + name_width + 3;
        if (payload + 8 > buffer.length) throw new Error('Truncated Stata value-label table');
        const entries = view.getInt32(payload, little_endian);
        const text_bytes = view.getInt32(payload + 4, little_endian);
        if (entries < 0 || text_bytes < 0) throw new Error('Invalid Stata value-label table');
        total_entries += entries;
        assert_total(total_entries);
        const payload_length = 8 + entries * 8 + text_bytes;
        if (declared_length !== payload_length) {
            throw new Error('Invalid Stata value-label table length');
        }
        const close_position = payload + payload_length;
        const next = close_position + table_close_tag.length;
        if (!Number.isSafeInteger(next) || next <= position || next > buffer.length) {
            throw new Error('Invalid Stata value-label table bounds');
        }
        if (!buffer.subarray(close_position, next).equals(table_close_tag)) {
            throw new Error('Invalid Stata value-label table closer');
        }
        position = next;
    }
    if (!buffer.subarray(position, position + close_tag.length).equals(close_tag)) {
        throw new Error('Invalid Stata value-label section framing');
    }
    return buffer;
}

function preflight_metadata(file_path: string): PreflightDta {
    const fd = fs.openSync(file_path, 'r');
    try {
        const stat = fs.fstatSync(fd);
        const file_size = stat.size;
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
            let metadata: DtaMetadata;
            try {
                metadata = parse(read_prefix(fd, file_size, size));
            } catch (error) {
                last_error = error;
                if (size === file_size || size === MAX_FILE_BACKED_DTA_METADATA_BYTES) break;
                size = Math.min(
                    file_size,
                    MAX_FILE_BACKED_DTA_METADATA_BYTES,
                    size * 2,
                );
                continue;
            }
            const value_label_length = metadata.section_offsets.end_of_file
                - metadata.section_offsets.value_labels;
            if (!Number.isSafeInteger(value_label_length) || value_label_length < 0) {
                throw new Error('Invalid Stata value-label section bounds');
            }
            if (value_label_length > MAX_FILE_BACKED_DTA_VALUE_LABEL_BYTES) {
                throw new Error(
                    `Stata value-label data exceeds the `
                    + `${MAX_FILE_BACKED_DTA_VALUE_LABEL_BYTES / 1024 / 1024} MiB safety limit`,
                );
            }
            const value_label_bytes = assert_value_label_entry_limits(fd, metadata);
            return { fd, metadata, stat, value_label_bytes };
        }
        throw new Error(
            `Stata metadata could not be parsed within the `
            + `${MAX_FILE_BACKED_DTA_METADATA_BYTES / 1024 / 1024} MiB safety limit`,
            { cause: last_error },
        );
    } catch (error) {
        fs.closeSync(fd);
        throw error;
    }
}

function abort_error(): Error {
    const error = new Error('Stata source open was cancelled.');
    error.name = 'AbortError';
    return error;
}

async function digest_descriptor(
    fd: number,
    size: number,
    is_cancelled: () => boolean,
): Promise<string> {
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(FILE_DIGEST_CHUNK_BYTES, Math.max(1, size)));
    let position = 0;
    while (position < size) {
        if (is_cancelled()) throw abort_error();
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
    if (is_cancelled()) throw abort_error();
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

interface ColumnRun {
    first: number;
    last: number;
}

/**
 * Keep sparse projection reads from rereading the same complete observation an
 * unbounded number of times. Merge the smallest gaps until physical passes are
 * capped; output projection still discards every unrequested gap column.
 */
function bounded_column_runs(columns: readonly number[]): ColumnRun[] {
    const unique = [...new Set(columns)].sort((left, right) => left - right);
    const runs: ColumnRun[] = [];
    for (const column of unique) {
        const previous = runs.at(-1);
        if (previous && previous.last === column) previous.last += 1;
        else runs.push({ first: column, last: column + 1 });
    }
    while (runs.length > MAX_COLUMN_RUNS_PER_READ) {
        let merge_at = 0;
        let smallest_gap = Number.POSITIVE_INFINITY;
        for (let index = 0; index + 1 < runs.length; index++) {
            const gap = runs[index + 1].first - runs[index].last;
            if (gap < smallest_gap) {
                smallest_gap = gap;
                merge_at = index;
            }
        }
        runs[merge_at].last = runs[merge_at + 1].last;
        runs.splice(merge_at + 1, 1);
    }
    return runs;
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
        if (file.nobs > MAX_FILE_BACKED_DTA_ROWS) {
            throw new Error(
                `Stata dataset has too many observations to open safely `
                + `(max ${MAX_FILE_BACKED_DTA_ROWS.toLocaleString('en-US')})`,
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
        this.reader = require_synchronous_dta_file_reader(file);
        this.all_column_indices = file.variables.map((_, index) => index);
        this._meta = {
            hasFormatting: true,
            sheets: [{
                name: 'Sheet1',
                unnamedSingleSheet: true,
                rowCount: file.nobs,
                sourceRowCount: file.nobs,
                columnCount: file.nvar,
                estimatedRowBytes: this.reader._metadata.obs_length,
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
        is_cancelled: () => boolean = () => false,
    ): Promise<ObservedFileDtaSource> {
        let file: DtaFile | undefined;
        let preflight: PreflightDta | undefined;
        try {
            if (is_cancelled()) throw abort_error();
            preflight = preflight_metadata(file_path);
            const { metadata } = preflight;
            assert_file_backed_dta_layout(metadata, preflight.stat.size);
            if (is_cancelled()) throw abort_error();
            const label_start = metadata.section_offsets.value_labels;
            const label_bytes = preflight.value_label_bytes;
            const label_buffer = label_bytes.buffer.slice(
                label_bytes.byteOffset,
                label_bytes.byteOffset + label_bytes.byteLength,
            ) as ArrayBuffer;
            const value_label_tables = label_bytes.byteLength === 0
                ? new Map<string, Map<number, string>>()
                : parse_value_labels(label_buffer, metadata, label_start);
            const Constructor = DtaFile as unknown as OwnedDtaFileConstructor;
            file = new Constructor(preflight.fd, metadata, value_label_tables);
            // The exact descriptor preflighted above is now owned by DtaFile.
            preflight = undefined;
            let label_entries = 0;
            let label_characters = 0;
            for (const table of file.value_label_tables.values()) {
                label_entries += table.size;
                for (const label of table.values()) label_characters += label.length;
            }
            if (label_entries > MAX_FILE_BACKED_DTA_VALUE_LABEL_ENTRIES) {
                throw new Error('Stata value-label data exceeds the entry safety limit');
            }
            if (label_characters * 2 > MAX_FILE_BACKED_DTA_VALUE_LABEL_BYTES) {
                throw new Error('Decoded Stata value-label data exceeds the memory safety limit');
            }
            const source = new FileDtaDataSource(file, file_path);
            file = undefined;
            try {
                return include_digest
                    ? await source.observe_file(is_cancelled)
                    : source.observe_file_without_digest();
            } catch (error) {
                source.close();
                throw error;
            }
        } catch (error) {
            file?.close();
            if (preflight) fs.closeSync(preflight.fd);
            if (error instanceof Error && error.name === 'AbortError') throw error;
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
            Math.floor(
                MAX_ASYNC_READ_BYTES / Math.max(1, this.reader._metadata.obs_length),
            ),
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
                MAX_ASYNC_READ_BYTES / Math.max(
                    1,
                    this.reader._metadata.obs_length
                        * bounded_column_runs(column_indices).length,
                ),
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
            Math.floor(
                MAX_ASYNC_READ_BYTES / Math.max(
                    1,
                    this.reader._metadata.obs_length
                        * bounded_column_runs(column_indices).length,
                ),
            ),
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

    async physical_content_matches(
        expected_digest: string,
        is_cancelled: () => boolean,
    ): Promise<boolean> {
        this.assert_open();
        const fd = this.reader._fd;
        if (fd === null) return false;
        const before = fs.fstatSync(fd);
        const digest = await digest_descriptor(fd, before.size, is_cancelled);
        const after = fs.fstatSync(fd);
        const path_stat = fs.statSync(this.file_path);
        return digest === expected_digest
            && same_descriptor(before, after)
            && same_descriptor(after, path_stat);
    }

    private all_columns(): readonly number[] {
        return this.all_column_indices;
    }

    private observe_file_without_digest(): ObservedFileDtaSource {
        const fd = this.reader._fd;
        if (fd === null) throw new Error('Stata source is closed');
        const descriptor = fs.fstatSync(fd);
        const path_stat = fs.statSync(this.file_path);
        if (!same_descriptor(descriptor, path_stat)) {
            throw new Error('The file changed while it was being opened.');
        }
        return {
            source: this,
            digest: '',
            size: descriptor.size,
            mtime: descriptor.mtimeMs,
        };
    }

    private async observe_file(
        is_cancelled: () => boolean,
    ): Promise<ObservedFileDtaSource> {
        const fd = this.reader._fd;
        if (fd === null) throw new Error('Stata source is closed');
        const before = fs.fstatSync(fd);
        const digest = await digest_descriptor(fd, before.size, is_cancelled);
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
        const runs = bounded_column_runs([...positions.keys()]);
        const output: (RenderedCell | RawCell | null)[][] = Array.from(
            { length: count },
            () => new Array<RenderedCell | RawCell | null>(columns.length),
        );
        for (const { first, last } of runs) {
            const rows = this.reader._read_rows_range(start, count, first, last);
            rows.forEach((row, row_index) => {
                for (let column = first; column < last; column += 1) {
                    const requested_positions = positions.get(column);
                    if (!requested_positions) continue;
                    const cell = row[column - first];
                    const value = rendered
                        ? this.render_cell(cell, column)
                        : raw_stata_cell(cell);
                    for (const position of requested_positions) {
                        output[row_index][position] = value;
                    }
                }
            });
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
