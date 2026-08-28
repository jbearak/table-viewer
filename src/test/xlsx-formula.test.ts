import { describe, expect, it } from 'vitest';
import { is_xlsx_formula_text, translate_a1_formula } from '../xlsx-formula';

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
