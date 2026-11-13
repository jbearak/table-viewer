// The live calculator with Worksheet Layouts: prospective addresses map
// through the layouts to identities, removed rows and columns are not
// addressable, formulas render from their anchors before they evaluate, and a
// request without layouts calculates exactly as before.
import { describe, expect, it } from 'vitest';
import {
    calculate_workbook_formulas,
    displayed_formula_result,
    own_formula_calculation_layouts,
    type FormulaCalculationAddress,
    type FormulaCalculationEdit,
    type FormulaCalculationLayout,
    type FormulaCalculationRequest,
} from '../formula-calculation';
import type { ColumnWindow, DataSource, RenderedCell, WorkbookMeta } from '../data-source/interface';
import { EMPTY_PENDING_STRUCTURAL_CHANGES, type PendingStructuralChanges } from '../pending-changes';
import {
    delete_columns,
    delete_rows,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import type { FormulaAnchors } from '../formula-anchors';

function number(raw: string): RenderedCell {
    return { raw, formatted: raw, bold: false, italic: false, rawType: raw === '' ? 'empty' : 'number' };
}

function formula(text: string): RenderedCell {
    return { raw: '', formatted: '', bold: false, italic: false, rawType: 'number', formula: text };
}

/** Sheet `Data`: header row 1, body rows 2..6 hold 10..50 in A and 1..5 in B; C2 holds `=SUM(A2:A6)`. */
function source(): { source: DataSource; reads: { start: number; count: number; columns: number[] }[] } {
    const rows: (RenderedCell | null)[][] = [
        [number(''), number(''), null],
        [number('10'), number('1'), formula('=SUM(A2:A6)')],
        [number('20'), number('2'), formula('=A4*2')],
        [number('30'), number('3'), formula('=INDEX(A:A,1):A3')],
        [number('40'), number('4'), formula('=B6+A2')],
        [number('50'), number('5'), null],
    ];
    const meta: WorkbookMeta = {
        hasFormatting: false,
        sheets: [{
            name: 'Data',
            rowCount: rows.length,
            sourceRowCount: rows.length,
            columnCount: 3,
            merges: [],
            hasFormatting: false,
            columnNames: ['Amount', 'Units', 'Total'],
            excelFirstRowHeader: { mode: 'on', detected: false, active: true, available: true, sourceRow: 0 },
        }],
    };
    const reads: { start: number; count: number; columns: number[] }[] = [];
    return {
        reads,
        source: {
            meta: () => meta,
            read_rows: (_sheet, start, count) => ({ startRow: start, rows: rows.slice(start, start + count) }),
            read_columns: (_sheet, start, count, columns): ColumnWindow => {
                reads.push({ start, count, columns: [...columns] });
                return {
                    startRow: start,
                    rows: rows.slice(start, start + count).map((row) => columns.map((column) => row[column] ?? null)),
                };
            },
            close: () => {},
        },
    };
}

const context: WorksheetStructureContext = {
    worksheet: { sheetIndex: 0, sheetName: 'Data' },
    bodyStart: 1,
    sourceRowCount: 6,
    sourceColumnCount: 3,
    bodyViewTransformed: false,
};

/** Delete the body rows at the given 0-based source rows through the store's operation. */
function deleted(source_rows: readonly number[], changes = EMPTY_PENDING_STRUCTURAL_CHANGES): PendingStructuralChanges {
    const result = delete_rows(changes, context, source_rows.map((sourceRow) => ({ kind: 'source', sourceRow })));
    if (!result.ok) throw new Error(result.refusal.message);
    return result.outcome.next;
}

function layout_of(changes: PendingStructuralChanges): FormulaCalculationLayout {
    return {
        bodyStart: 1,
        ...(changes.rowLayout === undefined ? {} : { rowLayout: changes.rowLayout }),
        ...(changes.columnLayout === undefined ? {} : { columnLayout: changes.columnLayout }),
        band: [],
    };
}

const at = (row: number, column: number): FormulaCalculationAddress => ({ sheetIndex: 0, row, column });

function results(request: FormulaCalculationRequest): Record<string, string> {
    return Object.fromEntries(calculate_workbook_formulas(source().source, request)
        .map((result) => [`${result.row}:${result.column}`, displayed_formula_result(result)]));
}

describe('calculation with layouts', () => {
    it('renders source formulas and reads prospective cells after a row delete', () => {
        // Delete row 3 (source row 2, A=20): rows 4..6 move up one.
        const layouts = [layout_of(deleted([2]))];
        expect(results({
            edits: [],
            // C2 stays at 1:2; C5 (`=B6+A2`, source row 4) is now row 4 (3:2); C4 (source row 3) is row 3.
            targets: [at(1, 2), at(3, 2), at(2, 2)],
            layouts,
        })).toEqual({
            // =SUM(A2:A5) over 10, 30, 40, 50.
            '1:2': '130',
            // =B5+A2: B of the old row 6 is 5, A of row 2 is 10.
            '3:2': '15',
            // =INDEX(A:A,1):A3 cannot be adjusted while rows on this sheet change.
            '2:2': "?? (can't adjust a range built from a function)",
        });
    });

    it('does not address a removed row or column', () => {
        // Delete row 3 and column B: column B is now the old C.
        const rows_and_column = (() => {
            const result = delete_columns(deleted([2]), context, [{ kind: 'source', sourceColumn: 1 }]);
            if (!result.ok) throw new Error(result.refusal.message);
            return result.outcome.next;
        })();
        const calculated = results({
            edits: [],
            targets: [at(1, 1), at(3, 1), at(5, 0), at(1, 2)],
            layouts: [layout_of(rows_and_column)],
        });
        // C2 is now B2: =SUM(A2:A5).
        expect(calculated['1:1']).toBe('130');
        // C5 is now B4: `=B6+A2` names the removed column, so it is `#REF!`.
        expect(calculated['3:1']).toBe('?? (parse error)');
        // Row 6 and column C are past the prospective sheet.
        expect(calculated['5:0']).toBe('?? (parse error)');
        expect(calculated['1:2']).toBe('?? (parse error)');
    });

    it('renders an edit from its stored anchors', () => {
        // `=A3`, anchored after the delete to the row holding 40 (source row 4).
        const anchors: FormulaAnchors = {
            references: [{
                start: 1,
                end: 3,
                corners: [{
                    row: { kind: 'identity', row: { kind: 'source', sourceRow: 4 } },
                    column: { kind: 'identity', column: { kind: 'source', sourceColumn: 0 } },
                }],
            }],
        };
        const edit: FormulaCalculationEdit = {
            ...at(4, 1),
            value: '=A3',
            writesFormula: true,
            formulaAnchors: anchors,
        };
        // With row 3 deleted the anchored row is prospective row 4.
        expect(results({ edits: [edit], targets: [at(4, 1)], layouts: [layout_of(deleted([2]))] })['4:1'])
            .toBe('40');
        // Restoring every row (the source layout) renders `=A5`.
        expect(results({
            edits: [{ ...edit, row: 4 }],
            targets: [at(4, 1)],
            layouts: [{ bodyStart: 1, band: [] }],
        })['4:1']).toBe('40');
    });

    it('reads consecutive source rows in one read', () => {
        const { source: data, reads } = source();
        calculate_workbook_formulas(data, {
            edits: [],
            targets: [at(1, 2)],
            layouts: [layout_of(deleted([2]))],
        });
        // SUM(A2:A5) reads source row 1, then the run of source rows 3..5.
        expect(reads).toContainEqual({ start: 3, count: 3, columns: [0] });
    });

    it('calculates exactly as before without layouts', () => {
        const request: FormulaCalculationRequest = {
            edits: [{ ...at(4, 1), value: '=A3', writesFormula: true }],
            targets: [at(1, 2), at(4, 2), at(4, 1)],
        };
        expect(results(request)).toEqual({ '1:2': '150', '4:2': '15', '4:1': '20' });
        // A source-layout request is the same calculation.
        expect(results({ ...request, layouts: [{ bodyStart: 1, band: [] }] }))
            .toEqual({ '1:2': '150', '4:2': '15', '4:1': '20' });
    });
});

describe('own_formula_calculation_layouts', () => {
    const sheets = [{ sourceRowCount: 6, columnCount: 3 }];

    it('owns a layout built by the store', () => {
        const layout = layout_of(deleted([2]));
        expect(own_formula_calculation_layouts([layout], sheets)).toEqual([layout]);
    });

    it.each<[string, unknown]>([
        ['a missing worksheet', []],
        ['an unknown field', [{ bodyStart: 1, band: [], extra: true }]],
        ['a body start past the sheet', [{ bodyStart: 7, band: [] }]],
        ['a duplicate band id', [{ bodyStart: 1, band: ['a', 'a'] }]],
        ['a row layout that misses a body row', [{
            bodyStart: 1,
            band: [],
            rowLayout: { runs: [{ kind: 'source', start: 1, count: 4 }], removedSourceRows: [], discardedPendingRows: [] },
        }]],
        ['a tail removal above the body', [{ bodyStart: 1, band: [], tailRemovedSourceRows: [0] }]],
    ])('refuses %s', (_label, value) => {
        expect(own_formula_calculation_layouts(value, sheets)).toBeUndefined();
    });
});
