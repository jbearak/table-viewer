import { describe, expect, it } from 'vitest';
import {
    a1_formula_references,
    is_xlsx_formula_text,
    local_a1_formula_references,
    retarget_moved_a1_formula,
    retarget_renamed_structured_formula,
    structured_formula_reference_at,
    structured_formula_references,
    translate_a1_formula,
    workbook_a1_formula_references,
} from '../xlsx-formula';

describe('structured formula references', () => {
    it('parses local, intersecting, qualified, quoted, and escaped names', () => {
        expect(structured_formula_reference_at('=[Revenue]', 1)).toEqual({
            reference: { columnName: 'Revenue', intersection: false },
            length: 9,
        });
        expect(structured_formula_reference_at("='Sales Q1'![@Net '#]", 1)).toEqual({
            reference: {
                sheetName: 'Sales Q1',
                columnName: 'Net #',
                intersection: true,
            },
            length: 20,
        });
    });

    it('retargets only references that identify the renamed worksheet column', () => {
        expect(retarget_renamed_structured_formula(
            '=SUM([Revenue])+Data![@Revenue]+Other![Revenue]+[[#Data],[Revenue]]',
            0,
            ['Data', 'Other'],
            [{ sheetIndex: 0, oldName: 'Revenue', newName: "Net @ Revenue" }],
        )).toBe(
            "=SUM([Net '@ Revenue])+Data![@Net '@ Revenue]+Other![Revenue]"
            + '+[[#Data],[Revenue]]',
        );
    });

    it('retargets escaped brackets without mistaking them for the opening bracket', () => {
        expect(retarget_renamed_structured_formula(
            "=SUM([a'[b])+'Sales [Q1'![@a'[b]",
            0,
            ['Data', 'Sales [Q1'],
            [
                { sheetIndex: 0, oldName: 'a[b', newName: 'Net' },
                { sheetIndex: 1, oldName: 'a[b', newName: 'Net' },
            ],
        )).toBe("=SUM([Net])+'Sales [Q1'![@Net]");
    });

    it('scans outside strings and rejects nested Excel table specifiers', () => {
        expect(structured_formula_references(
            '=SUM([Revenue])+"[@Ignored]"+Data![@Units]+[[#Data],[Revenue]]',
        )).toEqual([
            { columnName: 'Revenue', intersection: false },
            { sheetName: 'Data', columnName: 'Units', intersection: true },
        ]);
    });

    it('preserves real Excel table and external-workbook references', () => {
        const formula = '=Table1[Revenue]+Table1[[#Data],[Revenue]]'
            + "+[Book.xlsx]Sheet1![Revenue]+'[Revenue]Sales Q1'!A1+SUM([Revenue])";
        expect(retarget_renamed_structured_formula(
            formula,
            0,
            ['Sheet1'],
            [{ sheetIndex: 0, oldName: 'Revenue', newName: 'Net' }],
        )).toBe('=Table1[Revenue]+Table1[[#Data],[Revenue]]'
            + "+[Book.xlsx]Sheet1![Revenue]+'[Revenue]Sales Q1'!A1+SUM([Net])");
        expect(structured_formula_references(formula)).toEqual([
            { columnName: 'Revenue', intersection: false },
        ]);
    });
});

describe('retarget_moved_a1_formula', () => {
    const move = (sourceRow: number, sourceColumn: number, destinationRow: number, destinationColumn: number) => ({
        sheetIndex: 0,
        sourceRow,
        sourceColumn,
        destinationRow,
        destinationColumn,
    });

    it('keeps absolute markers while references follow moved cells', () => {
        expect(retarget_moved_a1_formula(
            '=$A$1+A1+"A1"+Other!A1',
            0,
            ['Data', 'Other'],
            [move(0, 0, 2, 2)],
        )).toBe('=$C$3+C3+"A1"+Other!A1');
    });

    it('retargets a range only when the whole range moved by one delta', () => {
        const moves = [
            move(0, 0, 2, 1),
            move(0, 1, 2, 2),
            move(1, 0, 3, 1),
            move(1, 1, 3, 2),
        ];
        expect(retarget_moved_a1_formula(
            '=SUM(A1:B2)+SUM(A1:C2)', 0, ['Data'], moves,
        )).toBe('=SUM(B3:C4)+SUM(A1:C2)');
    });

    it('resolves quoted worksheet qualifiers', () => {
        expect(retarget_moved_a1_formula(
            "='Sales Q1'!A1+Data!A1",
            1,
            ['Sales Q1', 'Data'],
            [move(0, 0, 1, 0)],
        )).toBe("='Sales Q1'!A2+Data!A1");
    });
});

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

    it('does not interpret a trailing absolute-row marker as row zero', () => {
        expect(a1_formula_references('=A$')).toEqual([]);
        expect(a1_formula_references('=A1$')).toEqual([]);
        expect(a1_formula_references('=A:B$+1:2$')).toEqual([]);
        expect(translate_a1_formula('A1$', 1, 1)).toBe('A1$');
        expect(translate_a1_formula('A:B$+1:2$', 1, 1)).toBe('A:B$+1:2$');
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
