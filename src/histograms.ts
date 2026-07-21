import type { DataSource, RenderedCell } from './data-source/interface';
import type { HistogramBin } from './types';

const BIN_COUNT = 50;
const ROW_BATCH_SIZE = 1_000;

function finite_numeric_value(cell: RenderedCell | null | undefined): number | undefined {
    const raw = cell?.raw;
    if (raw === null || raw === undefined || raw.trim().length === 0) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
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
): Promise<HistogramBin[]> {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet || column_index < 0 || column_index >= sheet.columnCount) {
        throw new RangeError('Histogram column is out of range.');
    }

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (let start = 0; start < sheet.rowCount; start += ROW_BATCH_SIZE) {
        if (is_cancelled()) throw abort_error();
        const window = source.read_rows(
            sheet_index,
            start,
            Math.min(ROW_BATCH_SIZE, sheet.rowCount - start),
        );
        for (const row of window.rows) {
            const value = finite_numeric_value(row[column_index]);
            if (value === undefined) continue;
            min = Math.min(min, value);
            max = Math.max(max, value);
            count += 1;
        }
        await yield_to_host();
    }

    if (is_cancelled()) throw abort_error();
    if (count === 0) return [];
    if (min === max) return [{ lo: min, hi: max, count }];

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
        const window = source.read_rows(
            sheet_index,
            start,
            Math.min(ROW_BATCH_SIZE, sheet.rowCount - start),
        );
        for (const row of window.rows) {
            const value = finite_numeric_value(row[column_index]);
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
    return bins;
}
