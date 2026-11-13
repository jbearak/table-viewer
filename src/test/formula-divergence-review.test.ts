// Review Changes' divergence list (design "Where this differs from Excel"):
// every formula of the workbook whose range references the divergence flags
// mark for the current layouts, source and pending, on the formula's own
// worksheet and on others, at its prospective cell with its rendered text.
import { describe, expect, it } from 'vitest';
import type { ColumnWindow, DataSource, RenderedCell, WorkbookMeta } from '../data-source/interface';
import { EMPTY_PENDING_STRUCTURAL_CHANGES, type PendingStructuralChanges } from '../pending-changes';
import { delete_rows, move_rows, type WorksheetStructureContext } from '../webview/pending-row-store';
import type { FormulaCalculationLayout } from '../formula-calculation';
import {
    MAX_FORMULA_DIVERGENCE_ITEMS,
    formula_divergence_class,
    review_formula_divergence,
} from '../formula-divergence-review';

function value(raw: string): RenderedCell {
    return { raw, formatted: raw, bold: false, italic: false, rawType: 'number' };
}

function formula(text: string): RenderedCell {
    return { raw: '', formatted: '', bold: false, italic: false, rawType: 'number', formula: text };
}

/**
 * `Data`: header row 1, body rows 2..7 with values in A, and C2 `=SUM(A2:A5)`
 * and C7 `=A3`. `Summary`: A1 `=SUM(Data!A2:A4)`, A2 `=Data!A3`, A3 `=SUM(A1:A2)`.
 */
function workbook(extra_summary_rows = 0): DataSource {
    const data: (RenderedCell | null)[][] = [
        [value('h'), null, null],
        [value('10'), null, formula('=SUM(A2:A5)')],
        [value('20'), null, null],
        [value('30'), null, null],
        [value('40'), null, null],
        [value('50'), null, null],
        [value('60'), null, formula('=A3')],
    ];
    const summary: (RenderedCell | null)[][] = [
        [formula('=SUM(Data!A2:A4)')],
        [formula('=Data!A3')],
        [formula('=SUM(A1:A2)')],
        ...Array.from({ length: extra_summary_rows }, () => [formula('=SUM(Data!A2:A3)')]),
    ];
    const sheets = [data, summary];
    const packed = (rows: (RenderedCell | null)[][]) => rows.flatMap((row, index) =>
        row.flatMap((cell, column) => cell?.formula === undefined ? [] : [index, column]));
    const meta: WorkbookMeta = {
        hasFormatting: false,
        sheets: [{
            name: 'Data',
            rowCount: data.length,
            sourceRowCount: data.length,
            columnCount: 3,
            merges: [],
            hasFormatting: false,
            formulaCells: packed(data),
            excelFirstRowHeader: { mode: 'on', detected: false, active: true, available: true, sourceRow: 0 },
        }, {
            name: 'Summary',
            rowCount: summary.length,
            sourceRowCount: summary.length,
            columnCount: 1,
            merges: [],
            hasFormatting: false,
            formulaCells: packed(summary),
        }],
    };
    return {
        meta: () => meta,
        read_rows: (sheet, start, count) => ({ startRow: start, rows: sheets[sheet]!.slice(start, start + count) }),
        read_columns: (sheet, start, count, columns): ColumnWindow => ({
            startRow: start,
            rows: sheets[sheet]!.slice(start, start + count).map((row) => columns.map((column) => row[column] ?? null)),
        }),
        close: () => {},
    };
}

const context: WorksheetStructureContext = {
    worksheet: { sheetIndex: 0, sheetName: 'Data' },
    bodyStart: 1,
    sourceRowCount: 7,
    sourceColumnCount: 3,
    bodyViewTransformed: false,
};

function layout_of(changes: PendingStructuralChanges | undefined, body_start: number): FormulaCalculationLayout {
    return {
        bodyStart: body_start,
        ...(changes?.rowLayout === undefined ? {} : { rowLayout: changes.rowLayout }),
        band: [],
    };
}

/** Data with source row 1 (worksheet row 2) moved below source row 4 (row 5). */
function moved(): PendingStructuralChanges {
    const result = move_rows(
        EMPTY_PENDING_STRUCTURAL_CHANGES,
        context,
        [{ kind: 'source', sourceRow: 1 }],
        { kind: 'source', sourceRow: 5 },
    );
    if (!result.ok) throw new Error(result.refusal.message);
    return result.outcome.next;
}

describe('review_formula_divergence', () => {
    it('lists flagged formulas on every worksheet that names the changed one, at their prospective cell', () => {
        const review = review_formula_divergence(workbook(), [], [layout_of(moved(), 1), layout_of(undefined, 0)]);
        // C2 moved with its row to row 5; its range's first corner was carried.
        expect(review.items).toEqual([
            {
                targetSheetIndex: 0,
                sheetIndex: 0,
                row: 4,
                column: 2,
                formula: '=SUM(A4:A5)',
                classes: ['moved'],
                axes: ['row'],
            },
            {
                targetSheetIndex: 0,
                sheetIndex: 1,
                row: 0,
                column: 0,
                formula: '=SUM(Data!A3:A5)',
                classes: ['moved'],
                axes: ['row'],
            },
        ]);
        // A single-cell reference and a formula naming only an unchanged sheet are never flagged.
        expect(review.counts).toEqual([{ targetSheetIndex: 0, formulas: 2 }]);
    });

    it('skips source formulas an edit replaces and formulas on deleted rows, and checks pending formulas', () => {
        const deleted = (() => {
            const result = delete_rows(moved(), context, [{ kind: 'source', sourceRow: 6 }]);
            if (!result.ok) throw new Error(result.refusal.message);
            return result.outcome.next;
        })();
        const review = review_formula_divergence(workbook(), [
            // A value typed over C2, now at row 5.
            { sheetIndex: 0, row: 4, column: 2, value: '5', writesFormula: false },
            // A pending formula on Summary naming the moved corner.
            { sheetIndex: 1, row: 3, column: 0, value: '=SUM(Data!A2:A3)', writesFormula: true },
        ], [layout_of(deleted, 1), layout_of(undefined, 0)]);
        expect(review.items.map((item) => `${item.sheetIndex}:${item.row}:${item.column} ${item.formula}`)).toEqual([
            '1:3:0 =SUM(Data!A2:A5)',
            '1:0:0 =SUM(Data!A3:A5)',
        ]);
    });

    it('caps the listed items but counts every flagged formula', () => {
        const review = review_formula_divergence(
            workbook(MAX_FORMULA_DIVERGENCE_ITEMS + 10),
            [],
            [layout_of(moved(), 1), layout_of(undefined, 0)],
        );
        expect(review.items).toHaveLength(MAX_FORMULA_DIVERGENCE_ITEMS);
        expect(review.counts).toEqual([{ targetSheetIndex: 0, formulas: MAX_FORMULA_DIVERGENCE_ITEMS + 12 }]);
    });

    it('maps each flag reason to the spec class it belongs to', () => {
        expect(formula_divergence_class('cornersCrossed')).toBe('moved');
        expect(formula_divergence_class('displacedCorner')).toBe('moved');
        expect(formula_divergence_class('tombstoneCorner')).toBe('refilled');
        expect(formula_divergence_class('discardedCorner')).toBe('discarded');
        expect(formula_divergence_class('unadjustable')).toBe('unadjustable');
    });
});
