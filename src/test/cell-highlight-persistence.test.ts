import { describe, expect, it } from 'vitest';
import type { SheetMeta, WorkbookMeta } from '../data-source/interface';
import { plan_cell_highlight_mutation } from '../cell-highlight-command';
import {
    MAX_HIGHLIGHTED_CELLS_PER_FILE,
    apply_cell_highlight_patch,
    count_cell_highlights,
    project_renderable_cell_highlight_state,
    reconcile_physical_cell_highlights,
    sanitize_cell_highlight_state,
} from '../cell-highlights';
import {
    transform_schema_for_sheet,
    type CellHighlightColor,
    type CellHighlightState,
} from '../types';

function sheet(
    name: string,
    source_row_count: number,
    column_count: number,
    column_names?: string[],
): SheetMeta {
    return {
        name,
        rowCount: source_row_count,
        sourceRowCount: source_row_count,
        columnCount: column_count,
        merges: [],
        hasFormatting: false,
        ...(column_names ? { columnNames: column_names } : {}),
    };
}

function workbook(...sheets: SheetMeta[]): WorkbookMeta {
    return { sheets, hasFormatting: false };
}

function highlight_state(
    sheets: Array<Record<string, CellHighlightColor> | undefined>,
    digest = 'stored-digest',
): CellHighlightState {
    return {
        sourceDigest: digest,
        sheets: sheets.map((cells, index) => cells && ({
            schema: `stored-schema-${index}`,
            cells,
        })),
    };
}

describe('cell highlight persistence acceptance', () => {
    it('retains positional cells through schema and independent row/column bound changes', () => {
        const durable = highlight_state([{
            '0:0': 'yellow',
            '1:1': 'green',
            '3:3': 'blue',
            '6:2': 'pink',
        }]);
        const before = structuredClone(durable);
        const changed_names = sheet('People', 7, 4, ['W', 'X', 'Y', 'Z']);

        const renamed = project_renderable_cell_highlight_state(
            durable,
            workbook(changed_names),
            'renamed-digest',
        );
        expect(renamed).toEqual({
            sourceDigest: 'renamed-digest',
            sheets: [{
                schema: transform_schema_for_sheet(changed_names),
                cells: {
                    '0:0': 'yellow',
                    '1:1': 'green',
                    '3:3': 'blue',
                    '6:2': 'pink',
                },
            }],
        });

        expect(project_renderable_cell_highlight_state(
            durable,
            workbook(sheet('People', 2, 4)),
        )?.sheets[0]?.cells).toEqual({
            '0:0': 'yellow',
            '1:1': 'green',
        });
        expect(project_renderable_cell_highlight_state(
            durable,
            workbook(sheet('People', 7, 4)),
        )?.sheets[0]?.cells).toEqual(renamed?.sheets[0]?.cells);
        expect(project_renderable_cell_highlight_state(
            durable,
            workbook(sheet('People', 7, 2)),
        )?.sheets[0]?.cells).toEqual({
            '0:0': 'yellow',
            '1:1': 'green',
        });
        expect(project_renderable_cell_highlight_state(
            durable,
            workbook(sheet('People', 7, 4)),
        )?.sheets[0]?.cells).toEqual(renamed?.sheets[0]?.cells);
        expect(durable).toEqual(before);
    });

    it('keeps an absent sheet dormant and restores it when the sheet returns', () => {
        const first = sheet('First', 2, 2);
        const second = sheet('Second', 2, 2);
        const durable = highlight_state([
            { '0:0': 'yellow' },
            { '1:1': 'pink' },
        ]);

        const absent = project_renderable_cell_highlight_state(
            durable,
            workbook(first),
            'one-sheet-digest',
        );
        expect(absent?.sheets).toEqual([{
            schema: transform_schema_for_sheet(first),
            cells: { '0:0': 'yellow' },
        }]);

        const reconciled = reconcile_physical_cell_highlights(
            durable,
            'two-sheet-digest',
        );
        expect(reconciled?.sheets[1]?.cells).toEqual({ '1:1': 'pink' });
        expect(project_renderable_cell_highlight_state(
            reconciled,
            workbook(first, second),
            'two-sheet-digest',
        )?.sheets[1]).toEqual({
            schema: transform_schema_for_sheet(second),
            cells: { '1:1': 'pink' },
        });
    });

    it('retains capacity-sized state while admitting only non-growing mutations', () => {
        const cells: Record<string, CellHighlightColor> = {};
        for (let row = 0; row < MAX_HIGHLIGHTED_CELLS_PER_FILE; row += 1) {
            cells[`${row}:0`] = 'yellow';
        }
        const durable = highlight_state([cells]);
        const large_sheet = sheet(
            'Capacity',
            MAX_HIGHLIGHTED_CELLS_PER_FILE + 1,
            1,
        );

        expect(count_cell_highlights(sanitize_cell_highlight_state(durable)))
            .toBe(MAX_HIGHLIGHTED_CELLS_PER_FILE);
        expect(count_cell_highlights(reconcile_physical_cell_highlights(
            durable,
            'replacement-digest',
        ))).toBe(MAX_HIGHLIGHTED_CELLS_PER_FILE);
        expect(project_renderable_cell_highlight_state(
            durable,
            workbook(sheet('Capacity', 1, 1)),
        )?.sheets[0]?.cells).toEqual({ '0:0': 'yellow' });
        expect(() => apply_cell_highlight_patch(durable, {
            sheetIndex: 0,
            cells: { [`${MAX_HIGHLIGHTED_CELLS_PER_FILE}:0`]: 'blue' },
        }, workbook(large_sheet), 'next-digest')).toThrow(RangeError);
        expect(count_cell_highlights(durable)).toBe(MAX_HIGHLIGHTED_CELLS_PER_FILE);

        const recolored = apply_cell_highlight_patch(durable, {
            sheetIndex: 0,
            cells: { '0:0': 'pink' },
        }, workbook(large_sheet), 'next-digest');
        expect(count_cell_highlights(recolored)).toBe(MAX_HIGHLIGHTED_CELLS_PER_FILE);
        expect(recolored?.sheets[0]?.cells['0:0']).toBe('pink');
        const cleared = apply_cell_highlight_patch(recolored, {
            sheetIndex: 0,
            cells: { '0:0': null },
        }, workbook(large_sheet), 'next-digest');
        expect(count_cell_highlights(cleared))
            .toBe(MAX_HIGHLIGHTED_CELLS_PER_FILE - 1);
    });

    it('explicit selection clear removes only requested renderable annotations', () => {
        const meta = workbook(sheet('First', 2, 2), sheet('Second', 2, 2));
        const durable = highlight_state([
            {
                '0:0': 'yellow',
                '0:1': 'green',
                '1:0': 'blue',
                '9:0': 'pink',
            },
            { '0:0': 'green' },
        ]);
        const result = plan_cell_highlight_mutation({
            sheetIndex: 0,
            sheetName: 'First',
            selection: {
                displayRows: [{ start: 0, end: 0 }],
                sourceColumns: [0],
            },
            mutation: { type: 'clear' },
        }, {
            current: durable,
            meta,
            sourceDigest: 'next-digest',
            mapDisplayRowsToSource: () => {
                throw new Error('clear must not materialize the selection');
            },
            displayRowForSource: (_sheet_index, source_row) => (
                source_row < 2 ? source_row : undefined
            ),
        });

        expect(result).toMatchObject({ type: 'applied', affectedCells: 1 });
        if (result.type !== 'applied') throw new Error('Expected clear to apply.');
        expect(result.state).toEqual({
            sourceDigest: 'next-digest',
            sheets: [{
                schema: transform_schema_for_sheet(meta.sheets[0]),
                cells: {
                    '0:1': 'green',
                    '1:0': 'blue',
                    '9:0': 'pink',
                },
            }, {
                schema: 'stored-schema-1',
                cells: { '0:0': 'green' },
            }],
        });
    });
});
