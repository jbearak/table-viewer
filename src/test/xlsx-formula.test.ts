import { describe, expect, it } from 'vitest';
import {
    is_xlsx_formula_text,
    local_a1_formula_references,
    translate_a1_formula,
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
