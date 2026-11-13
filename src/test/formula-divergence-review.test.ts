// Review Changes' divergence list (design "Where this differs from Excel"):
// every formula of the workbook whose range references the divergence flags
// mark for the current layouts, source and pending, on the formula's own
// worksheet and on others, at its prospective cell with its rendered text.
import { describe, expect, it } from 'vitest';
import type { ColumnWindow, DataSource, RenderedCell, WorkbookMeta } from '../data-source/interface';
import { EMPTY_PENDING_STRUCTURAL_CHANGES, type PendingStructuralChanges } from '../pending-changes';
import { delete_rows, move_rows, type WorksheetStructureContext } from '../webview/pending-row-store';
import { formula_calculation_workbook, type FormulaCalculationLayout } from '../formula-calculation';
import { formula_anchor_context } from '../formula-anchor-layout';
import { anchor_formula } from '../formula-anchors';
import { insert_rows as insert_layout_rows, source_row_layout } from '../worksheet-layout';
import {
    MAX_FORMULA_DIVERGENCE_ITEMS,
    formula_divergence_class,
    review_formula_divergence,
    review_formula_impact,
    review_formula_impact_cooperatively,
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

describe('review_formula_impact', () => {
    it('counts formulas a discard turns to #REF! and those it points at different rows', () => {
        // Data: a Pending Inserted Row `p1` after worksheet row 2.
        const inserted = insert_layout_rows(source_row_layout(1, 6), { kind: 'source', sourceRow: 1 }, 'after', ['p1']);
        if (!inserted.ok) throw new Error(inserted.refusal.message);
        const before_layouts: FormulaCalculationLayout[] = [
            { bodyStart: 1, rowLayout: inserted.layout, band: [] },
            layout_of(undefined, 0),
        ];
        const source = workbook();
        // Summary!A3 now names the inserted row, Data!A3, by its identity.
        const anchored = anchor_formula(
            '=Data!A3',
            formula_anchor_context(formula_calculation_workbook(source.meta().sheets, before_layouts), 1),
        );
        if (anchored.kind !== 'anchored') throw new Error('not anchored');
        const edit = {
            sheetIndex: 1,
            row: 2,
            column: 0,
            value: '=Data!A3',
            writesFormula: true,
            ...(anchored.anchors === undefined ? {} : { formulaAnchors: anchored.anchors }),
        };
        const impact = review_formula_impact(
            source,
            { edits: [edit], layouts: before_layouts },
            { edits: [edit], layouts: [layout_of(undefined, 1), layout_of(undefined, 0)] },
        );
        // Summary!A3 shows #REF!; Data!C2, Data!C7, Summary!A1, and Summary!A2
        // lose the inserted row and render one row up.
        expect(impact).toEqual({ ref: 1, moved: 4 });
        // A `#REF!` inside a string literal is text, not a broken reference.
        const quoted = anchor_formula(
            '="#REF!"&Data!A3',
            formula_anchor_context(formula_calculation_workbook(source.meta().sheets, before_layouts), 1),
        );
        if (quoted.kind !== 'anchored') throw new Error('not anchored');
        const quoted_edit = {
            ...edit,
            value: '="#REF!"&Data!A3',
            ...(quoted.anchors === undefined ? {} : { formulaAnchors: quoted.anchors }),
        };
        expect(review_formula_impact(
            source,
            { edits: [quoted_edit], layouts: before_layouts },
            { edits: [quoted_edit], layouts: [layout_of(undefined, 1), layout_of(undefined, 0)] },
        )).toEqual({ ref: 1, moved: 4 });
        // Nothing changes when the layouts do not.
        expect(review_formula_impact(
            source,
            { edits: [edit], layouts: before_layouts },
            { edits: [edit], layouts: before_layouts },
        )).toEqual({ ref: 0, moved: 0 });
    });

    it('yields while rendering formula edits, not only source formulas', async () => {
        const with_formulas = workbook();
        const meta = with_formulas.meta();
        // No source formulas: every formula the impact renders is an edit.
        const source: DataSource = {
            ...with_formulas,
            meta: () => ({ ...meta, sheets: meta.sheets.map((sheet) => ({ ...sheet, formulaCells: [] })) }),
        };
        const edits = Array.from({ length: 5_000 }, (_, index) => ({
            sheetIndex: 0, row: 1 + (index % 6), column: 1, value: '=A2', writesFormula: true,
        }));
        const state = { edits, layouts: [layout_of(moved(), 1), layout_of(undefined, 0)] };
        let yields = 0;
        await review_formula_impact_cooperatively(source, state, state, {
            isCancelled: () => false,
            workSliceMs: 0,
            yieldControl: async () => { yields += 1; },
        });
        expect(yields).toBeGreaterThan(2);
    });

    it('yields while comparing, counting unchanged formulas in each batch', async () => {
        const source = workbook(3_000);
        const state = { edits: [], layouts: [layout_of(undefined, 1), layout_of(undefined, 0)] };
        let yields = 0;
        // Nothing changes, so every comparison is of an unchanged formula.
        const impact = await review_formula_impact_cooperatively(source, state, state, {
            isCancelled: () => false,
            workSliceMs: 0,
            yieldControl: async () => { yields += 1; },
        });
        expect(impact).toEqual({ ref: 0, moved: 0 });
        // Rendering yields every 256 formulas in each state; comparing does too.
        expect(yields).toBeGreaterThanOrEqual(3 * Math.floor(3_000 / 256));
    });

    it('yields between slices and stops once cancelled', async () => {
        const source = workbook(2_500);
        const before = { edits: [], layouts: [layout_of(moved(), 1), layout_of(undefined, 0)] };
        const after = { edits: [], layouts: [layout_of(undefined, 1), layout_of(undefined, 0)] };
        let yields = 0;
        const impact = await review_formula_impact_cooperatively(source, before, after, {
            isCancelled: () => false,
            workSliceMs: 0,
            yieldControl: async () => { yields += 1; },
        });
        expect(impact).toEqual(review_formula_impact(source, before, after));
        expect(impact!.moved).toBeGreaterThan(2_500);
        expect(yields).toBeGreaterThan(0);
        let cancelled = false;
        expect(await review_formula_impact_cooperatively(source, before, after, {
            isCancelled: () => cancelled,
            workSliceMs: 0,
            yieldControl: async () => { cancelled = true; },
        })).toBeUndefined();
    });
});
