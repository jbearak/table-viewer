import { describe, expect, it } from 'vitest';
import {
    a1_formula_references,
    formula_reference_tokens,
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

describe('formula reference tokenizer', () => {
    const shapes = (formula: string) => formula_reference_tokens(formula).references.map(
        (token) => ({
            kind: token.kind,
            text: formula.slice(token.start, token.end),
            sheet: token.sheetName,
            corners: token.corners.map((corner) => ({
                text: formula.slice(corner.start, corner.end),
                sheet: corner.sheet && formula.slice(corner.sheet.start, corner.sheet.end),
                row: corner.row && `${corner.row.absolute ? '$' : ''}${corner.row.value}`
                    + `@${formula.slice(corner.row.start, corner.row.end)}`,
                column: corner.column && `${corner.column.absolute ? '$' : ''}${corner.column.value}`
                    + `@${formula.slice(corner.column.start, corner.column.end)}`,
            })),
        }),
    );
    const issues = (formula: string) => formula_reference_tokens(formula).issues.map(
        (issue) => ({
            kind: issue.kind,
            text: formula.slice(issue.start, issue.end),
            worksheets: issue.worksheets,
        }),
    );

    it('keeps each corner, its spans, and its $ flags in authored order', () => {
        expect(shapes('=SUM($b5:A$2)+c3')).toEqual([
            {
                kind: 'range',
                text: '$b5:A$2',
                sheet: undefined,
                corners: [
                    { text: '$b5', sheet: undefined, row: '5@5', column: '$2@b' },
                    { text: 'A$2', sheet: undefined, row: '$2@2', column: '1@A' },
                ],
            },
            {
                kind: 'cell',
                text: 'c3',
                sheet: undefined,
                corners: [{ text: 'c3', sheet: undefined, row: '3@3', column: '3@c' }],
            },
        ]);
    });

    it('reads whole-row and whole-column references', () => {
        expect(shapes('=SUM(3:$5)+SUM($A:C)')).toEqual([
            {
                kind: 'rows',
                text: '3:$5',
                sheet: undefined,
                corners: [
                    { text: '3', sheet: undefined, row: '3@3', column: undefined },
                    { text: '$5', sheet: undefined, row: '$5@5', column: undefined },
                ],
            },
            {
                kind: 'columns',
                text: '$A:C',
                sheet: undefined,
                corners: [
                    { text: '$A', sheet: undefined, row: undefined, column: '$1@A' },
                    { text: 'C', sheet: undefined, row: undefined, column: '3@C' },
                ],
            },
        ]);
    });

    it('reads unquoted, quoted, and per-corner sheet qualifiers', () => {
        const formula = "=Sheet1!A1:Sheet1!B2+'Sales Q1'!C3+'It''s'!D4:E5+sheet1!1:SHEET1!2";
        expect(shapes(formula).map(({ kind, text, sheet, corners }) => ({
            kind,
            text,
            sheet,
            sheets: corners.map((corner) => corner.sheet),
        }))).toEqual([
            { kind: 'range', text: 'Sheet1!A1:Sheet1!B2', sheet: 'Sheet1', sheets: ['Sheet1!', 'Sheet1!'] },
            { kind: 'cell', text: "'Sales Q1'!C3", sheet: 'Sales Q1', sheets: ["'Sales Q1'!"] },
            { kind: 'range', text: "'It''s'!D4:E5", sheet: "It's", sheets: ["'It''s'!", undefined] },
            { kind: 'rows', text: 'sheet1!1:SHEET1!2', sheet: 'sheet1', sheets: ['sheet1!', 'SHEET1!'] },
        ]);
        const quoted = formula_reference_tokens("='Sales Q1'!C3").references[0].corners[0].sheet;
        expect(quoted).toEqual({ name: 'Sales Q1', quoted: true, start: 1, end: 12 });
    });

    it('skips strings, functions, names, external workbooks, and structured references', () => {
        expect(shapes(
            '="A1"&LOG10(2)&[1]Sheet1!A1:B2&\'[Book.xlsx]Data\'!C3&[Revenue]&[@Cost]'
            + '&Data![Revenue]&Table1[[#Data],[A1]]&Name1&TRUE&D4',
        ).map((token) => token.text)).toEqual(['D4']);
        expect(issues('=[Book.xlsx]Sheet1!A1:B2+[Book.xlsx]Sheet1![Revenue]')).toEqual([]);
    });

    it('skips structured references with escaped brackets and quotes', () => {
        for (const formula of ["=Table1[A']+B2]+C3", "=Table1[A'[B]+C3", '=Table1[A"B]+C3']) {
            expect(shapes(formula).map((token) => token.text)).toEqual(['C3']);
            expect(issues(formula)).toEqual([]);
        }
        expect(shapes("=Table1[[#Data],[x'] y]]+Data![a'[b]+'Q(1'![c]+D4").map((token) => token.text))
            .toEqual(['D4']);
    });

    it('reports a range operator with a non-reference operand', () => {
        expect(issues('=SUM(INDEX(A:A,1):B5)')).toEqual([
            { kind: 'rangeOperand', text: 'INDEX(A:A,1):B5', worksheets: [undefined] },
        ]);
        expect(shapes('=SUM(INDEX(A:A,1):B5)').map((token) => token.text)).toEqual(['A:A']);
        expect(issues('=SUM(B5:INDEX(Data!A:A,2))')).toEqual([
            { kind: 'rangeOperand', text: 'B5:INDEX(Data!A:A,2)', worksheets: [undefined, 'Data'] },
        ]);
        expect(issues('=INDEX(Data!A:A,MATCH(")",A:A,0)):B5')).toEqual([{
            kind: 'rangeOperand',
            text: 'INDEX(Data!A:A,MATCH(")",A:A,0)):B5',
            worksheets: ['Data', undefined],
        }]);
        expect(issues("=INDEX(Data!A:A,MATCH(1,'Da(ta'!A:A,0)):B5")).toEqual([{
            kind: 'rangeOperand',
            text: "INDEX(Data!A:A,MATCH(1,'Da(ta'!A:A,0)):B5",
            worksheets: ['Data', 'Da(ta', undefined],
        }]);
        // Parentheses inside quoted sheet names and structured references
        // do not nest, scanning forward or backward.
        expect(issues("=B5:INDEX('Da)ta'!A:A,1)+C3")).toEqual([{
            kind: 'rangeOperand',
            text: "B5:INDEX('Da)ta'!A:A,1)",
            worksheets: [undefined, 'Da)ta'],
        }]);
        expect(shapes("=B5:INDEX('Da(ta'!A:A,1)+C3").map((token) => token.text)).toEqual(['C3']);
        expect(issues('=INDEX(Data!A:A,MATCH(1,Table1[foo(bar],0)):B5')).toEqual([{
            kind: 'rangeOperand',
            text: 'INDEX(Data!A:A,MATCH(1,Table1[foo(bar],0)):B5',
            // A table may lie on any sheet.
            worksheets: [],
        }]);
        expect(issues('=SUM(A1:B2:Data!C3)')).toEqual([
            { kind: 'rangeOperand', text: 'A1:B2:Data!C3', worksheets: [undefined, 'Data'] },
        ]);
        // A sheet-scoped defined name may point at any sheet.
        expect(issues('=INDEX(Data!Total,1):B5')).toEqual([
            { kind: 'rangeOperand', text: 'INDEX(Data!Total,1):B5', worksheets: [] },
        ]);
        expect(issues("=INDEX(Data![Col],1):B5+INDEX('Da ta'!Total,1):B5")).toEqual([
            { kind: 'rangeOperand', text: 'INDEX(Data![Col],1):B5', worksheets: ['Data', undefined] },
            { kind: 'rangeOperand', text: "INDEX('Da ta'!Total,1):B5", worksheets: [] },
        ]);
        expect(issues('=SUM(Total:B5)')).toEqual([
            // A defined name may lie on any sheet.
            { kind: 'rangeOperand', text: 'Total:B5', worksheets: [] },
        ]);
        expect(shapes('=SUM(A1:B2:C3)')).toEqual([]);
    });

    it('reports a range operator between two function results', () => {
        expect(issues('=INDEX(Data!A:A,1):INDEX(Data!B:B,2)')).toEqual([{
            kind: 'rangeOperand',
            text: 'INDEX(Data!A:A,1):INDEX(Data!B:B,2)',
            worksheets: ['Data'],
        }]);
        expect(shapes('=INDEX(Data!A:A,1):INDEX(Data!B:B,2)').map((token) => token.text))
            .toEqual(['Data!A:A']);
        expect(issues('=SUM(INDEX(A:A,1) : B5)+SUM(B5 : INDEX(A:A,2))')).toEqual([
            { kind: 'rangeOperand', text: 'INDEX(A:A,1) : B5', worksheets: [undefined] },
            { kind: 'rangeOperand', text: 'B5 : INDEX(A:A,2)', worksheets: [undefined] },
        ]);
    });

    it('reads whitespace around a range colon as one reference', () => {
        expect(shapes("=SUM(A2 : $A5)+SUM(2 :3)+SUM(A: C)+Sheet1!B1 :'Sheet1'!B2")).toEqual([
            {
                kind: 'range',
                text: 'A2 : $A5',
                sheet: undefined,
                corners: [
                    { text: 'A2', sheet: undefined, row: '2@2', column: '1@A' },
                    { text: '$A5', sheet: undefined, row: '5@5', column: '$1@A' },
                ],
            },
            {
                kind: 'rows',
                text: '2 :3',
                sheet: undefined,
                corners: [
                    { text: '2', sheet: undefined, row: '2@2', column: undefined },
                    { text: '3', sheet: undefined, row: '3@3', column: undefined },
                ],
            },
            {
                kind: 'columns',
                text: 'A: C',
                sheet: undefined,
                corners: [
                    { text: 'A', sheet: undefined, row: undefined, column: '1@A' },
                    { text: 'C', sheet: undefined, row: undefined, column: '3@C' },
                ],
            },
            {
                kind: 'range',
                text: "Sheet1!B1 :'Sheet1'!B2",
                sheet: 'Sheet1',
                corners: [
                    { text: 'Sheet1!B1', sheet: 'Sheet1!', row: '1@1', column: '2@B' },
                    { text: "'Sheet1'!B2", sheet: "'Sheet1'!", row: '2@2', column: '2@B' },
                ],
            },
        ]);
        // A space without a colon is the intersection operator.
        expect(shapes('=A1:B2 B2:C3').map((token) => token.text)).toEqual(['A1:B2', 'B2:C3']);
    });

    it('reports ranges whose corners name different worksheets', () => {
        expect(issues('=SUM(Sheet1!A1:Sheet2!B2)+SUM(A1:Sheet2!B2)')).toEqual([
            { kind: 'mixedSheets', text: 'Sheet1!A1:Sheet2!B2', worksheets: ['Sheet1', 'Sheet2'] },
            // `A1:Sheet2!B2` may also be a 3D reference from a sheet named A1.
            { kind: 'mixedSheets', text: 'A1:Sheet2!B2', worksheets: [undefined, 'A1', 'Sheet2'] },
        ]);
    });

    it('reports 3D, spill, and R1C1 references', () => {
        expect(issues("=SUM(Sheet1:Sheet3!A1)+SUM('Jan:Mar'!B2:B4)")).toEqual([
            { kind: 'threeDimensional', text: 'Sheet1:Sheet3!A1', worksheets: ['Sheet1', 'Sheet3'] },
            { kind: 'threeDimensional', text: "'Jan:Mar'!B2:B4", worksheets: ['Jan', 'Mar'] },
        ]);
        // A cell- or column-shaped 3D prefix names its bounds by its text.
        expect(issues('=SUM(S1:S3!A1)+SUM(A:C!B2:B3)')).toEqual([
            { kind: 'threeDimensional', text: 'S1:S3!A1', worksheets: ['S1', 'S3'] },
            { kind: 'threeDimensional', text: 'A:C!B2:B3', worksheets: ['A', 'C'] },
        ]);
        expect(issues('=SUM(A1#)+Data!B2#')).toEqual([
            { kind: 'spill', text: 'A1#', worksheets: [undefined] },
            { kind: 'spill', text: 'Data!B2#', worksheets: ['Data'] },
        ]);
        expect(issues('=R1C1+R[1]C[-2]+RC+Data!R2C+C[1]')).toEqual([
            { kind: 'r1c1', text: 'R1C1', worksheets: [undefined] },
            { kind: 'r1c1', text: 'R[1]C[-2]', worksheets: [undefined] },
            { kind: 'r1c1', text: 'RC', worksheets: [undefined] },
            { kind: 'r1c1', text: 'Data!R2C', worksheets: ['Data'] },
            { kind: 'r1c1', text: 'C[1]', worksheets: [undefined] },
        ]);
        // `RC4` is an A1 cell, and `ROUND` is a function.
        expect(shapes('=RC4+ROUND(R2,0)').map((token) => token.text)).toEqual(['RC4', 'R2']);
        expect(issues('=RC4+ROUND(R2,0)')).toEqual([]);
    });

    it('finds the same references as the existing lexer wherever both read them', () => {
        for (const formula of [
            '=SUM(A1:B2)+$C$3+Sheet2!D4:E5',
            "='My Sheet'!A:A+1:3+XFD1048576",
            '=IF(A1>0,"B2",C3)&[Revenue]',
        ]) {
            expect(formula_reference_tokens(formula).references.map((token) => {
                const rows = token.corners.map((corner) => corner.row?.value);
                const columns = token.corners.map((corner) => corner.column?.value);
                return {
                    ...(token.sheetName === undefined ? {} : { sheetName: token.sheetName }),
                    firstRow: Math.min(...rows.map((row) => row ?? 1)) - 1,
                    firstColumn: Math.min(...columns.map((column) => column ?? 1)) - 1,
                    lastRow: Math.max(...rows.map((row) => row ?? 1_048_576)) - 1,
                    lastColumn: Math.max(...columns.map((column) => column ?? 16_384)) - 1,
                };
            })).toEqual(a1_formula_references(formula));
        }
    });
});
