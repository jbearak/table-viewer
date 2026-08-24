import type {
    ColumnFilterMetadata,
    DataSource,
    RawCell,
} from './data-source/interface';
import { read_source_raw_columns_async } from './data-source/interface';
import type { FilterColumnKind, FilterValueOption, HistogramBin } from './types';
import {
    FILTER_DISTINCT_VALUE_BYTE_LIMIT,
    FILTER_DISTINCT_VALUE_LIMIT,
} from './types';
import {
    cell_can_be_numeric,
    filter_value,
    raw_value,
} from './transform-values';

const BIN_COUNT = 50;
const ROW_BATCH_SIZE = 1_000;

export interface ColumnHistogram {
    bins: HistogramBin[];
    columnKind: FilterColumnKind;
    /** Semantic source metadata may prefer the categorical checklist even when
     *  storage is numeric. This is independent of the Formatting toggle. */
    defaultCategorical: boolean;
    /** Exact canonical identities in first-seen source order, paired with
     * display-only raw previews and labels. Empty when either distinct cap is hit. */
    distinctValues: FilterValueOption[];
    distinctValuesExceeded: boolean;
}

interface DistinctValues {
    /** Identity -> display-safe raw value. Ordinary values map to themselves. */
    readonly entries: Map<string | null, string | null>;
    byteCount: number;
}

function finite_numeric_value(cell: RawCell | null | undefined): number | undefined {
    const raw = cell?.raw;
    if (raw === null || raw === undefined || raw.trim().length === 0) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

function iso_date_string(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-][0-2]\d:?[0-5]\d)?)?$/.test(value)) {
        return false;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp);
}

type ClassifiedValue =
    | { kind: 'numeric'; numericValue?: number }
    | { kind: 'orderedText' | 'text' }
    | undefined;

function classify_value(
    cell: RawCell | null | undefined,
): ClassifiedValue {
    const raw = raw_value(cell);
    if (raw === null) return undefined;
    if (cell?.rawType === 'date' || iso_date_string(raw)) {
        return { kind: 'orderedText' };
    }
    if (cell_can_be_numeric(cell)) {
        const numericValue = Number(raw);
        return Number.isFinite(numericValue)
            ? { kind: 'numeric', numericValue }
            : { kind: 'numeric' };
    }
    return { kind: 'text' };
}

function combine_kind(
    current: FilterColumnKind,
    next: 'numeric' | 'orderedText' | 'text',
): FilterColumnKind {
    if (current === 'unknown') return next;
    return current === next ? current : 'text';
}

async function yield_to_host(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function abort_error(): Error {
    const error = new Error('Histogram computation was cancelled.');
    error.name = 'AbortError';
    return error;
}

function raw_storage_bytes(
    cell: RawCell | null | undefined,
    raw: string | null,
): number {
    if (raw === null) return 0;
    return cell?.rawByteLength ?? raw.length * 2;
}

function add_distinct_value(
    distinct: DistinctValues,
    cell: RawCell | null | undefined,
): boolean {
    const raw = raw_value(cell);
    const bytes = raw_storage_bytes(cell, raw);
    // A bounded preview must not trick the checklist into hashing or retaining a
    // source value whose actual identity cannot fit in the transfer budget.
    if (bytes > FILTER_DISTINCT_VALUE_BYTE_LIMIT) return false;
    const identity = filter_value(cell);
    if (distinct.entries.has(identity)) return true;
    if (
        distinct.entries.size === FILTER_DISTINCT_VALUE_LIMIT
        || distinct.byteCount + bytes > FILTER_DISTINCT_VALUE_BYTE_LIMIT
    ) return false;
    distinct.entries.set(identity, raw);
    distinct.byteCount += bytes;
    return true;
}

/**
 * Build a bounded, uniform-width histogram for one source column.
 *
 * This intentionally scans only on demand. It uses two passes so memory stays
 * bounded by the 50 bins rather than the number of source rows, and yields
 * between row batches so source/receiver/editor cancellation can take effect.
 */
export async function compute_column_histogram(
    source: DataSource,
    sheet_index: number,
    column_index: number,
    is_cancelled: () => boolean,
): Promise<ColumnHistogram> {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet || column_index < 0 || column_index >= sheet.columnCount) {
        throw new RangeError('Histogram column is out of range.');
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;
    let columnKind: FilterColumnKind = 'unknown';
    let distinct: DistinctValues | null = { entries: new Map(), byteCount: 0 };
    for (let start = 0; start < sheet.rowCount; start += ROW_BATCH_SIZE) {
        if (is_cancelled()) throw abort_error();
        const window = await read_source_raw_columns_async(
            source,
            sheet_index,
            start,
            Math.min(ROW_BATCH_SIZE, sheet.rowCount - start),
            [column_index],
            is_cancelled,
        );
        for (const row of window.rows) {
            if (distinct !== null && !add_distinct_value(distinct, row[0])) {
                // Release retained strings; a partial list is never sent.
                distinct = null;
            }
            const classified = classify_value(row[0]);
            if (classified === undefined) continue;
            columnKind = combine_kind(columnKind, classified.kind);
            // A text column has no bins; once the distinct list has also
            // overflowed nothing further can change, so stop scanning.
            if (columnKind === 'text' && distinct === null) {
                return build_result(
                    [],
                    columnKind,
                    null,
                    source,
                    sheet_index,
                    column_index,
                    is_cancelled,
                );
            }
            if (
                classified.kind !== 'numeric'
                || classified.numericValue === undefined
            ) continue;
            const value = classified.numericValue;
            min = Math.min(min, value);
            max = Math.max(max, value);
            count += 1;
        }
        await yield_to_host();
    }

    if (is_cancelled()) throw abort_error();
    if (columnKind !== 'numeric' || count === 0) {
        return build_result(
            [],
            columnKind,
            distinct,
            source,
            sheet_index,
            column_index,
            is_cancelled,
        );
    }
    if (min === max) {
        return build_result(
            [{ lo: min, hi: max, count }],
            columnKind,
            distinct,
            source,
            sheet_index,
            column_index,
            is_cancelled,
        );
    }

    const span = max - min;
    const boundary = (index: number) => {
        const fraction = index / BIN_COUNT;
        return Number.isFinite(span)
            ? min + span * fraction
            : min * (1 - fraction) + max * fraction;
    };
    const bins = Array.from({ length: BIN_COUNT }, (_, index): HistogramBin => ({
        lo: boundary(index),
        hi: index === BIN_COUNT - 1 ? max : boundary(index + 1),
        count: 0,
    }));
    for (let start = 0; start < sheet.rowCount; start += ROW_BATCH_SIZE) {
        if (is_cancelled()) throw abort_error();
        const window = await read_source_raw_columns_async(
            source,
            sheet_index,
            start,
            Math.min(ROW_BATCH_SIZE, sheet.rowCount - start),
            [column_index],
            is_cancelled,
        );
        for (const row of window.rows) {
            const value = finite_numeric_value(row[0]);
            if (value === undefined) continue;
            const fraction = Number.isFinite(span)
                ? (value - min) / span
                : (value / 2 - min / 2) / (max / 2 - min / 2);
            const index = Math.max(
                0,
                Math.min(BIN_COUNT - 1, Math.floor(fraction * BIN_COUNT)),
            );
            bins[index].count += 1;
        }
        await yield_to_host();
    }
    if (is_cancelled()) throw abort_error();
    return build_result(
        bins,
        columnKind,
        distinct,
        source,
        sheet_index,
        column_index,
        is_cancelled,
    );
}

async function build_result(
    bins: HistogramBin[],
    columnKind: FilterColumnKind,
    distinct: DistinctValues | null,
    source: DataSource,
    sheet_index: number,
    column_index: number,
    is_cancelled: () => boolean,
): Promise<ColumnHistogram> {
    const metadata: ColumnFilterMetadata | undefined = distinct === null
        ? undefined
        : source.column_filter_metadata_async
            ? await source.column_filter_metadata_async(
                sheet_index,
                column_index,
                is_cancelled,
            )
            : source.column_filter_metadata?.(sheet_index, column_index);
    if (is_cancelled()) throw abort_error();

    let options: FilterValueOption[] = [];
    let exceeded = distinct === null;
    if (distinct !== null) {
        let serialized_bytes = distinct.byteCount;
        for (const [value, raw] of distinct.entries) {
            if (value === null) {
                options.push({ value });
                continue;
            }
            const option: FilterValueOption = { value };
            if (raw !== value && raw !== null) option.rawValue = raw;
            const label = raw === null ? undefined : metadata?.valueLabel?.(raw);
            if (label !== undefined) {
                serialized_bytes += label.length * 2;
                option.label = label;
            }
            if (serialized_bytes > FILTER_DISTINCT_VALUE_BYTE_LIMIT) {
                options = [];
                exceeded = true;
                break;
            }
            options.push(option);
        }
    }
    return {
        bins,
        columnKind,
        defaultCategorical: metadata?.categoricalCodes === true,
        distinctValues: options,
        distinctValuesExceeded: exceeded,
    };
}
