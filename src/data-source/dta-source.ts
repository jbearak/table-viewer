import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { raw_stata_missing_cell } from './stata-missing-cell';
import {
    MISSING,
    formatValue,
    isMissing,
    missingValue,
    openDta,
    type Cell,
    type Column,
    type DtaError,
    type DtaReader,
    type Options,
    type ValueLabels,
    type Variable,
} from '@jbearak/dta-parser';
import {
    assert_safe_sheet_shape,
    create_workbook_budget,
    MAX_SHEET_COLUMNS,
} from '../spreadsheet-safety';
import {
    DEFERRED_COMPARISON_IDENTITY,
    DEFERRED_FILTER_IDENTITY,
    type ColumnFilterMetadata,
    type ColumnWindow,
    type DataSource,
    type DeferredCellIdentity,
    type IndexedRawColumns,
    type IndexedRows,
    type RawCell,
    type RawColumnWindow,
    type RenderedCell,
    type RowWindow,
    type WorkbookMeta,
} from './interface';

const DECODE_WINDOW_ROWS = 256;
const MAX_DECODED_WINDOWS = 8;
const MAX_DECODED_CELLS = DECODE_WINDOW_ROWS * MAX_SHEET_COLUMNS;
const MAX_DECODED_CACHE_BYTES = 16 * 1024 * 1024;
/** Text strLs above this are refused. 1.0 decodes a strL before its size is
 * known, so this is checked after the parser has produced the string. */
const MAX_TEXT_STRL_BYTES = 16 * 1024 * 1024;
/** Cells decoded between cooperative yields in the async paths. */
const ASYNC_CELLS_PER_CHUNK = 64 * 1024;
const ASYNC_MAX_ROWS_PER_CHUNK = 4096;
const BINARY_IDENTITY_CHUNK_BYTES = 256 * 1024;
const BINARY_GSO_PREVIEW_BYTES = 32;
const BINARY_GSO_COMPARISON_PREFIX = 'stata-binary:sha256:';
/** Decoded binary strLs kept so rereads share one identity (and its digest). */
const MAX_BINARY_CACHE_ENTRIES = 256;
const MAX_BINARY_CACHE_BYTES = 16 * 1024 * 1024;
const MISSING_CODE = /^\.[a-z]?$/u;
// Called once per cell. Bundled, a call to an import goes through a getter
// for the CommonJS package's export; local bindings skip it (about 10% of a
// rendered page).
const format_value = formatValue;
const missing_value = missingValue;

/** Whether a raw number is a missing code. Formatted numbers never start with `.`. */
function is_missing_code(raw: string): boolean {
    return raw.charCodeAt(0) === 0x2e && MISSING_CODE.test(raw);
}

/** Bytes one observation occupies on disk, from its variables' storage types. */
export function stata_observation_bytes(variables: readonly Variable[]): number {
    let bytes = 0;
    for (const { type } of variables) {
        if (type === 'byte') bytes += 1;
        else if (type === 'int') bytes += 2;
        else if (type === 'long' || type === 'float') bytes += 4;
        else if (type === 'double' || type === 'strL') bytes += 8;
        else if (type.startsWith('str')) bytes += Number(type.slice(3));
    }
    return bytes;
}

function label_for(labels: ValueLabels | undefined, raw: string): string | undefined {
    if (labels === undefined) return undefined;
    if (is_missing_code(raw)) return labels.get(MISSING[raw]);
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? labels.get(numeric) : undefined;
}

export function filter_metadata_from_labels(
    labels: ValueLabels | undefined,
): ColumnFilterMetadata | undefined {
    if (!labels || labels.size === 0) return undefined;
    let categorical_codes = false;
    for (const value of labels.keys()) {
        // Missing-value labels describe absence, not a categorical domain.
        if (typeof value === 'number') {
            categorical_codes = true;
            break;
        }
    }
    return {
        categoricalCodes: categorical_codes,
        valueLabel: (raw) => label_for(labels, raw),
    };
}

function source_abort_error(): Error {
    const error = new Error('Stata source read was cancelled.');
    error.name = 'AbortError';
    return error;
}

async function yield_to_event_loop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function is_strictly_increasing(values: ArrayLike<number>): boolean {
    for (let index = 1; index < values.length; index++) {
        if (values[index] <= values[index - 1]) return false;
    }
    return true;
}

/** A binary strL as the parser returned it, with its bounded display preview. */
interface BinaryGso {
    readonly kind: 'binary-gso';
    readonly bytes: Uint8Array;
    readonly formatted: string;
    key?: string;
}

function binary_gso(bytes: Uint8Array): BinaryGso {
    const preview_length = Math.min(bytes.length, BINARY_GSO_PREVIEW_BYTES);
    let preview = '';
    for (let offset = 0; offset < preview_length; offset++) {
        preview += bytes[offset].toString(16).padStart(2, '0');
    }
    const suffix = bytes.length > preview_length ? '…' : '';
    return {
        kind: 'binary-gso',
        bytes,
        formatted: `binary (${bytes.length} bytes): ${preview}${suffix}`,
    };
}

function rendered_stata_cell(raw_cell: RawCell, formatted: string): RenderedCell {
    const cell = raw_cell as RenderedCell;
    cell.formatted = formatted;
    cell.bold = false;
    cell.italic = false;
    return cell;
}

interface CachedWindow {
    readonly rows: (RenderedCell | null)[][];
    readonly cellCount: number;
    readonly byteCount: number;
}

/**
 * Read-only Stata source over a dta-parser 1.0 reader. The reader seeks and
 * decodes; this class keeps a small cache of rendered windows, applies value
 * labels and display formats, and gives binary strLs deferred identities.
 */
export class StataReaderSource implements DataSource {
    protected readonly _meta: WorkbookMeta;
    protected readonly nobs: number;
    protected readonly variables: readonly Variable[];
    private readonly all_columns: readonly number[];
    private readonly windows = new Map<string, CachedWindow>();
    private window_cache_cells = 0;
    private window_cache_bytes = 0;
    private reader_handle?: DtaReader;
    private lifecycle_epoch = 0;
    private readonly binaries = new Map<string, DtaBinaryIdentity>();
    private binary_bytes = 0;

    protected constructor(reader: DtaReader) {
        this.reader_handle = reader;
        this.nobs = reader.info.nobs;
        this.variables = reader.variables;
        this.all_columns = reader.variables.map((_, index) => index);
        this._meta = {
            hasFormatting: true,
            sheets: [{
                name: 'Sheet1',
                unnamedSingleSheet: true,
                rowCount: this.nobs,
                sourceRowCount: this.nobs,
                columnCount: this.variables.length,
                estimatedRowBytes: stata_observation_bytes(this.variables),
                merges: [],
                hasFormatting: true,
                columnNames: this.variables.map((variable) => variable.name),
            }],
        };
    }

    meta(): WorkbookMeta {
        return this._meta;
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        this.open_reader();
        this.assert_sheet(sheet_index);
        const start = this.clamp_start(start_row);
        const end = Math.min(start + Math.max(0, count), this.nobs);
        return { startRow: start, rows: this.read_range(start, end, this.all_columns) };
    }

    read_rows_indexed(sheet_index: number, row_indices: ArrayLike<number>): IndexedRows {
        this.open_reader();
        this.assert_sheet(sheet_index);
        const requested = Array.from(row_indices);
        for (const row of requested) this.assert_row(row);
        if (requested.length === 0) return { rows: [] };
        const materialized = new Map<number, (RenderedCell | null)[]>();
        for (const { start, count } of row_runs(requested, DECODE_WINDOW_ROWS)) {
            const window = this.decoded_window(start, count, this.all_columns);
            for (let offset = 0; offset < count; offset++) {
                materialized.set(start + offset, window.rows[offset]);
            }
        }
        return { rows: requested.map((row) => materialized.get(row)!) };
    }

    async read_rows_indexed_async(
        sheet_index: number,
        row_indices: ArrayLike<number>,
        is_cancelled: () => boolean,
    ): Promise<IndexedRows> {
        const epoch = this.capture_lifecycle_epoch();
        this.assert_sheet(sheet_index);
        const requested = Array.from(row_indices);
        for (const row of requested) this.assert_row(row);
        this.assert_async_active(epoch, is_cancelled);
        if (requested.length === 0) return { rows: [] };
        if (this.all_columns.length === 0) return { rows: requested.map(() => []) };
        const raw = await this.read_raw_columns_indexed_async(
            sheet_index, requested, this.all_columns, is_cancelled,
        );
        this.assert_async_active(epoch, is_cancelled);
        const labels = this.all_columns.map((column) => this.labels_of(column));
        const rows: (RenderedCell | null)[][] = [];
        for (let row = 0; row < raw.rows.length; row++) {
            rows.push(raw.rows[row].map((cell, column) => cell === null
                ? null
                : this.render_raw_cell(cell, this.variables[column], labels[column])));
            if ((row + 1) % ASYNC_MAX_ROWS_PER_CHUNK === 0) {
                await yield_to_event_loop();
                this.assert_async_active(epoch, is_cancelled);
            }
        }
        return { rows };
    }

    read_columns(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow {
        return this.read_column_projection(
            sheet_index, start_row, count, column_indices,
            (start, end, columns) => this.read_range(start, end, columns),
        );
    }

    read_raw_columns(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): RawColumnWindow {
        return this.read_column_projection(
            sheet_index, start_row, count, column_indices,
            (start, end, columns) => this.read_raw_range(start, end, columns),
        );
    }

    async read_raw_columns_async(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<RawColumnWindow> {
        const epoch = this.capture_lifecycle_epoch();
        this.assert_sheet(sheet_index);
        for (const column of column_indices) this.assert_column(column);
        const start = this.clamp_start(start_row);
        const end = Math.min(start + Math.max(0, count), this.nobs);
        this.assert_async_active(epoch, is_cancelled);
        if (start >= end || column_indices.length === 0) {
            return { startRow: start, rows: Array.from({ length: end - start }, () => []) };
        }
        const columns = [...new Set(column_indices)].sort((a, b) => a - b);
        const per_chunk = this.async_rows_per_chunk(columns.length);
        const rows: (RawCell | null)[][] = [];
        for (let row = start; row < end;) {
            this.assert_async_active(epoch, is_cancelled);
            const chunk = Math.min(per_chunk, end - row);
            rows.push(...this.read_raw_range(row, row + chunk, columns));
            row += chunk;
            if (row < end) {
                await yield_to_event_loop();
                this.assert_async_active(epoch, is_cancelled);
            }
        }
        this.assert_async_active(epoch, is_cancelled);
        return { startRow: start, rows: project(rows, columns, column_indices) };
    }

    async read_raw_columns_indexed_async(
        sheet_index: number,
        row_indices: ArrayLike<number>,
        column_indices: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<IndexedRawColumns> {
        const epoch = this.capture_lifecycle_epoch();
        this.assert_sheet(sheet_index);
        const requested = Array.from(row_indices);
        for (const row of requested) this.assert_row(row);
        for (const column of column_indices) this.assert_column(column);
        this.assert_async_active(epoch, is_cancelled);
        if (requested.length === 0) return { rows: [] };
        if (column_indices.length === 0) return { rows: requested.map(() => []) };
        const columns = [...new Set(column_indices)].sort((a, b) => a - b);
        const per_chunk = this.async_rows_per_chunk(columns.length);
        const materialized = new Map<number, (RawCell | null)[]>();
        let since_yield = 0;
        for (const { start, count } of row_runs(requested, per_chunk)) {
            this.assert_async_active(epoch, is_cancelled);
            this.read_raw_range(start, start + count, columns).forEach(
                (row, offset) => materialized.set(start + offset, row),
            );
            since_yield += count;
            if (since_yield >= per_chunk) {
                since_yield = 0;
                await yield_to_event_loop();
                this.assert_async_active(epoch, is_cancelled);
            }
        }
        const rows: (RawCell | null)[][] = [];
        for (let at = 0; at < requested.length; at += per_chunk) {
            this.assert_async_active(epoch, is_cancelled);
            for (const row of requested.slice(at, at + per_chunk)) rows.push(materialized.get(row)!);
            if (at + per_chunk < requested.length) await yield_to_event_loop();
        }
        this.assert_async_active(epoch, is_cancelled);
        return { rows: project(rows, columns, column_indices) };
    }

    column_filter_metadata(
        sheet_index: number,
        column_index: number,
    ): ColumnFilterMetadata | undefined {
        this.open_reader();
        this.assert_sheet(sheet_index);
        this.assert_column(column_index);
        return filter_metadata_from_labels(this.labels_of(column_index));
    }

    async column_filter_metadata_async(
        sheet_index: number,
        column_index: number,
        is_cancelled: () => boolean,
    ): Promise<ColumnFilterMetadata | undefined> {
        const epoch = this.capture_lifecycle_epoch();
        this.assert_async_active(epoch, is_cancelled);
        return this.column_filter_metadata(sheet_index, column_index);
    }

    close(): void {
        if (this.reader_handle === undefined) return;
        this.lifecycle_epoch += 1;
        this.windows.clear();
        this.binaries.clear();
        this.binary_bytes = 0;
        this.window_cache_cells = 0;
        this.window_cache_bytes = 0;
        const reader = this.reader_handle;
        this.reader_handle = undefined;
        reader.close();
    }

    /** @internal Used only by the module-private DtaBinaryIdentity capability. */
    async resolve_binary_comparison_key(
        binary: BinaryGso,
        is_cancelled: () => boolean,
    ): Promise<string> {
        const epoch = this.capture_lifecycle_epoch();
        this.assert_async_active(epoch, is_cancelled);
        if (binary.key !== undefined) return binary.key;
        const hash = createHash('sha256');
        for (let at = 0; at < binary.bytes.length; at += BINARY_IDENTITY_CHUNK_BYTES) {
            if (at > 0) {
                await yield_to_event_loop();
                this.assert_async_active(epoch, is_cancelled);
            }
            hash.update(binary.bytes.subarray(at, at + BINARY_IDENTITY_CHUNK_BYTES));
        }
        this.assert_async_active(epoch, is_cancelled);
        binary.key = `${BINARY_GSO_COMPARISON_PREFIX}${hash.digest('hex')}`
            + `:${binary.bytes.length}`;
        return binary.key;
    }

    /** @internal Used only by the module-private DtaBinaryIdentity capability. */
    async binary_exactly_equals(
        binary: BinaryGso,
        other_source: StataReaderSource,
        other: BinaryGso,
        is_cancelled: () => boolean,
    ): Promise<boolean> {
        const epoch = this.capture_lifecycle_epoch();
        const other_epoch = other_source.capture_lifecycle_epoch();
        const assert_active = () => {
            this.assert_async_active(epoch, is_cancelled);
            other_source.assert_async_active(other_epoch, is_cancelled);
        };
        if (binary.bytes.length !== other.bytes.length) return false;
        if (binary.key !== undefined && other.key !== undefined) return binary.key === other.key;
        for (let at = 0; at < binary.bytes.length; at += BINARY_IDENTITY_CHUNK_BYTES) {
            if (at > 0) await yield_to_event_loop();
            assert_active();
            const end = at + BINARY_IDENTITY_CHUNK_BYTES;
            if (Buffer.compare(binary.bytes.subarray(at, end), other.bytes.subarray(at, end)) !== 0) {
                return false;
            }
        }
        assert_active();
        return true;
    }

    protected open_reader(): DtaReader {
        if (this.reader_handle === undefined) throw new Error('Stata source is closed');
        return this.reader_handle;
    }

    protected labels_of(column: number): ValueLabels | undefined {
        const name = this.variables[column].valueLabels;
        return name ? this.open_reader().valueLabels(name) : undefined;
    }

    private async_rows_per_chunk(column_count: number): number {
        return Math.max(1, Math.min(
            ASYNC_MAX_ROWS_PER_CHUNK,
            Math.floor(ASYNC_CELLS_PER_CHUNK / Math.max(1, column_count)),
        ));
    }

    private read_column_projection<C>(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
        read_range: (start: number, end: number, columns: readonly number[]) => (C | null)[][],
    ): { startRow: number; rows: (C | null)[][] } {
        this.open_reader();
        this.assert_sheet(sheet_index);
        for (const column of column_indices) this.assert_column(column);
        const start = this.clamp_start(start_row);
        const end = Math.min(start + Math.max(0, count), this.nobs);
        if (start >= end || column_indices.length === 0) {
            return { startRow: start, rows: Array.from({ length: end - start }, () => []) };
        }
        if (is_strictly_increasing(column_indices)) {
            return { startRow: start, rows: read_range(start, end, column_indices) };
        }
        const columns = [...new Set(column_indices)].sort((a, b) => a - b);
        return {
            startRow: start,
            rows: project(read_range(start, end, columns), columns, column_indices),
        };
    }

    private read_range(
        start: number,
        end: number,
        columns: readonly number[],
    ): (RenderedCell | null)[][] {
        const rows: (RenderedCell | null)[][] = [];
        for (let row = start; row < end;) {
            const window_start = Math.floor(row / DECODE_WINDOW_ROWS) * DECODE_WINDOW_ROWS;
            const window = this.decoded_window(
                window_start,
                Math.min(DECODE_WINDOW_ROWS, this.nobs - window_start),
                columns,
            );
            const offset = row - window_start;
            const take = Math.min(window.rows.length - offset, end - row);
            rows.push(...window.rows.slice(offset, offset + take));
            row += take;
        }
        return rows;
    }

    /** Decode rows [start, end) of strictly increasing `columns` as raw cells. */
    private read_raw_range(
        start: number,
        end: number,
        columns: readonly number[],
    ): (RawCell | null)[][] {
        const count = end - start;
        if (count <= 0) return [];
        if (columns.length === 0) return Array.from({ length: count }, () => []);
        const decoded = this.decode(columns, start, count);
        const rows: (RawCell | null)[][] = Array.from(
            { length: count }, () => new Array<RawCell | null>(columns.length),
        );
        decoded.forEach((column, k) => {
            const strl = this.variables[columns[k]].type === 'strL';
            for (let i = 0; i < count; i++) {
                rows[i][k] = this.canonicalize(cell_of(column, i), strl, start + i, columns[k]);
            }
        });
        return rows;
    }

    private decode(columns: readonly number[], start: number, count: number): Column[] {
        try {
            return this.open_reader().readColumns(columns, { start, count });
        } catch (error) {
            if (this.reader_handle === undefined) throw error;
            const detail = error instanceof Error ? error.message : String(error);
            const what = (error as Partial<DtaError>).code === 'DTA_CORRUPT'
                ? 'Corrupt .dta file'
                : 'Could not read Stata file';
            throw new Error(`${what}: ${detail}`, { cause: error });
        }
    }

    /** Canonical raw representation shared by rendered and raw-only reads. */
    private canonicalize(cell: Cell, strl: boolean, row: number, column: number): RawCell {
        if (cell instanceof Uint8Array) {
            const identity = this.binary_identity(`${row}:${column}`, cell);
            const binary = identity.binary;
            const raw_cell: RawCell = {
                raw: binary.formatted,
                rawType: 'string',
                rawByteLength: cell.length,
            };
            Object.defineProperties(raw_cell, {
                [DEFERRED_COMPARISON_IDENTITY]: { value: identity },
                [DEFERRED_FILTER_IDENTITY]: { value: identity },
            });
            return raw_cell;
        }
        if (isMissing(cell)) return raw_stata_missing_cell(cell.missing);
        if (typeof cell === 'string') {
            if (
                strl
                && cell.length * 3 + 1 > MAX_TEXT_STRL_BYTES
                && Buffer.byteLength(cell) + 1 > MAX_TEXT_STRL_BYTES
            ) {
                throw new Error(
                    `Stata text strL payload is too large to decode safely `
                    + `(max ${MAX_TEXT_STRL_BYTES} bytes)`,
                );
            }
            return { raw: cell, rawType: 'string' };
        }
        return { raw: String(cell), rawType: 'number' };
    }

    private binary_identity(location: string, bytes: Uint8Array): DtaBinaryIdentity {
        const cached = this.binaries.get(location);
        if (cached !== undefined) {
            this.binaries.delete(location);
            this.binaries.set(location, cached);
            return cached;
        }
        const identity = new DtaBinaryIdentity(this, binary_gso(bytes));
        if (bytes.length > MAX_BINARY_CACHE_BYTES) return identity;
        this.binaries.set(location, identity);
        this.binary_bytes += bytes.length;
        while (this.binaries.size > MAX_BINARY_CACHE_ENTRIES || this.binary_bytes > MAX_BINARY_CACHE_BYTES) {
            const [oldest_key, oldest] = this.binaries.entries().next().value!;
            this.binaries.delete(oldest_key);
            this.binary_bytes -= oldest.binary.bytes.length;
        }
        return identity;
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
        // Render straight from the parser's values: numbers are labelled and
        // formatted as numbers, without a second pass over raw cells.
        const rows: (RenderedCell | null)[][] = Array.from(
            { length: count }, () => new Array<RenderedCell | null>(columns.length),
        );
        let bytes = 0;
        const decoded = columns.length === 0 ? [] : this.decode(columns, start, count);
        decoded.forEach((column, k) => {
            const variable = this.variables[columns[k]];
            const labels = this.labels_of(columns[k]);
            const strl = variable.type === 'strL';
            for (let i = 0; i < count; i++) {
                if (column.kind === 'number' && column.missing[i] === 0) {
                    // The common cell, built whole: one object of one shape,
                    // not a raw cell that grows three more fields.
                    const value = column.values[i];
                    const raw = String(value);
                    const formatted = labels?.get(value) ?? format_value(value, variable.format);
                    bytes += raw.length * 2;
                    if (formatted !== raw) bytes += formatted.length * 2;
                    rows[i][k] = { raw, rawType: 'number', formatted, bold: false, italic: false };
                    continue;
                }
                let raw_cell: RawCell;
                let formatted: string;
                if (column.kind === 'number') {
                    const missing = missing_value(column.missing[i]);
                    raw_cell = raw_stata_missing_cell(missing.missing);
                    formatted = labels?.get(missing) ?? missing.missing;
                } else {
                    raw_cell = this.canonicalize(column.values[i], strl, start + i, columns[k]);
                    formatted = raw_cell.raw ?? '';
                }
                const raw = raw_cell.raw ?? '';
                bytes += raw.length * 2 + (raw_cell.rawByteLength ?? 0);
                if (formatted !== raw) bytes += formatted.length * 2;
                rows[i][k] = rendered_stata_cell(raw_cell, formatted);
            }
        });
        const window: CachedWindow = { rows, cellCount: count * columns.length, byteCount: bytes };
        if (window.cellCount <= MAX_DECODED_CELLS && window.byteCount <= MAX_DECODED_CACHE_BYTES) {
            this.windows.set(key, window);
            this.window_cache_cells += window.cellCount;
            this.window_cache_bytes += window.byteCount;
            while (
                this.windows.size > MAX_DECODED_WINDOWS
                || this.window_cache_cells > MAX_DECODED_CELLS
                || this.window_cache_bytes > MAX_DECODED_CACHE_BYTES
            ) {
                const oldest_key = this.windows.keys().next().value!;
                const oldest = this.windows.get(oldest_key)!;
                this.windows.delete(oldest_key);
                this.window_cache_cells -= oldest.cellCount;
                this.window_cache_bytes -= oldest.byteCount;
            }
        }
        return window;
    }

    private render_raw_cell(
        raw_cell: RawCell,
        variable: Variable,
        labels: ValueLabels | undefined,
    ): RenderedCell {
        const raw = raw_cell.raw ?? '';
        if (raw_cell.rawType !== 'number') return rendered_stata_cell(raw_cell, raw);
        const label = label_for(labels, raw);
        if (is_missing_code(raw)) return rendered_stata_cell(raw_cell, label ?? raw);
        return rendered_stata_cell(raw_cell, label ?? format_value(Number(raw), variable.format));
    }

    private capture_lifecycle_epoch(): number {
        this.open_reader();
        return this.lifecycle_epoch;
    }

    private assert_async_active(epoch: number, is_cancelled: () => boolean): void {
        if (epoch !== this.lifecycle_epoch || this.reader_handle === undefined) {
            throw source_abort_error();
        }
        if (is_cancelled()) throw source_abort_error();
    }

    private clamp_start(start: number): number {
        return Math.max(0, Math.min(start, this.nobs));
    }

    protected assert_sheet(sheet_index: number): void {
        if (!Number.isInteger(sheet_index) || sheet_index !== 0) {
            throw new RangeError(`sheet index ${sheet_index} out of range (1 sheet)`);
        }
    }

    private assert_row(row: number): void {
        if (!Number.isInteger(row) || row < 0 || row >= this.nobs) {
            throw new RangeError(`row index ${row} out of range (${this.nobs} rows)`);
        }
    }

    private assert_column(column: number): void {
        if (!Number.isInteger(column) || column < 0 || column >= this.variables.length) {
            throw new RangeError(
                `column index ${column} out of range (${this.variables.length} columns)`,
            );
        }
    }
}

/** Read-only, buffer-backed Stata source with bounded lazy row decoding. */
export class DtaDataSource extends StataReaderSource {
    static async create(bytes: Uint8Array, options: Options = {}): Promise<DtaDataSource> {
        let reader: DtaReader | undefined;
        try {
            reader = openDta(bytes, options);
            assert_safe_sheet_shape(
                create_workbook_budget(), reader.info.nobs, reader.variables.length, 0,
            );
            return new DtaDataSource(reader);
        } catch (error) {
            reader?.close();
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not open Stata file: ${detail}`, { cause: error });
        }
    }
}

function cell_of(column: Column, row: number): Cell {
    if (column.kind === 'string') return column.values[row];
    const code = column.missing[row];
    return code === 0 ? column.values[row] : missing_value(code);
}

/** Contiguous runs of the unique sorted rows, each at most `max` long. */
function row_runs(rows: readonly number[], max: number): Array<{ start: number; count: number }> {
    const unique = [...new Set(rows)].sort((a, b) => a - b);
    const runs: Array<{ start: number; count: number }> = [];
    let position = 0;
    while (position < unique.length) {
        const start = unique[position];
        let count = 1;
        while (
            count < max
            && position + count < unique.length
            && unique[position + count] === start + count
        ) count += 1;
        runs.push({ start, count });
        position += count;
    }
    return runs;
}

/** Reorder (and duplicate) cells read for sorted unique `columns` into `wanted`. */
function project<C>(rows: C[][], columns: readonly number[], wanted: readonly number[]): C[][] {
    if (columns.length === wanted.length && columns.every((c, i) => c === wanted[i])) return rows;
    const positions = new Map(columns.map((column, index) => [column, index]));
    return rows.map((row) => wanted.map((column) => row[positions.get(column)!]));
}

/** Shared-prototype identity capability for one decoded binary strL. */
class DtaBinaryIdentity implements DeferredCellIdentity {
    constructor(
        private readonly source: StataReaderSource,
        readonly binary: BinaryGso,
    ) {}

    cachedKey(): string | undefined {
        return this.binary.key;
    }

    resolveKey(is_cancelled: () => boolean): Promise<string> {
        return this.source.resolve_binary_comparison_key(this.binary, is_cancelled);
    }

    exactlyEquals(
        other: DeferredCellIdentity,
        is_cancelled: () => boolean,
    ): boolean | Promise<boolean> | undefined {
        if (!(other instanceof DtaBinaryIdentity)) return undefined;
        if (this.binary.bytes.length !== other.binary.bytes.length) return false;
        return this.source.binary_exactly_equals(
            this.binary, other.source, other.binary, is_cancelled,
        );
    }
}
