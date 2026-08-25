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
    resolve_text_encoding,
    type DtaMetadata,
    type GsoEntry,
    type Row,
    type RowCell,
    type TextEncodingOptions,
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
const MAX_GSO_CACHE_ENTRIES = 256;
const MAX_GSO_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_GSO_INDEX_ENTRIES = 1_024;
const GSO_LOCATION_PAGE_ENTRIES = 256;
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
const GSO_SCAN_ENTRIES_PER_YIELD = 256;
const OBSERVATION_CELLS_PER_YIELD = 256;
const VALUE_LABEL_ENTRIES_PER_YIELD = 256;
const VALUE_LABEL_QUEUE_CHECKS_PER_YIELD = 32;
const LEGACY_VALUE_LABEL_BYTES_PER_YIELD = 256 * 1024;
const BINARY_GSO_PREVIEW_BYTES = 32;
const BINARY_GSO_COMPARISON_PREFIX = 'stata-binary:sha256:';
const STRLS_TAG_LENGTH = '<strls>'.length;
const STRLS_CLOSE_TAG_LENGTH = '</strls>'.length;
const VALUE_LABELS_TAG_LENGTH = '<value_labels>'.length;
const VALUE_LABELS_CLOSE_TAG_LENGTH = '</value_labels>'.length;
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

function is_strictly_increasing(values: ArrayLike<number>): boolean {
    for (let index = 1; index < values.length; index++) {
        if (values[index] <= values[index - 1]) return false;
    }
    return true;
}

function touch_lru<K, V>(entries: Map<K, V>, key: K): V | undefined {
    const value = entries.get(key);
    if (value === undefined) return undefined;
    entries.delete(key);
    entries.set(key, value);
    return value;
}

function cache_byte_bounded_lru<K, V>(options: {
    readonly entries: Map<K, V>;
    readonly key: K;
    readonly value: V;
    readonly valueBytes: number;
    readonly bytesOf: (value: V) => number;
    readonly currentBytes: number;
    readonly entryLimit: number;
    readonly byteLimit: number;
}): number {
    const {
        entries,
        key,
        value,
        valueBytes,
        bytesOf,
        entryLimit,
        byteLimit,
    } = options;
    if (entryLimit < 1 || valueBytes > byteLimit) return options.currentBytes;
    let current_bytes = entries.size === 0 ? 0 : options.currentBytes;
    const previous = entries.get(key);
    if (previous !== undefined) {
        current_bytes -= bytesOf(previous);
        entries.delete(key);
    }
    entries.set(key, value);
    current_bytes += valueBytes;
    while (entries.size > entryLimit || current_bytes > byteLimit) {
        const oldest_key = entries.keys().next().value!;
        const oldest = entries.get(oldest_key)!;
        entries.delete(oldest_key);
        current_bytes -= bytesOf(oldest);
    }
    return current_bytes;
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

interface GsoIdentifier {
    readonly observation: number;
    readonly variable: number;
}

interface ScannedGso extends GsoIdentifier {
    readonly key: string;
    readonly startPosition: number;
    readonly value: GsoEntry;
    readonly nextPosition: number;
}

interface GsoLocationPage {
    identifierOffsets: Uint8Array;
    positions: Uint32Array;
    count: number;
}

interface GsoBatchTarget extends GsoIdentifier {
    readonly kind: 'gso-target';
    readonly key: string;
    /** Physical location only. Decoded payloads live in a request memo or the
     * bounded source LRU, never on lookup targets. */
    entry?: GsoEntry;
}

type StrlBatchCell = DecodedGso | GsoBatchTarget | undefined;
type GsoRequestMemo = Map<string, DecodedGso>;
type GsoResolutionPhase = 'cache' | 'historical' | 'forward' | 'done';

interface GsoResolutionState {
    phase: GsoResolutionPhase;
    historicalTargets: readonly GsoBatchTarget[];
    historicalTargetIndex: number;
}

interface GsoTransitionResult {
    readonly physicalWork: boolean;
}

type SourceWorkKind = 'gsoHeaders' | 'observationCells' | 'valueLabels' | 'payloadBytes';
type ResolvedTextEncoding = ReturnType<typeof resolve_text_encoding>;

interface SourceTextDecoderStream {
    decode(input: Uint8Array): string;
    finish(): string;
}

interface SourceTextDecoder {
    decode(input: Uint8Array): string;
    stream(): SourceTextDecoderStream;
}

interface ValueLabelWaiter {
    readonly isCancelled: () => boolean;
    readonly resolve: (labels: Map<number, string> | undefined) => void;
    readonly reject: (error: unknown) => void;
}

interface PendingValueLabelTable {
    readonly name: string;
    readonly epoch: number;
    readonly waiters: Set<ValueLabelWaiter>;
}

interface LegacyValueLabelTerminalProbe {
    readonly start: number;
    position: number;
    result?: number;
}

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
    return Object.assign(raw_cell, {
        formatted,
        bold: false,
        italic: false,
    });
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
    private readonly gso_variable_ordinals: Uint16Array;
    private readonly gso_variable_count: number;
    private readonly strl_variables: readonly VariableInfo[];
    private bytes?: Uint8Array;
    private view?: DataView;
    private lifecycle_epoch = 0;
    private readonly text_encoding: ResolvedTextEncoding;
    private readonly text_decoder: SourceTextDecoder;
    private readonly referenced_value_label_names: ReadonlySet<string>;
    private value_label_layout?: ValueLabelSectionLayout;
    private value_label_section_end?: number;
    private legacy_value_label_terminal_probe?: LegacyValueLabelTerminalProbe;
    private value_label_discovery_position: number;
    private value_label_discovery_complete = false;
    private readonly value_label_descriptors = new Map<string, ValueLabelTableEntry>();
    private readonly decoded_value_label_tables: DecodedValueLabelTables = new Map();
    private decoded_value_label_cache_bytes = 0;
    private readonly pending_value_label_tables = new Map<string, PendingValueLabelTable>();
    private readonly queued_value_label_tables = new Set<PendingValueLabelTable>();
    private value_label_queue_monitor?: Promise<void>;
    private value_label_decode_tail: Promise<void> = Promise.resolve();
    private value_label_table_entry_limit = MAX_VALUE_LABEL_TABLE_ENTRIES;
    private value_label_table_decoded_byte_limit = MAX_VALUE_LABEL_TABLE_DECODED_BYTES;
    private value_label_cache_entry_limit = MAX_VALUE_LABEL_CACHE_ENTRIES;
    private value_label_cache_byte_limit = MAX_VALUE_LABEL_CACHE_BYTES;
    private readonly missing_value_label_table_names = new Set<string>();
    private window_cache_cells = 0;
    private window_cache_bytes = 0;
    private readonly gso_index = new Map<string, GsoEntry>();
    private readonly gso_locations = new Map<number, GsoLocationPage>();
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
    private source_work_gso_headers = 0;
    private source_work_observation_cells = 0;
    private source_work_value_labels = 0;
    private source_work_payload_bytes = 0;
    private source_work_payload_jobs = 0;
    private source_work_yield?: Promise<void>;
    private binary_digest_computations = 0;
    private readonly binary_identities = new WeakMap<BinaryGso, DtaBinaryIdentity>();
    private readonly pending_binary_identities = new Map<number, PendingBinaryIdentity>();
    private gso_seen_identifiers?: Uint8Array;
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
        this.text_encoding = metadata.text_encoding
            ?? resolve_text_encoding(metadata.format_version);
        this.text_decoder = create_source_text_decoder(this.text_encoding);
        this.referenced_value_label_names = new Set(
            metadata.variables
                .map((variable) => variable.value_label_name)
                .filter((name): name is string => name.length > 0),
        );
        this.value_label_discovery_position = value_label_tables_start(metadata);
        if (is_legacy_format(metadata.format_version)) {
            this.legacy_value_label_terminal_probe = {
                start: this.value_label_discovery_position,
                position: metadata.section_offsets.stata_data_close,
            };
        } else {
            this.value_label_section_end = metadata.section_offsets.stata_data_close
                - VALUE_LABELS_CLOSE_TAG_LENGTH;
        }
        this.all_columns = metadata.variables.map((_, index) => index);
        this.gso_variable_ordinals = new Uint16Array(metadata.nvar + 1);
        const strl_variables: VariableInfo[] = [];
        metadata.variables.forEach((variable, index) => {
            if (variable.type === 'strL') {
                strl_variables.push(variable);
                this.gso_variable_ordinals[index + 1] = strl_variables.length;
            }
        });
        this.strl_variables = strl_variables;
        this.gso_variable_count = strl_variables.length;
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

    static async create(
        bytes: Uint8Array,
        text_options: TextEncodingOptions = {},
    ): Promise<DtaDataSource> {
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
                ? parse_metadata(buffer, text_options)
                : (validate_legacy_expansion_fields(buffer),
                    parse_legacy_metadata(buffer, buffer.byteLength, text_options));
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
        const runs: Array<{ start: number; count: number }> = [];
        let position = 0;
        while (position < unique.length) {
            const start = unique[position];
            let count = 1;
            while (
                count < DECODE_WINDOW_ROWS
                && position + count < unique.length
                && unique[position + count] === start + count
            ) count += 1;
            runs.push({ start, count });
            position += count;
        }
        let prefetched_gsos: ReadonlyMap<string, GsoBatchTarget> | undefined;
        const request_memo: GsoRequestMemo = new Map();
        if (runs.length > 1 && this.strl_variables.length > 0) {
            const columns_key = this.all_columns.join(',');
            const uncached_rows = runs.flatMap(({ start, count }) => {
                if (this.windows.has(`${start}:${count}:${columns_key}`)) return [];
                return Array.from({ length: count }, (_, offset) => start + offset);
            });
            if (uncached_rows.length > 0) {
                prefetched_gsos = this.resolve_indexed_gso_targets(
                    uncached_rows,
                    request_memo,
                );
            }
        }
        for (const { start, count } of runs) {
            const window = this.decoded_window(
                start,
                count,
                this.all_columns,
                prefetched_gsos,
                request_memo,
            );
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
        const lifecycle_epoch = this.capture_lifecycle_epoch();
        this.assert_sheet(sheet_index);
        const requested = Array.from(row_indices);
        for (const row of requested) this.assert_row(row);
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        if (requested.length === 0) return { rows: [] };
        if (this.all_columns.length === 0) {
            return { rows: requested.map(() => []) };
        }

        const raw = await this.read_raw_columns_indexed_async(
            sheet_index,
            requested,
            this.all_columns,
            is_cancelled,
        );
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        const labels_by_name = new Map<string, Map<number, string> | undefined>();
        for (const variable of this.metadata.variables) {
            const name = variable.value_label_name;
            if (!name || labels_by_name.has(name)) continue;
            labels_by_name.set(
                name,
                await this.value_labels_async(name, lifecycle_epoch, is_cancelled),
            );
            this.assert_async_active(lifecycle_epoch, is_cancelled);
        }

        const rows: (RenderedCell | null)[][] = [];
        let cells_since_yield = 0;
        for (const raw_row of raw.rows) {
            const rendered: (RenderedCell | null)[] = [];
            for (let column = 0; column < this.metadata.variables.length; column++) {
                const raw_cell = raw_row[column];
                const variable = this.metadata.variables[column];
                rendered.push(raw_cell === null || raw_cell === undefined
                    ? null
                    : this.render_raw_cell(
                        raw_cell,
                        variable,
                        variable.value_label_name
                            ? labels_by_name.get(variable.value_label_name)
                            : undefined,
                    ));
                cells_since_yield += 1;
                if (cells_since_yield >= OBSERVATION_CELLS_PER_YIELD) {
                    cells_since_yield = 0;
                    const scheduled = this.schedule_source_work(
                        'observationCells',
                        OBSERVATION_CELLS_PER_YIELD,
                    );
                    if (scheduled !== undefined) {
                        await scheduled;
                        this.assert_async_active(lifecycle_epoch, is_cancelled);
                    }
                }
            }
            rows.push(rendered);
        }
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        return { rows };
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
        const already_ordered = is_strictly_increasing(column_indices);
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

    async read_raw_columns_indexed_async(
        sheet_index: number,
        row_indices: ArrayLike<number>,
        column_indices: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<IndexedRawColumns> {
        const lifecycle_epoch = this.capture_lifecycle_epoch();
        this.assert_sheet(sheet_index);
        const requested_rows = Array.from(row_indices);
        for (const row of requested_rows) this.assert_row(row);
        for (const column of column_indices) this.assert_column(column);
        if (requested_rows.length === 0 || column_indices.length === 0) return { rows: [] };

        const rows_already_ordered = is_strictly_increasing(requested_rows);
        const columns_already_ordered = is_strictly_increasing(column_indices);
        const unique_rows = rows_already_ordered
            ? requested_rows
            : [...new Set(requested_rows)].sort((a, b) => a - b);
        const unique_columns = columns_already_ordered
            ? column_indices
            : [...new Set(column_indices)].sort((a, b) => a - b);
        const request_memo: GsoRequestMemo = new Map();
        const target_catalog = new Map<string, GsoBatchTarget>();
        const rows_per_chunk = this.async_observation_rows_per_chunk(unique_columns.length);
        const strl_column_count = unique_columns.reduce(
            (count, column) => count + (this.metadata.variables[column].type === 'strL' ? 1 : 0),
            0,
        );

        // Discover every requested GSO before decoding observations, but retain
        // only pointer targets — not every decoded chunk. Once the shared GSO
        // pass finishes, observations can be decoded and materialized one bounded
        // chunk at a time directly into the requested result.
        if (strl_column_count > 0) {
            let position = 0;
            while (position < unique_rows.length) {
                this.assert_async_active(lifecycle_epoch, is_cancelled);
                const start = unique_rows[position];
                let count = 1;
                while (
                    count < rows_per_chunk
                    && position + count < unique_rows.length
                    && unique_rows[position + count] === start + count
                ) count += 1;
                this.collect_strl_batch(
                    start,
                    count,
                    unique_columns,
                    undefined,
                    target_catalog,
                    request_memo,
                );
                position += count;
                const scheduled = this.schedule_source_work(
                    'observationCells',
                    count * strl_column_count,
                );
                if (scheduled !== undefined) {
                    await scheduled;
                    this.assert_async_active(lifecycle_epoch, is_cancelled);
                }
            }

            const unresolved_targets = new Map(target_catalog);
            this.resolve_cached_gso_targets(unresolved_targets, request_memo);
            if (unresolved_targets.size > 0) {
                await this.resolve_gso_batch_async(
                    unresolved_targets,
                    lifecycle_epoch,
                    is_cancelled,
                    request_memo,
                );
            }
            this.assert_async_active(lifecycle_epoch, is_cancelled);
        }

        const materialized = new Map<number, (RawCell | null)[]>();
        let position = 0;
        while (position < unique_rows.length) {
            this.assert_async_active(lifecycle_epoch, is_cancelled);
            const start = unique_rows[position];
            let count = 1;
            while (
                count < rows_per_chunk
                && position + count < unique_rows.length
                && unique_rows[position + count] === start + count
            ) count += 1;
            const decoded = await this.decode_columns_async(
                start,
                count,
                unique_columns,
                lifecycle_epoch,
                is_cancelled,
            );
            const strls = strl_column_count === 0
                ? []
                : this.collect_strl_batch(
                    start,
                    count,
                    unique_columns,
                    target_catalog,
                    undefined,
                    request_memo,
                ).cells;
            const resolved = await this.materialize_resolved_columns_async(
                decoded,
                start,
                unique_columns,
                strls,
                request_memo,
                lifecycle_epoch,
                is_cancelled,
            );
            resolved.forEach((row, offset) => materialized.set(
                start + offset,
                row.map((cell) => this.canonicalize_stata_raw(cell)),
            ));
            position += count;
            const scheduled = this.schedule_source_work(
                'observationCells',
                resolved.length * unique_columns.length,
            );
            if (scheduled !== undefined) {
                await scheduled;
                this.assert_async_active(lifecycle_epoch, is_cancelled);
            }
        }
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        if (columns_already_ordered) {
            return { rows: requested_rows.map((row) => materialized.get(row)!) };
        }
        const column_positions = new Map(
            unique_columns.map((column, index) => [column, index]),
        );
        return {
            rows: requested_rows.map((row) => {
                const values = materialized.get(row)!;
                return column_indices.map((column) => values[column_positions.get(column)!]);
            }),
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

        const already_ordered = is_strictly_increasing(column_indices);
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
        this.value_label_descriptors.clear();
        this.missing_value_label_table_names.clear();
        for (const job of this.pending_value_label_tables.values()) {
            const error = source_abort_error();
            for (const waiter of job.waiters) waiter.reject(error);
            job.waiters.clear();
        }
        this.pending_value_label_tables.clear();
        this.queued_value_label_tables.clear();
        this.value_label_layout = undefined;
        this.value_label_section_end = undefined;
        this.legacy_value_label_terminal_probe = undefined;
        this.gso_index.clear();
        this.gso_locations.clear();
        this.gso_cache.clear();
        this.gso_cache_bytes = 0;
        this.gso_digest_cache.clear();
        this.gso_digest_cache_bytes = 0;
        this.source_work_gso_headers = 0;
        this.source_work_observation_cells = 0;
        this.source_work_value_labels = 0;
        this.source_work_payload_bytes = 0;
        this.source_work_payload_jobs = 0;
        this.source_work_yield = undefined;
        for (const job of this.pending_binary_identities.values()) {
            const error = source_abort_error();
            for (const waiter of job.waiters) waiter.reject(error);
            job.waiters.clear();
        }
        this.pending_binary_identities.clear();
        this.gso_seen_identifiers = undefined;
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
        const request_memo: GsoRequestMemo = new Map();
        for (let row = start; row < end;) {
            const count = Math.min(DECODE_WINDOW_ROWS, end - row);
            const decoded = this.resolve_columns(
                this.decode_columns(row, count, columns),
                row,
                columns,
                undefined,
                request_memo,
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
        const request_memo: GsoRequestMemo = new Map();
        const rows_per_chunk = this.async_observation_rows_per_chunk(columns.length);
        for (let row = start; row < end;) {
            this.assert_async_active(lifecycle_epoch, is_cancelled);
            const count = Math.min(rows_per_chunk, end - row);
            const raw_rows = await this.decode_columns_async(
                row,
                count,
                columns,
                lifecycle_epoch,
                is_cancelled,
            );
            const decoded = await this.resolve_columns_async(
                raw_rows,
                row,
                columns,
                lifecycle_epoch,
                is_cancelled,
                request_memo,
            );
            this.assert_async_active(lifecycle_epoch, is_cancelled);
            rows.push(...decoded.map((values) => values.map((cell) =>
                this.canonicalize_stata_raw(cell),
            )));
            row += count;
            const scheduled = this.schedule_source_work(
                'observationCells',
                count * columns.length,
            );
            if (scheduled !== undefined) {
                await scheduled;
                this.assert_async_active(lifecycle_epoch, is_cancelled);
            }
        }
        return rows;
    }

    private decoded_window(
        start: number,
        count: number,
        columns: readonly number[],
        prefetched_gsos?: ReadonlyMap<string, GsoBatchTarget>,
        request_memo: GsoRequestMemo = new Map(),
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
            prefetched_gsos,
            request_memo,
        );
        const rows: RenderedCell[][] = raw_rows.map(() => []);
        columns.forEach((column, index) => {
            const variable = this.metadata.variables[column];
            const labels = variable.value_label_name
                ? this.value_labels(variable.value_label_name)
                : undefined;
            raw_rows.forEach((row, row_index) => {
                rows[row_index].push(this.render_cell(row[index], variable, labels));
            });
        });
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

    private async_observation_rows_per_chunk(column_count: number): number {
        return Math.max(
            1,
            Math.floor(OBSERVATION_CELLS_PER_YIELD / Math.max(1, column_count)),
        );
    }

    private async decode_columns_async(
        start: number,
        count: number,
        columns: readonly number[],
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<Row[]> {
        if (columns.length === 0) return Array.from({ length: count }, () => []);
        const rows: Row[] = Array.from({ length: count }, () => []);
        const columns_per_read = Math.max(
            1,
            Math.floor(OBSERVATION_CELLS_PER_YIELD / Math.max(1, count)),
        );
        let position = 0;
        while (position < columns.length) {
            this.assert_async_active(lifecycle_epoch, is_cancelled);
            const first = columns[position];
            let length = 1;
            while (
                length < columns_per_read
                && position + length < columns.length
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
            const scheduled = this.schedule_source_work(
                'observationCells',
                count * length,
            );
            if (scheduled !== undefined) {
                await scheduled;
                this.assert_async_active(lifecycle_epoch, is_cancelled);
            }
        }
        return rows;
    }

    private render_cell(
        resolved: ResolvedStataCell,
        variable: VariableInfo,
        labels: ReadonlyMap<number, string> | undefined,
    ): RenderedCell {
        return this.render_raw_cell(
            this.canonicalize_stata_raw(resolved),
            variable,
            labels,
        );
    }

    private render_raw_cell(
        raw_cell: RawCell,
        variable: VariableInfo,
        labels: ReadonlyMap<number, string> | undefined,
    ): RenderedCell {
        const raw = raw_cell.raw ?? '';
        if (raw_cell.rawType !== 'number') return rendered_stata_cell(raw_cell, raw);
        const label = labels === undefined ? undefined : stata_value_label(labels, raw);
        if (STATA_MISSING_LABEL_KEY_BY_TYPE.has(raw)) {
            return rendered_stata_cell(raw_cell, label ?? raw);
        }
        return rendered_stata_cell(
            raw_cell,
            label
                ?? apply_display_format(Number(raw), variable.format)
                ?? raw,
        );
    }

    private resolve_columns(
        rows: Row[],
        start: number,
        columns: readonly number[],
        prefetched_gsos?: ReadonlyMap<string, GsoBatchTarget>,
        request_memo: GsoRequestMemo = new Map(),
    ): ResolvedStataCell[][] {
        const batch = this.collect_strl_batch(
            start,
            rows.length,
            columns,
            prefetched_gsos,
            undefined,
            request_memo,
        );
        if (batch.targets.size > 0) this.resolve_gso_batch(batch.targets, request_memo);
        return this.materialize_resolved_columns(
            rows,
            start,
            columns,
            batch.cells,
            request_memo,
        );
    }

    private async resolve_columns_async(
        rows: Row[],
        start: number,
        columns: readonly number[],
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
        request_memo: GsoRequestMemo = new Map(),
    ): Promise<ResolvedStataCell[][]> {
        this.assert_lifecycle_epoch(lifecycle_epoch);
        const batch = this.collect_strl_batch(
            start,
            rows.length,
            columns,
            undefined,
            undefined,
            request_memo,
        );
        if (batch.targets.size > 0) {
            await this.resolve_gso_batch_async(
                batch.targets,
                lifecycle_epoch,
                is_cancelled,
                request_memo,
            );
            this.assert_async_active(lifecycle_epoch, is_cancelled);
        }
        return this.materialize_resolved_columns_async(
            rows,
            start,
            columns,
            batch.cells,
            request_memo,
            lifecycle_epoch,
            is_cancelled,
        );
    }

    private materialize_resolved_columns(
        rows: Row[],
        start: number,
        columns: readonly number[],
        resolved_strls: readonly StrlBatchCell[],
        request_memo: GsoRequestMemo,
    ): ResolvedStataCell[][] {
        if (resolved_strls.length === 0) return rows;
        return rows.map((row, row_offset) => row.map((cell, index) =>
            this.resolve_cell(
                cell,
                this.metadata.variables[columns[index]],
                start + row_offset,
                resolved_strls[row_offset * columns.length + index],
                request_memo,
            )));
    }

    private async materialize_resolved_columns_async(
        rows: Row[],
        start: number,
        columns: readonly number[],
        resolved_strls: readonly StrlBatchCell[],
        request_memo: GsoRequestMemo,
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<ResolvedStataCell[][]> {
        if (resolved_strls.length === 0) return rows;
        const resolved_rows: ResolvedStataCell[][] = [];
        for (let row_offset = 0; row_offset < rows.length; row_offset++) {
            const row = rows[row_offset];
            const resolved_row: ResolvedStataCell[] = [];
            for (let index = 0; index < row.length; index++) {
                const variable = this.metadata.variables[columns[index]];
                const strl_cell = resolved_strls[row_offset * columns.length + index];
                if (variable.type === 'strL' && is_gso_batch_target(strl_cell)) {
                    const resolved = await this.materialize_gso_target_async(
                        strl_cell,
                        request_memo,
                        lifecycle_epoch,
                        is_cancelled,
                    );
                    if (resolved === undefined) {
                        throw new Error(
                            `Stata strL cell at row ${start + row_offset} has a dangling reference`,
                        );
                    }
                    resolved_row.push(resolved);
                } else {
                    resolved_row.push(this.resolve_cell(
                        row[index],
                        variable,
                        start + row_offset,
                        strl_cell,
                        request_memo,
                    ));
                }
            }
            resolved_rows.push(resolved_row);
        }
        return resolved_rows;
    }

    private resolve_cell(
        cell: RowCell,
        variable: VariableInfo,
        row: number,
        strl_cell: StrlBatchCell,
        request_memo: GsoRequestMemo,
    ): ResolvedStataCell {
        if (variable.type === 'strL') {
            const resolved = is_gso_batch_target(strl_cell)
                ? this.materialize_gso_target(strl_cell, request_memo)
                : strl_cell;
            if (resolved === undefined) {
                throw new Error(`Stata strL cell at row ${row} has a dangling reference`);
            }
            return resolved;
        }
        return cell;
    }

    private materialize_gso_target(
        target: GsoBatchTarget,
        request_memo: GsoRequestMemo,
    ): DecodedGso | undefined {
        const { key } = target;
        const memoized = request_memo.get(key);
        if (memoized !== undefined) return memoized;
        const cached = this.touch_decoded_gso(key);
        if (cached !== undefined) {
            request_memo.set(key, cached);
            return cached;
        }
        const entry = target.entry ?? this.touch_gso_entry(key);
        if (entry === undefined) return undefined;
        const decoded = this.decode_and_cache_gso(key, this.open_bytes(), entry);
        request_memo.set(key, decoded);
        return decoded;
    }

    private async materialize_gso_target_async(
        target: GsoBatchTarget,
        request_memo: GsoRequestMemo,
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<DecodedGso | undefined> {
        const { key } = target;
        const memoized = request_memo.get(key);
        if (memoized !== undefined) return memoized;
        const cached = this.touch_decoded_gso(key);
        if (cached !== undefined) {
            request_memo.set(key, cached);
            return cached;
        }
        const entry = target.entry ?? this.touch_gso_entry(key);
        if (entry === undefined) return undefined;
        const decoded = await this.decode_and_cache_gso_async(
            key,
            entry,
            lifecycle_epoch,
            is_cancelled,
        );
        request_memo.set(key, decoded);
        return decoded;
    }

    private resolve_indexed_gso_targets(
        rows: readonly number[],
        request_memo: GsoRequestMemo = new Map(),
    ): ReadonlyMap<string, GsoBatchTarget> {
        const view = this.open_view();
        const targets = new Map<string, GsoBatchTarget>();
        for (const row of rows) {
            const row_base = this.data_start + row * this.metadata.obs_length;
            for (const variable of this.strl_variables) {
                const pointer = read_strl_cell_pointer(
                    view,
                    this.metadata,
                    row_base + variable.byte_offset,
                );
                if (pointer === null) continue;
                validate_gso_identifier(pointer.v, pointer.o, this.metadata, 'strL pointer');
                const key = gso_key(pointer.v, pointer.o);
                if (!targets.has(key)) {
                    targets.set(key, {
                        kind: 'gso-target',
                        key,
                        observation: pointer.o,
                        variable: pointer.v,
                    });
                }
            }
        }
        const unresolved = new Map(targets);
        this.resolve_cached_gso_targets(unresolved, request_memo);
        if (unresolved.size > 0) this.resolve_gso_batch(unresolved, request_memo);
        return targets;
    }

    private collect_strl_batch(
        start: number,
        count: number,
        columns: readonly number[],
        prefetched_gsos?: ReadonlyMap<string, GsoBatchTarget>,
        target_catalog?: Map<string, GsoBatchTarget>,
        request_memo: GsoRequestMemo = new Map(),
    ): CollectedStrlBatch {
        const strl_columns: Array<{ index: number; variable: VariableInfo }> = [];
        columns.forEach((column, index) => {
            const variable = this.metadata.variables[column];
            if (variable.type === 'strL') strl_columns.push({ index, variable });
        });
        if (strl_columns.length === 0) {
            return { cells: [], targets: new Map() };
        }

        const view = this.open_view();
        const cells = new Array<StrlBatchCell>(count * columns.length);
        const targets = target_catalog ?? new Map<string, GsoBatchTarget>();
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
                const prefetched = prefetched_gsos?.get(key);
                let target = prefetched ?? targets.get(key);
                if (target === undefined) {
                    target = {
                        kind: 'gso-target',
                        key,
                        observation: pointer.o,
                        variable: pointer.v,
                    };
                    targets.set(key, target);
                }
                cells[cell_index] = target;
            }
        }
        if (target_catalog === undefined) {
            this.resolve_cached_gso_targets(targets, request_memo);
        }
        return { cells, targets };
    }

    private create_gso_resolution_state(): GsoResolutionState {
        return {
            phase: 'cache',
            historicalTargets: [],
            historicalTargetIndex: 0,
        };
    }

    private begin_historical_gso_phase(
        state: GsoResolutionState,
        targets: ReadonlyMap<string, GsoBatchTarget>,
    ): void {
        state.historicalTargets = [...targets.values()]
            .filter((target) => this.has_seen_gso(target));
        state.historicalTargetIndex = 0;
        state.phase = state.historicalTargets.length > 0
            ? 'historical'
            : 'forward';
    }

    /** One shared physical transition used by both synchronous and asynchronous
     * GSO drivers. It records locations only; payload decode happens later while
     * materializing through a request-scoped memo. */
    private transition_gso_resolution(
        targets: Map<string, GsoBatchTarget>,
        state: GsoResolutionState,
        request_memo: GsoRequestMemo,
        lifecycle_epoch?: number,
    ): GsoTransitionResult {
        if (lifecycle_epoch !== undefined) this.assert_lifecycle_epoch(lifecycle_epoch);
        if (targets.size === 0) {
            state.phase = 'done';
            return { physicalWork: false };
        }
        if (state.phase === 'cache') {
            this.resolve_cached_gso_targets(targets, request_memo);
            if (targets.size === 0) {
                state.phase = 'done';
                return { physicalWork: false };
            }
            this.begin_historical_gso_phase(state, targets);
            return { physicalWork: false };
        }
        if (state.phase === 'historical') {
            const target = state.historicalTargets[state.historicalTargetIndex++];
            if (target === undefined) {
                state.phase = 'forward';
                return { physicalWork: false };
            }
            if (!targets.has(target.key)) return { physicalWork: false };
            const position = this.gso_location(target);
            if (position === undefined) {
                throw new Error('Corrupt .dta file: remembered strL location is missing');
            }
            const scanned = this.read_gso_at(
                this.open_bytes(),
                this.open_view(),
                position,
            );
            if (scanned === null || scanned.key !== target.key) {
                throw new Error('Corrupt .dta file: remembered strL location is invalid');
            }
            this.cache_gso_entry(scanned.key, scanned.value);
            target.entry = scanned.value;
            targets.delete(scanned.key);
            return { physicalWork: true };
        }
        if (state.phase === 'forward') {
            const section_end = gso_section_end(this.metadata);
            if (this.gso_scan_exhausted || this.gso_scan_position >= section_end) {
                state.phase = 'done';
                return { physicalWork: false };
            }
            const scanned = this.scan_next_gso(
                this.open_bytes(),
                this.open_view(),
                lifecycle_epoch,
            );
            if (scanned === null) {
                state.phase = 'done';
                return { physicalWork: false };
            }
            const target = targets.get(scanned.key);
            if (target !== undefined) {
                target.entry = scanned.value;
                targets.delete(scanned.key);
            }
            return { physicalWork: true };
        }
        return { physicalWork: false };
    }

    private resolve_gso_batch(
        targets: Map<string, GsoBatchTarget>,
        request_memo: GsoRequestMemo,
    ): void {
        const state = this.create_gso_resolution_state();
        while (state.phase !== 'done') {
            this.transition_gso_resolution(targets, state, request_memo);
        }
    }

    private async resolve_gso_batch_async(
        targets: Map<string, GsoBatchTarget>,
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
        request_memo: GsoRequestMemo,
    ): Promise<void> {
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        let state = this.create_gso_resolution_state();
        while (state.phase !== 'done') {
            const transition = this.transition_gso_resolution(
                targets,
                state,
                request_memo,
                lifecycle_epoch,
            );
            if (!transition.physicalWork) continue;
            const scheduled = this.schedule_source_work('gsoHeaders', 1);
            if (scheduled === undefined) continue;
            const forward_position = this.gso_scan_position;
            await scheduled;
            this.assert_async_active(lifecycle_epoch, is_cancelled);
            if (forward_position === this.gso_scan_position) continue;
            this.resolve_cached_gso_targets(targets, request_memo);
            if (targets.size === 0) return;
            // A concurrent synchronous/async reader may have advanced the shared
            // forward cursor past one of our targets while this request yielded.
            if (this.count_seen_gso_targets(targets) > 0) {
                state = this.create_gso_resolution_state();
            }
        }
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
        this.remember_gso(scanned);
        this.gso_scan_position = scanned.nextPosition;
        if (this.gso_scan_position >= gso_section_end(this.metadata)) {
            this.gso_scan_exhausted = true;
        }
        return scanned;
    }

    private read_gso_at(
        bytes: Uint8Array,
        view: DataView,
        start: number,
    ): ScannedGso | null {
        const section_end = gso_section_end(this.metadata);
        const header_width = this.metadata.format_version === 117 ? 16 : 20;
        let position = start;
        if (
            position + 3 > section_end
            || bytes[position] !== 0x47
            || bytes[position + 1] !== 0x53
            || bytes[position + 2] !== 0x4f
        ) return null;
        if (position + header_width > section_end) {
            throw new Error('Corrupt .dta file: strL object header is truncated');
        }
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
            startPosition: start,
            value: { content_offset: position, content_length, type },
            nextPosition: content_end,
        };
    }

    private remember_gso(scanned: ScannedGso): void {
        let seen = this.gso_seen_identifiers;
        if (seen === undefined) {
            seen = new Uint8Array(Math.ceil(this.metadata.nobs * this.gso_variable_count / 8));
            this.gso_seen_identifiers = seen;
        }
        const bit_index = this.gso_identifier_bit_index(scanned);
        const byte_index = bit_index >> 3;
        const mask = 1 << (bit_index & 7);
        if ((seen[byte_index] & mask) !== 0) {
            throw new Error(
                `Corrupt .dta file: duplicate strL object id ${scanned.key}`,
            );
        }
        this.remember_gso_location(bit_index, scanned.startPosition);
        seen[byte_index] |= mask;
        this.cache_gso_entry(scanned.key, scanned.value);
    }

    private remember_gso_location(bit_index: number, position: number): void {
        const page_index = Math.floor(bit_index / GSO_LOCATION_PAGE_ENTRIES);
        const identifier_offset = bit_index % GSO_LOCATION_PAGE_ENTRIES;
        let page = this.gso_locations.get(page_index);
        if (page === undefined) {
            page = {
                identifierOffsets: Uint8Array.of(identifier_offset),
                positions: Uint32Array.of(position),
                count: 1,
            };
            this.gso_locations.set(page_index, page);
            return;
        }
        if (page.count === page.positions.length) {
            const capacity = Math.min(
                GSO_LOCATION_PAGE_ENTRIES,
                page.count * 2,
            );
            const identifier_offsets = new Uint8Array(capacity);
            identifier_offsets.set(page.identifierOffsets);
            const positions = new Uint32Array(capacity);
            positions.set(page.positions);
            page.identifierOffsets = identifier_offsets;
            page.positions = positions;
        }
        page.identifierOffsets[page.count] = identifier_offset;
        page.positions[page.count] = position;
        page.count += 1;
    }

    private gso_location(identifier: GsoIdentifier): number | undefined {
        const bit_index = this.gso_identifier_bit_index(identifier);
        const page = this.gso_locations.get(
            Math.floor(bit_index / GSO_LOCATION_PAGE_ENTRIES),
        );
        if (page === undefined) return undefined;
        const identifier_offset = bit_index % GSO_LOCATION_PAGE_ENTRIES;
        for (let index = 0; index < page.count; index++) {
            if (page.identifierOffsets[index] === identifier_offset) {
                return page.positions[index];
            }
        }
        return undefined;
    }

    private gso_identifier_bit_index(identifier: GsoIdentifier): number {
        return (identifier.observation - 1) * this.gso_variable_count
            + this.gso_variable_ordinals[identifier.variable] - 1;
    }

    private has_seen_gso(identifier: GsoIdentifier): boolean {
        const seen = this.gso_seen_identifiers;
        if (seen === undefined) return false;
        const bit_index = this.gso_identifier_bit_index(identifier);
        return (seen[bit_index >> 3] & (1 << (bit_index & 7))) !== 0;
    }

    private count_seen_gso_targets(targets: ReadonlyMap<string, GsoBatchTarget>): number {
        let count = 0;
        for (const target of targets.values()) {
            if (this.has_seen_gso(target)) count += 1;
        }
        return count;
    }

    private cache_gso_entry(key: string, entry: GsoEntry): void {
        this.gso_index.delete(key);
        this.gso_index.set(key, entry);
        if (this.gso_index.size > MAX_GSO_INDEX_ENTRIES) {
            this.gso_index.delete(this.gso_index.keys().next().value!);
        }
    }

    private resolve_cached_gso_targets(
        targets: Map<string, GsoBatchTarget>,
        request_memo: GsoRequestMemo,
    ): void {
        for (const [key, target] of targets) {
            const decoded = this.touch_decoded_gso(key);
            if (decoded !== undefined) {
                request_memo.set(key, decoded);
                targets.delete(key);
                continue;
            }
            const entry = this.touch_gso_entry(key);
            if (entry === undefined) continue;
            target.entry = entry;
            targets.delete(key);
        }
    }

    private touch_decoded_gso(key: string): DecodedGso | undefined {
        return touch_lru(this.gso_cache, key);
    }

    private touch_gso_entry(key: string): GsoEntry | undefined {
        const entry = this.gso_index.get(key);
        if (entry === undefined) return undefined;
        this.cache_gso_entry(key, entry);
        return entry;
    }

    private cache_decoded_gso(key: string, decoded: DecodedGso): void {
        this.gso_cache_bytes = cache_byte_bounded_lru({
            entries: this.gso_cache,
            key,
            value: decoded,
            valueBytes: decoded_gso_byte_count(decoded),
            bytesOf: decoded_gso_byte_count,
            currentBytes: this.gso_cache_bytes,
            entryLimit: MAX_GSO_CACHE_ENTRIES,
            byteLimit: MAX_GSO_CACHE_BYTES,
        });
    }

    private decode_and_cache_gso(
        key: string,
        bytes: Uint8Array,
        entry: GsoEntry,
    ): DecodedGso {
        const decoded = this.decode_gso(bytes, entry);
        this.cache_decoded_gso(key, decoded);
        return decoded;
    }

    private async decode_and_cache_gso_async(
        key: string,
        entry: GsoEntry,
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<DecodedGso> {
        const decoded = await this.decode_gso_async(
            entry,
            lifecycle_epoch,
            is_cancelled,
        );
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        this.cache_decoded_gso(key, decoded);
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
        return decode_gso_entry(bytes, entry, this.text_encoding);
    }

    private async decode_gso_async(
        entry: GsoEntry,
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<DecodedGso> {
        if (entry.type === 129) return encode_binary_gso(this.open_bytes(), entry);
        if (entry.content_length > this.text_gso_decode_byte_limit) {
            throw new Error(
                `Stata text strL payload is too large to decode safely `
                + `(max ${this.text_gso_decode_byte_limit} bytes)`,
            );
        }
        if (entry.type !== 130) return this.decode_gso(this.open_bytes(), entry);
        const text_end = validated_gso_text_end(this.open_bytes(), entry);
        const chunk_bytes = this.payload_work_chunk_bytes();
        if (entry.content_length <= chunk_bytes) {
            await this.reserve_source_payload_work(
                Math.max(1, entry.content_length),
                lifecycle_epoch,
                is_cancelled,
            );
            const decoded = this.decode_gso(this.open_bytes(), entry);
            this.assert_async_active(lifecycle_epoch, is_cancelled);
            return decoded;
        }

        const stream = this.text_decoder.stream();
        const decoded: string[] = [];
        for (let position = entry.content_offset; position < text_end;) {
            const count = Math.min(chunk_bytes, text_end - position);
            await this.reserve_source_payload_work(count, lifecycle_epoch, is_cancelled);
            decoded.push(stream.decode(this.open_bytes().subarray(position, position + count)));
            position += count;
            this.assert_async_active(lifecycle_epoch, is_cancelled);
        }
        decoded.push(stream.finish());
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        return decoded.join('');
    }

    /** @internal Used only by the module-private DtaBinaryIdentity capability. */
    cached_binary_comparison_key(binary: BinaryGso): string | undefined {
        return touch_lru(this.gso_digest_cache, binary.contentOffset);
    }

    private cache_binary_comparison_key(binary: BinaryGso, key: string): void {
        this.gso_digest_cache_bytes = cache_byte_bounded_lru({
            entries: this.gso_digest_cache,
            key: binary.contentOffset,
            value: key,
            valueBytes: key.length * 2,
            bytesOf: (value) => value.length * 2,
            currentBytes: this.gso_digest_cache_bytes,
            entryLimit: this.gso_digest_cache_entry_limit,
            byteLimit: this.gso_digest_cache_byte_limit,
        });
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

    /** One source-owned macrotask gate shared by GSO headers, observation cells,
     * value-label work, and binary/payload bytes. It is deliberately not a mutex. */
    private yield_source_work(): Promise<void> {
        const existing = this.source_work_yield;
        if (existing !== undefined) return existing;
        const yielding = yield_to_event_loop();
        this.source_work_gso_headers = 0;
        this.source_work_observation_cells = 0;
        this.source_work_value_labels = 0;
        this.source_work_payload_bytes = 0;
        this.source_work_payload_jobs = 0;
        this.source_work_yield = yielding;
        void yielding.then(() => {
            if (this.source_work_yield === yielding) this.source_work_yield = undefined;
        });
        return yielding;
    }

    /** Account work that has just completed and yield when its bounded turn is
     * exhausted. Concurrent workloads share the same pending macrotask. */
    private schedule_source_work(
        kind: SourceWorkKind,
        amount: number,
    ): Promise<void> | undefined {
        let exhausted = false;
        if (kind === 'gsoHeaders') {
            this.source_work_gso_headers += amount;
            exhausted = this.source_work_gso_headers >= GSO_SCAN_ENTRIES_PER_YIELD;
        } else if (kind === 'observationCells') {
            this.source_work_observation_cells += amount;
            exhausted = this.source_work_observation_cells >= OBSERVATION_CELLS_PER_YIELD;
        } else if (kind === 'valueLabels') {
            this.source_work_value_labels += amount;
            exhausted = this.source_work_value_labels >= VALUE_LABEL_ENTRIES_PER_YIELD;
        } else {
            this.source_work_payload_bytes += amount;
            exhausted = this.source_work_payload_bytes
                >= Math.max(1, this.binary_identity_work_byte_limit);
        }
        const pending = this.source_work_yield;
        if (pending !== undefined) return pending;
        return exhausted ? this.yield_source_work() : undefined;
    }

    private payload_work_chunk_bytes(): number {
        return Math.max(1, Math.min(
            this.binary_identity_chunk_bytes,
            this.binary_identity_work_byte_limit,
        ));
    }

    private async reserve_source_payload_work(
        byte_count: number,
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<void> {
        while (true) {
            this.assert_async_active(lifecycle_epoch, is_cancelled);
            const scheduled = this.reserve_payload_work(byte_count, false);
            if (scheduled === undefined) return;
            await scheduled;
        }
    }

    /** Reserve payload work before hashing it so a burst of jobs cannot all begin
     * before the shared gate is observed. */
    private reserve_payload_work(
        byte_count: number,
        starts_job: boolean,
    ): Promise<void> | undefined {
        if (this.source_work_yield !== undefined) return this.source_work_yield;
        const byte_limit = Math.max(1, this.binary_identity_work_byte_limit);
        const job_limit = Math.max(1, this.binary_identity_work_job_limit);
        if (
            (this.source_work_payload_bytes > 0
                && byte_count > byte_limit - this.source_work_payload_bytes)
            || (starts_job && this.source_work_payload_jobs >= job_limit)
        ) return this.yield_source_work();
        this.source_work_payload_bytes += byte_count;
        if (starts_job) this.source_work_payload_jobs += 1;
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
                const scheduled = this.reserve_payload_work(count, hash === undefined);
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
                    await this.yield_source_work();
                }
            }

            this.reject_cancelled_binary_waiters(job);
            if (job.waiters.size === 0) {
                this.pending_binary_identities.delete(job.binary.contentOffset);
                return;
            }
            while (hash === undefined) {
                const scheduled = this.reserve_payload_work(0, true);
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
            const scheduled = this.schedule_source_work('payloadBytes', count);
            if (scheduled !== undefined) await scheduled;
            else if (compared < binary.contentLength) await this.yield_source_work();
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
        return touch_lru(this.decoded_value_label_tables, name)?.labels;
    }

    private cache_value_label_table(name: string, table: DecodedValueLabelTable): void {
        this.decoded_value_label_cache_bytes = cache_byte_bounded_lru({
            entries: this.decoded_value_label_tables,
            key: name,
            value: table,
            valueBytes: table.cacheBytes,
            bytesOf: (value) => value.cacheBytes,
            currentBytes: this.decoded_value_label_cache_bytes,
            entryLimit: this.value_label_cache_entry_limit,
            byteLimit: this.value_label_cache_byte_limit,
        });
    }

    private legacy_value_label_last_nonzero(): number | undefined {
        const probe = this.legacy_value_label_terminal_probe;
        if (probe === undefined) return undefined;
        if (probe.result !== undefined) return probe.result;
        const bytes = this.open_bytes();
        while (probe.position > probe.start) {
            probe.position -= 1;
            if (bytes[probe.position] !== 0) {
                probe.result = probe.position;
                return probe.result;
            }
        }
        probe.result = probe.start - 1;
        return probe.result;
    }

    private async legacy_value_label_last_nonzero_async(
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<number | undefined> {
        const probe = this.legacy_value_label_terminal_probe;
        if (probe === undefined) return undefined;
        while (probe.result === undefined) {
            this.assert_async_active(lifecycle_epoch, is_cancelled);
            const bytes = this.open_bytes();
            const stop = Math.max(probe.start, probe.position - LEGACY_VALUE_LABEL_BYTES_PER_YIELD);
            while (probe.position > stop) {
                probe.position -= 1;
                if (bytes[probe.position] !== 0) {
                    probe.result = probe.position;
                    break;
                }
            }
            if (probe.result !== undefined) break;
            if (probe.position <= probe.start) {
                probe.result = probe.start - 1;
                break;
            }
            const scheduled = this.schedule_source_work(
                'payloadBytes',
                LEGACY_VALUE_LABEL_BYTES_PER_YIELD,
            );
            await (scheduled ?? this.yield_source_work());
        }
        this.assert_async_active(lifecycle_epoch, is_cancelled);
        return probe.result;
    }

    private publish_completed_value_label_discovery(): void {
        this.value_label_discovery_complete = true;
        for (const referenced of this.referenced_value_label_names) {
            if (!this.value_label_descriptors.has(referenced)) {
                this.missing_value_label_table_names.add(referenced);
            }
        }
    }

    private discover_value_label_descriptor(name: string): ValueLabelTableEntry | undefined {
        if (!this.referenced_value_label_names.has(name)) return undefined;
        const existing = this.value_label_descriptors.get(name);
        if (existing !== undefined || this.value_label_discovery_complete) return existing;
        const buffer = this.open_buffer();
        const bytes = this.open_bytes();
        const legacy_last_nonzero = this.legacy_value_label_last_nonzero();
        const layout = this.value_label_layout
            ??= value_label_section_layout(buffer, this.metadata, legacy_last_nonzero);
        while (!this.value_label_discovery_complete) {
            if (value_label_section_terminal(
                bytes,
                this.metadata,
                this.value_label_discovery_position,
                this.value_label_section_end,
                legacy_last_nonzero,
            )) {
                this.publish_completed_value_label_discovery();
                break;
            }
            const scanned = scan_value_label_table_at(
                buffer,
                this.metadata,
                this.value_label_discovery_position,
                layout,
                this.text_decoder,
            );
            if (scanned === null) {
                throw new Error('Corrupt value label table: invalid section terminal');
            }
            this.value_label_discovery_position = advance_value_label_table_position(
                buffer,
                this.metadata,
                scanned.entryEndPosition,
                this.value_label_section_end,
            );
            if (
                this.referenced_value_label_names.has(scanned.entry.name)
                && !this.value_label_descriptors.has(scanned.entry.name)
            ) this.value_label_descriptors.set(scanned.entry.name, scanned.entry);
            const descriptor = this.value_label_descriptors.get(name);
            if (descriptor !== undefined && is_legacy_format(this.metadata.format_version)) {
                return descriptor;
            }
        }
        return this.value_label_descriptors.get(name);
    }

    private async discover_value_label_descriptor_async(
        name: string,
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<ValueLabelTableEntry | undefined> {
        if (!this.referenced_value_label_names.has(name)) return undefined;
        const existing = this.value_label_descriptors.get(name);
        if (existing !== undefined || this.value_label_discovery_complete) return existing;
        const assert_active = () => this.assert_async_active(lifecycle_epoch, is_cancelled);
        assert_active();
        const legacy_last_nonzero = await this.legacy_value_label_last_nonzero_async(
            lifecycle_epoch,
            is_cancelled,
        );
        if (this.value_label_layout === undefined) {
            this.value_label_layout = await value_label_section_layout_async(
                () => this.open_buffer(),
                this.metadata,
                legacy_last_nonzero,
                async () => {
                    const scheduled = this.schedule_source_work('valueLabels', 1);
                    if (scheduled !== undefined) await scheduled;
                    assert_active();
                },
            );
            assert_active();
        }
        while (!this.value_label_discovery_complete) {
            assert_active();
            const buffer = this.open_buffer();
            const bytes = this.open_bytes();
            if (value_label_section_terminal(
                bytes,
                this.metadata,
                this.value_label_discovery_position,
                this.value_label_section_end,
                legacy_last_nonzero,
            )) {
                this.publish_completed_value_label_discovery();
                break;
            }
            const scanned = scan_value_label_table_at(
                buffer,
                this.metadata,
                this.value_label_discovery_position,
                this.value_label_layout,
                this.text_decoder,
            );
            if (scanned === null) {
                throw new Error('Corrupt value label table: invalid section terminal');
            }
            this.value_label_discovery_position = advance_value_label_table_position(
                buffer,
                this.metadata,
                scanned.entryEndPosition,
                this.value_label_section_end,
            );
            if (
                this.referenced_value_label_names.has(scanned.entry.name)
                && !this.value_label_descriptors.has(scanned.entry.name)
            ) this.value_label_descriptors.set(scanned.entry.name, scanned.entry);
            const scheduled = this.schedule_source_work('valueLabels', 1);
            if (scheduled !== undefined) {
                await scheduled;
                assert_active();
            }
            const descriptor = this.value_label_descriptors.get(name);
            if (descriptor !== undefined && is_legacy_format(this.metadata.format_version)) {
                return descriptor;
            }
        }
        return this.value_label_descriptors.get(name);
    }

    private value_labels(name: string): Map<number, string> | undefined {
        const cached = this.cached_value_labels(name);
        if (cached !== undefined) return cached;
        if (this.missing_value_label_table_names.has(name)) return undefined;
        const descriptor = this.discover_value_label_descriptor(name);
        if (descriptor === undefined) return undefined;
        const table = decode_value_label_table(
            this.open_buffer(),
            this.metadata,
            descriptor,
            this.text_decoder,
            this.value_label_table_entry_limit,
            this.value_label_table_decoded_byte_limit,
        );
        this.cache_value_label_table(name, table);
        return table.labels;
    }

    private reject_cancelled_value_label_waiters(job: PendingValueLabelTable): void {
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

    /** Poll queued cancellation through one bounded round-robin monitor, rather
     * than one timer loop per table or an unbounded full-queue sweep per turn. */
    private ensure_value_label_queue_monitor(): void {
        if (this.value_label_queue_monitor !== undefined) return;
        const monitor = (async () => {
            while (this.queued_value_label_tables.size > 0) {
                const checks = Math.min(
                    VALUE_LABEL_QUEUE_CHECKS_PER_YIELD,
                    this.queued_value_label_tables.size,
                );
                for (let index = 0; index < checks; index++) {
                    const job = this.queued_value_label_tables.values().next().value!;
                    this.queued_value_label_tables.delete(job);
                    this.reject_cancelled_value_label_waiters(job);
                    if (job.waiters.size > 0) {
                        this.queued_value_label_tables.add(job);
                    } else if (this.pending_value_label_tables.get(job.name) === job) {
                        this.pending_value_label_tables.delete(job.name);
                    }
                }
                if (this.queued_value_label_tables.size > 0) {
                    await yield_to_event_loop();
                }
            }
        })();
        this.value_label_queue_monitor = monitor.finally(() => {
            this.value_label_queue_monitor = undefined;
            if (this.queued_value_label_tables.size > 0) {
                this.ensure_value_label_queue_monitor();
            }
        });
    }

    private async run_value_label_table_job(job: PendingValueLabelTable): Promise<void> {
        const assert_active = (): void => {
            this.assert_lifecycle_epoch(job.epoch);
            this.reject_cancelled_value_label_waiters(job);
            if (job.waiters.size === 0) throw source_abort_error();
        };
        const all_cancelled = (): boolean => {
            assert_active();
            return false;
        };
        try {
            assert_active();
            const cached = this.cached_value_labels(job.name);
            if (cached !== undefined) {
                this.pending_value_label_tables.delete(job.name);
                for (const waiter of job.waiters) waiter.resolve(cached);
                job.waiters.clear();
                return;
            }
            if (this.missing_value_label_table_names.has(job.name)) {
                this.pending_value_label_tables.delete(job.name);
                for (const waiter of job.waiters) waiter.resolve(undefined);
                job.waiters.clear();
                return;
            }
            const descriptor = await this.discover_value_label_descriptor_async(
                job.name,
                job.epoch,
                all_cancelled,
            );
            assert_active();
            if (descriptor === undefined) {
                this.pending_value_label_tables.delete(job.name);
                for (const waiter of job.waiters) waiter.resolve(undefined);
                job.waiters.clear();
                return;
            }
            const table = await decode_value_label_table_async(
                () => this.open_buffer(),
                this.metadata,
                descriptor,
                this.text_decoder,
                this.value_label_table_entry_limit,
                this.value_label_table_decoded_byte_limit,
                () => this.assert_lifecycle_epoch(job.epoch),
                assert_active,
                async (work) => {
                    const scheduled = this.schedule_source_work('valueLabels', work);
                    if (scheduled !== undefined) await scheduled;
                    assert_active();
                },
                async (work) => {
                    const scheduled = this.schedule_source_work('payloadBytes', work);
                    if (scheduled !== undefined) await scheduled;
                    assert_active();
                },
            );
            assert_active();
            this.cache_value_label_table(job.name, table);
            this.pending_value_label_tables.delete(job.name);
            for (const waiter of job.waiters) waiter.resolve(table.labels);
            job.waiters.clear();
        } catch (error) {
            if (this.pending_value_label_tables.get(job.name) === job) {
                this.pending_value_label_tables.delete(job.name);
            }
            for (const waiter of job.waiters) waiter.reject(error);
            job.waiters.clear();
        }
    }

    private value_labels_async(
        name: string,
        lifecycle_epoch: number,
        is_cancelled: () => boolean,
    ): Promise<Map<number, string> | undefined> {
        try {
            this.assert_async_active(lifecycle_epoch, is_cancelled);
            const cached = this.cached_value_labels(name);
            if (cached !== undefined) return Promise.resolve(cached);
            if (this.missing_value_label_table_names.has(name)) {
                return Promise.resolve(undefined);
            }
        } catch (error) {
            return Promise.reject(error);
        }

        let job = this.pending_value_label_tables.get(name);
        let start_job = false;
        if (job === undefined) {
            job = { name, epoch: lifecycle_epoch, waiters: new Set() };
            this.pending_value_label_tables.set(name, job);
            start_job = true;
        }
        const promise = new Promise<Map<number, string> | undefined>((resolve, reject) => {
            job!.waiters.add({ isCancelled: is_cancelled, resolve, reject });
        });
        if (start_job) {
            const predecessor = this.value_label_decode_tail;
            this.queued_value_label_tables.add(job!);
            this.ensure_value_label_queue_monitor();
            const run = predecessor.then(async () => {
                this.queued_value_label_tables.delete(job!);
                this.assert_lifecycle_epoch(job!.epoch);
                this.reject_cancelled_value_label_waiters(job!);
                if (job!.waiters.size === 0) {
                    if (this.pending_value_label_tables.get(job!.name) === job) {
                        this.pending_value_label_tables.delete(job!.name);
                    }
                    return;
                }
                await this.run_value_label_table_job(job!);
            });
            this.value_label_decode_tail = run.catch(() => undefined);
        }
        return promise;
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

function validated_gso_text_end(bytes: Uint8Array, entry: GsoEntry): number {
    const end = entry.content_offset + entry.content_length;
    if (entry.content_length === 0 || bytes[end - 1] !== 0) {
        throw new Error('Type-130 GSO content is not NUL-terminated');
    }
    return end - 1;
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
    const layout = version === 105
        ? { header: 60, varname: 9, format: 12, valueLabel: 9, variableLabel: 32, length: 2 }
        : version === 108
            ? { header: 109, varname: 9, format: 12, valueLabel: 9, variableLabel: 81, length: 2 }
            : version === 110 || version === 111 || version === 113
                ? { header: 109, varname: 33, format: 12, valueLabel: 33, variableLabel: 81, length: 4 }
                : version === 114 || version === 115
                    ? { header: 109, varname: 33, format: 49, valueLabel: 33, variableLabel: 81, length: 4 }
                    : undefined;
    if (layout === undefined) return;
    if (buffer.byteLength < 10) throw new Error('Corrupt .dta file: legacy header is truncated');
    const little_endian = bytes[1] === 2;
    const view = new DataView(buffer);
    const nvar = view.getUint16(4, little_endian);
    let position = layout.header
        + nvar
        + nvar * layout.varname
        + (nvar + 1) * 2
        + nvar * layout.format
        + nvar * layout.valueLabel
        + nvar * layout.variableLabel;
    const header_width = 1 + layout.length;
    let field_count = 0;
    while (true) {
        if (!Number.isSafeInteger(position) || position + header_width > buffer.byteLength) {
            throw new Error('Corrupt .dta file: expansion fields are truncated');
        }
        const type = view.getUint8(position);
        const length = layout.length === 2
            ? view.getInt16(position + 1, little_endian)
            : view.getInt32(position + 1, little_endian);
        if (type === 0 && length === 0) return;
        if (type === 0 || length < 0) {
            throw new Error('Corrupt .dta file: invalid expansion field');
        }
        const next = position + header_width + length;
        if (!Number.isSafeInteger(next) || next <= position || next > buffer.byteLength) {
            throw new Error('Corrupt .dta file: expansion field is truncated');
        }
        field_count += 1;
        if (field_count > MAX_LEGACY_EXPANSION_FIELDS) {
            throw new Error('Corrupt .dta file: too many expansion fields');
        }
        position = next;
    }
}

/** dta-parser 0.5 fixes release 118's 2+6-byte pointer, but still applies that
 * layout to release 119. Keep the 3+5 override until the upstream helper
 * handles release 119, then delegate every release to read_strl_pointer. */
function read_strl_cell_pointer(
    view: DataView,
    metadata: DtaMetadata,
    pointer_offset: number,
): { v: number; o: number } | null {
    if (metadata.format_version !== 119) {
        return read_strl_pointer(view, metadata, pointer_offset);
    }
    const little_endian = metadata.byte_order === 'LSF';
    const variable = little_endian
        ? view.getUint16(pointer_offset, true)
            + view.getUint8(pointer_offset + 2) * 0x1_0000
        : view.getUint8(pointer_offset) * 0x1_0000
            + view.getUint16(pointer_offset + 1, false);
    const observation = little_endian
        ? view.getUint32(pointer_offset + 3, true)
            + view.getUint8(pointer_offset + 7) * 0x1_0000_0000
        : view.getUint8(pointer_offset + 3) * 0x1_0000_0000
            + view.getUint32(pointer_offset + 4, false);
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
    if (metadata.variables[variable - 1].type !== 'strL') {
        throw new Error(
            `Corrupt .dta file: ${source} variable ${variable} is not strL`,
        );
    }
}

function gso_key(variable: number, observation: number): string {
    return `${variable}:${observation}`;
}

function gso_section_end(metadata: DtaMetadata): number {
    return metadata.section_offsets.value_labels
        - (is_legacy_format(metadata.format_version) ? 0 : STRLS_CLOSE_TAG_LENGTH);
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
    if (!matches_ascii(bytes, gso_section_end(metadata), '</strls>')) {
        throw new Error('Corrupt .dta file: invalid strls closing tag');
    }
}

interface ValueLabelTableEntry {
    readonly name: string;
    readonly tableLength: number;
    readonly payloadStart: number;
    readonly entryEnd: number;
    readonly fixedCount?: number;
    readonly fixedLabelsStart?: number;
}

interface ValueLabelSectionLayout {
    readonly nameWidth: number;
    readonly fixedWidth: boolean;
}

interface ScannedValueLabelTable {
    readonly entry: ValueLabelTableEntry;
    readonly entryEndPosition: number;
}

function value_label_tables_start(metadata: DtaMetadata): number {
    return metadata.section_offsets.value_labels
        + (is_legacy_format(metadata.format_version) ? 0 : VALUE_LABELS_TAG_LENGTH);
}

function value_label_section_terminal(
    bytes: Uint8Array,
    metadata: DtaMetadata,
    position: number,
    modern_section_end: number | undefined,
    legacy_last_nonzero: number | undefined,
): boolean {
    if (is_legacy_format(metadata.format_version)) {
        return legacy_last_nonzero !== undefined && position > legacy_last_nonzero;
    }
    return position === modern_section_end
        && modern_section_end !== undefined
        && matches_ascii(bytes, modern_section_end, '</value_labels>');
}

interface LegacyLabelFramingProbe {
    position: number;
    readonly end: number;
    readonly lastNonzero: number;
    readonly nameWidth: number;
    result?: boolean;
}

function create_legacy_label_framing_probe(
    start: number,
    end: number,
    last_nonzero: number,
    name_width: number,
): LegacyLabelFramingProbe {
    return { position: start, end, lastNonzero: last_nonzero, nameWidth: name_width };
}

/** One release-layout probe transition shared by sync and async drivers. */
function transition_legacy_label_framing_probe(
    view: DataView,
    little_endian: boolean,
    state: LegacyLabelFramingProbe,
): void {
    if (state.result !== undefined) return;
    if (state.position >= state.end || state.position > state.lastNonzero) {
        state.result = true;
        return;
    }
    const prefix_width = 4 + state.nameWidth + LABEL_PADDING_BYTES;
    const payload_start = state.position + prefix_width;
    if (payload_start + 8 > state.end) {
        state.result = false;
        return;
    }
    const table_length = view.getInt32(state.position, little_endian);
    const count = view.getInt32(payload_start, little_endian);
    const text_length = view.getInt32(payload_start + 4, little_endian);
    const payload_length = 8 + count * 8 + text_length;
    if (
        table_length <= 0
        || count < 0
        || text_length < 0
        || !Number.isSafeInteger(payload_length)
        || payload_length !== table_length
        || payload_start + payload_length > state.end
    ) {
        state.result = false;
        return;
    }
    state.position = payload_start + payload_length;
}

function has_legacy_offset_label_framing(
    view: DataView,
    little_endian: boolean,
    start: number,
    end: number,
    last_nonzero: number,
    name_width: number,
): boolean {
    const state = create_legacy_label_framing_probe(
        start,
        end,
        last_nonzero,
        name_width,
    );
    while (state.result === undefined) {
        transition_legacy_label_framing_probe(view, little_endian, state);
    }
    return state.result;
}

async function has_legacy_offset_label_framing_async(
    open_buffer: () => ArrayBuffer,
    little_endian: boolean,
    start: number,
    end: number,
    last_nonzero: number,
    name_width: number,
    after_work: () => Promise<void>,
): Promise<boolean> {
    const state = create_legacy_label_framing_probe(
        start,
        end,
        last_nonzero,
        name_width,
    );
    while (state.result === undefined) {
        transition_legacy_label_framing_probe(
            new DataView(open_buffer()),
            little_endian,
            state,
        );
        if (state.result === undefined) await after_work();
    }
    return state.result;
}

function value_label_section_layout(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    legacy_last_nonzero: number | undefined,
): ValueLabelSectionLayout {
    if (!is_legacy_format(metadata.format_version)) {
        return {
            nameWidth: metadata.format_version >= 118
                ? UNICODE_LABEL_NAME_WIDTH
                : LEGACY_LABEL_NAME_WIDTH,
            fixedWidth: false,
        };
    }
    const view = new DataView(buffer);
    const little_endian = metadata.byte_order === 'LSF';
    const start = value_label_tables_start(metadata);
    const end = metadata.section_offsets.stata_data_close;
    if (legacy_last_nonzero === undefined) {
        throw new Error('Corrupt value label table: missing legacy section terminal');
    }
    if (metadata.format_version === 105) {
        const offset_compatibility = has_legacy_offset_label_framing(
            view,
            little_endian,
            start,
            end,
            legacy_last_nonzero,
            LEGACY_LABEL_NAME_WIDTH,
        );
        return offset_compatibility
            ? { nameWidth: LEGACY_LABEL_NAME_WIDTH, fixedWidth: false }
            : { nameWidth: 9, fixedWidth: true };
    }
    if (metadata.format_version === 108) {
        const standard = has_legacy_offset_label_framing(
            view, little_endian, start, end, legacy_last_nonzero, 9,
        );
        const name_width = standard || !has_legacy_offset_label_framing(
            view,
            little_endian,
            start,
            end,
            legacy_last_nonzero,
            LEGACY_LABEL_NAME_WIDTH,
        ) ? 9 : LEGACY_LABEL_NAME_WIDTH;
        return { nameWidth: name_width, fixedWidth: false };
    }
    return { nameWidth: LEGACY_LABEL_NAME_WIDTH, fixedWidth: false };
}

async function value_label_section_layout_async(
    open_buffer: () => ArrayBuffer,
    metadata: DtaMetadata,
    legacy_last_nonzero: number | undefined,
    after_work: () => Promise<void>,
): Promise<ValueLabelSectionLayout> {
    if (!is_legacy_format(metadata.format_version)) {
        return {
            nameWidth: metadata.format_version >= 118
                ? UNICODE_LABEL_NAME_WIDTH
                : LEGACY_LABEL_NAME_WIDTH,
            fixedWidth: false,
        };
    }
    const little_endian = metadata.byte_order === 'LSF';
    const start = value_label_tables_start(metadata);
    const end = metadata.section_offsets.stata_data_close;
    if (legacy_last_nonzero === undefined) {
        throw new Error('Corrupt value label table: missing legacy section terminal');
    }
    if (metadata.format_version === 105) {
        const offset_compatibility = await has_legacy_offset_label_framing_async(
            open_buffer,
            little_endian,
            start,
            end,
            legacy_last_nonzero,
            LEGACY_LABEL_NAME_WIDTH,
            after_work,
        );
        return offset_compatibility
            ? { nameWidth: LEGACY_LABEL_NAME_WIDTH, fixedWidth: false }
            : { nameWidth: 9, fixedWidth: true };
    }
    if (metadata.format_version === 108) {
        const standard = await has_legacy_offset_label_framing_async(
            open_buffer,
            little_endian,
            start,
            end,
            legacy_last_nonzero,
            9,
            after_work,
        );
        const compatibility = standard ? false : await has_legacy_offset_label_framing_async(
            open_buffer,
            little_endian,
            start,
            end,
            legacy_last_nonzero,
            LEGACY_LABEL_NAME_WIDTH,
            after_work,
        );
        return {
            nameWidth: standard || !compatibility ? 9 : LEGACY_LABEL_NAME_WIDTH,
            fixedWidth: false,
        };
    }
    return { nameWidth: LEGACY_LABEL_NAME_WIDTH, fixedWidth: false };
}

function scan_value_label_table_at(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    position: number,
    layout: ValueLabelSectionLayout,
    text_decoder: SourceTextDecoder,
): ScannedValueLabelTable | null {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const little_endian = metadata.byte_order === 'LSF';
    const legacy = is_legacy_format(metadata.format_version);
    const section_end = metadata.section_offsets.stata_data_close
        - (legacy ? 0 : VALUE_LABELS_CLOSE_TAG_LENGTH);
    if (position >= section_end) return null;

    if (layout.fixedWidth) {
        const header_end = position + 2 + layout.nameWidth + 1;
        if (header_end > section_end) {
            throw new Error('Corrupt value label table: truncated fixed-width header');
        }
        const count = view.getUint16(position, little_endian);
        const name_start = position + 2;
        const name_end = name_start + layout.nameWidth;
        const payload_start = header_end;
        const labels_start = payload_start + count * 2;
        const entry_end = labels_start + count * 8;
        if (!Number.isSafeInteger(entry_end) || entry_end > section_end) {
            throw new Error('Corrupt value label table: truncated fixed-width entry');
        }
        const name = decode_value_label_text(
            bytes,
            name_start,
            name_end,
            text_decoder,
            true,
        );
        return {
            entry: {
                name,
                tableLength: count * 10,
                payloadStart: payload_start,
                entryEnd: entry_end,
                fixedCount: count,
                fixedLabelsStart: labels_start,
            },
            entryEndPosition: entry_end,
        };
    }

    let table_length: number;
    if (legacy) {
        if (position + 4 > section_end) {
            throw new Error('Corrupt value label table: trailing bytes');
        }
        table_length = view.getInt32(position, little_endian);
        if (table_length <= 0) {
            throw new Error('Corrupt value label table: invalid table length');
        }
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
    const name_end = position + layout.nameWidth;
    const payload_start = name_end + LABEL_PADDING_BYTES;
    if (!Number.isSafeInteger(payload_start) || payload_start > section_end) {
        throw new Error('Corrupt value label table: truncated name');
    }
    const entry_end = payload_start + table_length;
    if (!Number.isSafeInteger(entry_end) || entry_end > section_end) {
        throw new Error('Corrupt value label table: entry exceeds section bounds');
    }
    const name = decode_value_label_text(
        bytes,
        position,
        name_end,
        text_decoder,
        true,
    );
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
    section_end: number | undefined,
): number {
    if (is_legacy_format(metadata.format_version)) return entry_end_position;
    if (
        section_end === undefined
        || entry_end_position + LBL_CLOSE_TAG_LENGTH > section_end
    ) {
        throw new Error('Corrupt value label table: closing tag overruns section');
    }
    if (!matches_ascii(new Uint8Array(buffer), entry_end_position, '</lbl>')) {
        throw new Error('Corrupt value label table: missing closing tag');
    }
    return entry_end_position + LBL_CLOSE_TAG_LENGTH;
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
    if (!Number.isSafeInteger(payload_end) || payload_end !== entry.entryEnd) {
        throw new Error('Corrupt value label table: payload length does not match entry');
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

interface FixedValueLabelPayloadLayout {
    readonly littleEndian: boolean;
    readonly count: number;
    readonly valuesStart: number;
    readonly labelsStart: number;
}

interface FixedValueLabelPayloadReader extends FixedValueLabelPayloadLayout {
    readonly bytes: Uint8Array;
    readonly view: DataView;
}

function fixed_value_label_payload_layout(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    entry: ValueLabelTableEntry,
    max_entry_count: number,
): FixedValueLabelPayloadLayout {
    const count = entry.fixedCount;
    const labels_start = entry.fixedLabelsStart;
    if (count === undefined || labels_start === undefined) {
        throw new Error('Corrupt value label table: missing fixed-width layout');
    }
    if (entry.tableLength > MAX_VALUE_LABEL_TABLE_BYTES) {
        throw new Error(
            `Value label table is too large to decode safely `
            + `(max ${MAX_VALUE_LABEL_TABLE_BYTES} bytes)`,
        );
    }
    if (count > max_entry_count) {
        throw new Error(
            `Value label table has too many entries to decode safely `
            + `(max ${max_entry_count} entries)`,
        );
    }
    const payload_end = labels_start + count * 8;
    if (payload_end !== entry.entryEnd || payload_end > buffer.byteLength) {
        throw new Error('Corrupt value label table: fixed-width payload exceeds entry bounds');
    }
    return {
        littleEndian: metadata.byte_order === 'LSF',
        count,
        valuesStart: entry.payloadStart,
        labelsStart: labels_start,
    };
}

function fixed_value_label_payload_reader(
    buffer: ArrayBuffer,
    layout: FixedValueLabelPayloadLayout,
): FixedValueLabelPayloadReader {
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

function charge_decoded_label_text(
    state: ValueLabelDecodeState,
    label: string,
    max_decoded_bytes: number,
): void {
    const decoded_bytes = label.length * 2;
    if (decoded_bytes > max_decoded_bytes - state.decodedBytes) {
        throw new Error(
            `Value label table exceeds its decoded text budget `
            + `(max ${max_decoded_bytes} UTF-16 bytes)`,
        );
    }
    state.decodedBytes += decoded_bytes;
}

function add_fixed_value_label(
    state: ValueLabelDecodeState,
    reader: FixedValueLabelPayloadReader,
    index: number,
    text_decoder: SourceTextDecoder,
    max_decoded_bytes: number,
): void {
    const label = decode_value_label_text(
        reader.bytes,
        reader.labelsStart + index * 8,
        reader.labelsStart + (index + 1) * 8,
        text_decoder,
        true,
    );
    charge_decoded_label_text(state, label, max_decoded_bytes);
    const value = reader.view.getInt16(
        reader.valuesStart + index * 2,
        reader.littleEndian,
    );
    state.labels.set(value, label);
}

function add_value_label(
    state: ValueLabelDecodeState,
    layout: ValueLabelPayloadReader,
    index: number,
    text_decoder: SourceTextDecoder,
    max_decoded_bytes: number,
): void {
    const offset = layout.view.getInt32(
        layout.offsetsStart + index * 4,
        layout.littleEndian,
    );
    if (offset < 0 || offset >= layout.textLength) {
        throw new Error('Corrupt value label table: text offset is outside the text block');
    }
    let label = state.decodedTextByOffset.get(offset);
    if (label === undefined) {
        const start = layout.textStart + offset;
        const text_end = layout.textStart + layout.textLength;
        let end = start;
        while (end < text_end && layout.bytes[end] !== 0) end += 1;
        if (end >= text_end) {
            throw new Error('Corrupt value label table: label text is missing a NUL terminator');
        }
        label = decode_value_label_text(
            layout.bytes,
            start,
            end,
            text_decoder,
            false,
        );
        charge_decoded_label_text(state, label, max_decoded_bytes);
        state.decodedTextByOffset.set(offset, label);
    }
    const value = layout.view.getInt32(
        layout.valuesStart + index * 4,
        layout.littleEndian,
    );
    state.labels.set(value, label);
}

async function add_value_label_async(
    state: ValueLabelDecodeState,
    layout: ValueLabelPayloadReader,
    index: number,
    text_decoder: SourceTextDecoder,
    max_decoded_bytes: number,
    after_payload_work: (work: number) => Promise<void>,
): Promise<void> {
    const offset = layout.view.getInt32(
        layout.offsetsStart + index * 4,
        layout.littleEndian,
    );
    if (offset < 0 || offset >= layout.textLength) {
        throw new Error('Corrupt value label table: text offset is outside the text block');
    }
    let label = state.decodedTextByOffset.get(offset);
    if (label === undefined) {
        const start = layout.textStart + offset;
        const text_end = layout.textStart + layout.textLength;
        let end = start;
        while (end < text_end) {
            const scan_start = end;
            const chunk_end = Math.min(
                end + LEGACY_VALUE_LABEL_BYTES_PER_YIELD,
                text_end,
            );
            while (end < chunk_end && layout.bytes[end] !== 0) end += 1;
            await after_payload_work(Math.max(1, end - scan_start));
            if (end < text_end && layout.bytes[end] === 0) break;
        }
        if (end >= text_end) {
            throw new Error('Corrupt value label table: label text is missing a NUL terminator');
        }
        const stream = text_decoder.stream();
        const decoded: string[] = [];
        for (let position = start; position < end;) {
            const chunk_end = Math.min(
                position + LEGACY_VALUE_LABEL_BYTES_PER_YIELD,
                end,
            );
            decoded.push(stream.decode(layout.bytes.subarray(position, chunk_end)));
            await after_payload_work(Math.max(1, chunk_end - position));
            position = chunk_end;
        }
        decoded.push(stream.finish());
        label = decoded.join('');
        charge_decoded_label_text(state, label, max_decoded_bytes);
        state.decodedTextByOffset.set(offset, label);
    }
    const value = layout.view.getInt32(
        layout.valuesStart + index * 4,
        layout.littleEndian,
    );
    state.labels.set(value, label);
}

function decode_value_label_table(
    buffer: ArrayBuffer,
    metadata: DtaMetadata,
    entry: ValueLabelTableEntry,
    text_decoder: SourceTextDecoder,
    max_entry_count: number,
    max_decoded_bytes: number,
): DecodedValueLabelTable {
    const state = create_value_label_decode_state();
    if (entry.fixedCount !== undefined) {
        const layout = fixed_value_label_payload_layout(
            buffer,
            metadata,
            entry,
            max_entry_count,
        );
        const reader = fixed_value_label_payload_reader(buffer, layout);
        for (let index = 0; index < layout.count; index++) {
            add_fixed_value_label(
                state,
                reader,
                index,
                text_decoder,
                max_decoded_bytes,
            );
        }
        return decoded_value_label_table(state);
    }
    const layout = value_label_payload_layout(buffer, metadata, entry, max_entry_count);
    const reader = value_label_payload_reader(buffer, layout);
    for (let index = 0; index < layout.count; index++) {
        add_value_label(state, reader, index, text_decoder, max_decoded_bytes);
    }
    return decoded_value_label_table(state);
}

async function decode_value_label_table_async(
    open_buffer: () => ArrayBuffer,
    metadata: DtaMetadata,
    entry: ValueLabelTableEntry,
    text_decoder: SourceTextDecoder,
    max_entry_count: number,
    max_decoded_bytes: number,
    assert_lifecycle: () => void,
    assert_active: () => void,
    after_work: (work: number) => Promise<void>,
    after_payload_work: (work: number) => Promise<void>,
): Promise<DecodedValueLabelTable> {
    assert_lifecycle();
    const state = create_value_label_decode_state();
    if (entry.fixedCount !== undefined) {
        const layout = fixed_value_label_payload_layout(
            open_buffer(),
            metadata,
            entry,
            max_entry_count,
        );
        for (let index = 0; index < layout.count;) {
            assert_lifecycle();
            const end = Math.min(index + VALUE_LABEL_ENTRIES_PER_YIELD, layout.count);
            const reader = fixed_value_label_payload_reader(open_buffer(), layout);
            const start = index;
            for (; index < end; index++) {
                add_fixed_value_label(
                    state,
                    reader,
                    index,
                    text_decoder,
                    max_decoded_bytes,
                );
            }
            await after_work(index - start);
        }
        assert_active();
        return decoded_value_label_table(state);
    }
    const layout = value_label_payload_layout(
        open_buffer(),
        metadata,
        entry,
        max_entry_count,
    );
    for (let index = 0; index < layout.count;) {
        assert_lifecycle();
        const end = Math.min(index + VALUE_LABEL_ENTRIES_PER_YIELD, layout.count);
        const reader = value_label_payload_reader(open_buffer(), layout);
        const start = index;
        for (; index < end; index++) {
            await add_value_label_async(
                state,
                reader,
                index,
                text_decoder,
                max_decoded_bytes,
                after_payload_work,
            );
        }
        await after_work(index - start);
    }
    assert_active();
    return decoded_value_label_table(state);
}

function decode_value_label_text(
    bytes: Uint8Array,
    start: number,
    end: number,
    text_decoder: SourceTextDecoder,
    fixed_width: boolean,
): string {
    let actual_end = end;
    if (fixed_width) {
        actual_end = start;
        while (actual_end < end && bytes[actual_end] !== 0) actual_end += 1;
    }
    return text_decoder.decode(bytes.subarray(start, actual_end));
}

function create_source_text_decoder(encoding: ResolvedTextEncoding): SourceTextDecoder {
    if (encoding === 'iso-8859-1') {
        const decode = (input: Uint8Array): string => {
            const chunk_size = 8_192;
            let result = '';
            for (let offset = 0; offset < input.length; offset += chunk_size) {
                result += String.fromCharCode(...input.subarray(offset, offset + chunk_size));
            }
            return result;
        };
        return {
            decode,
            stream: () => ({ decode, finish: () => '' }),
        };
    }
    const decoder = new TextDecoder(encoding, { ignoreBOM: true });
    return {
        decode: (input) => decoder.decode(input),
        stream: () => {
            const streaming = new TextDecoder(encoding, { ignoreBOM: true });
            return {
                decode: (input) => streaming.decode(input, { stream: true }),
                finish: () => streaming.decode(),
            };
        },
    };
}

function matches_ascii(bytes: Uint8Array, start: number, value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        if (bytes[start + index] !== value.charCodeAt(index)) return false;
    }
    return true;
}
