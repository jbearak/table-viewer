import { describe, expect, it } from 'vitest';
import {
    a1_formula_references,
    is_xlsx_formula_text,
    local_a1_formula_references,
    translate_a1_formula,
    workbook_a1_formula_references,
} from '../xlsx-formula';

describe('is_xlsx_formula_text', () => {
    it('requires a leading equals and a formula body', () => {
        expect(is_xlsx_formula_text('=A1*2')).toBe(true);
        expect(is_xlsx_formula_text('=')).toBe(false);
        expect(is_xlsx_formula_text('A1*2')).toBe(false);
    });
});

describe('translate_a1_formula', () => {
    it('moves relative references and preserves absolute components', () => {
        expect(translate_a1_formula('E2*F2+$A2+A$1+$A$1', 3, 0))
            .toBe('E5*F5+$A5+A$1+$A$1');
        expect(translate_a1_formula('A1:B2', 1, 2)).toBe('C2:D3');
    });

    it('moves relative whole-column and whole-row references', () => {
        expect(translate_a1_formula(
            'SUM(A:C)+SUM($D:F)+SUM(2:4)+SUM($5:7)',
            1,
            1,
        )).toBe('SUM(B:D)+SUM($D:G)+SUM(3:5)+SUM($5:8)');
    });

    it('does not translate quoted text, sheet names, brackets, or function names', () => {
        expect(translate_a1_formula(
            '"A1"&\'Sheet A1\'!B2+[Book1]Sheet1!C3+LOG10(A1)',
            1,
            1,
        )).toBe('"A1"&\'Sheet A1\'!C3+[Book1]Sheet1!D4+LOG10(B2)');
    });

    it('turns a relative reference outside the worksheet into #REF!', () => {
        expect(translate_a1_formula('A1+$A$1', -1, 0)).toBe('#REF!+$A$1');
    });
});

describe('local_a1_formula_references', () => {
    it('finds cells and normalized ranges on the current sheet', () => {
        expect(local_a1_formula_references(
            '=A1+$B$2+SUM(D5:C3)+Sheet1!E7+\'Sheet1\'!F8',
            'Sheet1',
        )).toEqual([
            { firstRow: 0, firstColumn: 0, lastRow: 0, lastColumn: 0 },
            { firstRow: 1, firstColumn: 1, lastRow: 1, lastColumn: 1 },
            { firstRow: 2, firstColumn: 2, lastRow: 4, lastColumn: 3 },
            { firstRow: 6, firstColumn: 4, lastRow: 6, lastColumn: 4 },
            { firstRow: 7, firstColumn: 5, lastRow: 7, lastColumn: 5 },
        ]);
    });

    it('finds whole-column and whole-row ranges', () => {
        expect(local_a1_formula_references('=SUM(A:C)+SUM($4:$2)', 'Sheet1'))
            .toEqual([
                {
                    firstRow: 0,
                    firstColumn: 0,
                    lastRow: 1_048_575,
                    lastColumn: 2,
                },
                {
                    firstRow: 1,
                    firstColumn: 0,
                    lastRow: 3,
                    lastColumn: 16_383,
                },
            ]);
    });

    it('ignores text, names, structured references, external books, and other sheets', () => {
        expect(local_a1_formula_references(
            '=LOG10(A1)+"B2 and ""C3"""+Table1[D4]+[Book1]Sheet1!E5+Other!F6+G7',
            'Sheet1',
        )).toEqual([
            { firstRow: 0, firstColumn: 0, lastRow: 0, lastColumn: 0 },
            { firstRow: 6, firstColumn: 6, lastRow: 6, lastColumn: 6 },
        ]);
    });
});

describe('a1_formula_references', () => {
    it('retains cross-sheet qualifiers and decodes quoted apostrophes', () => {
        expect(a1_formula_references(
            '=Sheet2!A1+\'Sales Q1\'!B2+\'Director\'\'s Cut\'!C3+D4',
        )).toEqual([
            { sheetName: 'Sheet2', firstRow: 0, firstColumn: 0, lastRow: 0, lastColumn: 0 },
            { sheetName: 'Sales Q1', firstRow: 1, firstColumn: 1, lastRow: 1, lastColumn: 1 },
            {
                sheetName: "Director's Cut",
                firstRow: 2,
                firstColumn: 2,
                lastRow: 2,
                lastColumn: 2,
            },
            { firstRow: 3, firstColumn: 3, lastRow: 3, lastColumn: 3 },
        ]);
    });

    it('ignores external workbooks and unsupported 3D references', () => {
        expect(a1_formula_references('=[Book.xlsx]Sheet2!A1+Sheet1:Sheet3!B2'))
            .toEqual([]);
    });

    it('scans malformed maximum-length quoted prefixes in linear time', () => {
        const malformed = `=${"'".repeat(8_192)}`;
        const started = performance.now();
        for (let iteration = 0; iteration < 16; iteration += 1) {
            expect(a1_formula_references(malformed)).toEqual([]);
        }
        // The former suffix parser rescanned from every apostrophe and took
        // well over a second for this loop. Offset parsing has ample CI margin.
        expect(performance.now() - started).toBeLessThan(500);
    });
});

describe('workbook_a1_formula_references', () => {
    it('resolves qualified names case-insensitively and drops unknown sheets', () => {
        expect(workbook_a1_formula_references(
            '=people!A1+Missing!B2+C3',
            1,
            ['People', 'Inventory'],
        )).toEqual([
            {
                sourceSheetIndex: 0,
                firstRow: 0,
                firstColumn: 0,
                lastRow: 0,
                lastColumn: 0,
            },
            {
                sourceSheetIndex: 1,
                firstRow: 2,
                firstColumn: 2,
                lastRow: 2,
                lastColumn: 2,
            },
        ]);
    });
});
