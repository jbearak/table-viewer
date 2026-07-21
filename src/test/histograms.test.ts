import { describe, expect, it, vi } from 'vitest';
import type { DataSource, RowWindow, WorkbookMeta } from '../data-source/interface';
import { compute_column_histogram } from '../histograms';

class HistogramSource implements DataSource {
    constructor(private readonly values: (string | null)[]) {}
    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1', rowCount: this.values.length, columnCount: 1,
                merges: [], hasFormatting: false,
            }],
        };
    }
    read_rows(_sheet: number, start: number, count: number): RowWindow {
        return {
            startRow: start,
            rows: this.values.slice(start, start + count).map((raw) => [
                raw === null ? null : { raw, formatted: raw, bold: false, italic: false },
            ]),
        };
    }
    close(): void {}
}

describe('compute_column_histogram', () => {
    it('builds 50 bounded bins and ignores blank, nonnumeric, and nonfinite values', async () => {
        const bins = await compute_column_histogram(
            new HistogramSource(['0', '25', '50', '75', '100', null, '', 'word', 'Infinity']),
            0,
            0,
            () => false,
        );
        expect(bins).toHaveLength(50);
        expect(bins[0].lo).toBe(0);
        expect(bins.at(-1)?.hi).toBe(100);
        expect(bins.reduce((total, bin) => total + bin.count, 0)).toBe(5);
    });

    it('returns one bin for a constant column and no bins without numeric values', async () => {
        await expect(compute_column_histogram(
            new HistogramSource(['4', '4', null]), 0, 0, () => false,
        )).resolves.toEqual([{ lo: 4, hi: 4, count: 2 }]);
        await expect(compute_column_histogram(
            new HistogramSource(['text', '', null]), 0, 0, () => false,
        )).resolves.toEqual([]);
    });

    it('checks cancellation between bounded row reads', async () => {
        const cancelled = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
        await expect(compute_column_histogram(
            new HistogramSource(Array.from({ length: 1_001 }, (_, i) => String(i))),
            0,
            0,
            cancelled,
        )).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('keeps extreme-range boundaries finite and monotone', async () => {
        const bins = await compute_column_histogram(
            new HistogramSource([
                String(-Number.MAX_VALUE),
                '0',
                String(Number.MAX_VALUE),
            ]),
            0,
            0,
            () => false,
        );
        expect(bins).toHaveLength(50);
        expect(bins[0].lo).toBe(-Number.MAX_VALUE);
        expect(bins.at(-1)?.hi).toBe(Number.MAX_VALUE);
        expect(bins.reduce((total, bin) => total + bin.count, 0)).toBe(3);
        for (let index = 0; index < bins.length; index += 1) {
            expect(Number.isFinite(bins[index].lo)).toBe(true);
            expect(Number.isFinite(bins[index].hi)).toBe(true);
            expect(bins[index].lo).toBeLessThanOrEqual(bins[index].hi);
            if (index > 0) expect(bins[index - 1].hi).toBe(bins[index].lo);
        }
    });
});
