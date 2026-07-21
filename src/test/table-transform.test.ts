import { describe, expect, it } from 'vitest';
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
import type { TransformSortInstrumentation } from '../table-transform';

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

    it('cancels key precomputation within a single wide multi-key row', async () => {
        const width = 4200;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source([
            Array.from({ length: width }, (_, column) => cell(String(column))),
        ]);

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
            // Three setup/scan checkpoints, 66 numeric-column preparation
            // checkpoints, one pre-filter checkpoint, then the key-build one.
            cancel_at_checkpoint(71),
            instrumentation,
        )).rejects.toMatchObject({ name: 'AbortError' });

        expect(instrumentation.numericSortKeyBuilds).toBe(4096);
        expect(instrumentation.numericSortKeyBuilds).toBeLessThan(width);
    });

    it('cancels while preparing arrays for a very wide numeric sort', async () => {
        const width = 4200;
        const instrumentation: TransformSortInstrumentation = {
            numericSortKeyBuilds: 0,
            numericSortComparisons: 0,
        };
        const source = new Source([
            Array.from({ length: width }, (_, column) => cell(String(column))),
        ]);

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
            // Checkpoints 1-3 cover setup and scanning, 4 precedes the first
            // key array, and 5 interrupts before the 65th key array.
            cancel_at_checkpoint(5),
            instrumentation,
        )).rejects.toMatchObject({ name: 'AbortError' });

        expect(instrumentation.numericSortKeyBuilds).toBe(0);
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
        }, cancel_at_checkpoint(3))).rejects.toMatchObject({ name: 'AbortError' });
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
        }, cancel_at_checkpoint(4))).rejects.toMatchObject({ name: 'AbortError' });
        expect(cancelled.read_calls).toBe(2);
        expect(cancelled.materialized_cells).toBe(256);
        expect(cancelled.materialized_cells).toBeLessThan(1_000);
    });

    it('cancels cooperatively during filtering, sorting, and compaction', async () => {
        const rows = Array.from(
            { length: 3000 },
            (_, index) => [cell(String(3000 - index))],
        );
        const state: SheetTransformState = {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [filter('greaterThanOrEqual', '1')],
        };

        // Checkpoints: setup 1-2, 24 source slices 3-26, filter start 27,
        // filter chunks 28-30, two bounded sort runs 31-32, merge/copy 33-34,
        // compaction allocation/copy 35-36.
        await expect(compute_transform(
            new Source(rows),
            0,
            state,
            cancel_at_checkpoint(28),
        )).rejects.toMatchObject({ name: 'AbortError' });
        await expect(compute_transform(
            new Source(rows),
            0,
            state,
            cancel_at_checkpoint(31),
        )).rejects.toMatchObject({ name: 'AbortError' });
        await expect(compute_transform(
            new Source(rows),
            0,
            state,
            cancel_at_checkpoint(36),
        )).rejects.toMatchObject({ name: 'AbortError' });
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
