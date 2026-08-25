import { describe, expect, it, vi } from 'vitest';
import {
    DEFERRED_FILTER_IDENTITY,
    type ColumnFilterMetadata,
    type ColumnWindow,
    type DataSource,
    type RawCell,
    type RawColumnWindow,
    type RowWindow,
    type WorkbookMeta,
} from '../data-source/interface';
import type { ColumnAnalysis, ColumnAnalysisCache } from '../column-analysis';
import { compute_column_histogram } from '../histograms';
import {
    canonical_filter_identity_for_raw,
    FILTER_DISTINCT_VALUE_BYTE_LIMIT,
    FILTER_DISTINCT_VALUE_LIMIT,
} from '../types';

type HistogramCell = string | null | (RawCell & { raw: string });

function histogram_raw_cell(entry: HistogramCell): RawCell | null {
    if (entry === null) return null;
    return typeof entry === 'string' ? { raw: entry } : entry;
}

function deferred_histogram_cell(
    raw: string,
    raw_byte_length: number,
    resolve_key: () => Promise<string>,
): RawCell & { raw: string } {
    const cell: RawCell & { raw: string } = {
        raw,
        rawType: 'number',
        rawByteLength: raw_byte_length,
    };
    Object.defineProperty(cell, DEFERRED_FILTER_IDENTITY, {
        value: { cachedKey: () => undefined, resolveKey: resolve_key },
    });
    return cell;
}

class HistogramSource implements DataSource {
    readonly selected_columns: number[][] = [];
    readonly raw_ranges: { start: number; count: number; columns: number[] }[] = [];
    filter_metadata_requests = 0;
    constructor(
        private readonly values: HistogramCell[],
        private readonly filter_metadata?: ColumnFilterMetadata,
    ) {}
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
    read_raw_columns(
        _sheet: number,
        start: number,
        count: number,
        column_indices: readonly number[],
    ): RawColumnWindow {
        this.selected_columns.push([...column_indices]);
        this.raw_ranges.push({ start, count, columns: [...column_indices] });
        return {
            startRow: start,
            rows: this.values.slice(start, start + count).map((entry) =>
                column_indices.map(() => histogram_raw_cell(entry))),
        };
    }
    column_filter_metadata(): ColumnFilterMetadata | undefined {
        this.filter_metadata_requests += 1;
        return this.filter_metadata;
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
        expect(source.selected_columns).toEqual([[0]]);
    });

    it('returns one bin for a constant column and no bins without numeric values', async () => {
        await expect(compute_column_histogram(
            new HistogramSource(['4', '4', null]), 0, 0, () => false,
        )).resolves.toEqual({
            bins: [{ lo: 4, hi: 4, count: 2 }],
            columnKind: 'numeric',
            defaultCategorical: false,
            distinctValues: [{ value: '4' }, { value: null }],
            distinctValuesExceeded: false,
        });
        await expect(compute_column_histogram(
            new HistogramSource(['text', '', null]), 0, 0, () => false,
        )).resolves.toEqual({
            bins: [],
            columnKind: 'text',
            defaultCategorical: false,
            distinctValues: [{ value: 'text' }, { value: null }],
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

    it('keeps Stata missing tags in numeric columns without binning them', async () => {
        const histogram = await compute_column_histogram(
            new HistogramSource([
                { raw: '1', rawType: 'number' },
                { raw: '.a', rawType: 'number' },
                { raw: '2', rawType: 'number' },
            ]),
            0,
            0,
            () => false,
        );
        expect(histogram.columnKind).toBe('numeric');
        expect(histogram.bins.reduce((total, bin) => total + bin.count, 0)).toBe(2);
        expect(histogram.distinctValues).toEqual([
            { value: '1' },
            { value: '.a' },
            { value: '2' },
        ]);
    });

    it('plumbs generic source labels beside raw filter identities in one scan path', async () => {
        const labels = new Map([
            ['1', 'First'],
            ['2', 'Second'],
            ['3', 'First'],
        ]);
        const source = new HistogramSource(
            [
                { raw: '1', rawType: 'number' },
                { raw: '2', rawType: 'number' },
                { raw: '3', rawType: 'number' },
            ],
            {
                categoricalCodes: true,
                valueLabel: (raw) => labels.get(raw),
            },
        );
        const histogram = await compute_column_histogram(source, 0, 0, () => false);

        expect(histogram).toMatchObject({
            columnKind: 'numeric',
            defaultCategorical: true,
            distinctValues: [
                { value: '1', label: 'First' },
                { value: '2', label: 'Second' },
                { value: '3', label: 'First' },
            ],
        });
        expect(source.selected_columns).toEqual([[0]]);
        expect(source.filter_metadata_requests).toBe(1);
    });

    it('classifies mixed numeric/text and leading-zero identifiers as text', async () => {
        await expect(compute_column_histogram(
            new HistogramSource(['02139', '10001']), 0, 0, () => false,
        )).resolves.toMatchObject({ columnKind: 'text', bins: [] });
        await expect(compute_column_histogram(
            new HistogramSource(['1', 'label', '2']), 0, 0, () => false,
        )).resolves.toMatchObject({ columnKind: 'text' });
    });

    it('scans each source range once when text kind and distinct overflow are final', async () => {
        const values = [
            '1',
            'label',
            ...Array.from({ length: 3_999 }, (_, index) => String(index + 2)),
        ];
        const source = new HistogramSource(values);
        await expect(compute_column_histogram(
            source, 0, 0, () => false,
        )).resolves.toEqual({
            bins: [],
            columnKind: 'text',
            defaultCategorical: false,
            distinctValues: [],
            distinctValuesExceeded: true,
        });
        expect(source.raw_ranges).toEqual(Array.from(
            { length: Math.ceil(values.length / 128) },
            (_, index) => ({
                start: index * 128,
                count: Math.min(128, values.length - index * 128),
                columns: [0],
            }),
        ));
        expect(source.filter_metadata_requests).toBe(0);
    });

    it('checks raw byte budgets before identity and stops resolving after overflow', async () => {
        const first = vi.fn(async () => 'identity:first');
        const oversized = vi.fn(async () => 'identity:oversized');
        const after_overflow = vi.fn(async () => 'identity:after');
        const histogram = await compute_column_histogram(
            new HistogramSource([
                deferred_histogram_cell('1', 2, first),
                deferred_histogram_cell(
                    '2',
                    FILTER_DISTINCT_VALUE_BYTE_LIMIT + 1,
                    oversized,
                ),
                deferred_histogram_cell('3', 2, after_overflow),
            ]),
            0,
            0,
            () => false,
        );

        expect(histogram.columnKind).toBe('numeric');
        expect(histogram.distinctValuesExceeded).toBe(true);
        expect(histogram.distinctValues).toEqual([]);
        expect(first).toHaveBeenCalledTimes(1);
        expect(oversized).not.toHaveBeenCalled();
        expect(after_overflow).not.toHaveBeenCalled();
    });

    it('keeps deferred durable identity separate from its raw preview', async () => {
        const key = `stata-binary:sha256:${'a'.repeat(64)}:40`;
        const cell = deferred_histogram_cell('binary (40 bytes): aa…', 40, async () => key);
        cell.rawType = 'string';
        await expect(compute_column_histogram(
            new HistogramSource([cell]), 0, 0, () => false,
        )).resolves.toMatchObject({
            distinctValues: [{
                value: key,
                rawValue: 'binary (40 bytes): aa…',
            }],
            distinctValuesExceeded: false,
        });
    });

    it('separates a literal raw binary-identity spelling from the binary identity', async () => {
        const key = `stata-binary:sha256:${'a'.repeat(64)}:40`;
        const preview = 'binary (40 bytes): aa…';
        const histogram = await compute_column_histogram(
            new HistogramSource([
                key,
                {
                    raw: preview,
                    rawType: 'string',
                    rawByteLength: 40,
                    filterKey: key,
                },
            ]),
            0,
            0,
            () => false,
        );

        expect(histogram.distinctValues).toEqual([
            { value: canonical_filter_identity_for_raw(key), rawValue: key },
            { value: key, rawValue: preview },
        ]);
        expect(new Set(histogram.distinctValues.map((option) => option.value)).size)
            .toBe(2);
    });

    it('resolves a deferred duplicate even when the distinct-entry cap is full', async () => {
        const resolve_duplicate = vi.fn(async () => 'v0');
        const duplicate = deferred_histogram_cell(
            'binary (1 byte): 00',
            1,
            resolve_duplicate,
        );
        duplicate.rawType = 'string';
        const histogram = await compute_column_histogram(
            new HistogramSource([
                ...Array.from(
                    { length: FILTER_DISTINCT_VALUE_LIMIT },
                    (_, index) => `v${index}`,
                ),
                duplicate,
            ]),
            0,
            0,
            () => false,
        );

        expect(resolve_duplicate).toHaveBeenCalledOnce();
        expect(histogram.distinctValuesExceeded).toBe(false);
        expect(histogram.distinctValues).toHaveLength(FILTER_DISTINCT_VALUE_LIMIT);
    });

    it('bounds repeated deferred duplicate resolution by count', async () => {
        const resolve_duplicate = vi.fn(async () => 'same-identity');
        const histogram = await compute_column_histogram(
            new HistogramSource(Array.from(
                { length: FILTER_DISTINCT_VALUE_LIMIT + 1 },
                () => deferred_histogram_cell('1', 1, resolve_duplicate),
            )),
            0,
            0,
            () => false,
        );

        expect(resolve_duplicate).toHaveBeenCalledTimes(FILTER_DISTINCT_VALUE_LIMIT);
        expect(histogram.distinctValuesExceeded).toBe(true);
        expect(histogram.distinctValues).toEqual([]);
    });

    it('bounds deferred identity resolution by aggregate source raw bytes', async () => {
        const resolve_duplicate = vi.fn(async () => 'same-identity');
        const raw_bytes = Math.floor(FILTER_DISTINCT_VALUE_BYTE_LIMIT / 2) + 1;
        const histogram = await compute_column_histogram(
            new HistogramSource([
                deferred_histogram_cell('1', raw_bytes, resolve_duplicate),
                deferred_histogram_cell('1', raw_bytes, resolve_duplicate),
            ]),
            0,
            0,
            () => false,
        );

        expect(resolve_duplicate).toHaveBeenCalledOnce();
        expect(histogram.distinctValuesExceeded).toBe(true);
        expect(histogram.distinctValues).toEqual([]);
    });

    it('charges serialized identity and raw-preview UTF-8 bytes together', async () => {
        const half = Math.floor(FILTER_DISTINCT_VALUE_BYTE_LIMIT / 2);
        const identity = `identity:${'i'.repeat(half)}`;
        const preview = `preview:${'p'.repeat(half)}`;
        const histogram = await compute_column_histogram(
            new HistogramSource([{
                raw: preview,
                rawType: 'string',
                rawByteLength: Buffer.byteLength(preview, 'utf8'),
                filterKey: identity,
            }]),
            0,
            0,
            () => false,
        );

        expect(histogram.distinctValuesExceeded).toBe(true);
        expect(histogram.distinctValues).toEqual([]);
    });

    it('charges source labels by their serialized UTF-8 bytes', async () => {
        const label = '€'.repeat(
            Math.floor(FILTER_DISTINCT_VALUE_BYTE_LIMIT / 3) + 1,
        );
        const histogram = await compute_column_histogram(
            new HistogramSource(['1'], {
                valueLabel: () => label,
            }),
            0,
            0,
            () => false,
        );

        expect(histogram.distinctValuesExceeded).toBe(true);
        expect(histogram.distinctValues).toEqual([]);
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
            defaultCategorical: false,
            // Exact raw values in first-seen order; whitespace-only collapses
            // to the single blank (null) entry, "a " stays distinct from "a".
            distinctValues: [
                { value: 'b' },
                { value: 'a' },
                { value: null },
                { value: 'a ' },
            ],
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
        expect(histogram.distinctValues).toEqual([
            { value: '1' },
            { value: '2' },
            { value: '2.0' },
        ]);
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
            defaultCategorical: false,
            distinctValues: [{ value: '2026-07-21' }],
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
            defaultCategorical: false,
            distinctValues: [
                { value: '2026-07-21' },
                { value: '2026-07-22' },
            ],
            distinctValuesExceeded: false,
        });
    });

    it('reuses a completed shared analysis without rereading the source', async () => {
        const source = new HistogramSource(Array.from(
            { length: 300 },
            (_, index) => String(index),
        ));
        const entries = new Map<string, ColumnAnalysis>();
        const cache: ColumnAnalysisCache = {
            get: (sheet, column) => entries.get(`${sheet}:${column}`),
            set: (sheet, column, analysis) => {
                entries.set(`${sheet}:${column}`, analysis);
            },
        };

        await compute_column_histogram(source, 0, 0, () => false, cache);
        const reads_after_first = source.raw_ranges.length;
        await compute_column_histogram(source, 0, 0, () => false, cache);

        expect(reads_after_first).toBe(3);
        expect(source.raw_ranges).toHaveLength(reads_after_first);
    });

    it('finishes request-locally when a cache rejects analysis retention', async () => {
        const source = new HistogramSource(Array.from(
            { length: 300 },
            (_, index) => String(index),
        ));
        const reject = vi.fn();
        const cache: ColumnAnalysisCache = {
            get: () => undefined,
            set: reject,
        };

        const first = await compute_column_histogram(
            source, 0, 0, () => false, cache,
        );
        expect(first.bins.reduce((total, bin) => total + bin.count, 0)).toBe(300);
        expect(reject).toHaveBeenCalledOnce();
        expect(source.raw_ranges).toHaveLength(3);

        await compute_column_histogram(source, 0, 0, () => false, cache);
        expect(reject).toHaveBeenCalledTimes(2);
        expect(source.raw_ranges).toHaveLength(6);
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
