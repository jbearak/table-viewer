// Columns on `.xlsx` (row and column structure design, delivery step 8 on
// top of step 9c's wiring): a column insert admitted by the host where the
// capability reports column support, its format resolved as "Formatting
// inheritance" says, a formula committed in the new column and anchored,
// then a delete and a move through the webview model, a publication, and a
// save that round-trips through `parse_xlsx`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { simulate_process_restart_for_tests } from '../viewer-controller';
import { EMPTY_PENDING_STRUCTURAL_CHANGES, type PendingColumn, type PendingStructuralChanges } from '../pending-changes';
import type { PerFileState } from '../types';
import type { WorksheetStructureContext } from '../webview/pending-row-store';
import { merge_ranges_of, structure_auto_filter } from '../webview/row-structure-model';
import {
    pending_column_format,
    plan_column_delete,
    plan_column_insert,
    plan_column_move,
    plan_pending_column_cells,
} from '../webview/column-structure-model';
import {
    committed_formula_fields,
    webview_formula_workbook,
    type AnchorSheetMeta,
} from '../webview/formula-anchor-model';
import { parse_xlsx } from '../parse-xlsx';
import { build_fixture_xlsx, cell, representative_workbook, row } from './helpers/xlsx-structure-fixture';
import { open_xlsx, part_text } from './helpers/xlsx-viewer';
import * as vscode_mock from './mocks/vscode';

afterEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    simulate_process_restart_for_tests();
});

const HEADER_ON: PerFileState = { excelFirstRowHeaders: { Data: 'on' } };
const DATA = { sheetIndex: 0, sheetName: 'Data', worksheetId: '1' };

/** The representative workbook's two sheets, as the webview's formula model reads them. */
const SHEETS: readonly AnchorSheetMeta[] = [
    {
        name: 'Data',
        sourceRowCount: 7,
        columnCount: 6,
        excelFirstRowHeader: { mode: 'on', detected: false, active: true, available: true, sourceRow: 0 },
    },
    { name: 'Summary', sourceRowCount: 4, columnCount: 2 },
];

const src = (sourceColumn: number) => ({ kind: 'source' as const, sourceColumn });

function cell_values(rows: readonly (readonly unknown[])[]): unknown[][] {
    return rows.map((cells) => cells.map((value) => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'object' && 'raw' in (value as object)) return (value as { raw: unknown }).raw;
        return value;
    }));
}

function planned<T extends { ok: boolean }>(plan: T): Extract<T, { ok: true }> {
    if (!plan.ok) throw new Error((plan as { message?: string }).message ?? 'refused');
    return plan as Extract<T, { ok: true }>;
}

describe('.xlsx columns end to end', () => {
    it('refuses a column insert on a worksheet whose scan refuses columns, in the menus\' words', async () => {
        const viewer = await open_xlsx(build_fixture_xlsx({
            sheets: [{
                name: 'Arrays',
                body: `<sheetData>${row(1, [cell('A1', 1), '<c r="B1"><f t="array" ref="B1">A1*2</f><v>2</v></c>'])}</sheetData>`,
            }],
        }));
        const columns = viewer.capability().sheets[0]!.columns;
        expect(columns.supported).toBe(false);
        const refused = await viewer.insertColumns({ requestId: 'refused', anchor: 0, side: 'after' });
        expect(refused).toMatchObject({
            granted: false,
            reason: columns.supported ? undefined : columns.reason,
        });
        expect(refused.columnIds).toBeUndefined();
        viewer.dispose();
    });

    it('inserts, deletes, and moves columns, then saves a workbook parse_xlsx reads back', async () => {
        // Data: Item / Qty / Price / Total (Total = B*C, shared), Header Row 1,
        // body rows 2-7 (Apple … Fig). Summary reads Data!D2:D7, Data!B5,
        // Quantities (Data!$B$2:$B$7), and Data!$C$7.
        const viewer = await open_xlsx(representative_workbook(), { state: HEADER_ON });
        const support = viewer.capability().sheets[0]!;
        expect(support.columns).toEqual({ supported: true });
        const context: WorksheetStructureContext = {
            worksheet: DATA,
            bodyStart: 1,
            sourceRowCount: 7,
            sourceColumnCount: 6,
            bodyViewTransformed: false,
            merges: merge_ranges_of(support.merges!),
            ...structure_auto_filter(support.autoFilter),
            structuralBasis: support.basis!,
        };

        // Insert "Discount" right of Total (D). The host admits it now that
        // the capability reports column support.
        const admitted = await viewer.insertColumns({ requestId: 'cols', anchor: 3, side: 'after' });
        expect(admitted).toMatchObject({ granted: true, structuralBasis: support.basis });
        const [id] = admitted.columnIds!;
        // Formatting inheritance: the live column to its left, a source column.
        const format = pending_column_format(EMPTY_PENDING_STRUCTURAL_CHANGES, context, src(3), 'after', false);
        expect(format).toEqual({ kind: 'source', sourceColumn: 3 });
        const column: PendingColumn = { id: id!, header: 'Discount', cells: {}, format, createdOrder: 1 };
        let changes: PendingStructuralChanges = planned(
            plan_column_insert(EMPTY_PENDING_STRUCTURAL_CHANGES, context, src(3), 'after', [column]),
        ).outcome.next;
        // A Pending Column left of the new one passes its own format on.
        expect(pending_column_format(changes, context, { kind: 'pending', pendingColumnId: id! }, 'after', false))
            .toEqual(format);
        await viewer.settle('cols', true);

        // Commit `=D2*0.1` (Total, then column D) in the new column on
        // Apple's row, anchored as a cell commit anchors it.
        const fields = committed_formula_fields(
            '=D2*0.1',
            true,
            webview_formula_workbook(true, SHEETS, (index) => index === 0 ? changes : EMPTY_PENDING_STRUCTURAL_CHANGES),
            0,
        );
        if (fields.kind !== 'fields' || fields.formulaAnchors === undefined) throw new Error('not anchored');
        changes = plan_pending_column_cells(changes, DATA, [
            { pendingColumnId: id!, rowKey: 's:1', cell: { value: '=D2*0.1', formulaAnchors: fields.formulaAnchors } },
            { pendingColumnId: id!, rowKey: 's:2', cell: { value: '0.2' } },
        ])!.next;

        // Delete Item (A), then move Price (C) before Qty (B).
        changes = planned(plan_column_delete(changes, context, [src(0)], new Map())).outcome.next;
        changes = planned(plan_column_move(changes, context, [src(2)], src(1))).outcome.next;
        // Price, Qty, Total, Discount, then the merge's two unnamed columns.
        expect(changes.columnLayout).toMatchObject({ removedSourceColumns: [0] });

        const structural = {
            columnLayout: changes.columnLayout!,
            pendingColumns: changes.pendingColumns!,
            structuralBasis: support.basis!,
        };
        expect(await viewer.publish(0, structural)).toBe(true);
        const result = await viewer.save([{ sheetIndex: 0, structural }]);
        expect(result.rejection).toBeUndefined();
        expect(result).toMatchObject({ success: true });
        expect(result.receipt).toMatchObject({
            structure: [{
                columnMap: [null, 1, 0, 2, 4, 5],
                insertedColumns: [{ pendingColumnId: id, column: 3 }],
            }],
        });

        const saved = viewer.file.bytes;
        const data = part_text(saved, 'xl/worksheets/sheet1.xml')!;
        // Total = Qty * Price follows its columns, on every row.
        for (const number of [2, 3, 4, 5, 6, 7]) {
            expect(data).toContain(`<c r="C${number}"><f>B${number}*A${number}</f></c>`);
        }
        // Item's width went with it; Price's moved to A; the filter shrank.
        expect(data).toContain('<cols><col min="1" max="1" width="10" style="2" customWidth="1"/></cols>');
        expect(data).toContain('<autoFilter ref="A1:C7"/>');
        // The header copies Total's bold header style.
        expect(data).toContain('<c r="D1" s="1" t="inlineStr"><is><t xml:space="preserve">Discount</t></is></c>');
        // The anchored formula follows Total from D to C, in the new D,
        // styled like its inherited source column (Total writes no style).
        expect(data).toMatch(/<c r="D2"><f>C2\*0\.1<\/f><\/c>/);
        expect(data).toContain('<c r="D3"><v>0.2</v></c>');
        // The merge keeps its columns; the rule follows Price.
        expect(data).toContain('<mergeCell ref="E2:F3"/>');
        expect(data).toContain('<formula>B2&gt;A2</formula>');
        const summary = part_text(saved, 'xl/worksheets/sheet2.xml')!;
        expect(summary).toContain('<f>SUM(Data!C2:C7)</f>');
        expect(summary).toContain('<f>Data!B5</f>');
        expect(summary).toContain('<f>Data!$A$7</f>');
        expect(part_text(saved, 'xl/workbook.xml')).toContain('Data!$B$2:$B$7');

        const parsed = await parse_xlsx(saved);
        const values = cell_values(parsed.data.sheets[0]!.rows as unknown[][]);
        expect(values.map((cells) => cells.slice(0, 2))).toEqual([
            ['Price', 'Qty'], [0.5, 3], [0.25, 5], [2, 7], [1.5, 9], [3, 11], [0.75, 13],
        ]);
        expect(values[0]!.slice(2, 4)).toEqual(['Total', 'Discount']);
        expect(values[2]![3]).toBe(0.2);
        viewer.dispose();
    });
});
