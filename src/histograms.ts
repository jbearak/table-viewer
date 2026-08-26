import { Buffer } from 'node:buffer';
import type {
    ColumnFilterMetadata,
    DataSource,
} from './data-source/interface';
import {
    acquire_column_analysis,
    type ColumnAnalysisCache,
    type ColumnAnalysisDistinct,
} from './column-analysis';
import type { FilterColumnKind, FilterValueOption, HistogramBin } from './types';
import { FILTER_DISTINCT_VALUE_BYTE_LIMIT } from './types';

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

function finite_numeric_value(raw: string | null | undefined): number | undefined {
    if (raw === null || raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

async function yield_to_host(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function abort_error(): Error {
    const error = new Error('Histogram computation was cancelled.');
    error.name = 'AbortError';
    return error;
}

function utf8_bytes(value: string): number {
    return Buffer.byteLength(value, 'utf8');
}

/**
 * Build a bounded, uniform-width histogram for one source column.
 *
 * Source values are acquired once through the shared column analysis. Numeric
 * bins iterate its normalized row values in memory, and retained analyses are
 * bounded by the caller-owned cache rather than by this request.
 */
export async function compute_column_histogram(
    source: DataSource,
    sheet_index: number,
    column_index: number,
    is_cancelled: () => boolean,
    analysis_cache?: ColumnAnalysisCache,
): Promise<ColumnHistogram> {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet || column_index < 0 || column_index >= sheet.columnCount) {
        throw new RangeError('Histogram column is out of range.');
    }
    const analysis = await acquire_column_analysis(
        source,
        sheet_index,
        column_index,
        sheet.rowCount,
        'bounded',
        analysis_cache,
        is_cancelled,
    );
    if (is_cancelled()) throw abort_error();

    const summary = analysis.numericSummary;
    if (analysis.columnKind !== 'numeric' || summary === undefined) {
        return build_result(
            [],
            analysis.columnKind,
            analysis.distinct,
            source,
            sheet_index,
            column_index,
            is_cancelled,
        );
    }
    if (summary.min === summary.max) {
        return build_result(
            [{ lo: summary.min, hi: summary.max, count: summary.count }],
            analysis.columnKind,
            analysis.distinct,
            source,
            sheet_index,
            column_index,
            is_cancelled,
        );
    }

    const span = summary.max - summary.min;
    const boundary = (index: number) => {
        const fraction = index / BIN_COUNT;
        return Number.isFinite(span)
            ? summary.min + span * fraction
            : summary.min * (1 - fraction) + summary.max * fraction;
    };
    const bins = Array.from({ length: BIN_COUNT }, (_, index): HistogramBin => ({
        lo: boundary(index),
        hi: index === BIN_COUNT - 1 ? summary.max : boundary(index + 1),
        count: 0,
    }));
    for (let start = 0; start < analysis.values.length; start += ROW_BATCH_SIZE) {
        if (is_cancelled()) throw abort_error();
        const end = Math.min(start + ROW_BATCH_SIZE, analysis.values.length);
        for (let row = start; row < end; row += 1) {
            const value = finite_numeric_value(analysis.values[row]);
            if (value === undefined) continue;
            const fraction = Number.isFinite(span)
                ? (value - summary.min) / span
                : (value / 2 - summary.min / 2)
                    / (summary.max / 2 - summary.min / 2);
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
        analysis.columnKind,
        analysis.distinct,
        source,
        sheet_index,
        column_index,
        is_cancelled,
    );
}

async function build_result(
    bins: HistogramBin[],
    columnKind: FilterColumnKind,
    distinct: ColumnAnalysisDistinct,
    source: DataSource,
    sheet_index: number,
    column_index: number,
    is_cancelled: () => boolean,
): Promise<ColumnHistogram> {
    const metadata: ColumnFilterMetadata | undefined = distinct.exceeded
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
    let exceeded = distinct.exceeded;
    if (!distinct.exceeded) {
        let serialized_bytes = distinct.serializedByteCount;
        for (const entry of distinct.entries) {
            const { value, rawValue } = entry;
            if (value === null) {
                options.push({ value });
                continue;
            }
            const option: FilterValueOption = { value };
            if (rawValue !== value && rawValue !== null) option.rawValue = rawValue;
            const label = rawValue === null
                ? undefined
                : metadata?.valueLabel?.(rawValue);
            if (label !== undefined) {
                serialized_bytes += utf8_bytes(label);
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
