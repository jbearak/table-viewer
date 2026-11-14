// Formulas that use a #REF! formula's result: Save writes #REF! into the
// formulas that name a deleted row or column, and every formula that uses
// their results, directly or through others and on any worksheet, ends up
// as an error too. The Save warning counts those, by what the calculator
// evaluates them to after Save, and lists them after the formulas that name
// the deletion.
import { describe, expect, it } from 'vitest';
import { build_source_from_buffer } from '../data-source/from-buffer';
import type { DataSource } from '../data-source/interface';
import { EMPTY_PENDING_STRUCTURAL_CHANGES } from '../pending-changes';
import { delete_columns, type WorksheetStructureContext } from '../webview/pending-row-store';
import type { FormulaCalculationEdit, FormulaCalculationLayout } from '../formula-calculation';
import {
    MAX_FORMULA_DIVERGENCE_ITEMS,
    review_formula_divergence,
    type FormulaDivergenceReview,
} from '../formula-divergence-review';
import { build_fixture_xlsx, cell, row } from './helpers/xlsx-structure-fixture';

/**
 * Data: Item / Qty / Price / Total, Total `=B*C` on rows 2..(rows + 1), and an
 * "All" row with `=SUM(D2:D…)`. Summary: formulas that use the All total.
 */
async function prices(summary: readonly string[], rows = 4): Promise<DataSource> {
    const last = rows + 1;
    const data = [row(1, ['Item', 'Qty', 'Price', 'Total'].map((text, column) => cell(`${'ABCD'[column]}1`, text)))];
    for (let n = 2; n <= last; n += 1) {
        data.push(row(n, [
            cell(`A${n}`, `item ${n}`),
            cell(`B${n}`, n),
            cell(`C${n}`, 1.5),
            cell(`D${n}`, { f: `B${n}*C${n}`, v: n * 1.5 }),
        ]));
    }
    data.push(row(last + 1, [cell(`A${last + 1}`, 'All'), cell(`D${last + 1}`, { f: `SUM(D2:D${last})`, v: 1 })]));
    const bytes = build_fixture_xlsx({
        sheets: [
            { name: 'Data', body: `<sheetData>${data.join('')}</sheetData>` },
            {
                name: 'Summary',
                body: `<sheetData>${summary.map((text, index) =>
                    row(index + 1, [cell(`A${index + 1}`, { f: text.replace(/^=/, ""), v: 1 })])).join('')}</sheetData>`,
            },
        ],
    });
    return build_source_from_buffer(bytes, 'prices.xlsx');
}

/** Column C (Price) of Data deleted. */
function price_deleted(source: DataSource): FormulaCalculationLayout[] {
    const sheets = source.meta().sheets;
    const context: WorksheetStructureContext = {
        worksheet: { sheetIndex: 0, sheetName: 'Data' },
        bodyStart: 1,
        sourceRowCount: sheets[0]!.sourceRowCount,
        sourceColumnCount: sheets[0]!.columnCount,
        bodyViewTransformed: false,
    };
    const result = delete_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context, [{ kind: 'source', sourceColumn: 2 }]);
    if (!result.ok) throw new Error(result.refusal.message);
    return [
        { bodyStart: 1, columnLayout: result.outcome.next.columnLayout!, band: [] },
        { bodyStart: 0, band: [] },
    ];
}

const listed = (review: FormulaDivergenceReview) => review.dependents.map((item) =>
    `${item.sheetIndex}!${item.row}:${item.column} ${item.formula} ${item.result}`);

describe('formulas that use a #REF! formula', () => {
    it('counts and lists them on every worksheet, transitively, by what they evaluate to', async () => {
        const source = await prices([
            '=Data!D6*2',
            '=IFERROR(Data!D6,0)',
            '=ROUND(Data!D6,2)',
            '=Data!B2*2',
            '=A1+1',
            '=SUM(Data!B2:B5)',
            '=ISERROR(A3)',
            // Uses the IFERROR result, which catches the #REF!.
            '=A2*2',
        ]);
        const review = review_formula_divergence(source, [], price_deleted(source));
        expect(review.totals.deleted).toBe(4);
        expect(listed(review)).toEqual([
            // The All row, now in column C: SUM over four #REF! cells.
            '0!5:2 =SUM(C2:C5) ref',
            '1!0:0 =Data!C6*2 ref',
            '1!4:0 =A1+1 ref',
            // ROUND is outside what the calculator evaluates: it might show an error.
            '1!2:0 =ROUND(Data!C6,2) unchecked',
        ]);
        expect(review.totals).toMatchObject({ refDependents: 3, uncheckedDependents: 1 });
    });

    it('follows a pending formula that uses a broken result, and the formulas that use it', async () => {
        const source = await prices(['=Data!D6', '=SUM(A3:A4)', '=1', '=2']);
        const edits: FormulaCalculationEdit[] = [
            // Summary!A3, typed over `=1`: uses the All total. Without anchors
            // the text names source cells, so it renders as Data!C6.
            { sheetIndex: 1, row: 2, column: 0, value: '=Data!D6+1', writesFormula: true },
            // Summary!A4, typed over `=2`: uses nothing that breaks.
            { sheetIndex: 1, row: 3, column: 0, value: '=Data!B2', writesFormula: true },
        ];
        const review = review_formula_divergence(source, edits, price_deleted(source));
        expect(listed(review)).toEqual([
            '0!5:2 =SUM(C2:C5) ref',
            '1!0:0 =Data!C6 ref',
            '1!1:0 =SUM(A3:A4) ref',
            '1!2:0 =Data!C6+1 ref',
        ]);
    });

    it('says a pending formula it cannot calculate might break when it uses a broken one', async () => {
        const source = await prices(['=ROUND(Data!D6,2)', '=1']);
        const review = review_formula_divergence(source, [
            // Summary!A1 edited, still rounding the All total.
            { sheetIndex: 1, row: 0, column: 0, value: '=ROUND(Data!D6,3)', writesFormula: true },
            // Summary!A2 typed: rounds a Qty, which nothing broke.
            { sheetIndex: 1, row: 1, column: 0, value: '=ROUND(Data!B2,1)', writesFormula: true },
        ], price_deleted(source));
        expect(listed(review)).toEqual([
            '0!5:2 =SUM(C2:C5) ref',
            '1!0:0 =ROUND(Data!C6,3) unchecked',
        ]);
    });

    it('passes nothing on through a pending formula that catches errors', async () => {
        const source = await prices(['=Data!D6', '=A1*2']);
        const review = review_formula_divergence(source, [
            { sheetIndex: 1, row: 0, column: 0, value: '=IFERROR(Data!D6,0)', writesFormula: true },
        ], price_deleted(source));
        expect(listed(review)).toEqual(['0!5:2 =SUM(C2:C5) ref']);
    });

    it('lists nothing when a value typed over a broken formula stops the chain', async () => {
        const source = await prices(['=Data!D6']);
        const review = review_formula_divergence(source, [
            // Data!D6 (now C6) replaced by a number.
            { sheetIndex: 0, row: 5, column: 2, value: '12', writesFormula: false },
        ], price_deleted(source));
        expect(review.totals.deleted).toBe(4);
        expect(review.dependents).toEqual([]);
        expect(review.totals).toMatchObject({ refDependents: 0, uncheckedDependents: 0 });
    });

    it('shares the item cap with the formulas that name the deletion, and counts past it', async () => {
        const rows = MAX_FORMULA_DIVERGENCE_ITEMS - 10;
        const source = await prices(Array.from({ length: 30 }, () => `=Data!D${rows + 2}*2`), rows);
        const review = review_formula_divergence(source, [], price_deleted(source));
        expect(review.deleted).toHaveLength(rows);
        expect(review.dependents).toHaveLength(MAX_FORMULA_DIVERGENCE_ITEMS - rows);
        expect(review.totals).toMatchObject({ deleted: rows, refDependents: 31, uncheckedDependents: 0 });
    }, 60_000);
});
