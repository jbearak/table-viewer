// Formulas after column changes (delivery step 8 meeting Formula Anchors):
// source formulas render through the column layout after columns move and
// are deleted, a formula committed in a Pending Column cell is anchored
// through `committed_formula_fields` and follows the columns it names, and
// CSV and TSV values are never anchored. Columns are CSV/TSV-only in step 8,
// so this anchors formulas the way an `.xlsx` commit does, at the
// format-agnostic layers step 9's `.xlsx` columns run through unchanged.
import { describe, expect, it } from 'vitest';
import {
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    type PendingStructuralChanges,
} from '../pending-changes';
import type { WorksheetTarget } from '../types';
import {
    delete_columns,
    insert_columns,
    move_columns,
    type StructureResult,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import {
    committed_formula_fields,
    formula_display,
    webview_formula_workbook,
    type AnchorSheetMeta,
} from '../webview/formula-anchor-model';
import { plan_pending_column_cells } from '../webview/column-structure-model';

const DATA: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data' };

/** Header on row 1, body rows 2..4, columns A..D. */
const SHEETS: readonly AnchorSheetMeta[] = [{
    name: 'Data',
    sourceRowCount: 4,
    columnCount: 4,
    excelFirstRowHeader: { mode: 'on', detected: false, active: true, available: true, sourceRow: 0 },
}];

const context: WorksheetStructureContext = {
    worksheet: DATA,
    bodyStart: 1,
    sourceRowCount: 4,
    sourceColumnCount: 4,
    bodyViewTransformed: false,
};

const src = (sourceColumn: number) => ({ kind: 'source' as const, sourceColumn });
const pend = (pendingColumnId: string) => ({ kind: 'pending' as const, pendingColumnId });

function next(result: StructureResult): PendingStructuralChanges {
    if (!result.ok) throw new Error(result.refusal.message);
    return result.outcome.next;
}

const workbook = (changes: PendingStructuralChanges, xlsx = true) =>
    webview_formula_workbook(xlsx, SHEETS, () => changes);

const rendered = (text: string, changes: PendingStructuralChanges, anchors?: Parameters<typeof formula_display>[1]) =>
    formula_display(text, anchors, workbook(changes), 0).text;

describe('source formulas after column changes', () => {
    it('render through deletes', () => {
        const deleted = next(delete_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context, [src(1)]));
        expect(rendered('=D2', deleted)).toBe('=C2');
        expect(rendered('=SUM(A2:D2)', deleted)).toBe('=SUM(A2:C2)');
        expect(rendered('=B2*2', deleted)).toBe('=#REF!*2');
        expect(rendered('=SUM(B2:C2)', deleted)).toBe('=SUM(B2:B2)');
    });

    it('render through moves, the reference following its column', () => {
        const moved = next(move_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context, [src(2)], src(0)));
        expect(rendered('=C2+A2', moved)).toBe('=A2+B2');
        expect(rendered('=$D$3', moved)).toBe('=$D$3');
        const moved_and_deleted = next(delete_columns(moved, context, [src(0)]));
        expect(rendered('=C2+A2', moved_and_deleted)).toBe('=A2+#REF!');
        expect(rendered('=D2', moved_and_deleted)).toBe('=C2');
    });

    it('shift past an inserted column', () => {
        const inserted = next(insert_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context, src(0), 'after', [
            { id: 'new', header: 'New column', cells: {}, format: { kind: 'source', sourceColumn: 0 }, createdOrder: 1 },
        ]));
        expect(rendered('=B2', inserted)).toBe('=C2');
        expect(rendered('=SUM(A2:B2)', inserted)).toBe('=SUM(A2:C2)');
    });
});

describe('a formula committed in a Pending Column cell', () => {
    const with_column = next(insert_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context, src(3), 'after', [
        { id: 'new', header: 'New column', cells: {}, format: { kind: 'source', sourceColumn: 3 }, createdOrder: 1 },
    ]));

    it('anchors a reference to a Pending Column, which then follows it and shows #REF! once it is gone', () => {
        // The new column is E.
        const fields = committed_formula_fields('=E2+A2', true, workbook(with_column), 0);
        if (fields.kind !== 'fields' || fields.formulaAnchors === undefined) throw new Error('not anchored');
        const plan = plan_pending_column_cells(with_column, DATA, [{
            pendingColumnId: 'new',
            rowKey: 's:1',
            cell: { value: '=E2+A2', formulaAnchors: fields.formulaAnchors },
        }])!;
        const stored = plan.next.pendingColumns![0]!.cells['s:1']!;
        expect(rendered(stored.value, plan.next, stored.formulaAnchors)).toBe('=E2+A2');
        const moved = next(move_columns(plan.next, context, [pend('new')], src(0)));
        expect(rendered(stored.value, moved, stored.formulaAnchors)).toBe('=A2+B2');
        const discarded = next(delete_columns(moved, { ...context, isColumnReferenced: () => true }, [pend('new')]));
        expect(rendered(stored.value, discarded, stored.formulaAnchors)).toBe('=#REF!+A2');
    });

    it('never anchors a CSV or TSV value', () => {
        expect(committed_formula_fields('=E2', true, workbook(with_column, false), 0)).toEqual({ kind: 'fields' });
        expect(committed_formula_fields('=E2', false, workbook(with_column), 0)).toEqual({ kind: 'fields' });
    });
});
