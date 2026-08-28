import { describe, expect, it } from 'vitest';
import { compile_workbook_formula_graph } from '../formula-dependencies';

describe('compile_workbook_formula_graph', () => {
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
});
