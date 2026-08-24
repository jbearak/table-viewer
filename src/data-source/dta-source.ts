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
import type {
    ColumnFilterMetadata,
    ColumnWindow,
    DataSource,
    IndexedRows,
    RawCell,
    RawColumnWindow,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
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
const MAX_SYNC_BINARY_HASH_BYTES = 16 * 1024 * 1024;
const MAX_VALUE_LABEL_TABLE_BYTES = 16 * 1024 * 1024;
const MAX_VALUE_LABEL_TABLE_ENTRIES = 65_536;
const MAX_VALUE_LABEL_TABLE_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_VALUE_LABEL_CACHE_ENTRIES = 64;
const MAX_VALUE_LABEL_CACHE_BYTES = 16 * 1024 * 1024;
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
    readonly decodedBytes: number;
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
    readonly bytes: Uint8Array;
    readonly view: DataView;
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
            is_cancelled,
        );
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
        this.assert_sheet(sheet_index);
        this.assert_column(column_index);
        const label_name = this.metadata.variables[column_index].value_label_name;
        if (!label_name) return undefined;
        return filter_metadata_from_labels(
            await this.value_labels_async(label_name, is_cancelled),
        );
    }

    private read_column_projection<Cell>(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
        read_range: (start: number, end: number, columns: readonly number[]) => (Cell | null)[][],
    ): { startRow: number; rows: (Cell | null)[][] } {
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
        this.gso_checkpoints = [];
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
            const identity = () => this.binary_comparison_key(cell);
            Object.defineProperties(raw_cell, {
                comparisonKey: { enumerable: false, get: identity },
                filterKey: { enumerable: false, get: identity },
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
        is_cancelled: () => boolean,
    ): Promise<(RawCell | null)[][]> {
        const rows: (RawCell | null)[][] = [];
        for (let row = start; row < end;) {
            if (is_cancelled()) throw source_abort_error();
            const count = Math.min(DECODE_WINDOW_ROWS, end - row);
            const decoded = await this.resolve_columns_async(
                this.decode_columns(row, count, columns),
                row,
                columns,
                is_cancelled,
            );
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
            this.resolve_gso_batch(batch.bytes, batch.view, batch.targets);
        }
        return this.materialize_resolved_columns(rows, start, columns, batch.cells);
    }

    private async resolve_columns_async(
        rows: Row[],
        start: number,
        columns: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<ResolvedStataCell[][]> {
        const batch = this.collect_strl_batch(start, rows.length, columns);
        if (batch.targets.size > 0) {
            await this.resolve_gso_batch_async(
                batch.bytes,
                batch.view,
                batch.targets,
                is_cancelled,
            );
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
        return { bytes, view, cells, targets };
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
        bytes: Uint8Array,
        view: DataView,
        targets: Map<string, GsoBatchTarget>,
        is_cancelled: () => boolean,
    ): Promise<void> {
        if (is_cancelled()) throw source_abort_error();
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
            scanned_since_yield += 1;
            if (scanned_since_yield >= GSO_SCAN_ENTRIES_PER_YIELD) {
                scanned_since_yield = 0;
                await yield_to_event_loop();
                if (is_cancelled()) throw source_abort_error();
            }
        }
    }

    private scan_next_gso(bytes: Uint8Array, view: DataView): ScannedGso | null {
        const position = this.gso_scan_position;
        const scanned = this.read_gso_at(bytes, view, position);
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

    private binary_comparison_key(binary: BinaryGso): string {
        let digest = this.gso_digest_cache.get(binary.contentOffset);
        if (digest !== undefined) {
            this.gso_digest_cache.delete(binary.contentOffset);
            this.gso_digest_cache.set(binary.contentOffset, digest);
        } else {
            if (binary.contentLength > MAX_SYNC_BINARY_HASH_BYTES) {
                throw new Error(
                    `Stata binary strL is too large to compare exactly without blocking `
                    + `(max ${MAX_SYNC_BINARY_HASH_BYTES} bytes)`,
                );
            }
            const content = this.open_bytes().subarray(
                binary.contentOffset,
                binary.contentOffset + binary.contentLength,
            );
            digest = createHash('sha256').update(content).digest('hex');
            this.gso_digest_cache.set(binary.contentOffset, digest);
            if (this.gso_digest_cache.size > MAX_GSO_DIGEST_CACHE_ENTRIES) {
                this.gso_digest_cache.delete(this.gso_digest_cache.keys().next().value!);
            }
        }
        return `${BINARY_GSO_COMPARISON_PREFIX}${digest}:${binary.contentLength}`;
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
            || table.decodedBytes > this.value_label_cache_byte_limit
        ) return;
        if (this.decoded_value_label_tables.size === 0) {
            this.decoded_value_label_cache_bytes = 0;
        }
        const previous = this.decoded_value_label_tables.get(name);
        if (previous !== undefined) {
            this.decoded_value_label_tables.delete(name);
            this.decoded_value_label_cache_bytes -= previous.decodedBytes;
        }
        this.decoded_value_label_tables.set(name, table);
        this.decoded_value_label_cache_bytes += table.decodedBytes;
        while (
            this.decoded_value_label_tables.size > this.value_label_cache_entry_limit
            || this.decoded_value_label_cache_bytes > this.value_label_cache_byte_limit
        ) {
            const oldest_name = this.decoded_value_label_tables.keys().next().value!;
            const oldest = this.decoded_value_label_tables.get(oldest_name)!;
            this.decoded_value_label_tables.delete(oldest_name);
            this.decoded_value_label_cache_bytes -= oldest.decodedBytes;
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
        is_cancelled: () => boolean,
    ): Promise<Map<number, string> | undefined> {
        const cached = this.cached_value_labels(name);
        if (cached !== undefined) return cached;
        if (this.missing_value_label_table_names.has(name)) return undefined;
        const table = await parse_value_label_table_async(
            this.open_buffer(),
            this.metadata,
            name,
            this.unicode_decoder,
            this.pre_unicode_utf8_decoder,
            this.pre_unicode_fallback_decoder,
            this.value_label_table_entry_limit,
            this.value_label_table_decoded_byte_limit,
            is_cancelled,
        );
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
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const little_endian = metadata.byte_order === 'LSF';
    const legacy = is_legacy_format(metadata.format_version);
    const name_width = metadata.format_version >= 118
        ? UNICODE_LABEL_NAME_WIDTH
        : LEGACY_LABEL_NAME_WIDTH;
    const section_end = metadata.section_offsets.stata_data_close;
    let position = metadata.section_offsets.value_labels
        + (legacy ? 0 : VALUE_LABELS_TAG_LENGTH);

    while (position < section_end) {
        let table_length: number;
        if (legacy) {
            if (position + 4 > section_end) break;
            table_length = view.getInt32(position, little_endian);
            if (table_length <= 0) break;
            position += 4;
        } else {
            if (!matches_ascii(bytes, position, '<lbl>')) break;
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
        yield {
            name,
            tableLength: table_length,
            payloadStart: payload_start,
            entryEnd: entry_end,
        };
        position = entry_end;
        if (!legacy) {
            if (!matches_ascii(bytes, position, '</lbl>')) {
                throw new Error('Corrupt value label table: missing closing tag');
            }
            position += LBL_CLOSE_TAG_LENGTH;
        }
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
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    wanted_name: string,
    unicode_decoder: TextDecoder,
    pre_unicode_utf8_decoder: TextDecoder,
    pre_unicode_fallback_decoder: TextDecoder,
    max_entry_count: number,
    max_decoded_bytes: number,
    is_cancelled: () => boolean,
): Promise<DecodedValueLabelTable | undefined> {
    let tables_scanned = 0;
    for (const entry of scan_value_label_tables(
        buffer,
        metadata,
        unicode_decoder,
        pre_unicode_utf8_decoder,
        pre_unicode_fallback_decoder,
    )) {
        if (is_cancelled()) throw source_abort_error();
        if (entry.name === wanted_name) {
            return decode_value_label_table_async(
                buffer,
                metadata,
                entry,
                unicode_decoder,
                pre_unicode_utf8_decoder,
                pre_unicode_fallback_decoder,
                max_entry_count,
                max_decoded_bytes,
                is_cancelled,
            );
        }
        tables_scanned += 1;
        if (tables_scanned >= VALUE_LABEL_ENTRIES_PER_YIELD) {
            tables_scanned = 0;
            await yield_to_event_loop();
        }
    }
    if (is_cancelled()) throw source_abort_error();
    return undefined;
}

function value_label_payload_layout(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    entry: ValueLabelTableEntry,
    max_entry_count: number,
): {
    bytes: Uint8Array;
    view: DataView;
    littleEndian: boolean;
    count: number;
    textLength: number;
    offsetsStart: number;
    valuesStart: number;
    textStart: number;
} {
    if (entry.tableLength > MAX_VALUE_LABEL_TABLE_BYTES) {
        throw new Error(
            `Value label table is too large to decode safely `
            + `(max ${MAX_VALUE_LABEL_TABLE_BYTES} bytes)`,
        );
    }
    const bytes = new Uint8Array(buffer);
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
        bytes,
        view,
        littleEndian: little_endian,
        count,
        textLength: text_length,
        offsetsStart: offsets_start,
        valuesStart: values_start,
        textStart: text_start,
    };
}

interface ValueLabelDecodeState extends DecodedValueLabelTable {
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
    return { labels: state.labels, decodedBytes: state.decodedBytes };
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
    const state = create_value_label_decode_state();
    for (let index = 0; index < layout.count; index++) {
        add_value_label(
            state,
            metadata,
            layout,
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
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    entry: ValueLabelTableEntry,
    unicode_decoder: TextDecoder,
    pre_unicode_utf8_decoder: TextDecoder,
    pre_unicode_fallback_decoder: TextDecoder,
    max_entry_count: number,
    max_decoded_bytes: number,
    is_cancelled: () => boolean,
): Promise<DecodedValueLabelTable> {
    const layout = value_label_payload_layout(buffer, metadata, entry, max_entry_count);
    const state = create_value_label_decode_state();
    for (let index = 0; index < layout.count; index++) {
        add_value_label(
            state,
            metadata,
            layout,
            index,
            unicode_decoder,
            pre_unicode_utf8_decoder,
            pre_unicode_fallback_decoder,
            max_decoded_bytes,
        );
        if ((index + 1) % VALUE_LABEL_ENTRIES_PER_YIELD === 0) {
            await yield_to_event_loop();
            if (is_cancelled()) throw source_abort_error();
        }
    }
    if (is_cancelled()) throw source_abort_error();
    return decoded_value_label_table(state);
}

function add_value_label(
    state: ValueLabelDecodeState,
    metadata: DtaMetadata,
    layout: ReturnType<typeof value_label_payload_layout>,
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
