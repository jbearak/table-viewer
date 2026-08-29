import { describe, expect, it } from 'vitest';
import {
    assert_safe_workbook_formula_edits,
    compile_workbook_formula_graph,
    plan_workbook_formula_recalculation,
} from '../formula-dependencies';
import {
    MAX_WORKBOOK_FORMULAS,
    MAX_WORKBOOK_FORMULA_RANGES,
} from '../spreadsheet-safety';

describe('compile_workbook_formula_graph', () => {
    it('resolves Header Row column and cross-sheet intersection dependencies', () => {
        const graph = compile_workbook_formula_graph([
            {
                formulaCells: [3, 2],
                structuredFormulaReferences: {
                    names: ['Revenue'],
                    references: [3, 2, 1, 0, 0, 3, 2, 1, 1, 0],
                },
                sourceRowCount: 5,
            },
            {
                formulaCells: [],
                sourceRowCount: 5,
                columnNames: ['Revenue'],
                excelFirstRowHeader: { active: true, sourceRow: 1 },
            },
        ]);

        expect(graph.invalidatedBy([{ sheetIndex: 1, row: 2, column: 0 }])
            .forSheet(0).has(3, 2)).toBe(true);
        expect(graph.invalidatedBy([{ sheetIndex: 1, row: 3, column: 0 }])
            .forSheet(0).has(3, 2)).toBe(true);
        expect(graph.invalidatedBy([{ sheetIndex: 1, row: 1, column: 0 }]).size).toBe(0);
    });

    it('walks exact references, ranges, and recursive cross-sheet chains', () => {
        const graph = compile_workbook_formula_graph([
            {
                formulaDependencies: [
                    0, 1, 0, 0, 0, 0, 0,
                    0, 3, 1, 4, 0, 8, 2,
                ],
            },
            { formulaDependencies: [0, 2, 0, 0, 1, 0, 1] },
        ]);

        const exact = graph.invalidatedBy([{ sheetIndex: 0, row: 0, column: 0 }]);
        expect(new Set(exact.forSheet(0).keys())).toEqual(new Set(['0:1']));
        expect(new Set(exact.forSheet(1).keys())).toEqual(new Set(['0:2']));

        const range = graph.invalidatedBy([{ sheetIndex: 1, row: 6, column: 1 }]);
        expect(new Set(range.forSheet(0).keys())).toEqual(new Set(['0:3']));
        expect(graph.invalidatedBy([{ sheetIndex: 1, row: 0, column: 8 }]).size).toBe(0);
    });

    it('terminates cycles that cross worksheets', () => {
        const graph = compile_workbook_formula_graph([
            { formulaDependencies: [0, 0, 1, 0, 1, 0, 1] },
            { formulaDependencies: [0, 1, 0, 0, 0, 0, 0] },
        ]);
        const impact = graph.invalidatedBy([{ sheetIndex: 0, row: 0, column: 0 }]);
        expect(new Set(impact.forSheet(0).keys())).toEqual(new Set(['0:0']));
        expect(new Set(impact.forSheet(1).keys())).toEqual(new Set(['0:1']));
        expect(impact.size).toBe(2);
    });

    it('keeps a large exact fan-out in one flat metadata allocation', () => {
        const formula_count = 50_000;
        const packed: number[] = [];
        for (let row = 0; row < formula_count; row += 1) {
            packed.push(row, 1, 0, 0, 0, 0, 0);
        }
        expect(packed).toHaveLength(formula_count * 7);

        const impact = compile_workbook_formula_graph([
            { formulaDependencies: packed },
        ]).invalidatedBy([{ sheetIndex: 0, row: 0, column: 0 }]);

        expect(impact.size).toBe(formula_count);
        expect(impact.forSheet(0).size).toBe(formula_count);
        expect(impact.forSheet(0).has(formula_count - 1, 1)).toBe(true);
    });

    it('does not rescan every broad range for every affected formula', () => {
        const formula_count = 16_000;
        const packed: number[] = [];
        for (let index = 0; index < formula_count; index += 1) {
            packed.push(
                100 + Math.floor(index / 256),
                index % 256,
                0,
                0,
                0,
                64,
                64,
            );
        }
        const started = performance.now();
        const impact = compile_workbook_formula_graph([
            { formulaDependencies: packed },
        ]).invalidatedBy([{ sheetIndex: 0, row: 0, column: 0 }]);
        const elapsed = performance.now() - started;

        expect(impact.size).toBe(formula_count);
        // The former flat broad-range list took about 900 ms here because it
        // performed 256 million rectangle checks. Leave ample CI headroom while
        // retaining a red signal for that quadratic traversal.
        expect(elapsed).toBeLessThan(500);
    });

    it('prunes perpendicular false-positive range bounds during a dense closure', () => {
        const formula_count = 16_000;
        const packed: number[] = [];
        for (let index = 0; index < formula_count; index += 1) {
            packed.push(
                600 + Math.floor(index / 96),
                160 + index % 96,
                0,
                0,
                0,
                0,
                0,
            );
            packed.push(
                500_100,
                201,
                0,
                ...(index % 2 === 0
                    ? [100, 99, 1_000_000, 101]
                    : [500_049, 0, 500_051, 200]),
            );
        }
        const started = performance.now();
        const impact = compile_workbook_formula_graph([
            { formulaDependencies: packed },
        ]).invalidatedBy([{ sheetIndex: 0, row: 0, column: 0 }]);
        const elapsed = performance.now() - started;

        expect(impact.size).toBe(formula_count);
        expect(elapsed).toBeLessThan(500);
    });

    it('batches deep exact chains before testing unmatched ranges', () => {
        const formula_count = 8_000;
        const packed: number[] = [];
        for (let index = 0; index < formula_count; index += 1) {
            const row = 800 + Math.floor(index / 96);
            const column = 160 + index % 96;
            const previous_row = index === 0 ? 0 : 800 + Math.floor((index - 1) / 96);
            const previous_column = index === 0 ? 0 : 160 + (index - 1) % 96;
            packed.push(
                row,
                column,
                0,
                previous_row,
                previous_column,
                previous_row,
                previous_column,
            );
            packed.push(
                500_200,
                201,
                0,
                ...(index % 2 === 0
                    ? [100, 375, 1_100, 625]
                    : [475, 0, 725, 1_000]),
            );
        }
        const started = performance.now();
        const impact = compile_workbook_formula_graph([
            { formulaDependencies: packed },
        ]).invalidatedBy([{ sheetIndex: 0, row: 0, column: 0 }]);
        const elapsed = performance.now() - started;

        expect(impact.size).toBe(formula_count);
        expect(elapsed).toBeLessThan(500);
    });

    it('matches direct rectangle containment across varied packed ranges', () => {
        const ranges: Array<{
            firstRow: number;
            firstColumn: number;
            lastRow: number;
            lastColumn: number;
        }> = [];
        const packed: number[] = [];
        for (let index = 0; index < 1_000; index += 1) {
            const firstRow = (index * 37) % 400;
            const firstColumn = (index * 53) % 200;
            const lastRow = firstRow + (index * 17) % 120;
            const lastColumn = firstColumn + (index * 29) % 80;
            ranges.push({ firstRow, firstColumn, lastRow, lastColumn });
            packed.push(
                600 + Math.floor(index / 200),
                index % 200,
                0,
                firstRow,
                firstColumn,
                lastRow,
                lastColumn,
            );
        }
        const graph = compile_workbook_formula_graph([
            { formulaDependencies: packed },
            {},
        ]);
        for (let index = 0; index < 100; index += 1) {
            const row = (index * 71) % 520;
            const column = (index * 43) % 280;
            const expected = new Set(ranges.flatMap((range, formula) => (
                row >= range.firstRow
                && row <= range.lastRow
                && column >= range.firstColumn
                && column <= range.lastColumn
            ) ? [`${600 + Math.floor(formula / 200)}:${formula % 200}`] : []));
            expect(new Set(graph.invalidatedBy([
                { sheetIndex: 0, row, column },
            ]).forSheet(0).keys())).toEqual(expected);
        }
    });

    it('keeps range invalidation state local to each graph traversal', () => {
        const packed: number[] = [];
        for (let row = 0; row < 32; row += 1) {
            packed.push(row, 2, 0, 0, 0, 0, 1);
        }
        const graph = compile_workbook_formula_graph([{ formulaDependencies: packed }]);

        expect(graph.invalidatedBy([
            { sheetIndex: 0, row: 0, column: 0 },
        ]).size).toBe(32);
        expect(graph.invalidatedBy([
            { sheetIndex: 0, row: 0, column: 1 },
        ]).size).toBe(32);
    });

    it('defends the range-index memory bound at graph compilation', () => {
        const packed: number[] = [];
        for (let index = 0; index <= MAX_WORKBOOK_FORMULA_RANGES; index += 1) {
            packed.push(index % 1_000, 2, 0, 0, 0, 0, 1);
        }

        expect(() => compile_workbook_formula_graph([
            { formulaDependencies: packed },
        ])).toThrow('Workbook has too many formula ranges to index safely');
    });

    it('rejects unsorted or duplicate packed formula coordinates', () => {
        expect(() => compile_workbook_formula_graph([{
            formulaCells: [1, 0, 0, 0],
        }])).toThrow('Malformed packed formula cells');
        expect(() => compile_workbook_formula_graph([{
            formulaCells: [0, 0, 0, 0],
        }])).toThrow('Malformed packed formula cells');
    });
});

describe('plan_workbook_formula_recalculation', () => {
    it('marks an edited formula itself stale while its replacement is pending', () => {
        const plan = plan_workbook_formula_recalculation(
            [{ formulaCells: [0, 0] }],
            [{
                sheetIndex: 0,
                row: 0,
                column: 0,
                value: '=10+10',
                writesFormula: true,
            }],
        );

        expect(plan.impact.forSheet(0).has(0, 0)).toBe(true);
        expect(plan.targets).toEqual([{ sheetIndex: 0, row: 0, column: 0 }]);
    });

    it('flags an edit that would make a saved workbook exceed the formula cap', () => {
        const formulaCells: number[] = [];
        for (let row = 0; row < MAX_WORKBOOK_FORMULAS; row += 1) {
            formulaCells.push(row, 0);
        }
        const plan = plan_workbook_formula_recalculation(
            [{ formulaCells }],
            [{
                sheetIndex: 0,
                row: MAX_WORKBOOK_FORMULAS,
                column: 0,
                value: '=1',
                writesFormula: true,
            }],
        );

        expect(plan.formulaLimitExceeded).toBe(true);
        expect(plan.targets).toEqual([{
            sheetIndex: 0,
            row: MAX_WORKBOOK_FORMULAS,
            column: 0,
        }]);
    });

    it('preflights the final edited range-reference budget', () => {
        const values: Record<string, string> = {};
        const ranges = Array.from(
            { length: 501 },
            (_, index) => `A${index + 1}:B${index + 1}`,
        ).join(',');
        for (let row = 0; row < 200; row += 1) {
            values[`${row}:0`] = `=SUM(${ranges})`;
        }

        expect(() => assert_safe_workbook_formula_edits(
            [{ name: 'Sheet1' }],
            [{ sheetIndex: 0, values }],
        )).toThrow('Workbook has too many formula ranges to index safely');
    });

    it('rejects an overlong edited formula before dependency parsing', () => {
        expect(() => assert_safe_workbook_formula_edits(
            [{ name: 'Sheet1' }],
            [{
                sheetIndex: 0,
                values: { '0:0': `=${"'".repeat(8_193)}` },
            }],
        )).toThrow('Formula exceeds Excel\'s maximum length');
    });

    it('does not admit rich text beginning with equals as a formula', () => {
        expect(() => assert_safe_workbook_formula_edits(
            [{ name: 'Sheet1' }],
            [{
                sheetIndex: 0,
                values: { '0:0': `=${'x'.repeat(8_193)}` },
                isFormulaValue: () => false,
            }],
        )).not.toThrow();
    });

    it('does not count formula-shaped rich text as a formula target', () => {
        const formulaCells: number[] = [];
        for (let row = 0; row < MAX_WORKBOOK_FORMULAS; row += 1) {
            formulaCells.push(row, 0);
        }
        const plan = plan_workbook_formula_recalculation(
            [{ formulaCells }],
            [{
                sheetIndex: 0,
                row: MAX_WORKBOOK_FORMULAS,
                column: 1,
                value: '=literal',
                writesFormula: false,
            }],
        );

        expect(plan.formulaLimitExceeded).toBe(false);
        expect(plan.targets).toEqual([]);
    });
});
