import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
    apply_display_format,
    decode_gso_entry,
    is_legacy_format,
    is_missing_value_object,
    missing_type_to_label_key,
    parse_legacy_metadata,
    parse_metadata,
    read_strl_pointer,
    read_rows_from_buffer,
    type DtaMetadata,
    type GsoEntry,
    type Row,
    type RowCell,
    type VariableInfo,
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
const MAX_GSO_CACHE_ENTRIES = 256;
const MAX_GSO_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_GSO_INDEX_ENTRIES = 1_024;
const MAX_GSO_CHECKPOINTS = 1_024;
const MAX_GSO_DIGEST_CACHE_ENTRIES = 4_096;
const MAX_GSO_DIGEST_CACHE_BYTES = 1024 * 1024;
const BINARY_IDENTITY_CHUNK_BYTES = 256 * 1024;
const BINARY_IDENTITY_WORK_BYTES_PER_TURN = BINARY_IDENTITY_CHUNK_BYTES;
const BINARY_IDENTITY_JOBS_PER_TURN = 64;
const MAX_VALUE_LABEL_TABLE_BYTES = 16 * 1024 * 1024;
const MAX_VALUE_LABEL_TABLE_ENTRIES = 65_536;
const MAX_VALUE_LABEL_TABLE_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_VALUE_LABEL_CACHE_ENTRIES = 64;
const MAX_VALUE_LABEL_CACHE_BYTES = 16 * 1024 * 1024;
const VALUE_LABEL_CACHE_BYTES_PER_ENTRY = 64;
const MAX_LEGACY_EXPANSION_FIELDS = 10_000;
const INITIAL_GSO_CHECKPOINT_STRIDE = 64;
const GSO_SCAN_ENTRIES_PER_YIELD = 256;
const VALUE_LABEL_ENTRIES_PER_YIELD = 256;
const BINARY_GSO_PREVIEW_BYTES = 32;
const BINARY_GSO_COMPARISON_PREFIX = 'stata-binary:sha256:';
const STRLS_TAG_LENGTH = '<strls>'.length;
const VALUE_LABELS_TAG_LENGTH = '<value_labels>'.length;
const LBL_OPEN_TAG_LENGTH = '<lbl>'.length;
const LBL_CLOSE_TAG_LENGTH = '</lbl>'.length;
const LEGACY_LABEL_NAME_WIDTH = 33;
const UNICODE_LABEL_NAME_WIDTH = 129;
const LABEL_PADDING_BYTES = 3;
const MODERN_SECTION_TAGS: readonly [
    keyof DtaMetadata['section_offsets'],
    string,
][] = [
    ['stata_data', '<stata_dta>'],
    ['map', '<map>'],
    ['variable_types', '<variable_types>'],
    ['varnames', '<varnames>'],
    ['sortlist', '<sortlist>'],
    ['formats', '<formats>'],
    ['value_label_names', '<value_label_names>'],
    ['variable_labels', '<variable_labels>'],
    ['characteristics', '<characteristics>'],
    ['data', '<data>'],
    ['strls', '<strls>'],
    ['value_labels', '<value_labels>'],
    ['stata_data_close', '</stata_dta>'],
];

interface DecodedValueLabelTable {
    readonly labels: Map<number, string>;
    /** Unique decoded UTF-16 text, used only for parser safety. */
    readonly decodedBytes: number;
    /** Conservative retained cache charge, including labels Map entries. */
    readonly cacheBytes: number;
}

type DecodedValueLabelTables = Map<string, DecodedValueLabelTable>;
type StataMissingType = Parameters<typeof missing_type_to_label_key>[0];

const STATA_MISSING_TYPES: readonly StataMissingType[] = [
    '.',
    ...Array.from(
        { length: 26 },
        (_, index) => `.${String.fromCharCode('a'.charCodeAt(0) + index)}` as StataMissingType,
    ),
];
const STATA_MISSING_LABEL_KEY_BY_TYPE = new Map<string, number>(
    STATA_MISSING_TYPES.map((missing) => [missing, missing_type_to_label_key(missing)]),
);
const STATA_MISSING_LABEL_KEYS = new Set(STATA_MISSING_LABEL_KEY_BY_TYPE.values());

function stata_value_label(
    labels: ReadonlyMap<number, string>,
    raw: string,
): string | undefined {
    const missing_key = STATA_MISSING_LABEL_KEY_BY_TYPE.get(raw);
    if (missing_key !== undefined) return labels.get(missing_key);
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? labels.get(numeric) : undefined;
}

function filter_metadata_from_labels(
    labels: Map<number, string> | undefined,
): ColumnFilterMetadata | undefined {
    if (!labels || labels.size === 0) return undefined;
    let categorical_codes = false;
    for (const value of labels.keys()) {
        if (STATA_MISSING_LABEL_KEYS.has(value)) continue;
        categorical_codes = true;
        break;
    }
    return {
        categoricalCodes: categorical_codes,
        valueLabel: (raw) => stata_value_label(labels, raw),
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

interface BinaryGso {
    readonly kind: 'binary-gso';
    readonly contentOffset: number;
    readonly contentLength: number;
    readonly formatted: string;
}

interface BinaryIdentityWaiter {
    readonly isCancelled: () => boolean;
    readonly resolve: (key: string) => void;
    readonly reject: (error: unknown) => void;
}

interface PendingBinaryIdentity {
    readonly binary: BinaryGso;
    readonly waiters: Set<BinaryIdentityWaiter>;
}

type DecodedGso = string | BinaryGso;
type ResolvedStataCell = RowCell | BinaryGso;

interface GsoOrder {
    readonly observation: number;
    readonly variable: number;
}

interface GsoCheckpoint extends GsoOrder {
    readonly position: number;
}

interface ScannedGso extends GsoOrder {
    readonly key: string;
    readonly value: GsoEntry;
    readonly nextPosition: number;
}

interface GsoBatchTarget extends GsoOrder {
    readonly kind: 'gso-target';
    value?: DecodedGso;
}

type StrlBatchCell = DecodedGso | GsoBatchTarget | undefined;

interface CachedWindow {
    readonly rows: (RenderedCell | null)[][];
    readonly cellCount: number;
    readonly byteCount: number;
}

interface CollectedStrlBatch {
    readonly cells: StrlBatchCell[];
    readonly targets: Map<string, GsoBatchTarget>;
}

function rendered_stata_cell(raw_cell: RawCell, formatted: string): RenderedCell {
    const rendered = raw_cell as RenderedCell;
    rendered.formatted = formatted;
    rendered.bold = false;
    rendered.italic = false;
    return rendered;
}

function decoded_gso_byte_count(value: DecodedGso): number {
    return typeof value === 'string' ? value.length * 2 : 64;
}

function rendered_rows_byte_count(rows: readonly (RenderedCell | null)[][]): number {
    let bytes = 0;
    for (const row of rows) {
        for (const cell of row) {
            if (cell === null) continue;
            bytes += (cell.raw?.length ?? 0) * 2;
            if (cell.formatted !== cell.raw) bytes += cell.formatted.length * 2;
        }
    }
    return bytes;
}

/** Read-only, buffer-backed Stata source with bounded lazy row decoding. */
export class DtaDataSource implements DataSource {
    private readonly _meta: WorkbookMeta;
    private readonly windows = new Map<string, CachedWindow>();
    private readonly all_columns: readonly number[];
    private readonly data_start: number;
    private bytes?: Uint8Array;
    private view?: DataView;
    private lifecycle_epoch = 0;
    private readonly pre_unicode_utf8_decoder = new TextDecoder('utf-8', { fatal: true });
    private readonly pre_unicode_fallback_decoder = new TextDecoder('windows-1252');
    private readonly unicode_decoder = new TextDecoder('utf-8');
    private readonly decoded_value_label_tables: DecodedValueLabelTables = new Map();
    private decoded_value_label_cache_bytes = 0;
    private value_label_table_entry_limit = MAX_VALUE_LABEL_TABLE_ENTRIES;
    private value_label_table_decoded_byte_limit = MAX_VALUE_LABEL_TABLE_DECODED_BYTES;
    private value_label_cache_entry_limit = MAX_VALUE_LABEL_CACHE_ENTRIES;
    private value_label_cache_byte_limit = MAX_VALUE_LABEL_CACHE_BYTES;
    private readonly missing_value_label_table_names = new Set<string>();
    private window_cache_cells = 0;
    private window_cache_bytes = 0;
    private readonly gso_index = new Map<string, GsoEntry>();
    private readonly gso_cache = new Map<string, DecodedGso>();
    private gso_cache_bytes = 0;
    private text_gso_decode_byte_limit = MAX_GSO_CACHE_BYTES;
    private readonly gso_digest_cache = new Map<number, string>();
    private gso_digest_cache_bytes = 0;
    private gso_digest_cache_entry_limit = MAX_GSO_DIGEST_CACHE_ENTRIES;
    private gso_digest_cache_byte_limit = MAX_GSO_DIGEST_CACHE_BYTES;
    private binary_identity_chunk_bytes = BINARY_IDENTITY_CHUNK_BYTES;
    private binary_identity_work_byte_limit = BINARY_IDENTITY_WORK_BYTES_PER_TURN;
    private binary_identity_work_job_limit = BINARY_IDENTITY_JOBS_PER_TURN;
    private binary_identity_work_bytes = 0;
    private binary_identity_work_jobs = 0;
    private binary_identity_work_yield?: Promise<void>;
    private binary_digest_computations = 0;
    private readonly binary_identities = new WeakMap<BinaryGso, DtaBinaryIdentity>();
    private readonly pending_binary_identities = new Map<number, PendingBinaryIdentity>();
    private gso_checkpoints: GsoCheckpoint[] = [];
    private gso_checkpoint_stride = INITIAL_GSO_CHECKPOINT_STRIDE;
    private gso_entries_scanned = 0;
    private gso_last_order?: GsoOrder;
    private readonly gso_start_position: number;
    private gso_scan_position: number;
    private gso_scan_exhausted = false;

    private constructor(
        buffer: ArrayBuffer,
        private readonly metadata: DtaMetadata,
    ) {
        assert_safe_sheet_shape(
            create_workbook_budget(),
            metadata.nobs,
            metadata.nvar,
            0,
        );
        const file_bytes = new Uint8Array(buffer);
        this.data_start = metadata.section_offsets.data
            + (is_legacy_format(metadata.format_version) ? 0 : '<data>'.length);
        const data_end = this.data_start + metadata.nobs * metadata.obs_length;
        if (
            !Number.isSafeInteger(data_end)
            || data_end > buffer.byteLength
            || data_end > metadata.section_offsets.strls
        ) {
            throw new Error('Corrupt .dta file: observation data is truncated');
        }
        validate_section_offsets(metadata, file_bytes);
        this.all_columns = metadata.variables.map((_, index) => index);
        this.bytes = file_bytes;
        this.view = new DataView(buffer);
        this.gso_start_position = metadata.section_offsets.strls
            + (is_legacy_format(metadata.format_version) ? 0 : STRLS_TAG_LENGTH);
        this.gso_scan_position = this.gso_start_position;
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
        const backing = bytes.buffer;
        // Buffer.slice() aliases its slab, so only preserve a backing buffer
        // when the requested bytes already occupy it exactly.
        const buffer = backing instanceof ArrayBuffer
            && bytes.byteOffset === 0
            && bytes.byteLength === backing.byteLength
            ? backing
            : new Uint8Array(bytes).buffer;
        try {
            const metadata = bytes[0] === '<'.charCodeAt(0)
                ? parse_metadata(buffer)
                : (validate_legacy_expansion_fields(buffer),
                    parse_legacy_metadata(buffer, buffer.byteLength));
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
        this.open_bytes();
        this.assert_sheet(sheet_index);
        const start = this.clamp_start(start_row);
        const end = Math.min(start + Math.max(0, count), this.metadata.nobs);
        return {
            startRow: start,
            rows: this.read_range(start, end, this.all_columns),
        };
    }

    read_rows_indexed(sheet_index: number, row_indices: ArrayLike<number>): IndexedRows {
        this.open_bytes();
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
        return this.read_column_projection(
            sheet_index,
            start_row,
            count,
            column_indices,
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
            sheet_index,
            start_row,
            count,
            column_indices,
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
        const lifecycle_epoch = this.capture_lifecycle_epoch();
        this.assert_sheet(sheet_index);
        for (const column of column_indices) this.assert_column(column);
        const start = this.clamp_start(start_row);
        const end = Math.min(start + Math.max(0, count), this.metadata.nobs);
        if (start >= end || column_indices.length === 0) {
            return { startRow: start, rows: Array.from({ length: end - start }, () => []) };
        }
        const already_ordered = column_indices.every(
            (column, index) => index === 0 || column > column_indices[index - 1],
        );
        const columns = already_ordered
            ? column_indices
            : [...new Set(column_indices)].sort((a, b) => a - b);
        const rows = await this.read_raw_range_async(
            start,
            end,
            columns,
            lifecycle_epoch,
            is_cancelled,
        );
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        if (already_ordered) return { startRow: start, rows };
        const positions = new Map(columns.map((column, index) => [column, index]));
        return {
            startRow: start,
            rows: rows.map((row) => column_indices.map((column) => row[positions.get(column)!])),
        };
    }

    column_filter_metadata(
        sheet_index: number,
        column_index: number,
    ): ColumnFilterMetadata | undefined {
        this.open_bytes();
        this.assert_sheet(sheet_index);
        this.assert_column(column_index);
        const label_name = this.metadata.variables[column_index].value_label_name;
        if (!label_name) return undefined;
        return filter_metadata_from_labels(this.value_labels(label_name));
    }

    async column_filter_metadata_async(
        sheet_index: number,
        column_index: number,
        is_cancelled: () => boolean,
    ): Promise<ColumnFilterMetadata | undefined> {
        const lifecycle_epoch = this.capture_lifecycle_epoch();
        this.assert_lifecycle_epoch(lifecycle_epoch);
        this.assert_sheet(sheet_index);
        this.assert_column(column_index);
        const label_name = this.metadata.variables[column_index].value_label_name;
        if (!label_name) return undefined;
        const labels = await this.value_labels_async(
            label_name,
            lifecycle_epoch,
            is_cancelled,
        );
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        return filter_metadata_from_labels(labels);
    }

    private read_column_projection<Cell>(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
        read_range: (start: number, end: number, columns: readonly number[]) => (Cell | null)[][],
    ): { startRow: number; rows: (Cell | null)[][] } {
        this.open_bytes();
        this.assert_sheet(sheet_index);
        for (const column of column_indices) this.assert_column(column);
        const start = this.clamp_start(start_row);
        const end = Math.min(start + Math.max(0, count), this.metadata.nobs);
        if (start >= end || column_indices.length === 0) {
            return { startRow: start, rows: Array.from({ length: end - start }, () => []) };
        }

        const already_ordered = column_indices.every(
            (column, index) => index === 0 || column > column_indices[index - 1],
        );
        const columns = already_ordered
            ? column_indices
            : [...new Set(column_indices)].sort((a, b) => a - b);
        const rows = read_range(start, end, columns);
        if (already_ordered) return { startRow: start, rows };

        const positions = new Map(columns.map((column, index) => [column, index]));
        return {
            startRow: start,
            rows: rows.map((row) => column_indices.map((column) => row[positions.get(column)!])),
        };
    }

    close(): void {
        if (this.bytes === undefined) return;
        this.lifecycle_epoch += 1;
        this.windows.clear();
        this.window_cache_cells = 0;
        this.window_cache_bytes = 0;
        this.decoded_value_label_tables.clear();
        this.decoded_value_label_cache_bytes = 0;
        this.missing_value_label_table_names.clear();
        this.gso_index.clear();
        this.gso_cache.clear();
        this.gso_cache_bytes = 0;
        this.gso_digest_cache.clear();
        this.gso_digest_cache_bytes = 0;
        this.binary_identity_work_bytes = 0;
        this.binary_identity_work_jobs = 0;
        this.binary_identity_work_yield = undefined;
        for (const job of this.pending_binary_identities.values()) {
            const error = source_abort_error();
            for (const waiter of job.waiters) waiter.reject(error);
            job.waiters.clear();
        }
        this.pending_binary_identities.clear();
        this.gso_checkpoints = [];
        this.gso_checkpoint_stride = INITIAL_GSO_CHECKPOINT_STRIDE;
        this.gso_entries_scanned = 0;
        this.gso_last_order = undefined;
        this.gso_scan_position = this.gso_start_position;
        this.gso_scan_exhausted = true;
        this.view = undefined;
        this.bytes = undefined;
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

    /** Canonical raw representation shared by rendered and raw-only reads. */
    private canonicalize_stata_raw(cell: ResolvedStataCell): RawCell {
        if (is_binary_gso(cell)) {
            const raw_cell: RawCell = {
                raw: cell.formatted,
                rawType: 'string',
                rawByteLength: cell.contentLength,
            };
            let identity = this.binary_identities.get(cell);
            if (identity === undefined) {
                identity = new DtaBinaryIdentity(this, cell);
                this.binary_identities.set(cell, identity);
            }
            Object.defineProperties(raw_cell, {
                [DEFERRED_COMPARISON_IDENTITY]: { value: identity },
                [DEFERRED_FILTER_IDENTITY]: { value: identity },
            });
            return raw_cell;
        }
        if (is_missing_value_object(cell)) {
            return { raw: cell.missing_type, rawType: 'number' };
        }
        if (typeof cell === 'string') return { raw: cell, rawType: 'string' };
        return { raw: String(cell), rawType: 'number' };
    }

    private read_raw_range(
        start: number,
        end: number,
        columns: readonly number[],
    ): (RawCell | null)[][] {
        const rows: (RawCell | null)[][] = [];
        for (let row = start; row < end;) {
            const count = Math.min(DECODE_WINDOW_ROWS, end - row);
            const decoded = this.resolve_columns(
                this.decode_columns(row, count, columns),
                row,
                columns,
            );
            rows.push(...decoded.map((values) => values.map((cell) =>
                this.canonicalize_stata_raw(cell),
            )));
            row += count;
        }
        return rows;
    }

    private async read_raw_range_async(
        start: number,
        end: number,
        columns: readonly number[],
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<(RawCell | null)[][]> {
        const rows: (RawCell | null)[][] = [];
        for (let row = start; row < end;) {
            this.assert_async_active(lifecycle_epoch, is_cancelled);
            const count = Math.min(DECODE_WINDOW_ROWS, end - row);
            const decoded = await this.resolve_columns_async(
                this.decode_columns(row, count, columns),
                row,
                columns,
                lifecycle_epoch,
                is_cancelled,
            );
            this.assert_async_active(lifecycle_epoch, is_cancelled);
            rows.push(...decoded.map((values) => values.map((cell) =>
                this.canonicalize_stata_raw(cell),
            )));
            row += count;
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

        const raw_rows = this.resolve_columns(
            this.decode_columns(start, count, columns),
            start,
            columns,
        );
        const rows = raw_rows.map((row) => row.map((cell, index) =>
            this.render_cell(cell, this.metadata.variables[columns[index]])));
        const window: CachedWindow = {
            rows,
            cellCount: count * columns.length,
            byteCount: rendered_rows_byte_count(rows),
        };
        if (
            window.cellCount <= MAX_DECODED_CELLS
            && window.byteCount <= MAX_DECODED_CACHE_BYTES
        ) {
            if (this.windows.size === 0) {
                this.window_cache_cells = 0;
                this.window_cache_bytes = 0;
            }
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
                this.open_buffer(),
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
        resolved: ResolvedStataCell,
        variable: VariableInfo,
    ): RenderedCell {
        const raw_cell = this.canonicalize_stata_raw(resolved);
        if (is_binary_gso(resolved) || typeof resolved === 'string') {
            return rendered_stata_cell(
                raw_cell,
                is_binary_gso(resolved) ? resolved.formatted : resolved,
            );
        }

        const labels = variable.value_label_name
            ? this.value_labels(variable.value_label_name)
            : undefined;
        const label = labels === undefined
            ? undefined
            : stata_value_label(labels, raw_cell.raw!);
        if (is_missing_value_object(resolved)) {
            return rendered_stata_cell(raw_cell, label ?? resolved.missing_type);
        }
        return rendered_stata_cell(
            raw_cell,
            label
                ?? apply_display_format(resolved, variable.format)
                ?? raw_cell.raw!,
        );
    }

    private resolve_columns(
        rows: Row[],
        start: number,
        columns: readonly number[],
    ): ResolvedStataCell[][] {
        const batch = this.collect_strl_batch(start, rows.length, columns);
        if (batch.targets.size > 0) {
            this.resolve_gso_batch(this.open_bytes(), this.open_view(), batch.targets);
        }
        return this.materialize_resolved_columns(rows, start, columns, batch.cells);
    }

    private async resolve_columns_async(
        rows: Row[],
        start: number,
        columns: readonly number[],
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<ResolvedStataCell[][]> {
        this.assert_lifecycle_epoch(lifecycle_epoch);
        const batch = this.collect_strl_batch(start, rows.length, columns);
        if (batch.targets.size > 0) {
            await this.resolve_gso_batch_async(
                batch.targets,
                lifecycle_epoch,
                is_cancelled,
            );
            this.assert_async_active(lifecycle_epoch, is_cancelled);
        }
        return this.materialize_resolved_columns(rows, start, columns, batch.cells);
    }

    private materialize_resolved_columns(
        rows: Row[],
        start: number,
        columns: readonly number[],
        resolved_strls: readonly StrlBatchCell[],
    ): ResolvedStataCell[][] {
        return rows.map((row, row_offset) => row.map((cell, index) =>
            this.resolve_cell(
                cell,
                this.metadata.variables[columns[index]],
                start + row_offset,
                resolved_strls[row_offset * columns.length + index],
            )));
    }

    private resolve_cell(
        cell: RowCell,
        variable: VariableInfo,
        row: number,
        strl_cell: StrlBatchCell,
    ): ResolvedStataCell {
        if (variable.type === 'strL') {
            const resolved = is_gso_batch_target(strl_cell)
                ? strl_cell.value
                : strl_cell;
            if (resolved === undefined) {
                throw new Error(`Stata strL cell at row ${row} has a dangling reference`);
            }
            return resolved;
        }
        if (
            typeof cell === 'string'
            && this.metadata.format_version < 118
        ) {
            const offset = this.data_start
                + row * this.metadata.obs_length
                + variable.byte_offset;
            return decode_fixed(
                this.open_bytes(),
                offset,
                variable.byte_width,
                this.pre_unicode_utf8_decoder,
                this.pre_unicode_fallback_decoder,
            );
        }
        return cell;
    }

    private collect_strl_batch(
        start: number,
        count: number,
        columns: readonly number[],
    ): CollectedStrlBatch {
        const view = this.open_view();
        const bytes = this.open_bytes();
        const cells = new Array<StrlBatchCell>(count * columns.length);
        const targets = new Map<string, GsoBatchTarget>();
        const strl_columns: Array<{ index: number; variable: VariableInfo }> = [];
        columns.forEach((column, index) => {
            const variable = this.metadata.variables[column];
            if (variable.type === 'strL') strl_columns.push({ index, variable });
        });
        for (let row_offset = 0; row_offset < count; row_offset++) {
            const row_base = this.data_start
                + (start + row_offset) * this.metadata.obs_length;
            const cell_base = row_offset * columns.length;
            for (const { index, variable } of strl_columns) {
                const cell_index = cell_base + index;
                const pointer = read_strl_cell_pointer(
                    view,
                    this.metadata,
                    row_base + variable.byte_offset,
                );
                if (pointer === null) {
                    cells[cell_index] = '';
                    continue;
                }
                validate_gso_identifier(pointer.v, pointer.o, this.metadata, 'strL pointer');
                const key = gso_key(pointer.v, pointer.o);
                let target = targets.get(key);
                if (target === undefined) {
                    target = {
                        kind: 'gso-target',
                        observation: pointer.o,
                        variable: pointer.v,
                    };
                    targets.set(key, target);
                }
                cells[cell_index] = target;
            }
        }
        for (const [key, target] of targets) {
            const cached = this.find_cached_gso(key, bytes);
            if (cached === undefined) continue;
            target.value = cached;
            targets.delete(key);
        }
        return { cells, targets };
    }

    private resolve_gso_batch(
        bytes: Uint8Array,
        view: DataView,
        targets: Map<string, GsoBatchTarget>,
    ): void {
        let first: GsoBatchTarget | undefined;
        for (const target of targets.values()) {
            if (first === undefined || compare_gso_order(target, first) < 0) {
                first = target;
            }
        }
        if (first === undefined) return;
        let position = !this.gso_scan_exhausted
            && this.gso_last_order !== undefined
            && compare_gso_order(this.gso_last_order, first) < 0
            ? this.gso_scan_position
            : this.gso_checkpoint_position(first);

        const section_end = this.metadata.section_offsets.value_labels;
        while (position < section_end) {
            const historical = position < this.gso_scan_position;
            const scanned = historical
                ? this.read_gso_at(bytes, view, position)
                : this.scan_next_gso(bytes, view);
            if (scanned === null) break;
            const target = targets.get(scanned.key);
            if (target !== undefined) {
                if (historical) this.cache_gso_entry(scanned.key, scanned.value);
                target.value = this.decode_and_cache_gso(
                    scanned.key,
                    bytes,
                    scanned.value,
                );
                targets.delete(scanned.key);
                if (targets.size === 0) return;
            }
            position = scanned.nextPosition;
        }
    }

    private async resolve_gso_batch_async(
        targets: Map<string, GsoBatchTarget>,
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<void> {
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        let first: GsoBatchTarget | undefined;
        for (const target of targets.values()) {
            if (first === undefined || compare_gso_order(target, first) < 0) {
                first = target;
            }
        }
        if (first === undefined) return;
        let position = !this.gso_scan_exhausted
            && this.gso_last_order !== undefined
            && compare_gso_order(this.gso_last_order, first) < 0
            ? this.gso_scan_position
            : this.gso_checkpoint_position(first);

        const section_end = this.metadata.section_offsets.value_labels;
        let scanned_since_yield = 0;
        while (position < section_end) {
            this.assert_lifecycle_epoch(lifecycle_epoch);
            const historical = position < this.gso_scan_position;
            const scanned = this.scan_gso_batch_entry(
                position,
                historical,
                targets,
                lifecycle_epoch,
            );
            if (scanned === null || targets.size === 0) return;
            position = scanned.nextPosition;
            scanned_since_yield += 1;
            if (scanned_since_yield >= GSO_SCAN_ENTRIES_PER_YIELD) {
                scanned_since_yield = 0;
                await yield_to_event_loop();
                this.assert_async_active(lifecycle_epoch, is_cancelled);
            }
        }
    }

    private scan_gso_batch_entry(
        position: number,
        historical: boolean,
        targets: Map<string, GsoBatchTarget>,
        lifecycle_epoch: number,
    ): ScannedGso | null {
        this.assert_lifecycle_epoch(lifecycle_epoch);
        const bytes = this.open_bytes();
        const view = this.open_view();
        const scanned = historical
            ? this.read_gso_at(bytes, view, position)
            : this.scan_next_gso(bytes, view, lifecycle_epoch);
        if (scanned === null) return null;
        const target = targets.get(scanned.key);
        if (target === undefined) return scanned;
        this.assert_lifecycle_epoch(lifecycle_epoch);
        if (historical) this.cache_gso_entry(scanned.key, scanned.value);
        target.value = this.decode_and_cache_gso(
            scanned.key,
            bytes,
            scanned.value,
        );
        targets.delete(scanned.key);
        return scanned;
    }

    private scan_next_gso(
        bytes: Uint8Array,
        view: DataView,
        lifecycle_epoch?: number,
    ): ScannedGso | null {
        const position = this.gso_scan_position;
        const scanned = this.read_gso_at(bytes, view, position);
        if (lifecycle_epoch !== undefined) this.assert_lifecycle_epoch(lifecycle_epoch);
        if (scanned === null) {
            this.gso_scan_exhausted = true;
            return null;
        }
        this.remember_gso(scanned, position);
        this.gso_scan_position = scanned.nextPosition;
        return scanned;
    }

    private read_gso_at(
        bytes: Uint8Array,
        view: DataView,
        start: number,
    ): ScannedGso | null {
        const section_end = this.metadata.section_offsets.value_labels;
        let position = start;
        if (
            position + 3 > section_end
            || bytes[position] !== 0x47
            || bytes[position + 1] !== 0x53
            || bytes[position + 2] !== 0x4f
        ) return null;
        position += 3;
        const little_endian = this.metadata.byte_order === 'LSF';
        const variable = view.getUint32(position, little_endian);
        position += 4;
        let observation: number;
        if (this.metadata.format_version === 117) {
            observation = view.getUint32(position, little_endian);
            position += 4;
        } else if (little_endian) {
            observation = view.getUint32(position, true);
            if (view.getUint32(position + 4, true) !== 0) {
                throw new Error('strL observation number exceeds 32-bit range');
            }
            position += 8;
        } else {
            if (view.getUint32(position, false) !== 0) {
                throw new Error('strL observation number exceeds 32-bit range');
            }
            observation = view.getUint32(position + 4, false);
            position += 8;
        }
        validate_gso_identifier(variable, observation, this.metadata, 'strL object');
        const type = bytes[position++];
        const content_length = view.getUint32(position, little_endian);
        position += 4;
        const content_end = position + content_length;
        if (!Number.isSafeInteger(content_end) || content_end > section_end) {
            throw new Error('Corrupt .dta file: strL object is truncated');
        }
        return {
            key: gso_key(variable, observation),
            observation,
            variable,
            value: { content_offset: position, content_length, type },
            nextPosition: content_end,
        };
    }

    private remember_gso(scanned: ScannedGso, position: number): void {
        if (this.gso_last_order !== undefined) {
            const order = compare_gso_order(scanned, this.gso_last_order);
            if (order === 0) {
                throw new Error(
                    `Corrupt .dta file: duplicate strL object id ${scanned.key}`,
                );
            }
            if (order < 0) {
                throw new Error(
                    'Corrupt .dta file: strL objects are out of observation-major order',
                );
            }
        }
        this.gso_last_order = scanned;
        this.cache_gso_entry(scanned.key, scanned.value);
        if (this.gso_entries_scanned % this.gso_checkpoint_stride === 0) {
            this.gso_checkpoints.push({
                observation: scanned.observation,
                variable: scanned.variable,
                position,
            });
            if (this.gso_checkpoints.length > MAX_GSO_CHECKPOINTS) {
                this.gso_checkpoints = this.gso_checkpoints.filter((_, index) => index % 2 === 0);
                this.gso_checkpoint_stride *= 2;
            }
        }
        this.gso_entries_scanned += 1;
    }

    private cache_gso_entry(key: string, entry: GsoEntry): void {
        this.gso_index.delete(key);
        this.gso_index.set(key, entry);
        if (this.gso_index.size > MAX_GSO_INDEX_ENTRIES) {
            this.gso_index.delete(this.gso_index.keys().next().value!);
        }
    }

    private find_cached_gso(key: string, bytes: Uint8Array): DecodedGso | undefined {
        const cached = this.gso_cache.get(key);
        if (cached !== undefined) {
            this.gso_cache.delete(key);
            this.gso_cache.set(key, cached);
            return cached;
        }
        const indexed = this.gso_index.get(key);
        if (indexed === undefined) return undefined;
        this.cache_gso_entry(key, indexed);
        return this.decode_and_cache_gso(key, bytes, indexed);
    }

    private gso_checkpoint_position(target_order: GsoOrder): number {
        let low = 0;
        let high = this.gso_checkpoints.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (compare_gso_order(this.gso_checkpoints[middle], target_order) <= 0) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low > 0
            ? this.gso_checkpoints[low - 1].position
            : this.gso_start_position;
    }

    private decode_and_cache_gso(
        key: string,
        bytes: Uint8Array,
        entry: GsoEntry,
    ): DecodedGso {
        const decoded = this.decode_gso(bytes, entry);
        const decoded_bytes = decoded_gso_byte_count(decoded);
        if (decoded_bytes <= MAX_GSO_CACHE_BYTES) {
            if (this.gso_cache.size === 0) this.gso_cache_bytes = 0;
            const previous = this.gso_cache.get(key);
            if (previous !== undefined) {
                this.gso_cache_bytes -= decoded_gso_byte_count(previous);
                this.gso_cache.delete(key);
            }
            this.gso_cache.set(key, decoded);
            this.gso_cache_bytes += decoded_bytes;
            while (
                this.gso_cache.size > MAX_GSO_CACHE_ENTRIES
                || this.gso_cache_bytes > MAX_GSO_CACHE_BYTES
            ) {
                const oldest_key = this.gso_cache.keys().next().value!;
                const oldest = this.gso_cache.get(oldest_key)!;
                this.gso_cache.delete(oldest_key);
                this.gso_cache_bytes -= decoded_gso_byte_count(oldest);
            }
        }
        return decoded;
    }

    private decode_gso(bytes: Uint8Array, entry: GsoEntry): DecodedGso {
        if (entry.type === 129) return encode_binary_gso(bytes, entry);
        if (entry.content_length > this.text_gso_decode_byte_limit) {
            throw new Error(
                `Stata text strL payload is too large to decode safely `
                + `(max ${this.text_gso_decode_byte_limit} bytes)`,
            );
        }
        if (this.metadata.format_version >= 118 || entry.type !== 130) {
            return decode_gso_entry(bytes, entry);
        }
        const content_length = entry.content_length > 0
            ? entry.content_length - 1
            : 0;
        return decode_pre_unicode(
            bytes,
            entry.content_offset,
            entry.content_offset + content_length,
            this.pre_unicode_utf8_decoder,
            this.pre_unicode_fallback_decoder,
        );
    }

    /** @internal Used only by the module-private DtaBinaryIdentity capability. */
    cached_binary_comparison_key(binary: BinaryGso): string | undefined {
        const cached = this.gso_digest_cache.get(binary.contentOffset);
        if (cached === undefined) return undefined;
        this.gso_digest_cache.delete(binary.contentOffset);
        this.gso_digest_cache.set(binary.contentOffset, cached);
        return cached;
    }

    private cache_binary_comparison_key(binary: BinaryGso, key: string): void {
        const key_bytes = key.length * 2;
        if (
            this.gso_digest_cache_entry_limit < 1
            || key_bytes > this.gso_digest_cache_byte_limit
        ) return;
        if (this.gso_digest_cache.size === 0) this.gso_digest_cache_bytes = 0;
        const previous = this.gso_digest_cache.get(binary.contentOffset);
        if (previous !== undefined) {
            this.gso_digest_cache.delete(binary.contentOffset);
            this.gso_digest_cache_bytes -= previous.length * 2;
        }
        this.gso_digest_cache.set(binary.contentOffset, key);
        this.gso_digest_cache_bytes += key_bytes;
        while (
            this.gso_digest_cache.size > this.gso_digest_cache_entry_limit
            || this.gso_digest_cache_bytes > this.gso_digest_cache_byte_limit
        ) {
            const oldest_offset = this.gso_digest_cache.keys().next().value!;
            const oldest = this.gso_digest_cache.get(oldest_offset)!;
            this.gso_digest_cache.delete(oldest_offset);
            this.gso_digest_cache_bytes -= oldest.length * 2;
        }
    }

    private reject_cancelled_binary_waiters(job: PendingBinaryIdentity): void {
        for (const waiter of job.waiters) {
            let cancelled: boolean;
            try {
                cancelled = waiter.isCancelled();
            } catch (error) {
                job.waiters.delete(waiter);
                waiter.reject(error);
                continue;
            }
            if (!cancelled) continue;
            job.waiters.delete(waiter);
            waiter.reject(source_abort_error());
        }
    }

    /** @internal Used only by the module-private DtaBinaryIdentity capability. */
    resolve_binary_comparison_key(
        binary: BinaryGso,
        is_cancelled: () => boolean,
    ): Promise<string> {
        let lifecycle_epoch: number;
        try {
            lifecycle_epoch = this.capture_lifecycle_epoch();
            this.assert_async_active(lifecycle_epoch, is_cancelled);
        } catch (error) {
            return Promise.reject(error);
        }
        const cached = this.cached_binary_comparison_key(binary);
        if (cached !== undefined) return Promise.resolve(cached);

        let job = this.pending_binary_identities.get(binary.contentOffset);
        let start_job = false;
        if (job === undefined) {
            job = { binary, waiters: new Set() };
            this.pending_binary_identities.set(binary.contentOffset, job);
            start_job = true;
        }
        const promise = new Promise<string>((resolve, reject) => {
            job!.waiters.add({ isCancelled: is_cancelled, resolve, reject });
        });
        if (start_job) void this.run_binary_identity_job(job);
        return promise;
    }

    /** Share one source-owned macrotask gate across jobs so neither payload bytes
     * nor a burst of tiny digest setups can grow without yielding. */
    private yield_binary_identity_work(): Promise<void> {
        const existing = this.binary_identity_work_yield;
        if (existing !== undefined) return existing;
        const yielding = yield_to_event_loop();
        this.binary_identity_work_yield = yielding;
        void yielding.then(() => {
            if (this.binary_identity_work_yield !== yielding) return;
            this.binary_identity_work_bytes = 0;
            this.binary_identity_work_jobs = 0;
            this.binary_identity_work_yield = undefined;
        });
        return yielding;
    }

    private schedule_binary_identity_work(
        byte_count: number,
        starts_job: boolean,
    ): Promise<void> | undefined {
        if (this.binary_identity_work_yield !== undefined) {
            return this.binary_identity_work_yield;
        }
        const byte_limit = Math.max(1, this.binary_identity_work_byte_limit);
        const job_limit = Math.max(1, this.binary_identity_work_job_limit);
        if (
            (this.binary_identity_work_bytes > 0
                && byte_count > byte_limit - this.binary_identity_work_bytes)
            || (starts_job && this.binary_identity_work_jobs >= job_limit)
        ) return this.yield_binary_identity_work();
        this.binary_identity_work_bytes += byte_count;
        if (starts_job) this.binary_identity_work_jobs += 1;
        return undefined;
    }

    private async run_binary_identity_job(job: PendingBinaryIdentity): Promise<void> {
        try {
            let hash: ReturnType<typeof createHash> | undefined;
            let hashed = 0;
            while (hashed < job.binary.contentLength) {
                this.reject_cancelled_binary_waiters(job);
                if (job.waiters.size === 0) {
                    this.pending_binary_identities.delete(job.binary.contentOffset);
                    return;
                }
                const count = Math.min(
                    Math.max(1, this.binary_identity_chunk_bytes),
                    Math.max(1, this.binary_identity_work_byte_limit),
                    job.binary.contentLength - hashed,
                );
                const scheduled = this.schedule_binary_identity_work(count, hash === undefined);
                if (scheduled !== undefined) {
                    await scheduled;
                    continue;
                }
                if (hash === undefined) {
                    hash = createHash('sha256');
                    this.binary_digest_computations += 1;
                }
                const start = job.binary.contentOffset + hashed;
                hash.update(this.open_bytes().subarray(start, start + count));
                hashed += count;
                if (hashed < job.binary.contentLength) {
                    await this.yield_binary_identity_work();
                }
            }

            this.reject_cancelled_binary_waiters(job);
            if (job.waiters.size === 0) {
                this.pending_binary_identities.delete(job.binary.contentOffset);
                return;
            }
            while (hash === undefined) {
                const scheduled = this.schedule_binary_identity_work(0, true);
                if (scheduled === undefined) {
                    hash = createHash('sha256');
                    this.binary_digest_computations += 1;
                    break;
                }
                await scheduled;
                this.reject_cancelled_binary_waiters(job);
                if (job.waiters.size === 0) {
                    this.pending_binary_identities.delete(job.binary.contentOffset);
                    return;
                }
            }
            const key = `${BINARY_GSO_COMPARISON_PREFIX}${hash.digest('hex')}`
                + `:${job.binary.contentLength}`;
            this.cache_binary_comparison_key(job.binary, key);
            this.pending_binary_identities.delete(job.binary.contentOffset);
            for (const waiter of job.waiters) waiter.resolve(key);
            job.waiters.clear();
        } catch (error) {
            if (this.pending_binary_identities.get(job.binary.contentOffset) === job) {
                this.pending_binary_identities.delete(job.binary.contentOffset);
            }
            for (const waiter of job.waiters) waiter.reject(error);
            job.waiters.clear();
        }
    }

    /** @internal Used only by the module-private DtaBinaryIdentity capability. */
    binary_exactly_equals(
        binary: BinaryGso,
        other_source: DtaDataSource,
        other_binary: BinaryGso,
        is_cancelled: () => boolean,
    ): boolean | Promise<boolean> {
        const lifecycle_epoch = this.capture_lifecycle_epoch();
        const other_lifecycle_epoch = other_source.capture_lifecycle_epoch();
        if (binary.contentLength !== other_binary.contentLength) return false;
        if (this === other_source && binary.contentOffset === other_binary.contentOffset) {
            return true;
        }
        const cached = this.cached_binary_comparison_key(binary);
        const other_cached = other_source.cached_binary_comparison_key(other_binary);
        if (cached !== undefined && other_cached !== undefined) return cached === other_cached;
        return this.compare_binary_bytes(
            binary,
            lifecycle_epoch,
            other_source,
            other_binary,
            other_lifecycle_epoch,
            is_cancelled,
        );
    }

    private async compare_binary_bytes(
        binary: BinaryGso,
        lifecycle_epoch: number,
        other_source: DtaDataSource,
        other_binary: BinaryGso,
        other_lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<boolean> {
        const chunk_bytes = Math.max(1, Math.min(
            this.binary_identity_chunk_bytes,
            other_source.binary_identity_chunk_bytes,
        ));
        for (let compared = 0; compared < binary.contentLength;) {
            this.assert_binary_comparison_active(
                lifecycle_epoch,
                other_source,
                other_lifecycle_epoch,
                is_cancelled,
            );
            const count = Math.min(chunk_bytes, binary.contentLength - compared);
            const left_start = binary.contentOffset + compared;
            const right_start = other_binary.contentOffset + compared;
            if (Buffer.compare(
                this.open_bytes().subarray(left_start, left_start + count),
                other_source.open_bytes().subarray(right_start, right_start + count),
            ) !== 0) return false;
            compared += count;
            if (compared < binary.contentLength) await yield_to_event_loop();
        }
        this.assert_binary_comparison_active(
            lifecycle_epoch,
            other_source,
            other_lifecycle_epoch,
            is_cancelled,
        );
        return true;
    }

    private capture_lifecycle_epoch(): number {
        this.open_bytes();
        this.open_view();
        return this.lifecycle_epoch;
    }

    private assert_lifecycle_epoch(lifecycle_epoch: number): void {
        if (
            lifecycle_epoch !== this.lifecycle_epoch
            || this.bytes === undefined
            || this.view === undefined
        ) throw source_abort_error();
    }

    private assert_async_active(
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): void {
        this.assert_lifecycle_epoch(lifecycle_epoch);
        if (is_cancelled()) throw source_abort_error();
        this.assert_lifecycle_epoch(lifecycle_epoch);
    }

    private assert_binary_comparison_active(
        lifecycle_epoch: number,
        other_source: DtaDataSource,
        other_lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): void {
        this.assert_lifecycle_epoch(lifecycle_epoch);
        other_source.assert_lifecycle_epoch(other_lifecycle_epoch);
        if (is_cancelled()) throw source_abort_error();
        this.assert_lifecycle_epoch(lifecycle_epoch);
        other_source.assert_lifecycle_epoch(other_lifecycle_epoch);
    }

    private open_buffer(): ArrayBuffer {
        const buffer = this.open_bytes().buffer;
        if (!(buffer instanceof ArrayBuffer)) throw new Error('Expected an ArrayBuffer');
        return buffer;
    }

    private open_bytes(): Uint8Array {
        if (this.bytes === undefined) throw new Error('Stata source is closed');
        return this.bytes;
    }

    private open_view(): DataView {
        if (this.view === undefined) throw new Error('Stata source is closed');
        return this.view;
    }

    private cached_value_labels(name: string): Map<number, string> | undefined {
        const cached = this.decoded_value_label_tables.get(name);
        if (cached === undefined) return undefined;
        this.decoded_value_label_tables.delete(name);
        this.decoded_value_label_tables.set(name, cached);
        return cached.labels;
    }

    private cache_value_label_table(name: string, table: DecodedValueLabelTable): void {
        if (
            this.value_label_cache_entry_limit < 1
            || table.cacheBytes > this.value_label_cache_byte_limit
        ) return;
        if (this.decoded_value_label_tables.size === 0) {
            this.decoded_value_label_cache_bytes = 0;
        }
        const previous = this.decoded_value_label_tables.get(name);
        if (previous !== undefined) {
            this.decoded_value_label_tables.delete(name);
            this.decoded_value_label_cache_bytes -= previous.cacheBytes;
        }
        this.decoded_value_label_tables.set(name, table);
        this.decoded_value_label_cache_bytes += table.cacheBytes;
        while (
            this.decoded_value_label_tables.size > this.value_label_cache_entry_limit
            || this.decoded_value_label_cache_bytes > this.value_label_cache_byte_limit
        ) {
            const oldest_name = this.decoded_value_label_tables.keys().next().value!;
            const oldest = this.decoded_value_label_tables.get(oldest_name)!;
            this.decoded_value_label_tables.delete(oldest_name);
            this.decoded_value_label_cache_bytes -= oldest.cacheBytes;
        }
    }

    private value_labels(name: string): Map<number, string> | undefined {
        const cached = this.cached_value_labels(name);
        if (cached !== undefined) return cached;
        if (this.missing_value_label_table_names.has(name)) return undefined;
        const table = parse_value_label_table(
            this.open_buffer(),
            this.metadata,
            name,
            this.unicode_decoder,
            this.pre_unicode_utf8_decoder,
            this.pre_unicode_fallback_decoder,
            this.value_label_table_entry_limit,
            this.value_label_table_decoded_byte_limit,
        );
        if (table === undefined) this.missing_value_label_table_names.add(name);
        else this.cache_value_label_table(name, table);
        return table?.labels;
    }

    private async value_labels_async(
        name: string,
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<Map<number, string> | undefined> {
        this.assert_lifecycle_epoch(lifecycle_epoch);
        const cached = this.cached_value_labels(name);
        if (cached !== undefined) return cached;
        if (this.missing_value_label_table_names.has(name)) return undefined;
        const assert_lifecycle = () => this.assert_lifecycle_epoch(lifecycle_epoch);
        const assert_active = () => this.assert_async_active(lifecycle_epoch, is_cancelled);
        const open_buffer = () => {
            assert_lifecycle();
            return this.open_buffer();
        };
        const table = await parse_value_label_table_async(
            open_buffer,
            this.metadata,
            name,
            this.unicode_decoder,
            this.pre_unicode_utf8_decoder,
            this.pre_unicode_fallback_decoder,
            this.value_label_table_entry_limit,
            this.value_label_table_decoded_byte_limit,
            assert_lifecycle,
            assert_active,
        );
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        if (table === undefined) this.missing_value_label_table_names.add(name);
        else this.cache_value_label_table(name, table);
        return table?.labels;
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

/** Shared-prototype identity capability, weakly interned by the decoded GSO so
 * repeated cell materialization does not allocate another closure bundle. */
class DtaBinaryIdentity implements DeferredCellIdentity {
    constructor(
        private readonly source: DtaDataSource,
        private readonly binary: BinaryGso,
    ) {}

    cachedKey(): string | undefined {
        return this.source.cached_binary_comparison_key(this.binary);
    }

    resolveKey(is_cancelled: () => boolean): Promise<string> {
        return this.source.resolve_binary_comparison_key(this.binary, is_cancelled);
    }

    exactlyEquals(
        other: DeferredCellIdentity,
        is_cancelled: () => boolean,
    ): boolean | Promise<boolean> | undefined {
        if (!(other instanceof DtaBinaryIdentity)) return undefined;
        return this.source.binary_exactly_equals(
            this.binary,
            other.source,
            other.binary,
            is_cancelled,
        );
    }
}

function encode_binary_gso(bytes: Uint8Array, entry: GsoEntry): BinaryGso {
    const preview_length = Math.min(entry.content_length, BINARY_GSO_PREVIEW_BYTES);
    let preview = '';
    for (let offset = 0; offset < preview_length; offset++) {
        preview += bytes[entry.content_offset + offset].toString(16).padStart(2, '0');
    }
    const suffix = entry.content_length > preview_length ? '…' : '';
    return {
        kind: 'binary-gso',
        contentOffset: entry.content_offset,
        contentLength: entry.content_length,
        formatted: `binary (${entry.content_length} bytes): ${preview}${suffix}`,
    };
}

function compare_gso_order(left: GsoOrder, right: GsoOrder): number {
    return left.observation - right.observation || left.variable - right.variable;
}

function is_binary_gso(cell: ResolvedStataCell): cell is BinaryGso {
    return typeof cell === 'object' && cell !== null && 'kind' in cell
        && cell.kind === 'binary-gso';
}

function is_gso_batch_target(cell: StrlBatchCell): cell is GsoBatchTarget {
    return typeof cell === 'object' && cell !== null && cell.kind === 'gso-target';
}

function validate_legacy_expansion_fields(buffer: ArrayBuffer): void {
    const bytes = new Uint8Array(buffer);
    const version = bytes[0];
    if (version !== 113 && version !== 114 && version !== 115) return;
    if (buffer.byteLength < 10) throw new Error('Corrupt .dta file: legacy header is truncated');
    const little_endian = bytes[1] === 2;
    const view = new DataView(buffer);
    const nvar = view.getUint16(4, little_endian);
    const format_width = version === 113 ? 12 : 49;
    let position = 109
        + nvar
        + nvar * 33
        + (nvar + 1) * 2
        + nvar * format_width
        + nvar * 33
        + nvar * 81;
    let field_count = 0;
    while (true) {
        if (!Number.isSafeInteger(position) || position + 5 > buffer.byteLength) {
            throw new Error('Corrupt .dta file: expansion fields are truncated');
        }
        const type = view.getUint8(position);
        const length = view.getInt32(position + 1, little_endian);
        if (length < 0) {
            throw new Error('Corrupt .dta file: expansion field has negative length');
        }
        const next = position + 5 + length;
        if (!Number.isSafeInteger(next) || next <= position || next > buffer.byteLength) {
            throw new Error('Corrupt .dta file: expansion field is truncated');
        }
        if (type === 0 && length === 0) return;
        field_count += 1;
        if (field_count > MAX_LEGACY_EXPANSION_FIELDS) {
            throw new Error('Corrupt .dta file: too many expansion fields');
        }
        position = next;
    }
}

function read_strl_cell_pointer(
    view: DataView,
    metadata: DtaMetadata,
    pointer_offset: number,
): { v: number; o: number } | null {
    if (metadata.format_version !== 118 && metadata.format_version !== 119) {
        return read_strl_pointer(view, metadata, pointer_offset);
    }
    const little_endian = metadata.byte_order === 'LSF';
    let variable: number;
    let observation: number;
    if (metadata.format_version === 118) {
        // Remove this workaround once @jbearak/dta-parser includes the fix for
        // jbearak/dta-parser#37. Release 118 uses a 2-byte v and 6-byte o.
        variable = view.getUint16(pointer_offset, little_endian);
        if (little_endian) {
            observation = view.getUint32(pointer_offset + 2, true);
            if (view.getUint16(pointer_offset + 6, true) !== 0) {
                throw new Error('strL observation number exceeds 32-bit range');
            }
        } else {
            if (view.getUint16(pointer_offset + 2, false) !== 0) {
                throw new Error('strL observation number exceeds 32-bit range');
            }
            observation = view.getUint32(pointer_offset + 4, false);
        }
    } else if (little_endian) {
        // Release 119 uses a 3-byte v and 5-byte o.
        variable = view.getUint16(pointer_offset, true)
            + view.getUint8(pointer_offset + 2) * 0x1_0000;
        observation = view.getUint32(pointer_offset + 3, true);
        if (view.getUint8(pointer_offset + 7) !== 0) {
            throw new Error('strL observation number exceeds 32-bit range');
        }
    } else {
        variable = view.getUint8(pointer_offset) * 0x1_0000
            + view.getUint16(pointer_offset + 1, false);
        if (view.getUint8(pointer_offset + 3) !== 0) {
            throw new Error('strL observation number exceeds 32-bit range');
        }
        observation = view.getUint32(pointer_offset + 4, false);
    }
    return variable === 0 && observation === 0
        ? null
        : { v: variable, o: observation };
}

function validate_gso_identifier(
    variable: number,
    observation: number,
    metadata: DtaMetadata,
    source: 'strL pointer' | 'strL object',
): void {
    if (
        !Number.isInteger(variable)
        || !Number.isInteger(observation)
        || variable < 1
        || variable > metadata.nvar
        || observation < 1
        || observation > metadata.nobs
    ) {
        throw new Error(
            `Corrupt .dta file: ${source} id (${variable}, ${observation}) is outside `
            + `the dataset range (1..${metadata.nvar}, 1..${metadata.nobs})`,
        );
    }
}

function gso_key(variable: number, observation: number): string {
    return `${variable}:${observation}`;
}

function validate_section_offsets(metadata: DtaMetadata, bytes: Uint8Array): void {
    let previous = -1;
    for (const [name, offset] of Object.entries(metadata.section_offsets)) {
        if (!Number.isSafeInteger(offset) || offset < previous || offset > bytes.byteLength) {
            throw new Error(`Corrupt .dta file: invalid ${name} section offset`);
        }
        previous = offset;
    }
    if (is_legacy_format(metadata.format_version)) return;
    for (const [name, tag] of MODERN_SECTION_TAGS) {
        if (!matches_ascii(bytes, metadata.section_offsets[name], tag)) {
            throw new Error(`Corrupt .dta file: invalid ${name} section tag`);
        }
    }
}

interface ValueLabelTableEntry {
    readonly name: string;
    readonly tableLength: number;
    readonly payloadStart: number;
    readonly entryEnd: number;
}

interface ScannedValueLabelTable {
    readonly entry: ValueLabelTableEntry;
    readonly entryEndPosition: number;
}

function value_label_tables_start(metadata: DtaMetadata): number {
    return metadata.section_offsets.value_labels
        + (is_legacy_format(metadata.format_version) ? 0 : VALUE_LABELS_TAG_LENGTH);
}

function scan_value_label_table_at(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    position: number,
    unicode_decoder: TextDecoder,
    pre_unicode_utf8_decoder: TextDecoder,
    pre_unicode_fallback_decoder: TextDecoder,
): ScannedValueLabelTable | null {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const little_endian = metadata.byte_order === 'LSF';
    const legacy = is_legacy_format(metadata.format_version);
    const name_width = metadata.format_version >= 118
        ? UNICODE_LABEL_NAME_WIDTH
        : LEGACY_LABEL_NAME_WIDTH;
    const section_end = metadata.section_offsets.stata_data_close;
    if (position >= section_end) return null;

    let table_length: number;
    if (legacy) {
        if (position + 4 > section_end) return null;
        table_length = view.getInt32(position, little_endian);
        if (table_length <= 0) return null;
        position += 4;
    } else {
        if (!matches_ascii(bytes, position, '<lbl>')) return null;
        position += LBL_OPEN_TAG_LENGTH;
        if (position + 4 > section_end) {
            throw new Error('Corrupt value label table: truncated entry length');
        }
        table_length = view.getInt32(position, little_endian);
        position += 4;
        if (table_length < 0) {
            throw new Error('Corrupt value label table: negative entry length');
        }
    }
    const entry_end = position + table_length;
    if (!Number.isSafeInteger(entry_end) || entry_end > section_end) {
        throw new Error('Corrupt value label table: entry exceeds section bounds');
    }
    if (position + name_width + LABEL_PADDING_BYTES > entry_end) {
        throw new Error('Corrupt value label table: truncated name');
    }
    const name = decode_value_label_text(
        bytes,
        position,
        position + name_width,
        metadata,
        unicode_decoder,
        pre_unicode_utf8_decoder,
        pre_unicode_fallback_decoder,
        true,
    );
    const payload_start = position + name_width + LABEL_PADDING_BYTES;
    return {
        entry: {
            name,
            tableLength: table_length,
            payloadStart: payload_start,
            entryEnd: entry_end,
        },
        entryEndPosition: entry_end,
    };
}

function advance_value_label_table_position(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    entry_end_position: number,
): number {
    if (is_legacy_format(metadata.format_version)) return entry_end_position;
    if (!matches_ascii(new Uint8Array(buffer), entry_end_position, '</lbl>')) {
        throw new Error('Corrupt value label table: missing closing tag');
    }
    return entry_end_position + LBL_CLOSE_TAG_LENGTH;
}

/** Local until @jbearak/dta-parser exposes a single-table, declared-length-bounded
 * parser with a pre-Unicode decoder hook. Version 0.3.0 parses every table and
 * lets modern payload reads cross the current <lbl>'s declared boundary. */
function* scan_value_label_tables(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    unicode_decoder: TextDecoder,
    pre_unicode_utf8_decoder: TextDecoder,
    pre_unicode_fallback_decoder: TextDecoder,
): Generator<ValueLabelTableEntry> {
    let position = value_label_tables_start(metadata);
    while (true) {
        const scanned = scan_value_label_table_at(
            buffer,
            metadata,
            position,
            unicode_decoder,
            pre_unicode_utf8_decoder,
            pre_unicode_fallback_decoder,
        );
        if (scanned === null) return;
        yield scanned.entry;
        position = advance_value_label_table_position(
            buffer,
            metadata,
            scanned.entryEndPosition,
        );
    }
}

function parse_value_label_table(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    wanted_name: string,
    unicode_decoder: TextDecoder,
    pre_unicode_utf8_decoder: TextDecoder,
    pre_unicode_fallback_decoder: TextDecoder,
    max_entry_count: number,
    max_decoded_bytes: number,
): DecodedValueLabelTable | undefined {
    for (const entry of scan_value_label_tables(
        buffer,
        metadata,
        unicode_decoder,
        pre_unicode_utf8_decoder,
        pre_unicode_fallback_decoder,
    )) {
        if (entry.name !== wanted_name) continue;
        return decode_value_label_table(
            buffer,
            metadata,
            entry,
            unicode_decoder,
            pre_unicode_utf8_decoder,
            pre_unicode_fallback_decoder,
            max_entry_count,
            max_decoded_bytes,
        );
    }
    return undefined;
}

async function parse_value_label_table_async(
    open_buffer: () => ArrayBuffer,
    metadata: DtaMetadata,
    wanted_name: string,
    unicode_decoder: TextDecoder,
    pre_unicode_utf8_decoder: TextDecoder,
    pre_unicode_fallback_decoder: TextDecoder,
    max_entry_count: number,
    max_decoded_bytes: number,
    assert_lifecycle: () => void,
    assert_active: () => void,
): Promise<DecodedValueLabelTable | undefined> {
    let position = value_label_tables_start(metadata);
    let tables_scanned = 0;
    while (true) {
        assert_active();
        const scanned = scan_value_label_table_at(
            open_buffer(),
            metadata,
            position,
            unicode_decoder,
            pre_unicode_utf8_decoder,
            pre_unicode_fallback_decoder,
        );
        if (scanned === null) break;
        if (scanned.entry.name === wanted_name) {
            const table = await decode_value_label_table_async(
                open_buffer,
                metadata,
                scanned.entry,
                unicode_decoder,
                pre_unicode_utf8_decoder,
                pre_unicode_fallback_decoder,
                max_entry_count,
                max_decoded_bytes,
                assert_lifecycle,
                assert_active,
            );
            assert_active();
            return table;
        }
        position = advance_value_label_table_position(
            open_buffer(),
            metadata,
            scanned.entryEndPosition,
        );
        tables_scanned += 1;
        if (tables_scanned >= VALUE_LABEL_ENTRIES_PER_YIELD) {
            tables_scanned = 0;
            await yield_to_event_loop();
            assert_lifecycle();
        }
    }
    assert_active();
    return undefined;
}

interface ValueLabelPayloadLayout {
    readonly littleEndian: boolean;
    readonly count: number;
    readonly textLength: number;
    readonly offsetsStart: number;
    readonly valuesStart: number;
    readonly textStart: number;
}

interface ValueLabelPayloadReader extends ValueLabelPayloadLayout {
    readonly bytes: Uint8Array;
    readonly view: DataView;
}

function value_label_payload_layout(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    entry: ValueLabelTableEntry,
    max_entry_count: number,
): ValueLabelPayloadLayout {
    if (entry.tableLength > MAX_VALUE_LABEL_TABLE_BYTES) {
        throw new Error(
            `Value label table is too large to decode safely `
            + `(max ${MAX_VALUE_LABEL_TABLE_BYTES} bytes)`,
        );
    }
    const view = new DataView(buffer);
    const little_endian = metadata.byte_order === 'LSF';
    if (entry.payloadStart + 8 > entry.entryEnd) {
        throw new Error('Corrupt value label table: truncated header');
    }
    const count = view.getInt32(entry.payloadStart, little_endian);
    const text_length = view.getInt32(entry.payloadStart + 4, little_endian);
    if (count < 0 || text_length < 0) {
        throw new Error('Corrupt value label table: negative count or text length');
    }
    if (count > max_entry_count) {
        throw new Error(
            `Value label table has too many entries to decode safely `
            + `(max ${max_entry_count} entries)`,
        );
    }
    const offsets_start = entry.payloadStart + 8;
    const values_start = offsets_start + count * 4;
    const text_start = values_start + count * 4;
    const payload_end = text_start + text_length;
    if (!Number.isSafeInteger(payload_end) || payload_end > entry.entryEnd) {
        throw new Error('Corrupt value label table: payload exceeds entry bounds');
    }
    return {
        littleEndian: little_endian,
        count,
        textLength: text_length,
        offsetsStart: offsets_start,
        valuesStart: values_start,
        textStart: text_start,
    };
}

function value_label_payload_reader(
    buffer: ArrayBuffer,
    layout: ValueLabelPayloadLayout,
): ValueLabelPayloadReader {
    return {
        ...layout,
        bytes: new Uint8Array(buffer),
        view: new DataView(buffer),
    };
}

interface ValueLabelDecodeState {
    readonly labels: Map<number, string>;
    readonly decodedTextByOffset: Map<number, string>;
    decodedBytes: number;
}

function create_value_label_decode_state(): ValueLabelDecodeState {
    return {
        labels: new Map(),
        decodedTextByOffset: new Map(),
        decodedBytes: 0,
    };
}

function decoded_value_label_table(state: ValueLabelDecodeState): DecodedValueLabelTable {
    return {
        labels: state.labels,
        decodedBytes: state.decodedBytes,
        cacheBytes: state.decodedBytes
            + state.labels.size * VALUE_LABEL_CACHE_BYTES_PER_ENTRY,
    };
}

function decode_value_label_table(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    entry: ValueLabelTableEntry,
    unicode_decoder: TextDecoder,
    pre_unicode_utf8_decoder: TextDecoder,
    pre_unicode_fallback_decoder: TextDecoder,
    max_entry_count: number,
    max_decoded_bytes: number,
): DecodedValueLabelTable {
    const layout = value_label_payload_layout(buffer, metadata, entry, max_entry_count);
    const reader = value_label_payload_reader(buffer, layout);
    const state = create_value_label_decode_state();
    for (let index = 0; index < layout.count; index++) {
        add_value_label(
            state,
            metadata,
            reader,
            index,
            unicode_decoder,
            pre_unicode_utf8_decoder,
            pre_unicode_fallback_decoder,
            max_decoded_bytes,
        );
    }
    return decoded_value_label_table(state);
}

async function decode_value_label_table_async(
    open_buffer: () => ArrayBuffer,
    metadata: DtaMetadata,
    entry: ValueLabelTableEntry,
    unicode_decoder: TextDecoder,
    pre_unicode_utf8_decoder: TextDecoder,
    pre_unicode_fallback_decoder: TextDecoder,
    max_entry_count: number,
    max_decoded_bytes: number,
    assert_lifecycle: () => void,
    assert_active: () => void,
): Promise<DecodedValueLabelTable> {
    assert_lifecycle();
    const layout = value_label_payload_layout(
        open_buffer(),
        metadata,
        entry,
        max_entry_count,
    );
    const state = create_value_label_decode_state();
    for (let index = 0; index < layout.count;) {
        assert_lifecycle();
        const chunk_start = index;
        const end = Math.min(index + VALUE_LABEL_ENTRIES_PER_YIELD, layout.count);
        {
            const reader = value_label_payload_reader(open_buffer(), layout);
            for (; index < end; index++) {
                add_value_label(
                    state,
                    metadata,
                    reader,
                    index,
                    unicode_decoder,
                    pre_unicode_utf8_decoder,
                    pre_unicode_fallback_decoder,
                    max_decoded_bytes,
                );
            }
        }
        if (index - chunk_start === VALUE_LABEL_ENTRIES_PER_YIELD) {
            await yield_to_event_loop();
            assert_active();
        }
    }
    assert_active();
    return decoded_value_label_table(state);
}

function add_value_label(
    state: ValueLabelDecodeState,
    metadata: DtaMetadata,
    layout: ValueLabelPayloadReader,
    index: number,
    unicode_decoder: TextDecoder,
    pre_unicode_utf8_decoder: TextDecoder,
    pre_unicode_fallback_decoder: TextDecoder,
    max_decoded_bytes: number,
): void {
    const offset = layout.view.getInt32(
        layout.offsetsStart + index * 4,
        layout.littleEndian,
    );
    if (offset < 0 || offset >= layout.textLength) return;
    let label = state.decodedTextByOffset.get(offset);
    if (label === undefined) {
        const start = layout.textStart + offset;
        let end = start;
        while (end < layout.textStart + layout.textLength && layout.bytes[end] !== 0) end += 1;
        label = decode_value_label_text(
            layout.bytes,
            start,
            end,
            metadata,
            unicode_decoder,
            pre_unicode_utf8_decoder,
            pre_unicode_fallback_decoder,
            false,
        );
        const decoded_bytes = label.length * 2;
        if (decoded_bytes > max_decoded_bytes - state.decodedBytes) {
            throw new Error(
                `Value label table exceeds its decoded text budget `
                + `(max ${max_decoded_bytes} UTF-16 bytes)`,
            );
        }
        state.decodedTextByOffset.set(offset, label);
        state.decodedBytes += decoded_bytes;
    }
    const value = layout.view.getInt32(
        layout.valuesStart + index * 4,
        layout.littleEndian,
    );
    state.labels.set(value, label);
}

function decode_value_label_text(
    bytes: Uint8Array,
    start: number,
    end: number,
    metadata: DtaMetadata,
    unicode_decoder: TextDecoder,
    pre_unicode_utf8_decoder: TextDecoder,
    pre_unicode_fallback_decoder: TextDecoder,
    fixed_width: boolean,
): string {
    let actual_end = end;
    if (fixed_width) {
        actual_end = start;
        while (actual_end < end && bytes[actual_end] !== 0) actual_end += 1;
    }
    return metadata.format_version >= 118
        ? unicode_decoder.decode(bytes.subarray(start, actual_end))
        : decode_pre_unicode(
            bytes,
            start,
            actual_end,
            pre_unicode_utf8_decoder,
            pre_unicode_fallback_decoder,
        );
}

function decode_fixed(
    bytes: Uint8Array,
    start: number,
    width: number,
    utf8_decoder: TextDecoder,
    fallback_decoder: TextDecoder,
): string {
    let end = start;
    while (end < start + width && bytes[end] !== 0) end += 1;
    return decode_pre_unicode(bytes, start, end, utf8_decoder, fallback_decoder);
}

function decode_pre_unicode(
    bytes: Uint8Array,
    start: number,
    end: number,
    utf8_decoder: TextDecoder,
    fallback_decoder: TextDecoder,
): string {
    const value = bytes.subarray(start, end);
    try {
        return utf8_decoder.decode(value);
    } catch {
        return fallback_decoder.decode(value);
    }
}

function matches_ascii(bytes: Uint8Array, start: number, value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        if (bytes[start + index] !== value.charCodeAt(index)) return false;
    }
    return true;
}
