// The Save warnings' divergence list (design "Where this differs from Excel"):
// every formula of the workbook whose range references the divergence flags
// mark for the current layouts, source and pending, on the formula's own
// worksheet and on others, at its prospective cell with its rendered text.
import { describe, expect, it } from 'vitest';
import type { ColumnWindow, DataSource, RenderedCell, WorkbookMeta } from '../data-source/interface';
import { EMPTY_PENDING_STRUCTURAL_CHANGES, type PendingStructuralChanges } from '../pending-changes';
import { delete_columns, delete_rows, move_rows, type WorksheetStructureContext } from '../webview/pending-row-store';
import { formula_calculation_workbook, type FormulaCalculationLayout } from '../formula-calculation';
import { formula_anchor_context } from '../formula-anchor-layout';
import { anchor_formula, formula_divergence_flags, render_formula } from '../formula-anchors';
import {
    delete_columns as delete_layout_columns,
    insert_rows as insert_layout_rows,
    move_rows as move_layout_rows,
    source_column_layout,
    source_row_layout,
    type RowLayout,
} from '../worksheet-layout';
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
                written: '=SUM(A2:A5)',
                classes: ['moved'],
                axes: ['row'],
            },
            {
                targetSheetIndex: 0,
                sheetIndex: 1,
                row: 0,
                column: 0,
                formula: '=SUM(Data!A3:A5)',
                written: '=SUM(Data!A2:A4)',
                classes: ['moved'],
                axes: ['row'],
            },
        ]);
        // A single-cell reference and a formula naming only an unchanged sheet are never flagged.
        expect(review.counts).toEqual([{ targetSheetIndex: 0, formulas: 2 }]);
        // A move deletes nothing, so no formula will show #REF!.
        expect(review.deleted).toEqual([]);
        expect(review.deletedCounts).toEqual([]);
    });

    it('lists the formulas Save writes #REF! into, with the deleted rows and columns they name', () => {
        // Worksheet row 3 (source row 2) deleted: Data!C7 `=A3` and Summary!A2
        // `=Data!A3` lose their only cell. The ranges around it shrink instead.
        const row_deleted = (() => {
            const result = delete_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context, [{ kind: 'source', sourceRow: 2 }]);
            if (!result.ok) throw new Error(result.refusal.message);
            return result.outcome.next;
        })();
        const rows = review_formula_divergence(workbook(), [], [layout_of(row_deleted, 1), layout_of(undefined, 0)]);
        expect(rows.deleted.map((item) => [item.sheetIndex, item.row, item.column, item.formula, item.written]))
            .toEqual([
                [0, 5, 2, '=#REF!', '=A3'],
                [1, 1, 0, '=Data!#REF!', '=Data!A3'],
            ]);
        expect(rows.deleted.every((item) =>
            item.targetSheetIndex === 0
            && JSON.stringify(item.rows) === JSON.stringify([{ kind: 'source', sourceRow: 2 }])
            && item.columns.length === 0)).toBe(true);
        expect(rows.deletedCounts).toEqual([{ targetSheetIndex: 0, formulas: 2 }]);

        // Column A deleted: every formula on the workbook names it.
        const column_deleted = (() => {
            const result = delete_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context, [{ kind: 'source', sourceColumn: 0 }]);
            if (!result.ok) throw new Error(result.refusal.message);
            return result.outcome.next;
        })();
        const columns = review_formula_divergence(workbook(), [], [
            { ...layout_of(undefined, 1), columnLayout: column_deleted.columnLayout! },
            layout_of(undefined, 0),
        ]);
        expect(columns.deleted.map((item) => `${item.sheetIndex}!${item.row}:${item.column} ${item.formula}`))
            .toEqual([
                '0!1:1 =SUM(#REF!)',
                '0!6:1 =#REF!',
                '1!0:0 =SUM(Data!#REF!)',
                '1!1:0 =Data!#REF!',
            ]);
        expect(columns.deleted.every((item) =>
            JSON.stringify(item.columns) === JSON.stringify([{ kind: 'source', sourceColumn: 0 }]))).toBe(true);
        // Summary!A3 `=SUM(A1:A2)` names Summary only, which lost nothing.
        expect(columns.deletedCounts).toEqual([{ targetSheetIndex: 0, formulas: 4 }]);
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
        expect(review.totals).toEqual({ deleted: 0, changedRanges: MAX_FORMULA_DIVERGENCE_ITEMS + 12, unadjustable: 0, refDependents: 0, uncheckedDependents: 0 });
    });

    describe('past the item cap, totals count each formula cell once', () => {
        // Data and Other: Header Row 1 and six body rows of values in A and B.
        // Summary: past the cap, formulas that each name both worksheets.
        const values = () => Array.from({ length: 7 }, (_, row) => [value(`${row}`), value(`${row}`)]);
        const past_cap = MAX_FORMULA_DIVERGENCE_ITEMS + 5;
        const source = (summary: (RenderedCell | null)[][]) => source_of([
            { name: 'Data', header: true, rows: values() },
            { name: 'Other', header: true, rows: values() },
            { name: 'Summary', rows: summary },
        ]);

        it('counts a formula using deleted columns on two worksheets once', () => {
            const deleted = delete_layout_columns(source_column_layout(2), [{ kind: 'source', sourceColumn: 0 }], () => 0);
            if (!deleted.ok) throw new Error(deleted.refusal.reason);
            const review = review_formula_divergence(
                source(Array.from({ length: past_cap }, () => [formula('=Data!A2+Other!A2')])),
                [],
                [
                    { bodyStart: 1, columnLayout: deleted.layout, band: [] },
                    { bodyStart: 1, columnLayout: deleted.layout, band: [] },
                    layout_of(undefined, 0),
                ],
            );
            expect(review.deleted).toHaveLength(MAX_FORMULA_DIVERGENCE_ITEMS);
            expect(review.deletedCounts).toEqual([
                { targetSheetIndex: 0, formulas: past_cap },
                { targetSheetIndex: 1, formulas: past_cap },
            ]);
            expect(review.totals).toEqual({ deleted: past_cap, changedRanges: 0, unadjustable: 0, refDependents: 0, uncheckedDependents: 0 });
        });

        it('counts range changes on two worksheets once, and an unadjustable formula the cap left unlisted', () => {
            // Both worksheets: source row 1 moved below source row 4, so
            // A2:A4's first corner was carried.
            const layout = layout_of(moved(), 1);
            const review = review_formula_divergence(
                source([
                    ...Array.from({ length: past_cap }, () => [formula('=SUM(Data!A2:A4)+SUM(Other!A2:A4)')]),
                    [formula('=SUM(INDEX(Data!A:A,MATCH("x",Data!A:A,0)):Data!B5)')],
                ]),
                [],
                [layout, layout, layout_of(undefined, 0)],
            );
            expect(review.items).toHaveLength(MAX_FORMULA_DIVERGENCE_ITEMS);
            expect(review.items.some((item) => item.classes.includes('unadjustable'))).toBe(false);
            expect(review.counts).toEqual([
                { targetSheetIndex: 0, formulas: past_cap + 1 },
                { targetSheetIndex: 1, formulas: past_cap },
            ]);
            expect(review.totals).toEqual({ deleted: 0, changedRanges: past_cap, unadjustable: 1, refDependents: 0, uncheckedDependents: 0 });
        });
    });

    it('maps each flag reason to the spec class it belongs to', () => {
        expect(formula_divergence_class('cornersCrossed')).toBe('moved');
        expect(formula_divergence_class('displacedCorner')).toBe('moved');
        expect(formula_divergence_class('tombstoneCorner')).toBe('refilled');
        expect(formula_divergence_class('discardedCorner')).toBe('discarded');
        expect(formula_divergence_class('unadjustable')).toBe('unadjustable');
    });
});

/** A DataSource over in-memory sheets; `header` marks sheets whose row 1 is an active Header Row. */
function source_of(sheets: readonly { name: string; rows: (RenderedCell | null)[][]; header?: boolean }[]): DataSource {
    const packed = (rows: (RenderedCell | null)[][]) => rows.flatMap((row, index) =>
        row.flatMap((cell, column) => cell?.formula === undefined ? [] : [index, column]));
    const meta: WorkbookMeta = {
        hasFormatting: false,
        sheets: sheets.map(({ name, rows, header }) => ({
            name,
            rowCount: rows.length,
            sourceRowCount: rows.length,
            columnCount: Math.max(...rows.map((row) => row.length)),
            merges: [],
            hasFormatting: false,
            formulaCells: packed(rows),
            ...(header ? {
                excelFirstRowHeader: { mode: 'on' as const, detected: false, active: true, available: true, sourceRow: 0 },
            } : {}),
        })),
    };
    return {
        meta: () => meta,
        read_rows: (sheet, start, count) => ({ startRow: start, rows: sheets[sheet]!.rows.slice(start, start + count) }),
        read_columns: (sheet, start, count, columns): ColumnWindow => ({
            startRow: start,
            rows: sheets[sheet]!.rows.slice(start, start + count)
                .map((row) => columns.map((column) => row[column] ?? null)),
        }),
        close: () => {},
    };
}

describe('a range whose last row was moved up', () => {
    // The report: Header Row 1, amounts in B2:B5, B7 `=SUM(B2:B5)`, a note in
    // row 8, and Summary!A1 `=SUM(Data!B2:B5)`.
    const budget = () => source_of([
        {
            name: 'Data',
            header: true,
            rows: [
                [value('Name'), value('Amount')],
                [value('a'), value('3')],
                [value('b'), value('5')],
                [value('c'), value('9')],
                [value('d'), value('7')],
                [null, null],
                [value('Total'), formula('=SUM(B2:B5)')],
                [value('Note'), null],
            ],
        },
        { name: 'Summary', rows: [[formula('=SUM(Data!B2:B5)')]] },
    ]);
    const budget_context: WorksheetStructureContext = {
        worksheet: { sheetIndex: 0, sheetName: 'Data' },
        bodyStart: 1,
        sourceRowCount: 8,
        sourceColumnCount: 2,
        bodyViewTransformed: false,
    };
    /** Move worksheet rows, named by source row, before another source row's row. */
    const move = (changes: PendingStructuralChanges, source_row: number, before: number) => {
        const result = move_rows(changes, budget_context, [{ kind: 'source', sourceRow: source_row }], {
            kind: 'source',
            sourceRow: before,
        });
        if (!result.ok) throw new Error(result.refusal.message);
        return result.outcome.next;
    };
    const review_of = (changes: PendingStructuralChanges) =>
        review_formula_divergence(budget(), [], [layout_of(changes, 1), layout_of(undefined, 0)]);

    it('flags the formula and its cross-sheet dependent when one move carries the corner', () => {
        // Row 5 (`d`) above row 3: the range's last corner now sits on row 3.
        const review = review_of(move(EMPTY_PENDING_STRUCTURAL_CHANGES, 4, 2));
        expect(review.items.map((item) => `${item.sheetIndex}:${item.row}:${item.column} ${item.formula} ${item.classes}`))
            .toEqual(['0:6:1 =SUM(B2:B3) moved', '1:0:0 =SUM(Data!B2:B3) moved']);
        expect(review.counts).toEqual([{ targetSheetIndex: 0, formulas: 2 }]);
    });

    it('still flags them after a later move leaves the carried corner in order with its neighbors', () => {
        // Row 5 (`d`) above row 4 (`c`), then the note row above `c`: rows
        // 2, 3, 5, 8, 4, 6, 7. `d`'s run is in order with the runs beside it,
        // but `c`, after it, came before it in the source.
        const changes = move(move(EMPTY_PENDING_STRUCTURAL_CHANGES, 4, 3), 7, 3);
        const review = review_of(changes);
        expect(review.items.map((item) => `${item.sheetIndex}:${item.row}:${item.column} ${item.formula} ${item.classes} ${item.axes}`))
            .toEqual(['0:7:1 =SUM(B2:B4) moved row', '1:0:0 =SUM(Data!B2:B4) moved row']);
        expect(review.counts).toEqual([{ targetSheetIndex: 0, formulas: 2 }]);
    });
});

describe('divergence flags over every short move sequence', () => {
    // Data: Header Row 1, body rows 2-7 (source rows 1-6). Each range is on
    // Summary, so no move carries the formula itself.
    const BODY = 6;
    const sheets = [
        { name: 'Data', sourceRowCount: BODY + 1, columnCount: 2 },
        { name: 'Summary', sourceRowCount: 1, columnCount: 1 },
    ];
    type State = { readonly layout: RowLayout; readonly order: readonly number[] };
    /** Every move of one or two adjacent body rows to every other place. */
    function* moves(state: State): Generator<State> {
        const { order } = state;
        for (let count = 1; count <= 2; count += 1) {
            for (let first = 0; first + count <= order.length; first += 1) {
                for (let before = 0; before <= order.length; before += 1) {
                    if (before >= first && before <= first + count) continue;
                    const block = order.slice(first, first + count);
                    const result = move_layout_rows(
                        state.layout,
                        block.map((sourceRow) => ({ kind: 'source' as const, sourceRow })),
                        before === order.length ? 'end' : { kind: 'source', sourceRow: order[before]! },
                    );
                    if (!result.ok) throw new Error(result.refusal.reason);
                    const rest = order.filter((row) => !block.includes(row));
                    const at = before === order.length ? rest.length : rest.indexOf(order[before]!);
                    yield { layout: result.layout, order: [...rest.slice(0, at), ...block, ...rest.slice(at)] };
                }
            }
        }
    }

    it('flags every range that no longer sums the rows it summed', () => {
        const start: State = {
            layout: source_row_layout(1, BODY),
            order: Array.from({ length: BODY }, (_, index) => index + 1),
        };
        let checked = 0;
        let flagged_count = 0;
        const check = (state: State) => {
            const workbook = formula_calculation_workbook(sheets, [
                { bodyStart: 1, rowLayout: state.layout, band: [] },
                { bodyStart: 0, band: [] },
            ]);
            const context = formula_anchor_context(workbook, 1);
            for (let first = 2; first <= BODY + 1; first += 1) {
                for (let last = first + 1; last <= BODY + 1; last += 1) {
                    const text = `=SUM(Data!B${first}:B${last})`;
                    checked += 1;
                    if (formula_divergence_flags(text, undefined, context).length > 0) {
                        flagged_count += 1;
                        continue;
                    }
                    const rendered = render_formula(text, undefined, context);
                    const match = rendered.kind === 'rendered'
                        ? /^=SUM\(Data!B(\d+):B(\d+)\)$/.exec(rendered.text)
                        : null;
                    expect(match, text).not.toBeNull();
                    // Worksheet row r holds source row order[r - 2].
                    const summed = state.order.slice(Number(match![1]) - 2, Number(match![2]) - 1).sort((a, b) => a - b);
                    const before = Array.from({ length: last - first + 1 }, (_, index) => first - 1 + index);
                    expect(summed, `${text} after ${state.order.join(',')}`).toEqual(before);
                }
            }
        };
        for (const once of moves(start)) {
            check(once);
            for (const twice of moves(once)) check(twice);
        }
        expect(checked).toBeGreaterThan(30_000);
        expect(flagged_count).toBeGreaterThan(0);
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

    it('counts what a plain column delete does, with no conflict: #REF! for every reference wholly in it', () => {
        // Data (no Header Row): values in A-D, formulas in E and one in C4,
        // the column the action deletes.
        const source = source_of([
            {
                name: 'Data',
                rows: [
                    [value('1'), value('2'), value('3'), value('4'), formula('=C1')],
                    [value('1'), value('2'), value('3'), value('4'), formula('=SUM(B2:D2)')],
                    [value('1'), value('2'), value('3'), value('4'), formula('=SUM(C1:C3)')],
                    [value('1'), value('2'), formula('=B4'), value('4'), formula('=A4+#REF!')],
                    [value('1'), value('2'), value('3'), value('4'), formula('=A5')],
                ],
            },
            {
                name: 'Summary',
                rows: [
                    [formula('=Data!C2')],
                    [formula('=SUM(Data!C:C)')],
                    [formula('=SUM(Data!B:D)')],
                    [formula('=Data!D1')],
                    [formula('="#REF!"&Data!A1')],
                    [formula('=Data!E2+Data!C2')],
                ],
            },
        ]);
        const deleted = delete_layout_columns(
            source_column_layout(5),
            [{ kind: 'source', sourceColumn: 2 }],
            () => 0,
        );
        if (!deleted.ok) throw new Error(deleted.refusal.reason);
        const impact = review_formula_impact(
            source,
            { edits: [], layouts: [layout_of(undefined, 0), layout_of(undefined, 0)] },
            {
                edits: [],
                layouts: [{ bodyStart: 0, columnLayout: deleted.layout, band: [] }, layout_of(undefined, 0)],
            },
        );
        // #REF!: E1 `=C1`, E3 `=SUM(C1:C3)`, Summary `=Data!C2`, `=SUM(Data!C:C)`,
        // and `=Data!E2+Data!C2`, which gains one. Moved: E2 to `=SUM(B2:C2)`,
        // `=SUM(Data!B:C)`, and `=Data!C1`. Not counted: C4, on the deleted
        // column; `=A4+#REF!` and `=A5`, unchanged though their cells move left;
        // and the `#REF!` inside a string.
        expect(impact).toEqual({ ref: 5, moved: 3 });
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
