import { describe, expect, it } from 'vitest';
import type {
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
        return {
            startRow: start,
            rows: this.rows.slice(start, start + count),
        };
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
