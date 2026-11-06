import { Buffer } from 'node:buffer';
import {
    MISSING,
    formatValue,
    isMissing,
    missingValue,
    openParquet,
    type ColumnChunk,
    type DtaError,
    type ParquetOptions,
    type ParquetReader,
    type ParquetVariable,
    type Statistic,
    type TableCell,
    type TableColumn,
    type ValueLabels,
} from '@jbearak/dta-parser';
import {
    assert_safe_sheet_shape,
    create_workbook_budget,
} from '../spreadsheet-safety';
import { capped_column_details, list_text } from './column-details';
import type {
    ColumnDetails,
    IndexedRawColumns,
    IndexedRows,
    RawCell,
    RenderedCell,
} from './interface';
import { temporal_text, type TemporalColumn } from './parquet-temporal';
import { raw_stata_missing_cell } from './stata-missing-cell';
import {
    DECODE_WINDOW_ROWS,
    MAX_TEXT_STRL_BYTES,
    TableReaderSource,
    assert_value_label_limits,
    is_missing_code,
    label_for,
    rendered_cell,
    yield_to_event_loop,
    type CachedWindow,
    type SourceNaming,
} from './table-reader-source';

export const PARQUET_NAMING: SourceNaming = {
    format: 'Parquet',
    corrupt: 'Corrupt Parquet file',
    failed: 'Could not read Parquet file',
};

// Limits checked from the footer before any data or value label is decoded.
export const MAX_PARQUET_FOOTER_BYTES = 64 * 1024 * 1024;
export const MAX_PARQUET_ROWS = 2_000_000;
export const MAX_PARQUET_COLUMNS = 10_000;
/**
 * Column chunks (columns times row groups): their statistics are parsed at
 * once and kept until the reader closes. 400,000 hold about 61 MiB of heap
 * (1,000,000, the plan's first limit, held 152 MiB; see
 * docs/plans/parquet-measurements.md).
 */
export const MAX_PARQUET_COLUMN_CHUNKS = 400_000;
/** The dta profile, from which value labels are parsed on first use. */
export const MAX_PARQUET_PROFILE_BYTES = 16 * 1024 * 1024;
export const MAX_PARQUET_ROW_BYTES = 1024 * 1024;
export const MAX_PARQUET_DICTIONARY_PAGE_BYTES = 16 * 1024 * 1024;

/**
 * Decompressed pages each reader keeps between reads. Measured on the
 * source (docs/plans/parquet-measurements.md): the smallest size within 10%
 * of the best of 8, 16, and 32 MiB.
 */
export const PARQUET_PAGE_CACHE_BYTES = 32 * 1024 * 1024;

/** Rows decoded at a time for rendered windows, at most. */
export const PARQUET_BLOCK_ROWS = 2048;
/** What one block's decoded columns may hold, by the footer's bounds. */
export const PARQUET_BLOCK_BUDGET = 32 * 1024 * 1024;
/** What one batch of a raw scan may hold, by the footer's bounds. */
export const PARQUET_SCAN_BUDGET = 64 * 1024 * 1024;
/** Raw scans read at least this many rows a chunk, so pages are not reread. */
export const PARQUET_SCAN_ROWS = 2048;
/** Columns one read asks for, at most. */
export const PARQUET_BATCH_COLUMNS = 16;

// Bytes counted per decoded value: a number or bigint and its missing code;
// a text value's array slot and string header (plus twice its length); a
// binary value's Uint8Array, ArrayBuffer, and backing store (plus its
// length). The plan's 160 bytes for a binary value was low: 32,768 copies
// of 16 bytes took 549 bytes each of RSS (240 of heap and array buffers),
// so 544 is counted (docs/plans/parquet-measurements.md).
const NUMBER_VALUE_BYTES = 9;
const TEXT_VALUE_BYTES = 16;
const BINARY_VALUE_BYTES = 544;
/** Encodings with which a stored value may decode more than once. */
const REPEATING_ENCODINGS = new Set(['RLE_DICTIONARY', 'PLAIN_DICTIONARY', 'DELTA_BYTE_ARRAY']);
/** Comparison key of a null in a text, categorical, or binary column. */
export const PARQUET_NULL_KEY = 'parquet:null';
const MAX_WARNING_NAMES = 20;
/** A text bound longer than this, in characters, is left out of the tooltip. */
export const MAX_TEXT_BOUND_CHARACTERS = 64;

const format_value = formatValue;
const missing_value = missingValue;

/** How a column's values become cells. */
type CellKind =
    | 'number'
    | 'bool'
    | 'temporal'
    | 'bigint'
    | 'text'
    | 'decimal'
    | 'binary'
    | 'categorical';

interface ColumnPlan {
    readonly variable: ParquetVariable;
    /** The variable's index in the reader. */
    readonly reader_index: number;
    readonly cell: CellKind;
    /** Numbers, bigints, dates, and bools: every row decodes to `row_bytes`. */
    readonly fixed: boolean;
    /** The display format to apply: non-empty only for a number without a unit. */
    readonly format: string;
    readonly temporal?: TemporalColumn;
    /** Bytes counted per decoded row. */
    readonly row_bytes: number;
    /** Per row group: bytes counted for the chunk's values beyond `row_bytes` a row. */
    readonly chunk_bytes: readonly number[];
    /** Per row group: whether a stored value may decode more than once. */
    readonly repeats: readonly boolean[];
}

/** Columns read together, and those read alone. */
interface ReadPlan {
    readonly batches: number[][];
    readonly alone: number[];
    /** A column with a known bound did not fit (only for a cumulative budget). */
    readonly overflow: boolean;
}

/** One block's decoded columns, by table column. */
interface DecodedBlock {
    readonly start: number;
    readonly count: number;
    readonly columns: Map<number, TableColumn>;
    /** Columns read alone for each window, never held in the block. */
    readonly alone: Set<number>;
    bytes: number;
}

/** Receives decoded column `k` (a position in the columns asked for). */
type ColumnSink = (k: number, column: TableColumn, from: number, at: number, count: number) => void;

function utf8_bytes_at_least(text: string, limit: number): boolean {
    return text.length * 3 + 1 > limit && Buffer.byteLength(text) + 1 > limit;
}

function too_large_text(): Error {
    return new Error(
        `Parquet text value is too large to show safely (max ${MAX_TEXT_STRL_BYTES} bytes)`,
    );
}

function text_null_cell(): RawCell {
    return { raw: null, rawType: 'empty', comparisonKey: PARQUET_NULL_KEY };
}

function mib(bytes: number): string {
    return `${bytes / 1024 / 1024} MiB`;
}

function limit_error(message: string): Error {
    return new Error(message);
}

/** The cell kind of a readable variable. */
function cell_kind(variable: ParquetVariable): CellKind {
    switch (variable.columnKind) {
        case 'bigint':
            return 'bigint';
        case 'dictionary':
            return 'categorical';
        case 'string':
            if (variable.type === 'binary') return 'binary';
            return variable.type === 'decimal' ? 'decimal' : 'text';
        default:
            if (variable.unit !== undefined) return 'temporal';
            return variable.type === 'bool' ? 'bool' : 'number';
    }
}

function plan_column(variable: ParquetVariable, reader_index: number): ColumnPlan {
    const cell = cell_kind(variable);
    const temporal = variable.unit === undefined
        ? undefined
        : { type: variable.type, unit: variable.unit, timeZone: variable.timeZone };
    const chunks = variable.chunks;
    const fixed = cell !== 'text' && cell !== 'decimal' && cell !== 'binary'
        && cell !== 'categorical';
    let row_bytes = NUMBER_VALUE_BYTES;
    let chunk_bytes: number[] = [];
    let repeats: boolean[] = [];
    if (!fixed) {
        const binary = cell === 'binary';
        row_bytes = binary ? BINARY_VALUE_BYTES : TEXT_VALUE_BYTES;
        chunk_bytes = chunks.map((chunk) => chunk === null
            ? 0
            : (binary ? 1 : 2) * chunk.uncompressedBytes);
        // A categorical holds each level once, so it is bounded by its chunk;
        // text and binary values may repeat a stored value in many rows.
        repeats = cell === 'categorical'
            ? chunks.map((chunk) => chunk === null)
            : chunks.map((chunk) => chunk_repeats(chunk));
    }
    return {
        variable,
        reader_index,
        cell,
        fixed,
        format: cell === 'number' ? variable.format : '',
        temporal: cell === 'temporal' || (cell === 'bigint' && temporal) ? temporal : undefined,
        row_bytes,
        chunk_bytes,
        repeats,
    };
}

function chunk_repeats(chunk: ColumnChunk | null): boolean {
    if (chunk === null) return true;
    if (chunk.dictionaryPageBytes !== null) return true;
    return chunk.encodings.some((encoding) => REPEATING_ENCODINGS.has(encoding));
}

/**
 * The text a value of a planned column shows with Formatting on: its value
 * label, else its date or time, `true` or `false`, or display format.
 */
function format_cell(
    plan: ColumnPlan,
    labels: ValueLabels | undefined,
    raw_cell: RawCell,
    value: TableCell,
): string {
    const raw = raw_cell.raw ?? '';
    if (isMissing(value)) return raw_cell.raw === null ? '' : labels?.get(value) ?? raw;
    if (typeof value === 'bigint') {
        return plan.temporal === undefined ? raw : temporal_text(value, plan.temporal);
    }
    if (typeof value !== 'number') return raw;
    const label = labels?.get(value);
    if (label !== undefined) return label;
    switch (plan.cell) {
        case 'bool':
            return value === 1 ? 'true' : value === 0 ? 'false' : raw;
        case 'temporal':
            return temporal_text(value, plan.temporal!);
        case 'number':
            return plan.format !== '' && Number.isFinite(value)
                ? format_value(value, plan.format)
                : raw;
        default:
            return raw;
    }
}

// ------------------------------------------------------------ column details

/**
 * The tooltip's type line: the reader's type and display format, then
 * Parquet's physical and logical type, then the codecs the chunks use, as
 * `byte, %8.0g; Parquet DOUBLE; snappy`.
 */
function parquet_type_text(variable: ParquetVariable): string {
    const parquet = [variable.physicalType, variable.logicalType]
        .filter((type) => type !== '')
        .join(' ');
    let text = variable.format === '' ? variable.type : `${variable.type}, ${variable.format}`;
    if (parquet !== '') text += `; Parquet ${parquet}`;
    const codecs = new Set<string>();
    for (const chunk of variable.chunks) {
        if (chunk !== null) codecs.add(chunk.codec === 'none' ? 'uncompressed' : chunk.codec);
    }
    if (codecs.size > 0) text += `; ${list_text([...codecs])}`;
    return text;
}

/** Nulls in every row group, when each reports its count. */
function null_count(chunks: readonly (ColumnChunk | null)[]): number | undefined {
    if (chunks.length === 0) return undefined;
    let nulls = 0;
    for (const chunk of chunks) {
        if (chunk === null || chunk.nullCount === null) return undefined;
        nulls += chunk.nullCount;
    }
    return nulls;
}

/**
 * Compare two strings by code point, which is the order of their UTF-8
 * bytes, the order Parquet's statistics use for text (UTF-16 code units
 * order characters past U+FFFF before U+E000 to U+FFFF).
 */
export function compare_utf8(a: string, b: string): number {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length;) {
        const x = a.codePointAt(i)!;
        const y = b.codePointAt(i)!;
        if (x !== y) return x < y ? -1 : 1;
        i += x > 0xffff ? 2 : 1;
    }
    return a.length - b.length;
}

type Bound = number | bigint | string;

/** How a column's bounds are combined: by value, by UTF-8 bytes, or not at all. */
function bound_order(cell: CellKind): 'value' | 'text' | undefined {
    switch (cell) {
        case 'number':
        case 'bigint':
        case 'temporal':
            return 'value';
        case 'text':
        case 'categorical':
            return 'text';
        default:
            // Binary bounds are not shown; decimals and bools have no range.
            return undefined;
    }
}

function is_bound(value: Statistic | null, order: 'value' | 'text'): value is Bound {
    if (order === 'text') return typeof value === 'string';
    return typeof value === 'bigint' || (typeof value === 'number' && !Number.isNaN(value));
}

function bound_less(a: Bound, b: Bound, order: 'value' | 'text'): boolean {
    return order === 'text' ? compare_utf8(a as string, b as string) < 0 : a < b;
}

/**
 * The least and greatest bound over every row group, when each reports both
 * and the column's bounds can be combined. Text bounds that are not valid
 * UTF-8 come from the package as bytes, and are not combined.
 */
function combined_range(plan: ColumnPlan): [Bound, Bound] | undefined {
    const order = bound_order(plan.cell);
    const chunks = plan.variable.chunks;
    if (order === undefined || chunks.length === 0) return undefined;
    let low: Bound | undefined;
    let high: Bound | undefined;
    for (const chunk of chunks) {
        if (chunk === null) return undefined;
        const { min, max } = chunk;
        if (!is_bound(min, order) || !is_bound(max, order)) return undefined;
        if (low === undefined || bound_less(min, low, order)) low = min;
        if (high === undefined || bound_less(high, max, order)) high = max;
    }
    return [low!, high!];
}

/** Whether `text` has more than `limit` characters (code points). */
function longer_than(text: string, limit: number): boolean {
    if (text.length <= limit) return false;
    let characters = 0;
    for (const _ of text) {
        if (++characters > limit) return true;
    }
    return false;
}

/**
 * A bound as the column's cells show it with Formatting on; text in quotes,
 * so the range reads unambiguously and a line break stays on one line.
 * Undefined for text longer than `MAX_TEXT_BOUND_CHARACTERS`.
 */
function bound_text(plan: ColumnPlan, labels: ValueLabels | undefined, bound: Bound): string | undefined {
    if (typeof bound === 'string') {
        return longer_than(bound, MAX_TEXT_BOUND_CHARACTERS) ? undefined : JSON.stringify(bound);
    }
    let value: number | bigint = bound;
    if (typeof value === 'number' && plan.cell === 'bigint' && Number.isSafeInteger(value)) {
        value = BigInt(value);
    } else if (typeof value === 'bigint' && plan.cell !== 'bigint') {
        const number = Number(value);
        if (Number.isSafeInteger(number)) value = number;
    }
    return format_cell(plan, labels, { raw: String(value), rawType: 'number' }, value);
}

/**
 * The tooltip's statistics line, from the footer: the null count when every
 * row group reports one, and the range ("between <min> and <max>", since a
 * writer may record bounds that are not values) when every row group
 * reports both.
 */
function statistics_text(plan: ColumnPlan, labels: ValueLabels | undefined): string | undefined {
    const parts: string[] = [];
    const nulls = null_count(plan.variable.chunks);
    if (nulls !== undefined) {
        parts.push(nulls === 0
            ? 'no nulls'
            : `${nulls.toLocaleString('en-US')} ${nulls === 1 ? 'null' : 'nulls'}`);
    }
    const range = combined_range(plan);
    if (range !== undefined) {
        const low = bound_text(plan, labels, range[0]);
        const high = bound_text(plan, labels, range[1]);
        if (low !== undefined && high !== undefined) parts.push(`between ${low} and ${high}`);
    }
    if (parts.length === 0) return undefined;
    const text = parts.join('; ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function column_details_of(plan: ColumnPlan, labels: ValueLabels | undefined): ColumnDetails {
    const variable = plan.variable;
    const details: ColumnDetails = {};
    if (variable.label !== '') details.label = variable.label;
    details.type = parquet_type_text(variable);
    if (variable.valueLabels !== '') details.valueLabels = variable.valueLabels;
    const statistics = statistics_text(plan, labels);
    if (statistics !== undefined) details.statistics = statistics;
    return details;
}

/** A readable Parquet variable's header tooltip details; `labels` is its value label set. */
export function parquet_column_details(
    variable: ParquetVariable,
    labels?: ValueLabels,
): ColumnDetails {
    return column_details_of(plan_column(variable, 0), labels);
}

/** Each left-out column named, in one warning; then the profile's warnings. */
function parquet_warnings(reader: ParquetReader): string[] {
    const left_out = reader.variables.filter((variable) => variable.columnKind === null);
    const warnings: string[] = [];
    if (left_out.length > 0) {
        const described = left_out.slice(0, MAX_WARNING_NAMES).map((variable) =>
            variable.role === 'nested'
                ? `"${variable.name}" (a list, map, or struct)`
                : `"${variable.name}" (${variable.notRead ?? 'a type Table Viewer does not read'})`);
        const more = left_out.length > MAX_WARNING_NAMES
            ? ` and ${left_out.length - MAX_WARNING_NAMES} more`
            : '';
        warnings.push(
            `${left_out.length === 1 ? 'A column is' : `${left_out.length} columns are`} `
            + `not shown: ${described.join(', ')}${more}.`,
        );
    }
    warnings.push(...reader.info.warnings);
    return warnings;
}

/**
 * Check the footer length in the file's last 8 bytes, before the parser reads
 * the footer: a file whose footer is longer than the limit is refused here.
 */
export function assert_parquet_footer_length(tail: Uint8Array, file_bytes: number): void {
    const magic = String.fromCharCode(...tail.subarray(4, 8));
    if (file_bytes < 12 || tail.length < 8 || magic !== 'PAR1') {
        const error = new Error('Corrupt Parquet file: it does not end with a Parquet footer') as DtaError;
        error.code = 'DTA_CORRUPT';
        throw error;
    }
    const footer = new DataView(tail.buffer, tail.byteOffset, 8).getUint32(0, true);
    if (footer > MAX_PARQUET_FOOTER_BYTES) {
        throw limit_error(
            `Parquet footer is ${footer.toLocaleString('en-US')} bytes, more than the `
            + `${mib(MAX_PARQUET_FOOTER_BYTES)} safety limit`,
        );
    }
}

/** The limits checked from the footer, before any data or value label is decoded. */
export function assert_parquet_limits(reader: ParquetReader): void {
    const { info, variables } = reader;
    if (info.nobs > MAX_PARQUET_ROWS) {
        throw limit_error(
            `Parquet file has too many rows to open safely `
            + `(max ${MAX_PARQUET_ROWS.toLocaleString('en-US')})`,
        );
    }
    if (variables.length > MAX_PARQUET_COLUMNS) {
        throw limit_error(
            `Parquet file has too many columns to open safely `
            + `(max ${MAX_PARQUET_COLUMNS.toLocaleString('en-US')})`,
        );
    }
    if (variables.length * info.rowGroups.length > MAX_PARQUET_COLUMN_CHUNKS) {
        throw limit_error(
            `Parquet file has too many column chunks (columns times row groups) to open safely `
            + `(max ${MAX_PARQUET_COLUMN_CHUNKS.toLocaleString('en-US')})`,
        );
    }
    const profile = info.keyValue.find(({ key }) => key === 'dta');
    if (profile !== undefined && profile.bytes > MAX_PARQUET_PROFILE_BYTES) {
        throw limit_error(
            `Parquet file's dta metadata is larger than the `
            + `${mib(MAX_PARQUET_PROFILE_BYTES)} safety limit`,
        );
    }
    const uncompressed = info.rowGroups.reduce((sum, group) => sum + group.uncompressedBytes, 0);
    if (info.nobs > 0 && uncompressed / info.nobs > MAX_PARQUET_ROW_BYTES) {
        throw limit_error(
            `Parquet rows exceed the ${mib(MAX_PARQUET_ROW_BYTES)} per-row safety limit`,
        );
    }
    for (const variable of variables) {
        if (variable.columnKind === null) continue;
        for (const chunk of variable.chunks) {
            if ((chunk?.dictionaryPageBytes ?? 0) > MAX_PARQUET_DICTIONARY_PAGE_BYTES) {
                throw limit_error(
                    `Parquet column "${variable.name}" has a dictionary page larger than the `
                    + `${mib(MAX_PARQUET_DICTIONARY_PAGE_BYTES)} safety limit`,
                );
            }
        }
    }
}

/** Options a Parquet source opens its reader with. */
export interface ParquetSourceOptions {
    /** Bytes of decompressed pages kept between reads; default `PARQUET_PAGE_CACHE_BYTES`. */
    readonly pageCacheBytes?: number;
}

export function parquet_reader_options(options: ParquetSourceOptions = {}): ParquetOptions {
    return {
        nested: 'error',
        int64: 'auto',
        pageCacheBytes: options.pageCacheBytes ?? PARQUET_PAGE_CACHE_BYTES,
    };
}

/** "Could not open Parquet file: ...", calling a damaged file corrupt. */
export function parquet_open_error(error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    const corrupt = (error as Partial<DtaError>)?.code === 'DTA_CORRUPT'
        && !detail.startsWith(PARQUET_NAMING.corrupt);
    return new Error(
        `Could not open Parquet file: ${corrupt ? `${PARQUET_NAMING.corrupt}: ` : ''}${detail}`,
        { cause: error },
    );
}

/**
 * Read-only source over a Parquet reader. The table's columns are the
 * reader's readable variables, in order; nested and unreadable ones are
 * left out and named in `warnings`. Rendered windows are built from blocks
 * of up to `PARQUET_BLOCK_ROWS` rows decoded `PARQUET_BATCH_COLUMNS` columns
 * at a time, each request bounded by the footer's sizes before it is made.
 */
export class ParquetReaderSource extends TableReaderSource<ParquetReader> {
    readonly warnings: string[];
    /** Rows a block decodes: a multiple of 256, from 256 to 2,048. */
    readonly block_rows: number;
    private readonly plans: readonly ColumnPlan[];
    private readonly group_starts: readonly number[];
    private block?: DecodedBlock;
    /** The start of the last block found too large to keep. */
    private oversized_block?: number;

    protected constructor(reader: ParquetReader) {
        const readable: { variable: ParquetVariable; index: number }[] = [];
        reader.variables.forEach((variable, index) => {
            if (variable.columnKind !== null) readable.push({ variable, index });
        });
        const uncompressed = reader.info.rowGroups.reduce(
            (sum, group) => sum + group.uncompressedBytes, 0,
        );
        // Every column's chunks (and their statistics) are parsed here, once.
        const plans = readable.map(({ variable, index }) => plan_column(variable, index));
        super(reader, {
            variables: readable.map(({ variable }) => variable),
            estimatedRowBytes: reader.info.nobs > 0 ? Math.ceil(uncompressed / reader.info.nobs) : 0,
            naming: PARQUET_NAMING,
            columnDetails: capped_column_details(plans.length, (column) => {
                const name = plans[column].variable.valueLabels;
                return column_details_of(plans[column], name ? reader.valueLabels(name) : undefined);
            }),
        });
        this.warnings = parquet_warnings(reader);
        this.plans = plans;
        this.group_starts = reader.info.rowGroups.map((group) => group.firstRow);
        this.block_rows = this.choose_block_rows();
    }

    protected override on_close(): void {
        this.block = undefined;
        this.oversized_block = undefined;
    }

    protected override decode(
        columns: readonly number[],
        start: number,
        count: number,
    ): TableColumn[] {
        const indices = columns.map((column) => this.plans[column].reader_index);
        return this.reading(() => this.open_reader().readColumns(indices, { start, count }));
    }

    protected override async_scan_rows_per_chunk(column_count: number): number {
        return Math.max(PARQUET_SCAN_ROWS, this.async_rows_per_chunk(column_count));
    }

    // ------------------------------------------------------------ windows

    protected override render_window(
        start: number,
        count: number,
        columns: readonly number[],
    ): CachedWindow {
        const rows: (RenderedCell | null)[][] = Array.from(
            { length: count }, () => new Array<RenderedCell | null>(columns.length),
        );
        let bytes = 0;
        const labels = columns.map((column) => this.labels_of(column));
        this.read_window(start, count, columns, (k, column, from, at, n) => {
            bytes += this.render_column(
                rows, k, columns[k], labels[k], column, from, at, n, start,
            );
        });
        return { rows, cellCount: count * columns.length, byteCount: bytes };
    }

    /**
     * Hand each of `columns` over rows [start, start + count) to `sink`, from
     * the kept block when the columns fit it, else read for the window alone.
     */
    private read_window(
        start: number,
        count: number,
        columns: readonly number[],
        sink: ColumnSink,
    ): void {
        if (columns.length === 0 || count === 0) return;
        const block_start = Math.floor(start / this.block_rows) * this.block_rows;
        if (this.oversized_block === block_start) {
            this.read_bounded(start, count, columns, PARQUET_BLOCK_BUDGET, sink);
            return;
        }
        if (this.block?.start !== block_start) {
            // Evict before decoding the next, so at most one block is held.
            this.block = undefined;
            this.block = {
                start: block_start,
                count: Math.min(this.block_rows, this.nobs - block_start),
                columns: new Map(),
                alone: new Set(),
                bytes: 0,
            };
        }
        const block = this.block;
        const wanted: number[] = [];
        for (const column of columns) {
            if (!block.columns.has(column) && !block.alone.has(column)) wanted.push(column);
        }
        if (wanted.length > 0) {
            const plan = this.plan_reads(
                wanted, block.start, block.start + block.count,
                PARQUET_BLOCK_BUDGET - block.bytes, true,
            );
            if (plan.overflow) {
                // Not kept: this window and later ones in the block are read alone.
                this.block = undefined;
                this.oversized_block = block_start;
                this.read_bounded(start, count, columns, PARQUET_BLOCK_BUDGET, sink);
                return;
            }
            for (const batch of plan.batches) {
                const decoded = this.decode(batch, block.start, block.count);
                batch.forEach((column, j) => {
                    block.columns.set(column, decoded[j]);
                    block.bytes += this.bound(column, block.start, block.start + block.count);
                });
            }
            for (const column of plan.alone) block.alone.add(column);
        }
        columns.forEach((column, k) => {
            const held = block.columns.get(column);
            if (held !== undefined) {
                sink(k, held, start - block.start, 0, count);
                return;
            }
            // Read for this window only, rendered, and dropped.
            const [alone] = this.decode([column], start, count);
            sink(k, alone, 0, 0, count);
        });
    }

    /**
     * Read `columns` over rows [start, start + count) in batches bounded by
     * `budget` each, handing each batch to `sink` before reading the next.
     * A column with no bound, or whose bound passes the budget, is read alone
     * in ranges of 256 rows.
     */
    private read_bounded(
        start: number,
        count: number,
        columns: readonly number[],
        budget: number,
        sink: ColumnSink,
    ): void {
        const position = new Map(columns.map((column, k) => [column, k]));
        const plan = this.plan_reads(columns, start, start + count, budget, false);
        for (const batch of plan.batches) {
            const decoded = this.decode(batch, start, count);
            batch.forEach((column, j) => sink(position.get(column)!, decoded[j], 0, 0, count));
        }
        for (const column of plan.alone) {
            for (let at = 0; at < count; at += DECODE_WINDOW_ROWS) {
                const n = Math.min(DECODE_WINDOW_ROWS, count - at);
                const [decoded] = this.decode([column], start + at, n);
                sink(position.get(column)!, decoded, 0, at, n);
            }
        }
    }

    /**
     * Batches of at most `PARQUET_BATCH_COLUMNS` columns whose bounds over
     * rows [start, end) fit `budget`: in all (`cumulative`, for a kept
     * block) or per batch. Columns without a bound are read alone; so is a
     * column whose bound does not fit, which, for a cumulative budget, is an
     * overflow.
     */
    private plan_reads(
        columns: readonly number[],
        start: number,
        end: number,
        budget: number,
        cumulative: boolean,
    ): ReadPlan {
        const batches: number[][] = [];
        const alone: number[] = [];
        let overflow = false;
        let batch: number[] = [];
        let batch_bytes = 0;
        let remaining = budget;
        for (const column of columns) {
            const bound = this.bound(column, start, end);
            if (!Number.isFinite(bound)) {
                alone.push(column);
                continue;
            }
            if (bound > (cumulative ? remaining : budget)) {
                alone.push(column);
                if (cumulative) overflow = true;
                continue;
            }
            if (
                batch.length === PARQUET_BATCH_COLUMNS
                || (!cumulative && batch_bytes + bound > budget)
            ) {
                batches.push(batch);
                batch = [];
                batch_bytes = 0;
            }
            batch.push(column);
            batch_bytes += bound;
            remaining -= bound;
        }
        if (batch.length > 0) batches.push(batch);
        return { batches, alone, overflow };
    }

    /**
     * Bytes a read of `column` over rows [start, end) decodes at most, by the
     * footer: exact for numbers; for text and binary, per row plus the
     * chunks' uncompressed bytes. Infinity when a chunk in range may decode a
     * stored value more than once (a dictionary, or DELTA_BYTE_ARRAY).
     */
    bound(column: number, start: number, end: number): number {
        const plan = this.plans[column];
        let bytes = plan.row_bytes * (end - start);
        if (plan.fixed) return bytes;
        const groups = this.group_starts;
        for (let g = this.group_of(start); g < groups.length && groups[g] < end; g++) {
            if (plan.repeats[g]) return Number.POSITIVE_INFINITY;
            bytes += plan.chunk_bytes[g];
        }
        return bytes;
    }

    /** The row group holding `row`. */
    private group_of(row: number): number {
        const groups = this.group_starts;
        let low = 0;
        let high = groups.length - 1;
        while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (groups[middle] <= row) low = middle;
            else high = middle - 1;
        }
        return low;
    }

    /** 2,048 rows, or fewer (by 256s, at least 256) so a block is estimated at the budget. */
    private choose_block_rows(): number {
        const rows = Math.max(1, this.nobs);
        let per_row = 0;
        this.plans.forEach((plan, column) => {
            const bound = this.bound(column, 0, this.nobs);
            if (Number.isFinite(bound)) per_row += bound / rows;
            else per_row += plan.row_bytes;
        });
        const fit = Math.floor(PARQUET_BLOCK_BUDGET / Math.max(1, per_row) / DECODE_WINDOW_ROWS)
            * DECODE_WINDOW_ROWS;
        return Math.max(DECODE_WINDOW_ROWS, Math.min(PARQUET_BLOCK_ROWS, fit));
    }

    /**
     * Render rows [from, from + n) of decoded `column` (table column
     * `table_column`) into `rows[at + i][k]`; returns the bytes counted.
     */
    private render_column(
        rows: (RenderedCell | null)[][],
        k: number,
        table_column: number,
        labels: ValueLabels | undefined,
        column: TableColumn,
        from: number,
        at: number,
        n: number,
        window_start: number,
    ): number {
        const plan = this.plans[table_column];
        let bytes = 0;
        if (column.kind === 'number' && (plan.cell === 'number')) {
            const format = plan.format;
            for (let i = 0; i < n; i++) {
                const code = column.missing[from + i];
                let cell: RenderedCell;
                if (code === 0) {
                    const value = column.values[from + i];
                    const raw = String(value);
                    const formatted = labels?.get(value)
                        ?? (format !== '' && Number.isFinite(value) ? format_value(value, format) : raw);
                    bytes += raw.length * 2;
                    if (formatted !== raw) bytes += formatted.length * 2;
                    cell = { raw, rawType: 'number', formatted, bold: false, italic: false };
                } else {
                    cell = this.render_missing(code, labels);
                    bytes += 4;
                }
                rows[at + i][k] = cell;
            }
            return bytes;
        }
        for (let i = 0; i < n; i++) {
            const cell = this.render_value(
                plan, labels, cell_at(column, from + i), window_start + at + i, table_column,
            );
            const raw = cell.raw ?? '';
            bytes += raw.length * 2 + (cell.rawByteLength ?? 0);
            if (cell.formatted !== raw) bytes += cell.formatted.length * 2;
            rows[at + i][k] = cell;
        }
        return bytes;
    }

    private render_missing(code: number, labels: ValueLabels | undefined): RenderedCell {
        const missing = missing_value(code);
        return rendered_cell(
            raw_stata_missing_cell(missing.missing),
            labels?.get(missing) ?? missing.missing,
        );
    }

    /** The rendered cell of one value (as `readRowsAt` gives it) of a planned column. */
    private render_value(
        plan: ColumnPlan,
        labels: ValueLabels | undefined,
        value: TableCell,
        row: number,
        column: number,
    ): RenderedCell {
        const raw_cell = this.raw_value(plan, value, row, column);
        return rendered_cell(raw_cell, format_cell(plan, labels, raw_cell, value));
    }

    /** The raw cell of one value of a planned column. */
    private raw_value(plan: ColumnPlan, value: TableCell, row: number, column: number): RawCell {
        if (isMissing(value)) {
            return plan.cell === 'text' || plan.cell === 'decimal'
                || plan.cell === 'binary' || plan.cell === 'categorical'
                ? text_null_cell()
                : raw_stata_missing_cell(value.missing);
        }
        if (value instanceof Uint8Array) return this.binary_raw_cell(value, row, column);
        if (typeof value === 'string') {
            if (utf8_bytes_at_least(value, MAX_TEXT_STRL_BYTES)) throw too_large_text();
            return { raw: value, rawType: plan.cell === 'decimal' ? 'number' : 'string' };
        }
        return { raw: String(value), rawType: 'number' };
    }

    protected override render_raw_cell(
        raw_cell: RawCell,
        column: number,
        labels: ValueLabels | undefined,
    ): RenderedCell {
        const raw = raw_cell.raw;
        if (raw === null) return rendered_cell(raw_cell, '');
        if (raw_cell.rawType !== 'number') return rendered_cell(raw_cell, raw);
        const plan = this.plans[column];
        if (is_missing_code(raw)) return rendered_cell(raw_cell, label_for(labels, raw) ?? raw);
        if (plan.cell === 'decimal') return rendered_cell(raw_cell, raw);
        if (plan.cell === 'bigint') {
            return rendered_cell(raw_cell, format_cell(plan, labels, raw_cell, BigInt(raw)));
        }
        return rendered_cell(raw_cell, format_cell(plan, labels, raw_cell, Number(raw)));
    }

    // ------------------------------------------------------------ raw reads

    protected override read_raw_range(
        start: number,
        end: number,
        columns: readonly number[],
    ): (RawCell | null)[][] {
        const count = end - start;
        if (count <= 0) return [];
        const rows: (RawCell | null)[][] = Array.from(
            { length: count }, () => new Array<RawCell | null>(columns.length),
        );
        if (columns.length === 0) return rows;
        this.read_bounded(start, count, columns, PARQUET_SCAN_BUDGET, (k, column, from, at, n) => {
            const plan = this.plans[columns[k]];
            for (let i = 0; i < n; i++) {
                rows[at + i][k] = this.raw_value(
                    plan, cell_at(column, from + i), start + at + i, columns[k],
                );
            }
        });
        return rows;
    }

    // ------------------------------------------------------------ sparse reads

    /**
     * The `readRowsAt` calls for sorted unique `rows` of strictly increasing
     * table `columns`: rows grouped so each call's first and last are at most
     * `block_rows` apart (inclusive), columns batched by their bounds over that
     * span; a column without a bound, or too large, is read alone in groups
     * spanning at most 256 rows.
     */
    private *sparse_calls(
        rows: readonly number[],
        columns: readonly number[],
    ): Generator<{ rows: number[]; positions: number[] }> {
        const position = new Map(columns.map((column, k) => [column, k]));
        for (const group of span_groups(rows, this.block_rows)) {
            const plan = this.plan_reads(
                columns, group[0], group[group.length - 1] + 1, PARQUET_BLOCK_BUDGET, false,
            );
            for (const batch of plan.batches) {
                yield { rows: group, positions: batch.map((column) => position.get(column)!) };
            }
            if (plan.alone.length === 0) continue;
            for (const small of span_groups(group, DECODE_WINDOW_ROWS)) {
                for (const column of plan.alone) {
                    yield { rows: small, positions: [position.get(column)!] };
                }
            }
        }
    }

    private read_rows_at(rows: readonly number[], columns: readonly number[]): TableCell[][] {
        const indices = columns.map((column) => this.plans[column].reader_index);
        return this.reading(() => this.open_reader().readRowsAt(rows, indices));
    }

    override read_rows_indexed(sheet_index: number, row_indices: ArrayLike<number>): IndexedRows {
        this.open_reader();
        this.assert_sheet(sheet_index);
        const requested = Array.from(row_indices);
        for (const row of requested) this.assert_row(row);
        if (requested.length === 0) return { rows: [] };
        const columns = this.all_columns;
        if (columns.length === 0) return { rows: requested.map(() => []) };
        const labels = columns.map((column) => this.labels_of(column));
        const materialized = new Map<number, (RenderedCell | null)[]>();
        const unique = sorted_unique(requested);
        for (const call of this.sparse_calls(unique, columns)) {
            const cells = this.read_rows_at(call.rows, call.positions.map((k) => columns[k]));
            call.rows.forEach((row, i) => {
                let out = materialized.get(row);
                if (out === undefined) {
                    out = new Array<RenderedCell | null>(columns.length);
                    materialized.set(row, out);
                }
                call.positions.forEach((k, j) => {
                    out[k] = this.render_value(
                        this.plans[columns[k]], labels[k], cells[i][j], row, columns[k],
                    );
                });
            });
        }
        return { rows: requested.map((row) => materialized.get(row)!) };
    }

    override async read_raw_columns_indexed_async(
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
        const materialized = new Map<number, (RawCell | null)[]>();
        for (const call of this.sparse_calls(sorted_unique(requested), columns)) {
            this.assert_async_active(epoch, is_cancelled);
            const cells = this.read_rows_at(call.rows, call.positions.map((k) => columns[k]));
            call.rows.forEach((row, i) => {
                let out = materialized.get(row);
                if (out === undefined) {
                    out = new Array<RawCell | null>(columns.length);
                    materialized.set(row, out);
                }
                call.positions.forEach((k, j) => {
                    out[k] = this.raw_value(this.plans[columns[k]], cells[i][j], row, columns[k]);
                });
            });
            await yield_to_event_loop();
            this.assert_async_active(epoch, is_cancelled);
        }
        return {
            rows: await this.project_indexed(
                requested, materialized, columns, column_indices,
                this.async_rows_per_chunk(columns.length), epoch, is_cancelled,
            ),
        };
    }
}

/** Row `i` of a decoded column, as `readRowsAt` gives it: a null is `MISSING["."]`. */
function cell_at(column: TableColumn, i: number): TableCell {
    switch (column.kind) {
        case 'number':
            return column.missing[i] ? missing_value(column.missing[i]) : column.values[i];
        case 'bigint':
            return column.missing[i] ? MISSING['.'] : column.values[i];
        case 'dictionary':
            return column.missing?.[i] ? MISSING['.'] : column.values[column.codes[i]];
        default:
            return column.missing?.[i] ? MISSING['.'] : column.values[i];
    }
}

function sorted_unique(rows: readonly number[]): number[] {
    return [...new Set(rows)].sort((a, b) => a - b);
}

/** Sorted `rows` in groups whose first and last are at most `span` rows apart, inclusive. */
function span_groups(rows: readonly number[], span: number): number[][] {
    const groups: number[][] = [];
    let group: number[] = [];
    for (const row of rows) {
        if (group.length > 0 && row - group[0] + 1 > span) {
            groups.push(group);
            group = [];
        }
        group.push(row);
    }
    if (group.length > 0) groups.push(group);
    return groups;
}

/** Read-only, buffer-backed Parquet source: `git:` URIs and compare originals. */
export class ParquetDataSource extends ParquetReaderSource {
    static async create(
        bytes: Uint8Array,
        options: ParquetSourceOptions = {},
    ): Promise<ParquetDataSource> {
        let reader: ParquetReader | undefined;
        try {
            assert_parquet_footer_length(bytes.subarray(Math.max(0, bytes.length - 8)), bytes.length);
            reader = openParquet(bytes, parquet_reader_options(options));
            assert_parquet_limits(reader);
            const readable = reader.variables.filter((variable) => variable.columnKind !== null);
            assert_safe_sheet_shape(create_workbook_budget(), reader.info.nobs, readable.length, 0);
            assert_value_label_limits(reader, readable, 'Parquet');
            return new ParquetDataSource(reader);
        } catch (error) {
            reader?.close();
            throw parquet_open_error(error);
        }
    }
}
