import { describe, expect, it, vi } from 'vitest';
import {
    calculate_workbook_formulas,
    displayed_formula_result,
    type FormulaCalculationAddress,
} from '../formula-calculation';
import type {
    ColumnWindow,
    DataSource,
    RenderedCell,
    WorkbookMeta,
} from '../data-source/interface';

function cell(
    raw: string,
    options: Partial<RenderedCell> = {},
): RenderedCell {
    return {
        raw,
        formatted: raw,
        bold: false,
        italic: false,
        rawType: raw === '' ? 'empty' : 'number',
        ...options,
    };
}

function workbook(
    sheets: readonly { name: string; rows: (RenderedCell | null)[][] }[],
): DataSource {
    const meta: WorkbookMeta = {
        hasFormatting: false,
        sheets: sheets.map((sheet) => ({
            name: sheet.name,
            rowCount: sheet.rows.length,
            sourceRowCount: sheet.rows.length,
            columnCount: Math.max(0, ...sheet.rows.map((row) => row.length)),
            merges: [],
            hasFormatting: false,
        })),
    };
    return {
        meta: () => meta,
        read_rows: (sheet, start, count) => ({
            startRow: start,
            rows: sheets[sheet].rows.slice(start, start + count),
        }),
        read_columns: (sheet, start, count, columns): ColumnWindow => ({
            startRow: start,
            rows: sheets[sheet].rows.slice(start, start + count)
                .map((row) => columns.map((column) => row[column] ?? null)),
        }),
        close: () => {},
    };
}

const target = (sheetIndex: number, row: number, column: number): FormulaCalculationAddress => ({
    sheetIndex, row, column,
});

describe('calculate_workbook_formulas', () => {
    it('calculates arithmetic with precedence, unary operators, powers, and percentages', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('2'),
            cell('3'),
            cell('0', { formula: '=-(A1+B1*2)^2+10%' }),
        ]] }]);
        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 2)],
        })).toEqual([{ ...target(0, 0, 2), value: '64.1' }]);
    });

    it('streams SUM and AVERAGE ranges and ignores blank and text cells', () => {
        const rows = Array.from({ length: 9_000 }, (_, row) => [
            row === 2 ? cell('', { rawType: 'empty' })
                : row === 3 ? cell('word', { rawType: 'string' })
                : cell('1'),
        ]);
        rows[0].push(cell('0', { formula: '=SUM(A1:A9000)' }));
        rows[1].push(cell('0', { formula: '=AVERAGE(A1:A9000)' }));
        const source = workbook([{ name: 'Sheet1', rows }]);
        const read_columns = vi.spyOn(source, 'read_columns');
        const results = calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 1), target(0, 1, 1)],
        });
        expect(results).toEqual([
            { ...target(0, 0, 1), value: '8998' },
            { ...target(0, 1, 1), value: '1' },
        ]);
        expect(read_columns.mock.calls.every(([, , count, columns]) =>
            count * columns.length <= 8_192)).toBe(true);
    });

    it('uses dirty values and recalculates recursively across quoted sheets', () => {
        const source = workbook([
            { name: "People's data", rows: [[cell('2')], [cell('4')]] },
            { name: 'Inventory', rows: [[
                cell('6', { formula: "=SUM('People''s data'!A1:A2)" }),
                cell('9', { formula: "=AVERAGE('People''s data'!A1:A2)+A1" }),
            ]] },
        ]);
        expect(calculate_workbook_formulas(source, {
            edits: [{ ...target(0, 0, 0), value: '5' }],
            targets: [target(1, 0, 0), target(1, 0, 1)],
        })).toEqual([
            { ...target(1, 0, 0), value: '9' },
            { ...target(1, 0, 1), value: '13.5' },
        ]);
    });

    it('calculates a newly entered formula', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[cell('4'), cell('literal', {
            rawType: 'string',
        })]] }]);
        expect(calculate_workbook_formulas(source, {
            edits: [{ ...target(0, 0, 1), value: '=A1/2' }],
            targets: [target(0, 0, 1)],
        })).toEqual([{ ...target(0, 0, 1), value: '2' }]);
    });

    it('reads formula coordinates through the canonical row capability', () => {
        const source = workbook([{ name: 'Sheet1', rows: [
            [cell('2')],
            [cell('0'), cell('6', { formula: '=A1*3' })],
        ] }]);
        source.read_canonical_columns = source.read_columns;
        source.read_columns = (_sheet, start, count, columns) => ({
            startRow: start,
            rows: Array.from({ length: count }, () => columns.map(() => cell('99'))),
        });
        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 1, 1)],
        })).toEqual([{ ...target(0, 1, 1), value: '6' }]);
    });

    it('ignores header, sort, filter, and hidden-view projections when resolving A1 rows', () => {
        const source = workbook([{ name: 'Sheet1', rows: [
            [cell('Header', { rawType: 'string' })],
            [cell('10'), cell('100', { formula: '=SUM(A2:A5)' })],
            [cell('20')],
            [cell('30')],
            [cell('40')],
        ] }]);
        const canonical_read = source.read_columns!.bind(source);
        source.read_canonical_columns = canonical_read;
        source.read_columns = vi.fn(() => {
            throw new Error('formula calculation entered display-row space');
        });
        Object.assign(source.meta().sheets[0], {
            // The displayed view has promoted row 1, filtered out two rows, and
            // sorted the survivors. Formula coordinates still span all five
            // physical rows; hidden columns are likewise absent only from the UI.
            rowCount: 2,
            excelFirstRowHeader: {
                mode: 'on',
                detected: false,
                active: true,
                available: true,
                sourceRow: 0,
            },
        });

        expect(calculate_workbook_formulas(source, {
            // Excel row 3 is not in the displayed projection, but A3 still
            // resolves to it and sees its canonical dirty value.
            edits: [{ ...target(0, 2, 0), value: '200' }],
            targets: [target(0, 1, 1)],
        })).toEqual([{ ...target(0, 1, 1), value: '280' }]);
        expect(source.read_columns).not.toHaveBeenCalled();
    });

    it.each([
        ['=MEDIAN(A1:A2)', 'unsupported function'],
        ['=SUM(A1:A2', 'parse error'],
        ['=1/0', 'numeric error'],
    ] as const)('reports %s as a %s', (formula, error) => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('1'),
            cell('0', { formula }),
        ]] }]);
        const [result] = calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 1)],
        });
        expect(result).toEqual({ ...target(0, 0, 1), error });
        expect(displayed_formula_result(result)).toBe(`?? (${error})`);
    });

    it('reports cycles and carries the reason into dependents', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('0', { formula: '=B1+1' }),
            cell('0', { formula: '=A1+1' }),
            cell('0', { formula: '=A1+2' }),
        ]] }]);
        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 0), target(0, 0, 1), target(0, 0, 2)],
        })).toEqual([
            { ...target(0, 0, 0), error: 'cycle' },
            { ...target(0, 0, 1), error: 'cycle' },
            { ...target(0, 0, 2), error: 'cycle' },
        ]);
    });

    it('carries an unsupported-function reason into recursive dependents', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('0', { formula: '=MEDIAN(D1:D2)' }),
            cell('0', { formula: '=A1+1' }),
            cell('0', { formula: '=B1+1' }),
            cell('1'),
        ], [cell(''), cell(''), cell(''), cell('2')]] }]);
        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 0), target(0, 0, 1), target(0, 0, 2)],
        })).toEqual([
            { ...target(0, 0, 0), error: 'unsupported function' },
            { ...target(0, 0, 1), error: 'unsupported function' },
            { ...target(0, 0, 2), error: 'unsupported function' },
        ]);
    });

    it('calculates a referenced formula whose cached result is missing', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('', { formula: '=2+3', formulaResultPending: true }),
            cell('', { formula: '=A1*4', formulaResultPending: true }),
        ]] }]);
        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 1)],
        })).toEqual([{ ...target(0, 0, 1), value: '20' }]);
    });

    it('treats valid references beyond the used worksheet rectangle as blank', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('0', { formula: '=Z100+1' }),
            cell('0', { formula: '=SUM(Y90:Z100)' }),
            cell('0', { formula: '=AVERAGE(Y90:Z100)' }),
        ]] }]);
        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 0), target(0, 0, 1), target(0, 0, 2)],
        })).toEqual([
            { ...target(0, 0, 0), value: '1' },
            { ...target(0, 0, 1), value: '0' },
            { ...target(0, 0, 2), error: 'numeric error' },
        ]);
    });
});
