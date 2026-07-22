import { describe, expect, it, vi } from 'vitest';
import type {
    ColumnWindow,
    DataSource,
    RowWindow,
    WorkbookMeta,
} from '../data-source/interface';
import { compute_column_histogram } from '../histograms';

type HistogramCell = string | null | { raw: string; rawType?: 'string' | 'number' | 'boolean' | 'date' | 'empty' };

class HistogramSource implements DataSource {
    readonly selected_columns: number[][] = [];
    constructor(private readonly values: HistogramCell[]) {}
    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1', rowCount: this.values.length,
                sourceRowCount: this.values.length, columnCount: 1,
                merges: [], hasFormatting: false,
            }],
        };
    }
    read_rows(_sheet: number, start: number, count: number): RowWindow {
        return {
            startRow: start,
            rows: this.values.slice(start, start + count).map((entry) => {
                if (entry === null) return [null];
                const raw = typeof entry === 'string' ? entry : entry.raw;
                const rawType = typeof entry === 'string' ? undefined : entry.rawType;
                return [{ raw, formatted: raw, bold: false, italic: false, rawType }];
            }),
        };
    }
    read_columns(
        _sheet: number,
        start: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow {
        this.selected_columns.push([...column_indices]);
        const rows = this.values.slice(start, start + count).map((entry) => {
            const cell = entry === null
                ? null
                : (() => {
                    const raw = typeof entry === 'string' ? entry : entry.raw;
                    const rawType = typeof entry === 'string' ? undefined : entry.rawType;
                    return { raw, formatted: raw, bold: false, italic: false, rawType };
                })();
            return column_indices.map(() => cell);
        });
        return { startRow: start, rows };
    }
    close(): void {}
}

describe('compute_column_histogram', () => {
    it('builds 50 bounded bins and ignores blank values', async () => {
        const source = new HistogramSource([
            '0', '25', '50', '75', '100', null, '',
        ]);
        const histogram = await compute_column_histogram(
            source,
            0,
            0,
            () => false,
        );
        expect(histogram.columnKind).toBe('numeric');
        expect(histogram.bins).toHaveLength(50);
        expect(histogram.bins[0].lo).toBe(0);
        expect(histogram.bins.at(-1)?.hi).toBe(100);
        expect(histogram.bins.reduce((total, bin) => total + bin.count, 0)).toBe(5);
        expect(source.selected_columns).toEqual([[0], [0]]);
    });

    it('returns one bin for a constant column and no bins without numeric values', async () => {
        await expect(compute_column_histogram(
            new HistogramSource(['4', '4', null]), 0, 0, () => false,
        )).resolves.toEqual({
            bins: [{ lo: 4, hi: 4, count: 2 }],
            columnKind: 'numeric',
            distinctValues: ['4', null],
            distinctValuesExceeded: false,
        });
        await expect(compute_column_histogram(
            new HistogramSource(['text', '', null]), 0, 0, () => false,
        )).resolves.toEqual({
            bins: [],
            columnKind: 'text',
            distinctValues: ['text', null],
            distinctValuesExceeded: false,
        });
    });



    it('treats CSV-like string rawType numbers as numeric and ignores whitespace-only cells', async () => {
        await expect(compute_column_histogram(
            new HistogramSource([
                { raw: '1', rawType: 'string' },
                { raw: '2.5', rawType: 'string' },
                { raw: '   ', rawType: 'string' },
                { raw: '', rawType: 'string' },
                null,
            ]),
            0,
            0,
            () => false,
        )).resolves.toMatchObject({
            columnKind: 'numeric',
            bins: expect.any(Array),
        });
        const histogram = await compute_column_histogram(
            new HistogramSource([
                { raw: '0', rawType: 'string' },
                { raw: '100', rawType: 'string' },
                { raw: '	', rawType: 'string' },
            ]),
            0,
            0,
            () => false,
        );
        expect(histogram.columnKind).toBe('numeric');
        expect(histogram.bins.length).toBeGreaterThan(0);
        expect(histogram.bins.reduce((total, bin) => total + bin.count, 0)).toBe(2);
    });

    it('classifies mixed numeric/text and leading-zero identifiers as text', async () => {
        await expect(compute_column_histogram(
            new HistogramSource(['02139', '10001']), 0, 0, () => false,
        )).resolves.toMatchObject({ columnKind: 'text', bins: [] });
        await expect(compute_column_histogram(
            new HistogramSource(['1', 'label', '2']), 0, 0, () => false,
        )).resolves.toMatchObject({ columnKind: 'text' });
    });

    it('stops scanning once text kind and distinct overflow are both final', async () => {
        const source = new HistogramSource([
            '1',
            'label',
            ...Array.from({ length: 3_999 }, (_, index) => String(index + 2)),
        ]);
        await expect(compute_column_histogram(
            source, 0, 0, () => false,
        )).resolves.toEqual({
            bins: [],
            columnKind: 'text',
            distinctValues: [],
            distinctValuesExceeded: true,
        });
        // A complete distinct list requires the second batch; the remaining
        // two batches are skipped once both facts are final.
        expect(source.selected_columns).toEqual([[0], [0]]);
    });

    it('keeps a complete distinct list for text columns under the cap', async () => {
        const source = new HistogramSource([
            'b', 'a', 'b', '  ', 'a ', null,
        ]);
        await expect(compute_column_histogram(
            source, 0, 0, () => false,
        )).resolves.toEqual({
            bins: [],
            columnKind: 'text',
            // Exact raw values in first-seen order; whitespace-only collapses
            // to the single blank (null) entry, "a " stays distinct from "a".
            distinctValues: ['b', 'a', null, 'a '],
            distinctValuesExceeded: false,
        });
    });

    it('returns exactly the cap of distinct values but not one more', async () => {
        const under = await compute_column_histogram(
            new HistogramSource(
                Array.from({ length: 1_000 }, (_, i) => `v${i}`),
            ),
            0, 0, () => false,
        );
        expect(under.distinctValuesExceeded).toBe(false);
        expect(under.distinctValues).toHaveLength(1_000);

        const over = await compute_column_histogram(
            new HistogramSource(
                Array.from({ length: 1_001 }, (_, i) => `v${i}`),
            ),
            0, 0, () => false,
        );
        expect(over.distinctValuesExceeded).toBe(true);
        expect(over.distinctValues).toEqual([]);
    });

    it('counts blanks as one distinct entry toward the cap', async () => {
        const histogram = await compute_column_histogram(
            new HistogramSource([
                null,
                ...Array.from({ length: 1_000 }, (_, i) => `v${i}`),
            ]),
            0, 0, () => false,
        );
        expect(histogram.distinctValuesExceeded).toBe(true);
        expect(histogram.distinctValues).toEqual([]);
    });

    it('produces numeric bins and distinct values from the same scan', async () => {
        const histogram = await compute_column_histogram(
            new HistogramSource(['1', '2', '2.0', '1']),
            0, 0, () => false,
        );
        expect(histogram.columnKind).toBe('numeric');
        expect(histogram.bins.length).toBeGreaterThan(0);
        // Distinct values stay exact raw strings: '2' and '2.0' differ.
        expect(histogram.distinctValues).toEqual(['1', '2', '2.0']);
    });

    it('classifies raw and ISO date columns as ordered text', async () => {
        await expect(compute_column_histogram(
            new HistogramSource([{ raw: '2026-07-21', rawType: 'date' }]),
            0,
            0,
            () => false,
        )).resolves.toEqual({
            bins: [],
            columnKind: 'orderedText',
            distinctValues: ['2026-07-21'],
            distinctValuesExceeded: false,
        });
        await expect(compute_column_histogram(
            new HistogramSource(['2026-07-21', '2026-07-22']),
            0,
            0,
            () => false,
        )).resolves.toEqual({
            bins: [],
            columnKind: 'orderedText',
            distinctValues: ['2026-07-21', '2026-07-22'],
            distinctValuesExceeded: false,
        });
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
        const histogram = await compute_column_histogram(
            new HistogramSource([
                String(-Number.MAX_VALUE),
                '0',
                String(Number.MAX_VALUE),
            ]),
            0,
            0,
            () => false,
        );
        const { bins } = histogram;
        expect(histogram.columnKind).toBe('numeric');
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
