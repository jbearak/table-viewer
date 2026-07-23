import { describe, expect, it } from 'vitest';
import { ExcelHeaderDataSource } from '../data-source/excel-header-source';
import type {
    DataSource,
    RenderedCell,
    RowWindow,
    SheetMeta,
    WorkbookMeta,
} from '../data-source/interface';
import {
    migrate_compatible_sheet_schema,
    plan_excel_candidate_state,
    plan_excel_override_state,
} from '../excel-header-plan';
import { transform_schema_for_sheet, type PerFileState } from '../types';

const text = (raw: string): RenderedCell => ({
    raw, formatted: raw, bold: false, italic: false, rawType: 'string',
});
const number = (raw: number): RenderedCell => ({
    raw: String(raw), formatted: String(raw), bold: false, italic: false, rawType: 'number',
});

class PhysicalSource implements DataSource {
    constructor(
        private readonly rows: (RenderedCell | null)[][] = [
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
        ],
        private readonly name = 'People',
    ) {}
    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: this.name,
                rowCount: this.rows.length,
                sourceRowCount: this.rows.length,
                columnCount: 2,
                merges: [],
                hasFormatting: false,
            }],
        };
    }
    read_rows(_sheet: number, start: number, count: number): RowWindow {
        return { startRow: start, rows: this.rows.slice(start, start + count) };
    }
    close(): void {}
}

function source(
    override?: 'on' | 'off',
    rows?: (RenderedCell | null)[][],
    hidden_rows?: readonly (readonly number[] | undefined)[],
) {
    return new ExcelHeaderDataSource(
        new PhysicalSource(rows),
        override ? { People: override } : undefined,
        hidden_rows,
    );
}

describe('pure Excel header state planning', () => {
    it.each([
        ['off', 'on'],
        ['on', 'off'],
    ] as const)('migrates an explicit toggle from %s to %s', (from, to) => {
        const ds = source(from);
        const old_sheet = ds.meta().sheets[0];
        const old_schema = transform_schema_for_sheet(old_sheet);
        const current: PerFileState = {
            excelFirstRowHeaders: { People: from },
            excelFirstRowHeaderActive: { People: from === 'on' },
            excelFirstRowHeaderVersion: 1,
            columnWidths: [{ 0: 120 }],
            rowHeights: [{ 0: 40 }],
            scrollPosition: [{ top: 80, left: 10 }],
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: old_schema,
            }],
            columnVisibility: [{ hiddenColumns: [1], schema: old_schema }],
            cellHighlights: {
                sourceDigest: 'digest',
                sheets: [{
                    schema: old_schema,
                    cells: {
                        '0:0': 'green',
                        '1:1': 'yellow',
                        '4:0': 'pink',
                    },
                }],
            },
        };

        const plan = plan_excel_override_state(current, ds.planning_input(), 0, 'People', to)!;

        expect(ds.meta().sheets[0]).toBe(old_sheet);
        expect(plan.state.excelFirstRowHeaders).toEqual({ People: to });
        expect(plan.state.excelFirstRowHeaderActive).toEqual({ People: to === 'on' });
        expect(plan.state.rowHeights).toEqual([undefined]);
        expect(plan.state.scrollPosition).toEqual([undefined]);
        expect(plan.state.columnWidths).toEqual([{ 0: 120 }]);
        const new_schema = transform_schema_for_sheet(plan.newSheet);
        expect(plan.state.transforms?.[0]?.schema).toBe(new_schema);
        expect(plan.state.columnVisibility?.[0]?.schema).toBe(new_schema);
        expect(plan.state.cellHighlights?.sheets[0]).toEqual({
            schema: new_schema,
            cells: {
                '0:0': 'green',
                '1:1': 'yellow',
                '4:0': 'pink',
            },
        });
    });

    it('performs the first feature migration and preserves widths', () => {
        const ds = source();
        const physical = ds.plan_override('People', 'off')!.sheet;
        const physical_schema = transform_schema_for_sheet(physical);
        const current: PerFileState = {
            columnWidths: [{ 0: 99 }],
            rowHeights: [{ 1: 50 }],
            scrollPosition: [{ top: 12, left: 4 }],
            transforms: [{ sort: [], filters: [], schema: physical_schema }],
            columnVisibility: [{ hiddenColumns: [0], schema: physical_schema }],
        };

        const plan = plan_excel_candidate_state(current, ds.planning_input());

        expect(plan.changed).toBe(true);
        expect(plan.state.excelFirstRowHeaderVersion).toBe(1);
        expect(plan.state.excelFirstRowHeaderActive).toEqual({ People: true });
        expect(plan.state.rowHeights).toEqual([undefined]);
        expect(plan.state.scrollPosition).toEqual([undefined]);
        expect(plan.state.columnWidths).toEqual([{ 0: 99 }]);
        const projected_schema = transform_schema_for_sheet(ds.meta().sheets[0]);
        expect(plan.state.transforms?.[0]?.schema).toBe(projected_schema);
        expect(plan.state.columnVisibility?.[0]?.schema).toBe(projected_schema);
    });

    it('migrates compatible schemas after a later detector change', () => {
        const ds = source();
        const old_sheet = ds.plan_override('People', 'off')!.sheet;
        const old_schema = transform_schema_for_sheet(old_sheet);
        const plan = plan_excel_candidate_state({
            excelFirstRowHeaderVersion: 1,
            excelFirstRowHeaderActive: { People: false },
            rowHeights: [{ 0: 31 }],
            scrollPosition: [{ top: 8, left: 2 }],
            transforms: [{ sort: [], filters: [], schema: old_schema }],
            columnVisibility: [{ visibleColumns: [0], schema: old_schema }],
        }, ds.planning_input());

        const next_schema = transform_schema_for_sheet(ds.meta().sheets[0]);
        expect(plan.changed).toBe(true);
        expect(plan.state.transforms?.[0]?.schema).toBe(next_schema);
        expect(plan.state.columnVisibility?.[0]?.schema).toBe(next_schema);
        expect(plan.state.rowHeights).toEqual([undefined]);
        expect(plan.state.scrollPosition).toEqual([undefined]);
    });

    it("treats absent authoritative state as auto when the DTO captured 'off'", () => {
        const ds = source('off');
        const plan = plan_excel_candidate_state({
            excelFirstRowHeaderVersion: 1,
            excelFirstRowHeaderActive: { People: false },
        }, ds.planning_input());

        expect(plan.overrides).toEqual({});
        expect(plan.active).toEqual({ People: true });
        expect(plan.meta.sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'auto', detected: true, active: true,
        });
        ds.replace_overrides(plan.overrides);
        expect(ds.meta()).toEqual(plan.meta);
    });

    it("treats absent authoritative state as auto when the DTO captured 'on'", () => {
        const ds = source('on', [
            [text('Name'), text('City')],
            [text('Alice'), text('London')],
            [text('Bob'), text('Paris')],
        ]);
        const plan = plan_excel_candidate_state({
            excelFirstRowHeaderVersion: 1,
            excelFirstRowHeaderActive: { People: true },
        }, ds.planning_input());

        expect(plan.overrides).toEqual({});
        expect(plan.active).toEqual({ People: false });
        expect(plan.meta.sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'auto', detected: false, active: false,
        });
        ds.replace_overrides(plan.overrides);
        expect(ds.meta()).toEqual(plan.meta);
    });

    it('rebases an explicit plan from the override in a conflicting state', () => {
        const ds = source('off');
        const input = ds.planning_input();
        const current_sheet = ds.plan_override('People', 'on')!.sheet;
        const current_schema = transform_schema_for_sheet(current_sheet);
        const plan = plan_excel_override_state({
            excelFirstRowHeaders: { People: 'on' },
            excelFirstRowHeaderActive: { People: true },
            excelFirstRowHeaderVersion: 1,
            transforms: [{ sort: [], filters: [], schema: current_schema }],
            columnVisibility: [{ hiddenColumns: [1], schema: current_schema }],
        }, input, 0, 'People', 'off')!;
        const off_schema = transform_schema_for_sheet(plan.newSheet);

        expect(plan.oldSheet.excelFirstRowHeader?.active).toBe(true);
        expect(plan.newSheet.excelFirstRowHeader?.active).toBe(false);
        expect(plan.state.transforms?.[0]?.schema).toBe(off_schema);
        expect(plan.state.columnVisibility?.[0]?.schema).toBe(off_schema);
    });

    it('keeps planning stable after the source is reconfigured', () => {
        const ds = source('off');
        const input = ds.planning_input();
        const current: PerFileState = {
            excelFirstRowHeaderVersion: 1,
            excelFirstRowHeaderActive: { People: false },
        };
        const before = plan_excel_override_state(current, input, 0, 'People', 'on');

        ds.set_override('People', 'on');
        const after = plan_excel_override_state(current, input, 0, 'People', 'on');

        expect(after).toEqual(before);
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.sheets)).toBe(true);
        expect(Object.isFrozen(input.sheets[0].columnNames)).toBe(true);
        expect(Object.isFrozen(input.sheets[0].merges)).toBe(true);
    });

    it('plans a non-hidden manual header and preserves its hidden prefix', () => {
        const rows = [
            [text('Report'), text('')],
            [text('Notes'), text('')],
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
        ];
        const ds = source('off', rows, [[0, 1]]);
        const old_sheet = ds.meta().sheets[0];
        const plan = plan_excel_override_state({
            excelFirstRowHeaders: { People: 'off' },
            transforms: [{
                sort: [],
                filters: [],
                hiddenRows: [0, 1],
                schema: transform_schema_for_sheet(old_sheet),
            }],
        }, ds.planning_input(), 0, 'People', 'on')!;

        expect(plan.newSheet).toMatchObject({
            columnNames: ['Name', 'Age'],
            excelFirstRowHeader: { active: true, sourceRow: 2 },
        });
        expect(plan.state.transforms?.[0]?.hiddenRows).toEqual([0, 1]);
        expect(plan.state.transforms?.[0]?.schema)
            .toBe(transform_schema_for_sheet(plan.newSheet));
    });

    it('atomically hides the prefix and promotes a selected source row', () => {
        const rows = [
            [text('Report'), text('')],
            [text('Notes'), text('')],
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
            [text('Archived'), number(99)],
        ];
        const ds = source('off', rows);
        const old_sheet = ds.meta().sheets[0];
        const plan = plan_excel_override_state({
            excelFirstRowHeaders: { People: 'off' },
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                hiddenRows: [4],
                schema: transform_schema_for_sheet(old_sheet),
            }],
        }, ds.planning_input(), 0, 'People', 'on', {
            headerSourceRow: 2,
            targetInput: ds.planning_input_for_header_source('People', 2),
        })!;

        expect(plan.newSheet).toMatchObject({
            columnNames: ['Name', 'Age'],
            excelFirstRowHeader: { mode: 'on', active: true, sourceRow: 2 },
        });
        expect(plan.state.transforms?.[0]).toMatchObject({
            sort: [{ colIndex: 1, direction: 'asc' }],
            hiddenRows: [0, 1, 4],
            schema: transform_schema_for_sheet(plan.newSheet),
        });
    });

    it('rejects promotion when the selected source row became hidden', () => {
        const ds = source('off', undefined, [[0]]);
        expect(plan_excel_override_state({
            excelFirstRowHeaders: { People: 'off' },
            transforms: [{ sort: [], filters: [], hiddenRows: [0, 1] }],
        }, ds.planning_input(), 0, 'People', 'on', {
            headerSourceRow: 1,
            targetInput: ds.planning_input_for_header_source('People', 1),
        })).toBeUndefined();
    });

    it('atomically disables a nonzero header and unhides rows without clearing sort', () => {
        const rows = [
            [text('Report'), text('')],
            [text('Notes'), text('')],
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
        ];
        const ds = source('on', rows, [[0, 1]]);
        const old_sheet = ds.meta().sheets[0];
        const plan = plan_excel_override_state({
            excelFirstRowHeaders: { People: 'on' },
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                hiddenRows: [0, 1],
                schema: transform_schema_for_sheet(old_sheet),
            }],
        }, ds.planning_input(), 0, 'People', 'off', {
            clearHiddenRows: true,
        })!;

        expect(plan.newSheet.excelFirstRowHeader?.active).toBe(false);
        expect(plan.state.excelFirstRowHeaders).toEqual({ People: 'off' });
        expect(plan.state.transforms?.[0]).toEqual({
            sort: [{ colIndex: 1, direction: 'asc' }],
            filters: [],
            schema: transform_schema_for_sheet(plan.newSheet),
        });
    });

    it('rejects a stale manual candidate after hidden rows change', () => {
        const ds = source('off', undefined, [[0]]);
        expect(plan_excel_override_state({
            excelFirstRowHeaders: { People: 'off' },
            transforms: [{ sort: [], filters: [], hiddenRows: [] }],
        }, ds.planning_input(), 0, 'People', 'on')).toBeUndefined();
    });

    it('does not migrate descriptors when sheet identity or count differs', () => {
        const old_sheet: SheetMeta = {
            name: 'People', rowCount: 2, sourceRowCount: 2,
            columnCount: 2, merges: [], hasFormatting: false,
        };
        const entry = [{ sort: [], filters: [], schema: transform_schema_for_sheet(old_sheet) }];
        const renamed = { ...old_sheet, name: 'Renamed' };
        const resized = { ...old_sheet, columnCount: 3 };

        expect(migrate_compatible_sheet_schema(entry, 0, old_sheet, renamed)).toBe(entry);
        expect(migrate_compatible_sheet_schema(entry, 0, old_sheet, resized)).toBe(entry);
    });
});
