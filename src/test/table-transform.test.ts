import { describe, expect, it, vi } from 'vitest';
import type {
    ColumnWindow,
    DataSource,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from '../data-source/interface';
import {
    compare_cells,
    compute_transform,
    matches_filter,
    transformed_window,
} from '../table-transform';
import type { FilterEntry, SheetTransformState } from '../types';
import type {
    CachedTransformColumn,
    TransformColumnCache,
    TransformSortInstrumentation,
} from '../table-transform';

const cell = (
    raw: string,
    rawType: RenderedCell['rawType'] = 'string',
): RenderedCell => ({
    raw,
    formatted: raw,
    bold: false,
    italic: false,
    rawType,
});

class Source implements DataSource {
    read_calls = 0;
    materialized_cells = 0;
    readonly selected_columns: number[][] = [];

    constructor(
        readonly rows: (RenderedCell | null)[][],
        readonly merges: WorkbookMeta['sheets'][number]['merges'] = [],
    ) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: this.rows.length,
                columnCount: Math.max(0, ...this.rows.map((row) => row.length)),
                merges: this.merges,
                hasFormatting: false,
            }],
        };
    }

    read_rows(_sheet: number, start: number, count: number): RowWindow {
        this.read_calls += 1;
        const rows = this.rows.slice(start, start + count);
        this.materialized_cells += rows.reduce((total, row) => total + row.length, 0);
        return {
            startRow: start,
            rows,
        };
    }

    read_columns(
        _sheet: number,
        start: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow {
        this.read_calls += 1;
        this.selected_columns.push([...column_indices]);
        const rows = this.rows.slice(start, start + count).map((row) =>
            column_indices.map((column) => row[column] ?? null));
        this.materialized_cells += rows.length * column_indices.length;
        return { startRow: start, rows };
    }

    close(): void {}
}

const filter = (
    operator: FilterEntry['operator'],
    value?: string,
    colIndex = 0,
): FilterEntry => ({
    id: `${operator}-${colIndex}`,
    colIndex,
    operator,
    value,
    caseSensitive: false,
    enabled: true,
});

function cancel_at_checkpoint(checkpoint: number): () => boolean {
    let checks = 0;
    // A completed checkpoint checks once before and once after yielding. The
    // target checkpoint returns true on its first (pre-yield) check.
    return () => ++checks >= checkpoint * 2 - 1;
}

describe('table transforms', () => {
    it('sorts numeric values stably and keeps missing values last in both directions', () => {
        const ten = cell('10', 'number');
        const two = cell('2', 'number');
        const empty = cell('', 'empty');

        expect(compare_cells(ten, two, 'asc')).toBeGreaterThan(0);
        expect(compare_cells(ten, two, 'desc')).toBeLessThan(0);
        expect(compare_cells(empty, two, 'asc')).toBeGreaterThan(0);
        expect(compare_cells(empty, two, 'desc')).toBeGreaterThan(0);
    });

    it('applies enabled filters with AND and then a stable multi-key sort', async () => {
        const source = new Source([
            [cell('b'), cell('2', 'number')],
            [cell('a'), cell('2', 'number')],
            [cell('a'), cell('1', 'number')],
            [cell('a'), null],
        ]);
        const state: SheetTransformState = {
            filters: [
                filter('equals', 'a'),
                { ...filter('equals', 'ignored', 1), enabled: false },
            ],
            sort: [
                { colIndex: 1, direction: 'asc' },
                { colIndex: 0, direction: 'asc' },
            ],
        };

        const result = await compute_transform(source, 0, state);
        expect([...result.indices!]).toEqual([2, 1, 3]);
    });

    it('infers canonical CSV decimals as numeric but preserves zero-padded identifiers as text', async () => {
        const decimals = new Source([
            [cell('1.10')],
            [cell('1.2')],
            [cell('-2.5')],
        ]);
        const decimal_result = await compute_transform(decimals, 0, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        });
        expect([...decimal_result.indices!]).toEqual([2, 0, 1]);
        const equality_result = await compute_transform(decimals, 0, {
            sort: [],
            filters: [filter('equals', '1.1')],
        });
        expect([...equality_result.indices!]).toEqual([0]);

        const identifiers = new Source([
            [cell('002')],
            [cell('10')],
            [cell('1')],
        ]);
        const identifier_result = await compute_transform(identifiers, 0, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        });
        expect([...identifier_result.indices!]).toEqual([2, 0, 1]);
    });

    it('compares and sorts canonical text integers exactly beyond safe 64-bit ranges', async () => {
        const safe_boundary = cell('9007199254740992');
        const just_over = cell('9007199254740993');
        expect(compare_cells(just_over, safe_boundary, 'asc', true)).toBeGreaterThan(0);
        expect(compare_cells(just_over, safe_boundary, 'desc', true)).toBeLessThan(0);

        const source = new Source([
            [cell('9223372036854775808')],
            [cell('-9223372036854775809')],
            [cell('9007199254740993')],
            [cell('9223372036854775807')],
            [cell('9007199254740992')],
        ]);
        const result = await compute_transform(source, 0, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        });
        expect([...result.indices!]).toEqual([1, 4, 2, 3, 0]);
    });

    it('sorts mixed canonical integers, decimals, and scientific notation exactly', async () => {
        const integer = cell('9007199254740993');
        const scientific = cell('9.007199254740992e15');
        expect(compare_cells(integer, scientific, 'asc', true)).toBeGreaterThan(0);

        const source = new Source([
            [integer],
            [scientific],
            [cell('9007199254740992.5')],
            [cell('9.007199254740993e15')],
            [cell('9007199254740992')],
        ]);
        const result = await compute_transform(source, 0, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        });

        // Rows 1 and 4 are numerically equal, so their source order is stable.
        expect([...result.indices!]).toEqual([1, 4, 2, 0, 3]);
    });

    it('builds exact numeric sort keys once per cell rather than per comparison', async () => {
        const size = 4096;
        const reverse_bits = (value: number): number => {
            let result = 0;
            for (let bit = 0; bit < 12; bit++) {
                result = (result << 1) | ((value >>> bit) & 1);
            }
            return result;
        };
        const rows = Array.from({ length: size }, (_, source_row) => {
            const ordinal = reverse_bits(source_row);
            const integer = String(9007199254740992n + BigInt(ordinal));
            const raw = ordinal % 3 === 0
                ? integer
                : ordinal % 3 === 1
                    ? `${integer}.0`
                    : `${integer[0]}.${integer.slice(1)}e15`;
            return [cell(raw)];
        });
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };

        const result = await compute_transform(
            new Source(rows),
            0,
            { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
            undefined,
            instrumentation,
        );

        expect([...result.indices!]).toEqual(Array.from(
            { length: size },
            (_, ordinal) => reverse_bits(ordinal),
        ));
        expect(instrumentation.numericSortKeyBuilds).toBe(size);
        expect(instrumentation.numericSortComparisons).toBeGreaterThan(size * 4);
    });

    it('builds numeric sort keys only for surviving nonmissing cells', async () => {
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source([
            [cell('4'), cell('keep')],
            [null, cell('keep')],
            [cell('2'), cell('drop')],
            [cell('3'), cell('keep')],
        ]);

        const result = await compute_transform(
            source,
            0,
            {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [filter('equals', 'keep', 1)],
            },
            undefined,
            instrumentation,
        );

        expect([...result.indices!]).toEqual([3, 0, 1]);
        expect(instrumentation.numericSortKeyBuilds).toBe(2);
    });

    it('cancels during bounded numeric key precomputation', async () => {
        const size = 5000;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source(Array.from(
            { length: size },
            (_, row) => [cell(String(size - row))],
        ));

        await expect(compute_transform(
            source,
            0,
            {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
            },
            () => instrumentation.numericSortKeyBuilds >= 4096,
            instrumentation,
        )).rejects.toMatchObject({ name: 'AbortError' });

        expect(instrumentation.numericSortKeyBuilds).toBe(4096);
        expect(instrumentation.numericSortKeyBuilds).toBeLessThan(size);
        expect(instrumentation.numericSortKeySlots).toBe(0);
        expect(instrumentation.transformColumnValueSlots).toBe(0);
        expect(instrumentation.indexBufferCount).toBe(0);
    });

    it('cancels key preparation across thousands of surviving missing values', async () => {
        const size = 5001;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source(Array.from(
            { length: size },
            (_, row) => [
                row === 0 ? cell('1') : null,
                cell(row === 0 ? 'drop' : 'keep'),
            ],
        ));

        await expect(compute_transform(
            source,
            0,
            {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [filter('equals', 'keep', 1)],
            },
            () => (instrumentation.peakNumericSortKeySlots ?? 0) > 0,
            instrumentation,
        )).rejects.toMatchObject({ name: 'AbortError' });

        expect(instrumentation.numericSortKeyBuilds).toBe(0);
        expect(instrumentation.numericSortKeySlots).toBe(0);
        expect(instrumentation.transformColumnValueSlots).toBe(0);
        expect(instrumentation.indexBufferCount).toBe(0);
        expect(instrumentation.indexBufferBytes).toBe(0);
        expect(instrumentation.survivorMaskBytes).toBe(0);
    });

    it('cancels during the first sequential sort-column scan', async () => {
        const width = 4200;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source(Array.from(
            { length: 2 },
            (_, row) => Array.from(
                { length: width },
                (_, column) => cell(String(column + row)),
            ),
        ));

        await expect(compute_transform(
            source,
            0,
            {
                sort: Array.from(
                    { length: width },
                    (_, colIndex) => ({ colIndex, direction: 'asc' as const }),
                ),
                filters: [],
            },
            // The least-significant key is acquired first. Checkpoint 5 follows
            // its first bounded source scan.
            cancel_at_checkpoint(5),
            instrumentation,
        )).rejects.toMatchObject({ name: 'AbortError' });

        expect(instrumentation.numericSortKeyBuilds).toBe(0);
        expect(source.read_calls).toBe(1);
        expect(source.selected_columns).toEqual([[width - 1]]);
        expect(instrumentation.indexBufferCount).toBe(0);
        expect(instrumentation.transformColumnValueSlots ?? 0).toBe(0);
    });

    it('keeps cooperative sort index storage to two typed buffers', async () => {
        const size = 5000;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source(Array.from(
            { length: size },
            (_, index) => [cell(`value-${size - index}`)],
        ));

        const result = await compute_transform(
            source,
            0,
            { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
            undefined,
            instrumentation,
        );

        expect(result.indices).toBeInstanceOf(Uint32Array);
        expect(instrumentation.indexBufferAllocations).toBe(2);
        expect(instrumentation.indexBufferReleases).toBe(1);
        expect(instrumentation.peakIndexBufferCount).toBe(2);
        expect(instrumentation.peakIndexBufferBytes).toBe(size * 4 * 2);
        expect(instrumentation.indexBufferCount).toBe(1);
        expect(instrumentation.indexBufferBytes).toBe(size * 4);
    });

    it('allocates an exact survivor buffer for selective filters', async () => {
        const size = 5000;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source(Array.from(
            { length: size },
            (_, index) => [cell(index < 5 ? 'keep' : 'drop')],
        ));

        const result = await compute_transform(
            source,
            0,
            { sort: [], filters: [filter('equals', 'keep')] },
            undefined,
            instrumentation,
        );

        expect([...result.indices!]).toEqual([0, 1, 2, 3, 4]);
        expect(instrumentation.indexBufferAllocations).toBe(1);
        expect(instrumentation.peakIndexBufferCount).toBe(1);
        expect(instrumentation.peakIndexBufferBytes).toBe(5 * 4);
    });

    it('compacts numeric-key slots for selective sorted filters', async () => {
        const size = 5000;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source(Array.from(
            { length: size },
            (_, index) => [
                cell(String(size - index)),
                cell(index < 5 ? 'keep' : 'drop'),
            ],
        ));

        const result = await compute_transform(
            source,
            0,
            {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [filter('equals', 'keep', 1)],
            },
            undefined,
            instrumentation,
        );

        expect([...result.indices!]).toEqual([4, 3, 2, 1, 0]);
        expect(instrumentation.peakTransformColumnValueSlots).toBe(size);
        expect(instrumentation.transformColumnValueSlots).toBe(0);
        expect(instrumentation.peakNumericSortKeySlots).toBe(5);
        expect(instrumentation.numericSortKeySlots).toBe(0);
        expect(instrumentation.peakIndexBufferCount).toBe(2);
        expect(instrumentation.peakIndexBufferBytes).toBe(size * 4 + 5 * 4);
        expect(instrumentation.indexBufferCount).toBe(1);
        expect(instrumentation.indexBufferBytes).toBe(5 * 4);
    });

    it('tracks the three-buffer peak for a large selective numeric sort', async () => {
        const size = 6000;
        const survivor_count = 3000;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source(Array.from(
            { length: size },
            (_, index) => [
                cell(String(size - index)),
                cell(index < survivor_count ? 'keep' : 'drop'),
            ],
        ));

        const result = await compute_transform(
            source,
            0,
            {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [filter('equals', 'keep', 1)],
            },
            undefined,
            instrumentation,
        );

        expect(result.rowCount).toBe(survivor_count);
        expect(result.indices![0]).toBe(survivor_count - 1);
        expect(result.indices![survivor_count - 1]).toBe(0);
        expect(instrumentation.peakNumericSortKeySlots).toBe(survivor_count);
        expect(instrumentation.numericSortKeySlots).toBe(0);
        expect(instrumentation.peakIndexBufferCount).toBe(3);
        expect(instrumentation.peakIndexBufferBytes).toBe(
            size * 4 + survivor_count * 4 * 2,
        );
        expect(instrumentation.indexBufferCount).toBe(1);
        expect(instrumentation.indexBufferBytes).toBe(survivor_count * 4);
        expect(instrumentation.transformColumnValueSlots).toBe(0);
    });

    it('holds one active transform column across many filters and sort keys', async () => {
        const row_count = 256;
        const column_count = 24;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source(Array.from(
            { length: row_count },
            (_, row) => Array.from(
                { length: column_count },
                (_, column) => cell(String((row + column) % 17)),
            ),
        ));

        const result = await compute_transform(
            source,
            0,
            {
                filters: Array.from(
                    { length: column_count },
                    (_, colIndex) => filter('greaterThanOrEqual', '0', colIndex),
                ),
                sort: Array.from(
                    { length: column_count },
                    (_, colIndex) => ({ colIndex, direction: 'asc' as const }),
                ),
            },
            undefined,
            instrumentation,
        );

        expect(result.rowCount).toBe(row_count);
        expect(instrumentation.peakTransformColumnValueSlots).toBe(row_count);
        expect(instrumentation.transformColumnValueSlots).toBe(0);
        expect(instrumentation.peakNumericSortKeySlots).toBe(row_count);
        expect(instrumentation.numericSortKeySlots).toBe(0);
    });

    it('reacquires sequential transform columns from cache without rereading', async () => {
        const row_count = 300;
        const source = new Source(Array.from(
            { length: row_count },
            (_, row) => [cell(String(row % 7))],
        ));
        const stored = new Map<string, CachedTransformColumn>();
        const cache: TransformColumnCache = {
            get: (sheet, column) => stored.get(`${sheet}:${column}`),
            set: (sheet, column, value) => {
                stored.set(`${sheet}:${column}`, value);
            },
        };
        const state: SheetTransformState = {
            filters: [filter('greaterThanOrEqual', '0')],
            sort: [{ colIndex: 0, direction: 'desc' }],
        };

        await compute_transform(source, 0, state, undefined, undefined, cache);
        const first_read_count = source.read_calls;
        expect(first_read_count).toBe(Math.ceil(row_count / 128));
        await compute_transform(source, 0, state, undefined, undefined, cache);

        expect(source.read_calls).toBe(first_read_count);
        expect(stored.size).toBe(1);
    });

    it('skips sort-column acquisition for zero and singleton survivors', async () => {
        const state: SheetTransformState = {
            filters: [filter('equals', 'keep', 0)],
            sort: [
                { colIndex: 1, direction: 'asc' },
                { colIndex: 2, direction: 'desc' },
            ],
        };
        const make_source = (keep_row: number | undefined) => new Source(
            Array.from({ length: 10 }, (_, row) => [
                cell(row === keep_row ? 'keep' : 'drop'),
                cell(String(10 - row)),
                cell(String(row)),
            ]),
        );

        const empty_source = make_source(undefined);
        const empty = await compute_transform(empty_source, 0, state);
        expect([...empty.indices!]).toEqual([]);
        expect(empty_source.read_calls).toBe(1);
        expect(empty_source.selected_columns).toEqual([[0]]);

        const singleton_source = make_source(4);
        const singleton = await compute_transform(singleton_source, 0, state);
        expect([...singleton.indices!]).toEqual([4]);
        expect(singleton_source.read_calls).toBe(1);
        expect(singleton_source.selected_columns).toEqual([[0]]);
    });

    it('preserves stable multi-key order and missing-last across sort passes', async () => {
        const source = new Source([
            [cell('2'), cell('1')],
            [cell('1'), null],
            [cell('1'), cell('2')],
            [cell('2'), null],
            [cell('1'), cell('2')],
            [cell('2'), cell('3')],
        ]);

        const result = await compute_transform(source, 0, {
            sort: [
                { colIndex: 0, direction: 'asc' },
                { colIndex: 1, direction: 'desc' },
            ],
            filters: [],
        });

        // Equal rows 2 and 4 retain source order; missing secondary keys remain
        // last inside each primary-key group even for descending direction.
        expect([...result.indices!]).toEqual([2, 4, 1, 5, 0, 3]);
    });

    it('reuses repeated numeric keys with a bounded request-local table', async () => {
        const size = 4096;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source(Array.from(
            { length: size },
            (_, index) => [cell(String(index % 16))],
        ));

        await compute_transform(
            source,
            0,
            { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
            undefined,
            instrumentation,
        );

        expect(instrumentation.numericSortKeyBuilds).toBe(16);
        expect(instrumentation.numericSortKeyReuses).toBe(size - 16);
        expect(instrumentation.numericSortKeyInternPeakEntries).toBe(16);
    });

    it('bounds numeric-key interning for all-unique inputs', async () => {
        const size = 2048;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source(Array.from(
            { length: size },
            (_, index) => [cell(String(index + 1))],
        ));

        await compute_transform(
            source,
            0,
            { sort: [{ colIndex: 0, direction: 'desc' }], filters: [] },
            undefined,
            instrumentation,
        );

        expect(instrumentation.numericSortKeyBuilds).toBe(size);
        expect(instrumentation.numericSortKeyReuses ?? 0).toBe(0);
        expect(instrumentation.numericSortKeyInternPeakEntries).toBe(1024);
    });

    it('keeps mixed canonical and number-fallback keys transitive near 2^53', async () => {
        const values = [
            cell('9007199254740992'),
            cell('9007199254740993.', 'number'),
            cell('9007199254740993'),
        ];
        const permutations = [
            [0, 1, 2], [0, 2, 1], [1, 0, 2],
            [1, 2, 0], [2, 0, 1], [2, 1, 0],
        ];

        for (const permutation of permutations) {
            const source = new Source(permutation.map((index) => [values[index]]));
            const result = await compute_transform(source, 0, {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
            });
            const expected = permutation
                .map((value, source_row) => ({ value, source_row }))
                .filter(({ value }) => value !== 2)
                .map(({ source_row }) => source_row);
            expected.push(permutation.indexOf(2));
            expect([...result.indices!]).toEqual(expected);
        }
    });

    it('preserves signed zero and exact ordering at finite exponent extremes', async () => {
        const source = new Source([
            [cell('-0e+300')],
            [cell('0.0')],
            [cell('1e-308')],
            [cell('-1e-308')],
            [cell('1e308')],
            [cell('-1e308')],
            [cell('10000000000000001e-324')],
            [cell('10000000000000000e-324')],
        ]);
        const result = await compute_transform(source, 0, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        });

        expect([...result.indices!]).toEqual([5, 3, 0, 1, 2, 7, 6, 4]);
    });

    it('uses exact canonical integers for numeric equality, relations, and ranges', async () => {
        const source = new Source([
            [cell('9007199254740992')],
            [cell('9007199254740993')],
            [cell('9223372036854775807')],
            [cell('9223372036854775808')],
        ]);
        const apply = (entry: FilterEntry) => compute_transform(source, 0, {
            sort: [],
            filters: [entry],
        });

        await expect(apply(filter('equals', '9007199254740993')))
            .resolves.toMatchObject({ indices: Uint32Array.from([1]) });
        await expect(apply(filter('notEquals', '9007199254740993')))
            .resolves.toMatchObject({ indices: Uint32Array.from([0, 2, 3]) });
        await expect(apply(filter('greaterThan', '9223372036854775807')))
            .resolves.toMatchObject({ indices: Uint32Array.from([3]) });
        await expect(apply({
            ...filter('between', '9007199254740993'),
            secondValue: '9223372036854775807',
        })).resolves.toMatchObject({ indices: Uint32Array.from([1, 2]) });
    });

    it('filters mixed canonical integers, decimals, and scientific notation exactly', async () => {
        const source = new Source([
            [cell('9007199254740993')],
            [cell('9.007199254740992e15')],
            [cell('9007199254740992.5')],
            [cell('9.007199254740993e15')],
        ]);
        const apply = (entry: FilterEntry) => compute_transform(source, 0, {
            sort: [],
            filters: [entry],
        });

        await expect(apply(filter('equals', '9.007199254740993e15')))
            .resolves.toMatchObject({ indices: Uint32Array.from([0, 3]) });
        await expect(apply(filter('greaterThan', '9.007199254740992e15')))
            .resolves.toMatchObject({ indices: Uint32Array.from([0, 2, 3]) });
        await expect(apply({
            ...filter('between', '9.0071992547409925e15'),
            secondValue: '9007199254740993',
        })).resolves.toMatchObject({ indices: Uint32Array.from([0, 2, 3]) });
    });

    it('compiles numeric filter operands once per filter rather than per row', async () => {
        const measure = async (row_count: number) => {
            const instrumentation: TransformSortInstrumentation = {
                numericSortKeyBuilds: 0,
                numericSortComparisons: 0,
            };
            const source = new Source(Array.from(
                { length: row_count },
                (_, row) => [cell(String(row + 1))],
            ));
            const result = await compute_transform(
                source,
                0,
                {
                    sort: [],
                    filters: [
                        filter('greaterThanOrEqual', '-0'),
                        filter('lessThanOrEqual', '9.007199254740993e15'),
                        {
                            ...filter('between', '0.1e1'),
                            secondValue: '9007199254740993',
                        },
                    ],
                },
                undefined,
                instrumentation,
            );
            expect(result.rowCount).toBe(row_count);
            return instrumentation;
        };

        const small = await measure(7);
        const large = await measure(2_007);
        for (const [row_count, instrumentation] of [
            [7, small],
            [2_007, large],
        ] as const) {
            // One invariant build for each relation and two for the range.
            expect(instrumentation.numericFilterOperandKeyBuilds).toBe(4);
            expect(instrumentation.filterOperandCaseFolds ?? 0).toBe(0);
            // All three predicates share one lazily built exact LHS per row.
            expect(instrumentation.numericFilterRowKeyBuilds).toBe(row_count);
            expect(instrumentation.filterRowCaseFolds ?? 0).toBe(0);
        }
    });

    it('case-folds text operands once and only folds rows for text predicates', async () => {
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const result = await compute_transform(
            new Source(Array.from(
                { length: 257 },
                (_, row) => [cell(row % 2 === 0 ? 'ÄPFEL' : 'Birne')],
            )),
            0,
            {
                sort: [],
                filters: [
                    filter('startsWith', 'äpf'),
                    filter('notContains', 'zzz'),
                ],
            },
            undefined,
            instrumentation,
        );

        expect(result.rowCount).toBe(129);
        expect(instrumentation.filterOperandCaseFolds).toBe(2);
        expect(instrumentation.numericFilterOperandKeyBuilds ?? 0).toBe(0);
        // The second predicate is reached only by rows passing the first.
        expect(instrumentation.filterRowCaseFolds).toBe(257 + 129);
        expect(instrumentation.numericFilterRowKeyBuilds ?? 0).toBe(0);
    });

    it('builds a numeric row key lazily after earlier predicates pass', async () => {
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const result = await compute_transform(
            new Source(Array.from(
                { length: 20 },
                (_, row) => [cell(String(row + 1))],
            )),
            0,
            {
                sort: [],
                filters: [
                    filter('contains', '1'),
                    filter('greaterThan', '0'),
                ],
            },
            undefined,
            instrumentation,
        );

        expect(result.rowCount).toBe(11);
        expect(instrumentation.filterOperandCaseFolds).toBe(1);
        expect(instrumentation.numericFilterOperandKeyBuilds).toBe(1);
        expect(instrumentation.filterRowCaseFolds).toBe(20);
        expect(instrumentation.numericFilterRowKeyBuilds).toBe(11);
    });

    it('compiles every filter operator with its existing missing and case semantics', () => {
        const insensitive = (operator: FilterEntry['operator'], value?: string) =>
            filter(operator, value);
        const cases: Array<[
            RenderedCell | null,
            FilterEntry,
            boolean,
        ]> = [
            [cell('Alphabet'), insensitive('contains', 'PHA'), true],
            [cell('Alphabet'), insensitive('notContains', 'zzz'), true],
            [cell('Alphabet'), insensitive('equals', 'alphabet'), true],
            [cell('Alphabet'), insensitive('notEquals', 'beta'), true],
            [cell('Alphabet'), insensitive('startsWith', 'ALP'), true],
            [cell('Alphabet'), insensitive('endsWith', 'BET'), true],
            [cell('Zulu'), insensitive('greaterThan', 'Middle'), true],
            [cell('Middle'), insensitive('greaterThanOrEqual', 'Middle'), true],
            [cell('Alpha'), insensitive('lessThan', 'Middle'), true],
            [cell('Middle'), insensitive('lessThanOrEqual', 'Middle'), true],
            [cell('Middle'), {
                ...insensitive('between', 'Alpha'),
                secondValue: 'Zulu',
            }, true],
            [null, insensitive('isEmpty'), true],
            [cell('value'), insensitive('isNotEmpty'), true],
            [null, insensitive('notContains', 'x'), false],
            [cell('Alphabet'), {
                ...insensitive('equals', 'alphabet'),
                caseSensitive: true,
            }, false],
        ];

        for (const [value, entry, expected] of cases) {
            expect(matches_filter(value, entry), entry.operator).toBe(expected);
        }
    });

    it('keeps exact mixed-notation filtering, signed zero, and numeric inference', async () => {
        const source = new Source([
            [cell('9.007199254740992e15')],
            [cell('9007199254740992.5')],
            [cell('9007199254740993')],
            [cell('-0e+300')],
            [cell('0.0')],
        ]);
        const apply = (entry: FilterEntry) => compute_transform(source, 0, {
            sort: [],
            filters: [entry],
        });

        await expect(apply(filter('equals', '9007199254740992')))
            .resolves.toMatchObject({ indices: Uint32Array.from([0]) });
        await expect(apply(filter('notEquals', '9.007199254740992e15')))
            .resolves.toMatchObject({ indices: Uint32Array.from([1, 2, 3, 4]) });
        await expect(apply(filter('greaterThan', '9007199254740992.5')))
            .resolves.toMatchObject({ indices: Uint32Array.from([2]) });
        await expect(apply(filter('greaterThanOrEqual', '9007199254740992.5')))
            .resolves.toMatchObject({ indices: Uint32Array.from([1, 2]) });
        await expect(apply(filter('lessThan', '0')))
            .resolves.toMatchObject({ indices: Uint32Array.from([]) });
        await expect(apply(filter('lessThanOrEqual', '-0')))
            .resolves.toMatchObject({ indices: Uint32Array.from([3, 4]) });

        const identifiers = new Source([
            [cell('02')],
            [cell('2')],
        ]);
        await expect(compute_transform(identifiers, 0, {
            sort: [], filters: [filter('equals', '2')],
        })).resolves.toMatchObject({ indices: Uint32Array.from([1]) });

        expect(matches_filter(
            cell('2.', 'number'),
            filter('equals', '2e0'),
        )).toBe(true);
    });

    it('treats empty strings and nulls consistently as missing', () => {
        const empty_string = cell('', 'string');
        expect(matches_filter(empty_string, filter('isEmpty'))).toBe(true);
        expect(matches_filter(empty_string, filter('isNotEmpty'))).toBe(false);
        expect(matches_filter(null, filter('isEmpty'))).toBe(true);
        expect(matches_filter(null, filter('isNotEmpty'))).toBe(false);
    });

    it('supports string and numeric comparison predicates', () => {
        expect(matches_filter(cell('Alphabet'), filter('contains', 'pha'))).toBe(true);
        expect(matches_filter(cell('Alphabet'), filter('startsWith', 'alpha'))).toBe(true);
        expect(matches_filter(cell('12', 'number'), filter('greaterThan', '2'))).toBe(true);
        expect(matches_filter(
            cell('12', 'number'),
            { ...filter('between', '10'), secondValue: '20' },
        )).toBe(true);
    });

    it('rejects invalid numeric filter operands instead of comparing them as text', async () => {
        const source = new Source([
            [cell('1.5')],
            [cell('2.5')],
        ]);
        await expect(compute_transform(source, 0, {
            sort: [],
            filters: [filter('greaterThan', 'not-a-number')],
        })).rejects.toThrow('finite numbers');

        await expect(compute_transform(source, 0, {
            sort: [],
            filters: [{
                ...filter('between', '1'),
                secondValue: 'Infinity',
            }],
        })).rejects.toThrow('finite numbers');
    });

    it('cancels cooperatively during allocation and source acquisition', async () => {
        const rows = Array.from(
            { length: 3000 },
            (_, index) => [cell(String(3000 - index))],
        );
        const setup_source = new Source(rows);
        await expect(compute_transform(setup_source, 0, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        }, cancel_at_checkpoint(1))).rejects.toMatchObject({ name: 'AbortError' });
        expect(setup_source.read_calls).toBe(0);

        const scan_source = new Source(rows);
        await expect(compute_transform(scan_source, 0, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        }, cancel_at_checkpoint(7))).rejects.toMatchObject({ name: 'AbortError' });
        expect(scan_source.read_calls).toBe(1);
    });

    it('materializes only active columns and checkpoints within the old 1,000-row batch', async () => {
        const width = 2_000;
        const rows = Array.from({ length: 1_000 }, (_, row) => {
            const cells = new Array<RenderedCell | null>(width);
            cells[width - 1] = cell(String(row));
            return cells;
        });
        const source = new Source(rows);

        const result = await compute_transform(source, 0, {
            sort: [{ colIndex: width - 1, direction: 'desc' }],
            filters: [],
        });
        expect(result.rowCount).toBe(1_000);
        expect(source.selected_columns.every((columns) =>
            columns.length === 1 && columns[0] === width - 1)).toBe(true);
        expect(source.materialized_cells).toBe(1_000);

        const cancelled = new Source(rows);
        await expect(compute_transform(cancelled, 0, {
            sort: [{ colIndex: width - 1, direction: 'asc' }],
            filters: [],
        }, cancel_at_checkpoint(6))).rejects.toMatchObject({ name: 'AbortError' });
        expect(cancelled.read_calls).toBe(2);
        expect(cancelled.materialized_cells).toBe(256);
        expect(cancelled.materialized_cells).toBeLessThan(1_000);
    });

    it('cancels during native chunk sorting and cooperative merging', async () => {
        const rows = Array.from(
            { length: 3000 },
            (_, index) => [cell(String(3000 - index))],
        );
        const state: SheetTransformState = {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [filter('greaterThanOrEqual', '1')],
        };

        const run = async (
            should_cancel: (instrumentation: TransformSortInstrumentation) => boolean,
            expected_allocations: number,
        ) => {
            const instrumentation: TransformSortInstrumentation = {
                numericSortKeyBuilds: 0,
                numericSortComparisons: 0,
            };
            const source = new Source(rows);
            await expect(compute_transform(
                source,
                0,
                state,
                () => should_cancel(instrumentation),
                instrumentation,
            )).rejects.toMatchObject({ name: 'AbortError' });
            // Filter and sort reacquire the uncached column independently.
            expect(source.read_calls).toBe(48);
            expect(instrumentation.indexBufferAllocations).toBe(expected_allocations);
            expect(instrumentation.indexBufferReleases).toBe(expected_allocations);
            expect(instrumentation.indexBufferCount).toBe(0);
            expect(instrumentation.indexBufferBytes ?? 0).toBe(0);
            expect(instrumentation.numericSortKeySlots ?? 0).toBe(0);
            expect(instrumentation.transformColumnValueSlots ?? 0).toBe(0);
            expect(instrumentation.survivorMaskBytes ?? 0).toBe(0);
        };

        await run(
            (instrumentation) => instrumentation.numericSortComparisons > 0
                && instrumentation.indexBufferAllocations === 1,
            1,
        );
        await run(
            (instrumentation) => (instrumentation.indexBufferAllocations ?? 0) >= 2,
            2,
        );
    });

    it('releases all request-owned memory when a sort comparator throws', async () => {
        const rows = Array.from(
            { length: 3000 },
            (_, index) => [cell(String(3000 - index))],
        );
        let comparisons = 0;
        const instrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        } as TransformSortInstrumentation;
        Object.defineProperty(instrumentation, 'numericSortComparisons', {
            configurable: true,
            get: () => comparisons,
            set: (value: number) => {
                comparisons = value;
                if ((instrumentation.indexBufferAllocations ?? 0) >= 2) {
                    throw new Error('comparison failed');
                }
            },
        });

        await expect(compute_transform(
            new Source(rows),
            0,
            { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
            undefined,
            instrumentation,
        )).rejects.toThrow('comparison failed');

        expect(instrumentation.indexBufferAllocations).toBe(2);
        expect(instrumentation.indexBufferReleases).toBe(2);
        expect(instrumentation.indexBufferCount).toBe(0);
        expect(instrumentation.indexBufferBytes).toBe(0);
        expect(instrumentation.numericSortKeySlots).toBe(0);
        expect(instrumentation.transformColumnValueSlots).toBe(0);
    });

    it('keeps stable source-row tie breaks across cooperative sort runs', async () => {
        const source = new Source(Array.from(
            { length: 5000 },
            (_, index) => [cell(String(index % 3)), cell(String(index))],
        ));
        const result = await compute_transform(source, 0, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        });
        const indices = [...result.indices!];
        for (const remainder of [0, 1, 2]) {
            expect(indices.filter((index) => index % 3 === remainder))
                .toEqual(Array.from(
                    { length: Math.ceil((5000 - remainder) / 3) },
                    (_, position) => remainder + position * 3,
                ).filter((index) => index < 5000));
        }
        expect(indices.slice(0, 1667).every((index) => index % 3 === 0)).toBe(true);
        expect(indices.slice(1667, 3334).every((index) => index % 3 === 1)).toBe(true);
        expect(indices.slice(3334).every((index) => index % 3 === 2)).toBe(true);
    });

    it('serves transformed windows in display order', () => {
        const source = new Source([
            [cell('zero')],
            [cell('one')],
            [cell('two')],
        ]);
        const result = transformed_window(
            source,
            0,
            0,
            3,
            Uint32Array.from([2, 0, 1]),
        );
        expect(result.rows.map((row) => row[0]?.raw)).toEqual(['two', 'zero', 'one']);
    });

    it('uses the sequential reader for an identity window', () => {
        const indexed = vi.fn(() => ({ rows: [] }));
        const source = Object.assign(
            new Source([[cell('zero')], [cell('one')]]),
            { read_rows_indexed: indexed },
        );
        const sequential = vi.spyOn(source, 'read_rows');

        expect(transformed_window(source, 0, 0, 2, undefined).rows
            .map((row) => row[0]?.raw)).toEqual(['zero', 'one']);
        expect(sequential).toHaveBeenCalledOnce();
        expect(indexed).not.toHaveBeenCalled();
    });

    it('flattens merged semantics without inventing covered-cell values', async () => {
        const merges = [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
            { startRow: 1, startCol: 0, endRow: 2, endCol: 0 },
            { startRow: 3, startCol: 1, endRow: 4, endCol: 2 },
        ];
        const source = new Source([
            [cell('wide'), null, cell('x')],
            [cell('tall'), cell('y'), cell('z')],
            [null, cell('covered-row'), cell('z')],
            [cell('other'), cell('box'), null],
            [cell('last'), null, null],
        ], merges);
        const result = await compute_transform(source, 0, {
            sort: [],
            filters: [filter('isNotEmpty')],
        });
        expect([...result.indices!]).toEqual([0, 1, 3, 4]);
        expect(source.meta().sheets[0].merges).toEqual(merges);
        const window = transformed_window(
            source,
            0,
            0,
            5,
            Uint32Array.from([0, 1, 2, 3, 4]),
        );
        expect(window.rows[0][1]).toBeNull();
        expect(window.rows[2][0]).toBeNull();
        expect(window.rows[4][1]).toBeNull();
        expect(window.rows[4][2]).toBeNull();
    });

    it('returns the identity view when no transform is active', async () => {
        const source = new Source([[cell('a')], [cell('b')]]);
        await expect(compute_transform(source, 0, {
            sort: [],
            filters: [{ ...filter('equals', 'a'), enabled: false }],
        })).resolves.toEqual({ indices: undefined, rowCount: 2 });
    });

    it('rejects an out-of-range column instead of acknowledging a false transform', async () => {
        const source = new Source([[cell('a')]]);
        await expect(compute_transform(source, 0, {
            sort: [{ colIndex: 10, direction: 'asc' }],
            filters: [],
        })).rejects.toThrow('column index 10 out of range');
    });
});
