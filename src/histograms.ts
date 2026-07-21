import type { DataSource, RenderedCell } from './data-source/interface';
import { read_source_columns } from './data-source/interface';
import type { FilterColumnKind, HistogramBin } from './types';

const BIN_COUNT = 50;
const ROW_BATCH_SIZE = 1_000;

export interface ColumnHistogram {
    bins: HistogramBin[];
    columnKind: FilterColumnKind;
}

function finite_numeric_value(cell: RenderedCell | null | undefined): number | undefined {
    const raw = cell?.raw;
    if (raw === null || raw === undefined || raw.trim().length === 0) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

function raw_value(cell: RenderedCell | null | undefined): string | null {
    const raw = cell?.raw;
    // Match finite_numeric_value: whitespace-only cells are empty, not text.
    return raw === null || raw === undefined || raw.trim().length === 0
        ? null
        : raw;
}

function canonical_numeric_string(value: string): boolean {
    if (value.trim() !== value) return false;
    if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
        return false;
    }
    return Number.isFinite(Number(value));
}

/**
 * Align with transform column scanning (acquire_transform_column):
 * CSV cells are rawType:'string', but pure canonical number text is still numeric.
 * Dates are never numeric here; classify_value maps them to orderedText.
 */
function cell_can_be_numeric(cell: RenderedCell | null | undefined): boolean {
    const raw = raw_value(cell);
    if (raw === null || cell?.rawType === 'boolean' || cell?.rawType === 'date') {
        return false;
    }
    if (cell?.rawType === 'number') return Number.isFinite(Number(raw));
    return canonical_numeric_string(raw);
}

function iso_date_string(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-][0-2]\d:?[0-5]\d)?)?$/.test(value)) {
        return false;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp);
}

function classify_value(
    cell: RenderedCell | null | undefined,
): 'numeric' | 'orderedText' | 'text' | undefined {
    const raw = raw_value(cell);
    if (raw === null) return undefined;
    if (cell?.rawType === 'date' || iso_date_string(raw)) return 'orderedText';
    if (cell_can_be_numeric(cell)) return 'numeric';
    return 'text';
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
    for (let start = 0; start < sheet.rowCount; start += ROW_BATCH_SIZE) {
        if (is_cancelled()) throw abort_error();
        const window = read_source_columns(
            source,
            sheet_index,
            start,
            Math.min(ROW_BATCH_SIZE, sheet.rowCount - start),
            [column_index],
        );
        for (const row of window.rows) {
            const cell = row[0];
            const classified = classify_value(cell);
            if (classified !== undefined) {
                columnKind = combine_kind(columnKind, classified);
            }
            const value = cell_can_be_numeric(cell) ? finite_numeric_value(cell) : undefined;
            if (value === undefined) continue;
            min = Math.min(min, value);
            max = Math.max(max, value);
            count += 1;
        }
        await yield_to_host();
    }

    if (is_cancelled()) throw abort_error();
    if (columnKind !== 'numeric') return { bins: [], columnKind };
    if (count === 0) return { bins: [], columnKind };
    if (min === max) return { bins: [{ lo: min, hi: max, count }], columnKind };

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
        const window = read_source_columns(
            source,
            sheet_index,
            start,
            Math.min(ROW_BATCH_SIZE, sheet.rowCount - start),
            [column_index],
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
    return { bins, columnKind };
}
