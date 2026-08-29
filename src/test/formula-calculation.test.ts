import { describe, expect, it, vi } from 'vitest';
import {
    calculate_workbook_formulas,
    calculate_workbook_formulas_bounded,
    calculate_workbook_formulas_cooperatively,
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
    sheets: readonly {
        name: string;
        rows: (RenderedCell | null)[][];
        headerRow?: number;
        columnNames?: string[];
    }[],
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
            ...(sheet.columnNames ? {
                columnNames: sheet.columnNames,
                excelFirstRowHeader: {
                    mode: 'on' as const,
                    detected: false,
                    active: true,
                    available: true,
                    sourceRow: sheet.headerRow ?? 0,
                },
            } : {}),
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
    it('calculates Header Row column ranges and row intersections', () => {
        const source = workbook([{ name: 'Data', columnNames: ['Revenue', 'Units'], rows: [
            [cell('Revenue', { rawType: 'string' }), cell('Units', { rawType: 'string' })],
            [cell('10'), cell('2'), cell('0', { formula: '=SUM([Revenue])+[@Units]' })],
            [cell('20'), cell('3')],
        ] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 1, 2)],
        })).toEqual([{ ...target(0, 1, 2), value: '32' }]);
    });

    it('resolves qualified worksheet columns and the target physical row', () => {
        const source = workbook([
            { name: 'Output', rows: [[], [cell('0', { formula: "='Sales Q1'![@Revenue]" })]] },
            { name: 'Sales Q1', columnNames: ['Revenue'], rows: [
                [cell('Revenue', { rawType: 'string' })], [cell('7')],
            ] },
        ]);

        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 1, 0)],
        })).toEqual([{ ...target(0, 1, 0), value: '7' }]);
    });

    it('resolves both old and pending names during an unsaved column rename', () => {
        const source = workbook([{ name: 'Data', columnNames: ['Revenue', 'Formula'], rows: [
            [cell('Revenue', { rawType: 'string' }), cell('Formula', { rawType: 'string' })],
            [cell('5'), cell('0', { formula: '=SUM([Revenue])+SUM([Net Revenue])' })],
        ] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [{
                ...target(0, 0, 0),
                value: 'Net Revenue',
                writesFormula: false,
            }],
            targets: [target(0, 1, 1)],
        })).toEqual([{ ...target(0, 1, 1), value: '10' }]);
    });

    it('reports precise Header Row reference failures', () => {
        const source = workbook([{ name: 'Data', columnNames: ['Revenue', 'Revenue'], rows: [
            [cell('Revenue'), cell('Revenue'), cell('0', { formula: '=[Revenue]' })],
            [cell('1'), cell('2')],
        ] }]);
        expect(calculate_workbook_formulas(source, {
            edits: [
                { ...target(0, 0, 2), value: '=[Missing]', writesFormula: true },
                { ...target(0, 1, 0), value: '=[Revenue]', writesFormula: true },
            ],
            targets: [target(0, 0, 2), target(0, 1, 0)],
        })).toEqual([
            { ...target(0, 0, 2), error: 'unknown column' },
            { ...target(0, 1, 0), error: 'ambiguous column' },
        ]);
    });

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

    it('evaluates chained powers left to right like Excel', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('0', { formula: '=2^3^2' }),
        ]] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 0)],
        })).toEqual([{ ...target(0, 0, 0), value: '64' }]);
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

    it('calculates an unqualified whole-row range that starts with a digit', () => {
        const source = workbook([{ name: 'Sheet1', rows: [
            [cell('0', { formula: '=SUM(2:2)' })],
            [cell('2'), cell('3')],
        ] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 0)],
        })).toEqual([{ ...target(0, 0, 0), value: '5' }]);
    });

    it('does not retain ordinary point values across a broad calculation', () => {
        const row_count = 4_096;
        let first_literal_reads = 0;
        const meta: WorkbookMeta = {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: row_count,
                sourceRowCount: row_count,
                columnCount: 2,
                merges: [],
                hasFormatting: false,
            }],
        };
        const source: DataSource = {
            meta: () => meta,
            read_rows: () => { throw new Error('formula calculation used display rows'); },
            read_columns: (_sheet, start, count, columns) => ({
                startRow: start,
                rows: Array.from({ length: count }, (_, row_offset) => {
                    const row = start + row_offset;
                    return columns.map((column) => {
                        if (column === 0) {
                            if (row === 0) first_literal_reads += 1;
                            return cell(String(row + 1));
                        }
                        return cell('0', {
                            formula: row === row_count - 1 ? '=A1' : `=A${row + 1}`,
                        });
                    });
                }),
            }),
            close: () => {},
        };

        const results = calculate_workbook_formulas(source, {
            edits: [],
            targets: Array.from({ length: row_count }, (_, row) => target(0, row, 1)),
        });

        expect(results).toHaveLength(row_count);
        expect(results.at(-1)).toEqual({ ...target(0, row_count - 1, 1), value: '1' });
        // A1 is read for the first and last target. If ordinary point values
        // leaked into the request-long formula memo, the second read would hit it.
        expect(first_literal_reads).toBe(2);
    });

    it('bounds synchronous fallback work and returns only completed results', () => {
        const row_count = 1_000_000;
        const meta: WorkbookMeta = {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: row_count,
                sourceRowCount: row_count,
                columnCount: 2,
                merges: [],
                hasFormatting: false,
            }],
        };
        const read_columns: NonNullable<DataSource['read_columns']> = vi.fn((
            _sheet: number,
            start: number,
            count: number,
            columns: readonly number[],
        ): ColumnWindow => ({
            startRow: start,
            rows: Array.from({ length: count }, (_, row_offset) => columns.map((column) => {
                const row = start + row_offset;
                if (column === 1 && row === 0) return cell('0', { formula: '=1' });
                if (column === 1 && row === 1) {
                    return cell('0', { formula: '=SUM(A1:A1000000)' });
                }
                return cell('1');
            })),
        }));
        const source: DataSource = {
            meta: () => meta,
            read_rows: () => { throw new Error('formula calculation used display rows'); },
            read_columns,
            close: () => {},
        };

        expect(calculate_workbook_formulas_bounded(source, {
            edits: [],
            targets: [target(0, 0, 1), target(0, 1, 1)],
        })).toEqual([{ ...target(0, 0, 1), value: '1' }]);

        const source_cells_read = vi.mocked(read_columns).mock.calls.reduce(
            (total, [, , count, columns]) => total + count * columns.length,
            0,
        );
        expect(source_cells_read).toBeLessThanOrEqual(262_144);
    });

    it('cancels stale range work between bounded source reads', async () => {
        const rows = Array.from({ length: 50_000 }, () => [cell('1')]);
        rows[0].push(cell('0', { formula: '=SUM(A1:A50000)' }));
        const source = workbook([{ name: 'Sheet1', rows }]);
        const read_columns = vi.spyOn(source, 'read_columns');
        let cancelled = false;

        const result = await calculate_workbook_formulas_cooperatively(source, {
            edits: [],
            targets: [target(0, 0, 1)],
        }, {
            isCancelled: () => cancelled,
            workSliceMs: 0,
            yieldControl: async () => { cancelled = true; },
        });

        expect(result).toBeUndefined();
        expect(read_columns.mock.calls.length).toBe(2);
        expect(read_columns.mock.calls[1][2] * read_columns.mock.calls[1][3].length)
            .toBeLessThanOrEqual(8_192);
    });

    it('propagates worksheet errors through arithmetic and aggregate ranges', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('#DIV/0!', { rawType: 'error' as any }),
            cell('1'),
            cell('0', { formula: '=SUM(A1:B1)' }),
            cell('0', { formula: '=AVERAGE(A1:B1)' }),
            cell('0', { formula: '=A1+1' }),
        ]] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 2), target(0, 0, 3), target(0, 0, 4)],
        })).toEqual([
            { ...target(0, 0, 2), error: 'numeric error' },
            { ...target(0, 0, 3), error: 'numeric error' },
            { ...target(0, 0, 4), error: 'numeric error' },
        ]);
    });

    it('coerces numeric text for arithmetic but not aggregate references', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('2', { rawType: 'string' }),
            cell('0', { formula: '=A1+1' }),
            cell('0', { formula: '=SUM(A1)' }),
        ]] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 1), target(0, 0, 2)],
        })).toEqual([
            { ...target(0, 0, 1), value: '3' },
            { ...target(0, 0, 2), value: '0' },
        ]);
    });

    it('uses the underlying numeric serial for displayed date cells', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('2024-01-15T00:00:00.000Z', {
                rawType: 'date',
                numericRaw: 45_306,
            } as any),
            cell('0', { formula: '=A1+1' }),
        ]] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 1)],
        })).toEqual([{ ...target(0, 0, 1), value: '45307' }]);
    });

    it('coerces leading-zero numeric text in references and literals', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('0012', { rawType: 'string' }),
            cell('0', { formula: '=A1+1' }),
            cell('0', { formula: '=0012+1' }),
        ]] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [],
            targets: [target(0, 0, 1), target(0, 0, 2)],
        })).toEqual([
            { ...target(0, 0, 1), value: '13' },
            { ...target(0, 0, 2), value: '13' },
        ]);
    });

    it('keeps dirty leading-zero text out of aggregate references', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('', { rawType: 'string' }),
            cell('0', { formula: '=A1+1' }),
            cell('0', { formula: '=SUM(A1)' }),
        ]] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [{ ...target(0, 0, 0), value: '0012', writesFormula: false }],
            targets: [target(0, 0, 1), target(0, 0, 2)],
        })).toEqual([
            { ...target(0, 0, 1), value: '13' },
            { ...target(0, 0, 2), value: '0' },
        ]);
    });

    it('treats a rich numeric edit as text when the writer will use inlineStr', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('12', { rawType: 'number' }),
            cell('12', { formula: '=SUM(A1)' }),
        ]] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [{
                ...target(0, 0, 0),
                value: '12',
                writesFormula: false,
                runs: [{ text: '12', style: { bold: true } }],
            }],
            targets: [target(0, 0, 1)],
        })).toEqual([{ ...target(0, 0, 1), value: '0' }]);
    });

    it('treats formula-shaped rich text as text for recursive dependents', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('old', { rawType: 'string' }),
            cell('0', { formula: '=SUM(A1)' }),
        ]] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [{
                ...target(0, 0, 0),
                value: '=1+1',
                writesFormula: false,
                runs: [{ text: '=1+1', style: { bold: true } }],
            }],
            targets: [target(0, 0, 1)],
        })).toEqual([{ ...target(0, 0, 1), value: '0' }]);
    });

    it('uses the saved serial semantics for dirty ISO date values', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('2024-01-15T00:00:00.000Z', {
                rawType: 'date',
                numericRaw: 45_306,
                numberFormat: { code: 'm/d/yyyy' },
            }),
            cell('0', { formula: '=A1+1' }),
        ]] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [{ ...target(0, 0, 0), value: '2024-01-16', writesFormula: false }],
            targets: [target(0, 0, 1)],
        })).toEqual([{ ...target(0, 0, 1), value: '45308' }]);
    });

    it('infers the 1904 epoch for dirty native ISO date cells without a style', () => {
        const source = workbook([{ name: 'Sheet1', rows: [[
            cell('2024-01-15T00:00:00.000Z', {
                rawType: 'date',
                numericRaw: 43_844,
                xlsxIsoDate: true,
            }),
            cell('0', { formula: '=A1+1' }),
        ]] }]);

        expect(calculate_workbook_formulas(source, {
            edits: [{ ...target(0, 0, 0), value: '2024-01-16', writesFormula: false }],
            targets: [target(0, 0, 1)],
        })).toEqual([{ ...target(0, 0, 1), value: '43846' }]);
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
            edits: [{ ...target(0, 0, 0), value: '5', writesFormula: false }],
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
            edits: [{ ...target(0, 0, 1), value: '=A1/2', writesFormula: true }],
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
            edits: [{ ...target(0, 2, 0), value: '200', writesFormula: false }],
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
