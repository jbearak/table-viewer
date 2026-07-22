import { describe, expect, it, vi } from 'vitest';
import { plan_cell_highlight_mutation } from '../cell-highlight-command';
import { MAX_HIGHLIGHTED_CELLS_PER_FILE } from '../cell-highlights';
import { transform_schema_for_sheet, type CellHighlightState } from '../types';
import type { SheetMeta, WorkbookMeta } from '../data-source/interface';

const sheet: SheetMeta = {
    name: 'People', rowCount: 5, sourceRowCount: 8, columnCount: 3,
    merges: [], hasFormatting: false, columnNames: ['A', 'B', 'C'],
};
const meta: WorkbookMeta = { sheets: [sheet], hasFormatting: false };
const map = (_sheet: number, intervals: readonly { start: number; end: number }[]) =>
    Uint32Array.from(intervals.flatMap(({ start, end }) =>
        Array.from({ length: end - start + 1 }, (_, index) => start + index + 2)));

function plan(
    overrides: Partial<Parameters<typeof plan_cell_highlight_mutation>[0]> = {},
    current?: CellHighlightState,
) {
    return plan_cell_highlight_mutation({
        sheetIndex: 0,
        sheetName: 'People',
        selection: { displayRows: [{ start: 0, end: 1 }], sourceColumns: [0, 2] },
        mutation: { type: 'set', color: 'yellow' },
        ...overrides,
    }, {
        current, meta, sourceDigest: 'digest', mapDisplayRowsToSource: map,
        displayRowForSource: (_sheet, sourceRow) => sourceRow - 2,
    });
}

describe('plan_cell_highlight_mutation', () => {
    it('crosses compact display rows with source columns in canonical coordinates', () => {
        expect(plan()).toEqual({
            type: 'applied', affectedCells: 4,
            state: {
                sourceDigest: 'digest',
                sheets: [{
                    schema: transform_schema_for_sheet(sheet),
                    cells: {
                        '2:0': 'yellow', '2:2': 'yellow',
                        '3:0': 'yellow', '3:2': 'yellow',
                    },
                }],
            },
        });
    });

    it('rejects sheet, empty, non-compact, unsorted, and out-of-range selections', () => {
        const candidates = [
            plan({ sheetName: 'Other' }),
            plan({ selection: { displayRows: [], sourceColumns: [0] } }),
            plan({ selection: { displayRows: [{ start: 0, end: 0 }, { start: 1, end: 1 }], sourceColumns: [0] } }),
            plan({ selection: { displayRows: [{ start: 0, end: 0 }], sourceColumns: [1, 1] } }),
            plan({ selection: { displayRows: [{ start: 0, end: 0 }], sourceColumns: [3] } }),
        ];
        expect(candidates.every((result) => result.type === 'rejected')).toBe(true);
    });

    it('rejects malformed runtime mutations without changing existing state', () => {
        const current = plan().type === 'applied'
            ? (plan() as Extract<ReturnType<typeof plan>, { type: 'applied' }>).state
            : undefined;
        for (const mutation of [
            { type: 'set' },
            { type: 'set', color: 'orange' },
            { type: 'erase' },
            null,
        ]) {
            const result = plan({ mutation: mutation as never }, current);
            expect(result.type).toBe('rejected');
            expect(current?.sheets[0]?.cells).toEqual({
                '2:0': 'yellow', '2:2': 'yellow',
                '3:0': 'yellow', '3:2': 'yellow',
            });
        }
    });

    it('rejects mapper failures, length mismatches, and invalid physical rows', () => {
        const base = {
            sheetIndex: 0, sheetName: 'People',
            selection: { displayRows: [{ start: 0, end: 0 }], sourceColumns: [0] },
            mutation: { type: 'set', color: 'green' } as const,
        };
        for (const mapper of [
            () => { throw new RangeError(); },
            () => new Uint32Array(),
            () => Uint32Array.from([8]),
        ]) {
            expect(plan_cell_highlight_mutation(base, {
                current: undefined, meta, sourceDigest: 'digest',
                mapDisplayRowsToSource: mapper,
                displayRowForSource: (_sheet, sourceRow) => sourceRow - 2,
            }).type).toBe('rejected');
        }
    });

    it('clears only existing sparse cells without materializing the cross product', () => {
        const current: CellHighlightState = {
            sourceDigest: 'digest',
            sheets: [{ schema: transform_schema_for_sheet(sheet), cells: {
                '2:0': 'yellow', '2:1': 'green', '7:2': 'pink',
            } }],
        };
        const mapper = vi.fn(() => Uint32Array.from([2, 3, 4, 5, 6, 7]));
        const result = plan_cell_highlight_mutation({
            sheetIndex: 0, sheetName: 'People',
            selection: { displayRows: [{ start: 0, end: 5 }], sourceColumns: [0, 2] },
            mutation: { type: 'clear' },
        }, {
            current, meta, sourceDigest: 'digest', mapDisplayRowsToSource: mapper,
            displayRowForSource: (_sheet, sourceRow) => sourceRow - 2,
        });
        expect(mapper).not.toHaveBeenCalled();
        expect(result).toMatchObject({ type: 'applied', affectedCells: 2 });
        if (result.type === 'applied') {
            expect(result.state?.sheets[0]?.cells).toEqual({ '2:1': 'green' });
        }
    });

    it('pre-rejects oversized sets while allowing large clears', () => {
        const largeSheet = { ...sheet, rowCount: MAX_HIGHLIGHTED_CELLS_PER_FILE + 1, sourceRowCount: MAX_HIGHLIGHTED_CELLS_PER_FILE + 1, columnCount: 1 };
        const largeMeta = { sheets: [largeSheet], hasFormatting: false };
        const mapper = () => Uint32Array.from(
            { length: MAX_HIGHLIGHTED_CELLS_PER_FILE + 1 },
            (_, index) => index,
        );
        const input = {
            sheetIndex: 0, sheetName: 'People',
            selection: { displayRows: [{ start: 0, end: MAX_HIGHLIGHTED_CELLS_PER_FILE }], sourceColumns: [0] },
        };
        expect(plan_cell_highlight_mutation({
            ...input, mutation: { type: 'set', color: 'blue' },
        }, {
            current: undefined, meta: largeMeta, sourceDigest: 'digest',
            mapDisplayRowsToSource: mapper,
            displayRowForSource: (_sheet, sourceRow) => sourceRow,
        }).type).toBe('rejected');
        expect(plan_cell_highlight_mutation({
            ...input, mutation: { type: 'clear' },
        }, {
            current: undefined, meta: largeMeta, sourceDigest: 'digest',
            mapDisplayRowsToSource: mapper,
            displayRowForSource: (_sheet, sourceRow) => sourceRow,
        })).toMatchObject({
            type: 'applied', affectedCells: 0, state: undefined,
        });
    });

    it('rejects additions but permits recolors and clears in loaded over-cap state', () => {
        const cells: Record<string, 'yellow'> = {};
        for (let row = 0; row <= MAX_HIGHLIGHTED_CELLS_PER_FILE; row++) cells[`${row}:0`] = 'yellow';
        const largeSheet = { ...sheet, rowCount: MAX_HIGHLIGHTED_CELLS_PER_FILE + 2, sourceRowCount: MAX_HIGHLIGHTED_CELLS_PER_FILE + 2, columnCount: 2 };
        const current: CellHighlightState = {
            sourceDigest: 'digest',
            sheets: [{ schema: transform_schema_for_sheet(largeSheet), cells }],
        };
        const result = plan_cell_highlight_mutation({
            sheetIndex: 0, sheetName: 'People',
            selection: { displayRows: [{ start: MAX_HIGHLIGHTED_CELLS_PER_FILE + 1, end: MAX_HIGHLIGHTED_CELLS_PER_FILE + 1 }], sourceColumns: [1] },
            mutation: { type: 'set', color: 'pink' },
        }, {
            current, meta: { sheets: [largeSheet], hasFormatting: false }, sourceDigest: 'digest',
            mapDisplayRowsToSource: () => Uint32Array.from([MAX_HIGHLIGHTED_CELLS_PER_FILE + 1]),
            displayRowForSource: (_sheet, sourceRow) => sourceRow,
        });
        expect(result.type).toBe('rejected');
        expect(Object.keys(current.sheets[0]!.cells)).toHaveLength(MAX_HIGHLIGHTED_CELLS_PER_FILE + 1);

        const recolored = plan_cell_highlight_mutation({
            sheetIndex: 0, sheetName: 'People',
            selection: {
                displayRows: [{ start: 0, end: MAX_HIGHLIGHTED_CELLS_PER_FILE }],
                sourceColumns: [0],
            },
            mutation: { type: 'set', color: 'pink' },
        }, {
            current, meta: { sheets: [largeSheet], hasFormatting: false }, sourceDigest: 'digest',
            mapDisplayRowsToSource: () => Uint32Array.from(
                { length: MAX_HIGHLIGHTED_CELLS_PER_FILE + 1 },
                (_, index) => index,
            ),
            displayRowForSource: (_sheet, sourceRow) => sourceRow,
        });
        expect(recolored).toMatchObject({
            type: 'applied',
            affectedCells: MAX_HIGHLIGHTED_CELLS_PER_FILE + 1,
        });
        if (recolored.type !== 'applied') throw new Error('Expected recolor to apply.');
        expect(recolored.state?.sheets[0]?.cells['0:0']).toBe('pink');
        expect(recolored.state?.sheets[0]?.cells[`${MAX_HIGHLIGHTED_CELLS_PER_FILE}:0`])
            .toBe('pink');

        const cleared = plan_cell_highlight_mutation({
            sheetIndex: 0, sheetName: 'People',
            selection: { displayRows: [{ start: 0, end: 0 }], sourceColumns: [0] },
            mutation: { type: 'clear' },
        }, {
            current: recolored.state,
            meta: { sheets: [largeSheet], hasFormatting: false },
            sourceDigest: 'digest',
            mapDisplayRowsToSource: () => { throw new Error('clear must stay sparse'); },
            displayRowForSource: (_sheet, sourceRow) => sourceRow,
        });
        expect(cleared).toMatchObject({ type: 'applied', affectedCells: 1 });
    });
});
