// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import CFB from 'cfb';
import { parse_xlsx } from '../parse-xlsx';
import {
    delete_columns,
    delete_rows,
    has_live_column_layout_change,
    has_live_row_layout_change,
    insert_columns,
    insert_rows,
    move_columns,
    move_rows,
    source_column_layout,
    source_row_layout,
    type ColumnLayout,
    type LayoutResult,
    type RowLayout,
} from '../worksheet-layout';
import { restructure_worksheet, type XlsxRowFormat } from '../ooxml-surgery/worksheet-structure';
import {
    run_workbook_formula_stage,
    type WorkbookFormulaStagePendingFormula,
    type WorkbookFormulaStageResult,
    type WorkbookFormulaStageWorksheet,
} from '../ooxml-surgery/workbook-formula-stage';
import { render_formula } from '../formula-anchors';
import {
    parse_rule_sqref,
    wrap_translate_formula,
    relative_rule_split_count,
    rule_split_workbook,
    split_relative_rule,
    MAX_RULE_SPLIT,
} from '../formula-rule-split';
import { formula_reference_tokens } from '../xlsx-formula';
import type { FormulaAnchors } from '../formula-anchors';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function worksheet(inner: string): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
        + `<worksheet xmlns="${NS}" xmlns:r="${R_NS}">${inner}</worksheet>`;
}

function workbook(names: readonly string[], defined_names = ''): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<workbook xmlns="${NS}" xmlns:r="${R_NS}"><sheets>${
        names.map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')
    }</sheets>${defined_names === '' ? '' : `<definedNames>${defined_names}</definedNames>`}</workbook>`;
}

function ok<L>(result: LayoutResult<L>): L {
    if (!result.ok) throw new Error(result.refusal.message);
    return result.layout;
}

const source = (sourceRow: number) => ({ kind: 'source', sourceRow }) as const;
const source_column = (sourceColumn: number) => ({ kind: 'source', sourceColumn }) as const;

function letters(column: number): string {
    let out = '';
    for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
        out = String.fromCharCode(65 + ((value - 1) % 26)) + out;
    }
    return out;
}

/** A dense grid of `rows` × `columns` labelled cells, `r-c`, with extra cells merged in by address. */
function grid(rows: number, columns: number, cells: Readonly<Record<string, string>> = {}): string {
    const extra = new Map<string, string>(Object.entries(cells));
    const max_row = Math.max(rows, ...[...extra.keys()].map((key) => Number(/\d+$/.exec(key)![0])));
    const max_column = Math.max(columns, ...[...extra.keys()].map((key) => {
        const name = /^[A-Z]+/.exec(key)![0];
        let value = 0;
        for (const char of name) value = value * 26 + char.charCodeAt(0) - 64;
        return value;
    }));
    let body = '';
    for (let row = 0; row < max_row; row++) {
        let row_xml = '';
        for (let column = 0; column < max_column; column++) {
            const address = `${letters(column)}${row + 1}`;
            const custom = extra.get(address);
            if (custom !== undefined) row_xml += `<c r="${address}">${custom}</c>`;
            else if (row < rows && column < columns) {
                row_xml += `<c r="${address}" t="inlineStr"><is><t>${row}-${column}</t></is></c>`;
            }
        }
        if (row_xml !== '') body += `<row r="${row + 1}">${row_xml}</row>`;
    }
    return `<sheetData>${body}</sheetData>`;
}

interface SheetSpec {
    readonly name: string;
    readonly xml: string;
    /** Canonical source row count. */
    readonly rows: number;
    readonly columns: number;
    readonly bodyStart?: number;
    readonly rowLayout?: (layout: RowLayout) => RowLayout;
    readonly columnLayout?: (layout: ColumnLayout) => ColumnLayout;
}

interface Run {
    readonly sheets: readonly SheetSpec[];
    readonly definedNames?: string;
    readonly pending?: readonly WorkbookFormulaStagePendingFormula[];
    readonly unshareLimits?: { readonly followers: number; readonly bytes: number };
}

interface Outcome extends WorkbookFormulaStageResult {
    readonly worksheets: readonly WorkbookFormulaStageWorksheet[];
    readonly workbookXml: string;
    /** Final text of each worksheet, and of the workbook. */
    text(part: string): string;
}

function stage(run: Run): Outcome {
    const worksheets = run.sheets.map((sheet, index): WorkbookFormulaStageWorksheet => {
        const body_start = sheet.bodyStart ?? 0;
        const row_layout = sheet.rowLayout?.(source_row_layout(body_start, sheet.rows - body_start));
        const column_layout = sheet.columnLayout?.(source_column_layout(sheet.columns));
        const live = (row_layout !== undefined && has_live_row_layout_change(row_layout))
            || (column_layout !== undefined && has_live_column_layout_change(column_layout));
        const source_xml = Buffer.from(worksheet(sheet.xml), 'utf8');
        const format: XlsxRowFormat = { cellStyleIndexes: new Array(sheet.columns).fill(null) };
        const inserted_rows = (row_layout?.runs ?? []).flatMap((run) => run.kind === 'pending' ? run.ids : []);
        const inserted_columns = (column_layout?.columns ?? []).flatMap((column) =>
            column.kind === 'pending' ? [column.pendingColumnId] : []);
        const restructured = live ? restructure_worksheet({
            worksheet_xml: source_xml,
            layout: {
                bodyStart: body_start,
                rowLayout: row_layout ?? source_row_layout(body_start, sheet.rows - body_start),
                columnLayout: column_layout ?? source_column_layout(sheet.columns),
            },
            inserted_row_formats: new Map(inserted_rows.map((id) => [id, format])),
            appended_row_formats: [],
            inserted_column_formats: new Map(inserted_columns.map((id) => [id, { kind: 'default' as const }])),
        }) : undefined;
        return {
            target: { sheetIndex: index, sheetName: sheet.name },
            name: sheet.name,
            bodyStart: body_start,
            sourceRowCount: sheet.rows,
            sourceColumnCount: sheet.columns,
            changes: {
                appendedRows: [],
                tailRemovals: [],
                ...(row_layout === undefined ? {} : { rowLayout: row_layout }),
                ...(column_layout === undefined ? {} : { columnLayout: column_layout }),
            },
            part: `xl/worksheets/sheet${index + 1}.xml`,
            source_xml,
            ...(restructured === undefined ? {} : { restructured }),
        };
    });
    for (const entry of worksheets) {
        if (entry.restructured !== undefined) {
            expect_well_formed(`restructured ${entry.part}`, Buffer.from(entry.restructured.worksheet_xml).toString('utf8'));
        }
    }
    const workbook_xml = workbook(run.sheets.map((sheet) => sheet.name), run.definedNames);
    const result = run_workbook_formula_stage({
        workbook_part: 'xl/workbook.xml',
        workbook_xml: Buffer.from(workbook_xml, 'utf8'),
        worksheets,
        ...(run.pending === undefined ? {} : { pending_formulas: run.pending }),
        ...(run.unshareLimits === undefined ? {} : { unshare_limits: run.unshareLimits }),
    });
    for (const part of result.parts) expect_well_formed(part.part, part.newText);
    return {
        ...result,
        worksheets,
        workbookXml: workbook_xml,
        text(part: string): string {
            const written = result.parts.find((entry) => entry.part === part);
            if (written !== undefined) return written.newText;
            if (part === 'xl/workbook.xml') return workbook_xml;
            const index = worksheets.findIndex((entry) => entry.part === part);
            return Buffer.from(worksheets[index].source_xml).toString('utf8');
        },
    };
}

const XML_PARSER = new DOMParser();

/** Fails unless `text` is well-formed XML. */
function expect_well_formed(part: string, text: string): void {
    const document = XML_PARSER.parseFromString(text, 'application/xml');
    const errors = document.getElementsByTagName('parsererror');
    expect([part, errors.length === 0 ? '' : errors[0].textContent]).toEqual([part, '']);
}

const SHEET1 = 'xl/worksheets/sheet1.xml';
const SHEET2 = 'xl/worksheets/sheet2.xml';

function formula_of(text: string, address: string): string | undefined {
    const match = new RegExp(`<c r="${address}"[^>]*>(?:(?!</c>).)*?<f([^>]*)>([^<]*)</f>`).exec(text);
    return match === null ? undefined : match[2];
}

describe('workbook formula stage: cell formulas', () => {
    it('renders formulas on every worksheet that reference a restructured worksheet', () => {
        const outcome = stage({
            sheets: [
                {
                    name: 'Data',
                    xml: grid(6, 2, { C5: '<f>A5+Data!B6</f><v>1</v>', C1: '<f>SUM(A1:A6)</f><v>9</v>' }),
                    rows: 6,
                    columns: 3,
                    rowLayout: (layout) => ok(delete_rows(layout, [source(1)], () => 0)),
                },
                {
                    name: 'Report',
                    xml: grid(0, 0, {
                        A1: '<f>Data!A3*2</f><v>4</v>',
                        A2: "<f>SUM('Data'!$B$2:$B$5)</f><v>8</v>",
                        A3: '<f>Data!A2</f><v>0</v>',
                        A4: '<f>Other!A1</f><v>0</v>',
                    }),
                    rows: 4,
                    columns: 1,
                },
            ],
        });
        expect(outcome.refusals).toEqual([]);
        const data = outcome.text(SHEET1);
        // Row 2 is gone: row 5 moved up to row 4, and its references follow.
        expect(formula_of(data, 'C4')).toBe('A4+Data!B5');
        expect(formula_of(data, 'C1')).toBe('SUM(A1:A5)');
        const report = outcome.text(SHEET2);
        expect(formula_of(report, 'A1')).toBe('Data!A2*2');
        expect(formula_of(report, 'A2')).toBe("SUM('Data'!$B$2:$B$4)");
        expect(formula_of(report, 'A3')).toBe('Data!#REF!');
        expect(formula_of(report, 'A4')).toBe('Other!A1');
    });

    it('refuses a formula it cannot render, names its worksheet and cell, and writes nothing', () => {
        const outcome = stage({
            sheets: [
                { name: 'Data', xml: grid(4, 2), rows: 4, columns: 2, rowLayout: (layout) => ok(move_rows(layout, [source(0)], 'end')) },
                { name: 'Report', xml: grid(0, 0, { B3: '<f>SUM(Data!A1#)</f><v>1</v>' }), rows: 3, columns: 2 },
            ],
        });
        expect(outcome.parts).toEqual([]);
        expect(outcome.pending_formulas.size).toBe(0);
        expect(outcome.refusals).toHaveLength(1);
        expect(outcome.refusals[0]).toMatchObject({
            reason: 'unsupportedStructure',
            code: 'unrenderable-formula',
            sheetIndex: 1,
            location: { kind: 'cell', worksheet: 'Report', cell: 'B3' },
        });
        expect(outcome.refusals[0].message).toContain('Report!B3');
        expect(outcome.refusals[0].message).toContain("can't adjust a spill reference");
    });

    it('refuses an array formula on another worksheet whose references the layout changes', () => {
        const outcome = stage({
            sheets: [
                { name: 'Data', xml: grid(4, 1), rows: 4, columns: 1, rowLayout: (layout) => ok(delete_rows(layout, [source(0)], () => 0)) },
                {
                    name: 'Calc',
                    xml: grid(0, 0, {
                        A1: '<f t="array" ref="A1">SUM(Data!A2:A4)</f><v>1</v>',
                        A2: '<f t="array" ref="A2">SUM(Other!A2:A4)</f><v>1</v>',
                    }),
                    rows: 2,
                    columns: 1,
                },
            ],
        });
        expect(outcome.refusals).toMatchObject([{
            code: 'grouped-formula',
            sheetIndex: 1,
            location: { kind: 'cell', worksheet: 'Calc', cell: 'A1' },
        }]);
    });

    it('leaves a workbook without a live layout change untouched', () => {
        const outcome = stage({
            sheets: [{ name: 'Data', xml: grid(3, 1, { B1: '<f>A1</f>' }), rows: 3, columns: 2 }],
            definedNames: '<definedName name="X">Data!$A$1</definedName>',
        });
        expect(outcome.parts).toEqual([]);
        expect(outcome.invalidations).toEqual([]);
    });

    it('invalidates caches on restructured worksheets and the worksheets that read them, in new coordinates', () => {
        const outcome = stage({
            sheets: [
                {
                    name: 'Data',
                    xml: grid(3, 1, { B3: '<f>A3</f><v>1</v>' }),
                    rows: 3,
                    columns: 2,
                    rowLayout: (layout) => ok(delete_rows(layout, [source(0)], () => 0)),
                },
                { name: 'Reads', xml: grid(0, 0, { A1: '<f>Data!A2</f><v>1</v>' }), rows: 1, columns: 1 },
                { name: 'ByName', xml: grid(0, 0, { A1: '<f>Total*2</f><v>1</v>' }), rows: 1, columns: 1 },
                { name: 'Chain', xml: grid(0, 0, { A1: '<f>ByName!A1</f><v>1</v>' }), rows: 1, columns: 1 },
                { name: 'Alone', xml: grid(0, 0, { A1: '<f>1+1</f><v>2</v>' }), rows: 1, columns: 1 },
                { name: 'Dynamic', xml: grid(0, 0, { A1: '<f>Chosen</f><v>1</v>' }), rows: 1, columns: 1 },
            ],
            definedNames: '<definedName name="Total">Data!$A$3</definedName>'
                + '<definedName name="Chosen">INDIRECT("Data!A1")</definedName>',
        });
        expect(outcome.refusals).toEqual([]);
        expect(outcome.invalidations).toEqual([
            { sheetIndex: 0, row: 1, column: 1 },
            { sheetIndex: 1, row: 0, column: 0 },
            { sheetIndex: 2, row: 0, column: 0 },
            { sheetIndex: 3, row: 0, column: 0 },
            { sheetIndex: 5, row: 0, column: 0 },
        ]);
    });
});

describe('workbook formula stage: defined names and hyperlinks', () => {
    it('renders defined names, including print areas, print titles, and filter ranges', () => {
        const outcome = stage({
            sheets: [
                {
                    name: 'Data',
                    xml: grid(5, 3),
                    rows: 5,
                    columns: 3,
                    rowLayout: (layout) => ok(delete_rows(layout, [source(2)], () => 0)),
                    columnLayout: (layout) => ok(insert_columns(layout, source_column(0), 'after', ['pc'])),
                },
                { name: 'Other', xml: grid(2, 2), rows: 2, columns: 2 },
            ],
            definedNames: '<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$C$5</definedName>'
                + '<definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$1:$1,Data!$A:$A</definedName>'
                + '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Data!$A$1:$C$4</definedName>'
                + '<definedName name="Pick">Data!$B$4</definedName>'
                + '<definedName name="Kept">Other!$A$1:$B$2</definedName>',
        });
        expect(outcome.refusals).toEqual([]);
        const text = outcome.text('xl/workbook.xml');
        expect(text).toContain('<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$D$4</definedName>');
        expect(text).toContain('<definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$1:$1,Data!$A:$A</definedName>');
        expect(text).toContain('<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Data!$A$1:$D$3</definedName>');
        expect(text).toContain('<definedName name="Pick">Data!$C$3</definedName>');
        expect(text).toContain('<definedName name="Kept">Other!$A$1:$B$2</definedName>');
    });

    it('resolves a local name\'s unqualified reference to its own worksheet, and refuses a global one', () => {
        const local = stage({
            sheets: [
                { name: 'Other', xml: grid(2, 2), rows: 2, columns: 2 },
                {
                    name: 'Data',
                    xml: grid(5, 1),
                    rows: 5,
                    columns: 1,
                    rowLayout: (layout) => ok(delete_rows(layout, [source(0)], () => 0)),
                },
            ],
            definedNames: '<definedName name="Here" localSheetId="1">$A$3</definedName>',
        });
        expect(local.refusals).toEqual([]);
        expect(local.text('xl/workbook.xml')).toContain('<definedName name="Here" localSheetId="1">$A$2</definedName>');

        const global = stage({
            sheets: [
                {
                    name: 'Data',
                    xml: grid(5, 1),
                    rows: 5,
                    columns: 1,
                    rowLayout: (layout) => ok(delete_rows(layout, [source(0)], () => 0)),
                },
            ],
            definedNames: '<definedName name="Where">$A$3</definedName>',
        });
        expect(global.parts).toEqual([]);
        expect(global.refusals).toMatchObject([{ code: 'ambiguous-defined-name', location: { kind: 'defined-name', name: 'Where' } }]);
    });

    it('keeps a single-quoted location well-formed when its new text holds apostrophes', () => {
        const outcome = stage({
            sheets: [
                {
                    name: 'Data Set',
                    xml: grid(5, 1),
                    rows: 5,
                    columns: 1,
                    rowLayout: (layout) => ok(delete_rows(layout, [source(0)], () => 0)),
                },
                {
                    name: 'Index',
                    xml: grid(1, 1) + `<hyperlinks><hyperlink ref='A1' location='&apos;Data Set&apos;!A3'/></hyperlinks>`,
                    rows: 1,
                    columns: 1,
                },
            ],
        });
        expect(outcome.refusals).toEqual([]);
        expect(outcome.text(SHEET2)).toContain(`<hyperlink ref='A1' location='&apos;Data Set&apos;!A2'/>`);
    });

    it('renders internal hyperlink locations on every worksheet and leaves external ones alone', () => {
        const links = (location: string) => '<hyperlinks>'
            + `<hyperlink ref="A1" location="${location}" display="go"/>`
            + '<hyperlink ref="A2" r:id="rId1" location="Data!A4"/>'
            + '</hyperlinks>';
        const outcome = stage({
            sheets: [
                {
                    name: 'Data',
                    xml: grid(5, 2) + links('A5'),
                    rows: 5,
                    columns: 2,
                    rowLayout: (layout) => ok(move_rows(layout, [source(4)], source(0))),
                },
                { name: 'Index', xml: grid(2, 1) + links("'Data'!A4:B5"), rows: 2, columns: 1 },
            ],
        });
        expect(outcome.refusals).toEqual([]);
        expect(outcome.text(SHEET1)).toContain('<hyperlink ref="A2" location="A1" display="go"/>');
        expect(outcome.text(SHEET2)).toContain(`<hyperlink ref="A1" location="'Data'!A1:B5" display="go"/>`);
        expect(outcome.text(SHEET2)).toContain('<hyperlink ref="A2" r:id="rId1" location="Data!A4"/>');
    });
});

describe('workbook formula stage: shared formula groups', () => {
    const shared = (master_formula: string) => ({
        B2: `<f t="shared" ref="B2:B4" si="0">${master_formula}</f><v>1</v>`,
        B3: '<f t="shared" si="0"/><v>1</v>',
        B4: '<f t="shared" si="0"/><v>1</v>',
    });

    it('keeps a group whose cells all shift together and re-renders only its master\'s ref', () => {
        const outcome = stage({
            sheets: [
                {
                    name: 'Data',
                    xml: grid(5, 1, shared('Other!A1*2')),
                    rows: 5,
                    columns: 2,
                    rowLayout: (layout) => ok(insert_rows(layout, source(0), 'before', ['p1'])),
                },
                { name: 'Other', xml: grid(5, 1), rows: 5, columns: 1 },
            ],
        });
        expect(outcome.refusals).toEqual([]);
        const text = outcome.text(SHEET1);
        expect(text).toContain('<c r="B3"><f t="shared" ref="B3:B5" si="0">Other!A1*2</f><v>1</v></c>');
        expect(text).toContain('<c r="B4"><f t="shared" si="0"/><v>1</v></c>');
    });

    it('unshares a group a move splits, writing what each follower evaluated', () => {
        const outcome = stage({
            sheets: [{
                name: 'Data',
                xml: grid(5, 1, shared('A2*2')),
                rows: 5,
                columns: 2,
                rowLayout: (layout) => ok(move_rows(layout, [source(2)], 'end')),
            }],
        });
        expect(outcome.refusals).toEqual([]);
        const text = outcome.text(SHEET1);
        // Old row 3 (B3 = A3*2) is now last; rows 4 and 5 moved up.
        expect(text).toContain('<c r="B2"><f>A2*2</f><v>1</v></c>');
        expect(text).toContain('<c r="B3"><f>A3*2</f><v>1</v></c>');
        expect(text).toContain('<c r="B5"><f>A5*2</f><v>1</v></c>');
        expect(text).not.toContain('t="shared"');
    });

    it('unshares a group whose rendered text changes even when its cells keep their places', () => {
        const outcome = stage({
            sheets: [
                { name: 'Data', xml: grid(5, 1, shared('Other!A2*2')), rows: 5, columns: 2 },
                {
                    name: 'Other',
                    xml: grid(5, 1),
                    rows: 5,
                    columns: 1,
                    rowLayout: (layout) => ok(delete_rows(layout, [source(2)], () => 0)),
                },
            ],
        });
        expect(outcome.refusals).toEqual([]);
        const text = outcome.text(SHEET1);
        expect(text).toContain('<c r="B2"><f>Other!A2*2</f><v>1</v></c>');
        expect(text).toContain('<c r="B3"><f>Other!#REF!*2</f><v>1</v></c>');
        expect(text).toContain('<c r="B4"><f>Other!A3*2</f><v>1</v></c>');
    });

    it('unshares the survivors of a group whose master was deleted', () => {
        const outcome = stage({
            sheets: [{
                name: 'Data',
                xml: grid(5, 1, shared('A2*2')),
                rows: 5,
                columns: 2,
                rowLayout: (layout) => ok(delete_rows(layout, [source(1)], () => 0)),
            }],
        });
        expect(outcome.refusals).toEqual([]);
        const text = outcome.text(SHEET1);
        expect(text).toContain('<c r="B2"><f>A2*2</f><v>1</v></c>');
        expect(text).toContain('<c r="B3"><f>A3*2</f><v>1</v></c>');
    });

    it('refuses unsharing past the per-save cap', () => {
        const run: Run = {
            sheets: [{
                name: 'Data',
                xml: grid(5, 1, shared('A2*2')),
                rows: 5,
                columns: 2,
                rowLayout: (layout) => ok(move_rows(layout, [source(2)], 'end')),
            }],
        };
        expect(stage({ ...run, unshareLimits: { followers: 2, bytes: 1000 } }).refusals).toEqual([]);
        const followers = stage({ ...run, unshareLimits: { followers: 1, bytes: 1000 } });
        expect(followers.parts).toEqual([]);
        expect(followers.refusals).toMatchObject([{ code: 'unshare-limit', sheetIndex: 0, location: { kind: 'worksheet', worksheet: 'Data' } }]);
        expect(stage({ ...run, unshareLimits: { followers: 10, bytes: 7 } }).refusals)
            .toMatchObject([{ code: 'unshare-limit' }]);
    });
});

describe('workbook formula stage: conditional formatting and data validation', () => {
    const cf = (sqref: string, formula: string, priority: number) =>
        `<conditionalFormatting sqref="${sqref}"><cfRule type="expression" dxfId="0" priority="${priority}"><formula>${formula}</formula></cfRule></conditionalFormatting>`;

    it('keeps one rule when a move carries each cell with the cell it names', () => {
        const outcome = stage({
            sheets: [{
                name: 'Data',
                xml: grid(4, 2) + cf('A1:A2', 'B1', 1),
                rows: 4,
                columns: 2,
                rowLayout: (layout) => ok(move_rows(layout, [source(0)], source(2))),
            }],
        });
        expect(outcome.refusals).toEqual([]);
        expect(outcome.text(SHEET1)).toContain(cf('A1:A2', 'B1', 1));
    });

    it('splits a rule whose cells move away from the cells they name, renumbering later priorities', () => {
        const outcome = stage({
            sheets: [
                {
                    name: 'Data',
                    xml: grid(4, 2) + cf('A1:A2', 'Other!B1', 1) + cf('C1:C4', '$A1>0', 2),
                    rows: 4,
                    columns: 3,
                    rowLayout: (layout) => ok(move_rows(layout, [source(0)], source(2))),
                },
                { name: 'Other', xml: grid(4, 2), rows: 4, columns: 2 },
            ],
        });
        expect(outcome.refusals).toEqual([]);
        // Old A1 (now A2) still reads Other!B1; old A2 (now A1) still reads Other!B2.
        expect(outcome.text(SHEET1)).toContain(cf('A1', 'Other!B2', 1) + cf('A2', 'Other!B1', 2) + cf('C1:C4', '$A1>0', 3));
    });

    it('splits every cfRule of an element together, each copy right after its original\'s priority', () => {
        const element = (sqref: string, first: string, second: string, priorities: readonly [number, number]) =>
            `<conditionalFormatting sqref="${sqref}">`
            + `<cfRule type="expression" dxfId="0" priority="${priorities[0]}"><formula>${first}</formula></cfRule>`
            + `<cfRule type="expression" dxfId="1" priority="${priorities[1]}"><formula>${second}</formula></cfRule>`
            + '</conditionalFormatting>';
        const outcome = stage({
            sheets: [
                {
                    name: 'Data',
                    xml: grid(4, 2) + cf('C1', '1', 2) + element('A1:A2', 'Other!B1', 'B1', [1, 3]) + cf('D1', '1', 4),
                    rows: 4,
                    columns: 4,
                    rowLayout: (layout) => ok(move_rows(layout, [source(0)], source(2))),
                },
                { name: 'Other', xml: grid(4, 2), rows: 4, columns: 2 },
            ],
        });
        expect(outcome.refusals).toEqual([]);
        // The move carries C1 and D1 to row 2; each copy's B1 is written relative to its own top-left.
        expect(outcome.text(SHEET1)).toContain(cf('C2', '1', 3)
            + element('A1', 'Other!B2', 'B1', [1, 4])
            + element('A2', 'Other!B1', 'B2', [2, 5])
            + cf('D2', '1', 6));
    });

    it('refuses to split a rule on a worksheet whose extension formatting shares the priorities', () => {
        const outcome = stage({
            sheets: [
                { name: 'Data', xml: grid(4, 2), rows: 4, columns: 2, rowLayout: (layout) => ok(move_rows(layout, [source(0)], source(2))) },
                { name: 'View', xml: grid(2, 1) + cf('A1:A2', 'Data!B1', 1) + '<extLst><ext uri="{X}"/></extLst>', rows: 2, columns: 1 },
            ],
        });
        expect(outcome.refusals).toMatchObject([{ code: 'conditional-formatting-priority', sheetIndex: 1 }]);
    });

    it('splits on an insertion between the covered cells and the cells they name', () => {
        const outcome = stage({
            sheets: [{
                name: 'Data',
                xml: grid(8, 2) + cf('A1:A5', 'B5', 7),
                rows: 8,
                columns: 2,
                rowLayout: (layout) => ok(insert_rows(layout, source(5), 'before', ['p1'])),
            }],
        });
        expect(outcome.refusals).toEqual([]);
        expect(outcome.text(SHEET1)).toContain(cf('A1', 'B5', 7) + cf('A2:A5', 'B7', 8));
    });

    it('splits on a deletion between them, with #REF! where the named cell was deleted', () => {
        const outcome = stage({
            sheets: [{
                name: 'Data',
                xml: grid(8, 2) + cf('A1:A5', 'B5', 1),
                rows: 8,
                columns: 2,
                rowLayout: (layout) => ok(delete_rows(layout, [source(5)], () => 0)),
            }],
        });
        expect(outcome.refusals).toEqual([]);
        expect(outcome.text(SHEET1)).toContain(cf('A1', 'B5', 1) + cf('A2', '#REF!', 2) + cf('A3:A5', 'B6', 3));
    });

    it('fills an inserted row inside a rule with the formula of the row before it', () => {
        const outcome = stage({
            sheets: [{
                name: 'Data',
                xml: grid(6, 2) + cf('A1:A4', 'Other!B1', 1),
                rows: 6,
                columns: 2,
                rowLayout: (layout) => ok(insert_rows(layout, source(1), 'after', ['p1'])),
            }, { name: 'Other', xml: grid(6, 2), rows: 6, columns: 2 }],
        });
        expect(outcome.refusals).toEqual([]);
        // A1:A2 keep Other!B1-relative; the new A3 joins them; old A3:A4 (now A4:A5) name one row up.
        expect(outcome.text(SHEET1)).toContain(cf('A1:A3', 'Other!B1', 1) + cf('A4:A5', 'Other!B3', 2));
    });

    it('splits data validations, keeping attributes and updating the count', () => {
        const outcome = stage({
            sheets: [{
                name: 'Data',
                xml: grid(8, 2) + '<dataValidations count="2">'
                    + '<dataValidation type="custom" allowBlank="1" sqref="A1:A5"><formula1>B5&gt;0</formula1></dataValidation>'
                    + '<dataValidation type="list" sqref="C1"><formula1>"a,b"</formula1></dataValidation>'
                    + '</dataValidations>',
                rows: 8,
                columns: 3,
                rowLayout: (layout) => ok(insert_rows(layout, source(5), 'before', ['p1'])),
            }],
        });
        expect(outcome.refusals).toEqual([]);
        expect(outcome.text(SHEET1)).toContain('<dataValidations count="3">'
            + '<dataValidation type="custom" allowBlank="1" sqref="A1"><formula1>B5&gt;0</formula1></dataValidation>'
            + '<dataValidation type="custom" allowBlank="1" sqref="A2:A5"><formula1>B7&gt;0</formula1></dataValidation>'
            + '<dataValidation type="list" sqref="C1"><formula1>"a,b"</formula1></dataValidation>'
            + '</dataValidations>');
    });

    it('renders a rule on an unchanged worksheet that names a restructured one', () => {
        const outcome = stage({
            sheets: [
                {
                    name: 'Data',
                    xml: grid(6, 2),
                    rows: 6,
                    columns: 2,
                    columnLayout: (layout) => ok(move_columns(layout, [source_column(1)], source_column(0))),
                },
                { name: 'View', xml: grid(3, 1) + cf('A1:A3', 'Data!$B1&gt;0', 1), rows: 3, columns: 1 },
            ],
        });
        expect(outcome.refusals).toEqual([]);
        expect(outcome.text(SHEET2)).toContain(cf('A1:A3', 'Data!$A1&gt;0', 1));
    });

    it('keeps a whole-column rule whose references wrap past the last row as one rule', () => {
        const outcome = stage({
            sheets: [{
                name: 'Data',
                xml: grid(6, 2) + cf('A1:A1048576', 'A2&lt;&gt;A1', 1),
                rows: 6,
                columns: 2,
                columnLayout: (layout) => ok(insert_columns(layout, source_column(0), 'after', ['pc'])),
            }],
        });
        expect(outcome.refusals).toEqual([]);
        expect(outcome.text(SHEET1)).toContain(cf('A1:A1048576', 'A2&lt;&gt;A1', 1));
    });

    it('keeps a rule with a construct it cannot adjust only while none of its cells move', () => {
        const run = (xml: string, rowLayout: (layout: RowLayout) => RowLayout) => stage({
            sheets: [
                { name: 'View', xml: grid(6, 1) + xml, rows: 6, columns: 1, rowLayout },
                { name: 'Other', xml: grid(4, 2), rows: 4, columns: 2 },
            ],
        });
        const spill = (sqref: string) => cf(sqref, 'COUNT(Other!B1#)', 1);
        // Rows below the rule change: every covered cell keeps its place.
        const below = run(spill('A1:A3'), (layout) => ok(delete_rows(layout, [source(4)], () => 0)));
        expect(below.refusals).toEqual([]);
        expect(below.text(SHEET1)).toContain(spill('A1:A3'));
        // A deletion above shifts the rule's top-left; a swap inside it keeps its range but moves its cells.
        for (const moved of [
            run(spill('A2:A3'), (layout) => ok(delete_rows(layout, [source(0)], () => 0))),
            run(spill('A1:A3'), (layout) => ok(move_rows(layout, [source(0)], source(2)))),
        ]) {
            expect(moved.parts).toEqual([]);
            expect(moved.refusals).toMatchObject([{
                code: 'unrenderable-formula',
                sheetIndex: 0,
                location: { kind: 'conditional-formatting', worksheet: 'View' },
                issue: { kind: 'spill' },
            }]);
        }
    });

    it('refuses a rule that would split into more than 64 rules', () => {
        const rows = 200;
        const odd = Array.from({ length: rows / 2 }, (_, index) => source(index * 2 + 1));
        const outcome = stage({
            sheets: [
                {
                    name: 'Data',
                    xml: grid(rows, 1) + cf(`A1:A${rows}`, 'Other!B1', 1),
                    rows,
                    columns: 1,
                    rowLayout: (layout) => ok(delete_rows(layout, odd, () => 0)),
                },
                { name: 'Other', xml: grid(2, 2), rows: 2, columns: 2 },
            ],
        });
        expect(outcome.parts).toEqual([]);
        expect(outcome.refusals).toMatchObject([{
            code: 'rule-split-limit',
            sheetIndex: 0,
            location: { kind: 'conditional-formatting', worksheet: 'Data', sqref: 'A1:A100' },
        }]);
        expect(outcome.refusals[0].message).toContain('more than 64 rules');
    });
});

describe('workbook formula stage: pending formulas', () => {
    it('renders stored anchors and implicit ones for the layouts', () => {
        const anchors: FormulaAnchors = {
            references: [{
                start: 1,
                end: 3,
                corners: [{
                    row: { kind: 'identity', row: { kind: 'pending', pendingRowId: 'p1' } },
                    column: { kind: 'identity', column: { kind: 'source', sourceColumn: 0 } },
                }],
            }],
        };
        const outcome = stage({
            sheets: [{
                name: 'Data',
                xml: grid(4, 2),
                rows: 4,
                columns: 2,
                rowLayout: (layout) => ok(insert_rows(ok(delete_rows(layout, [source(0)], () => 0)), source(2), 'after', ['p1'])),
            }],
            pending: [
                { key: 'anchored', sheetIndex: 0, row: 0, column: 1, text: '=A9+1', anchors },
                { key: 'implicit', sheetIndex: 0, row: 1, column: 1, text: '=A4*2' },
                { key: 'unrenderable', sheetIndex: 0, row: 2, column: 1, text: '=A1#' },
            ],
        });
        expect(outcome.refusals).toMatchObject([{
            code: 'unrenderable-formula',
            location: { kind: 'pending-cell', worksheet: 'Data', cell: 'B3' },
        }]);
        expect(outcome.pending_formulas.size).toBe(0);

        const fine = stage({
            sheets: [{
                name: 'Data',
                xml: grid(4, 2),
                rows: 4,
                columns: 2,
                rowLayout: (layout) => ok(insert_rows(ok(delete_rows(layout, [source(0)], () => 0)), source(2), 'after', ['p1'])),
            }],
            pending: [
                { key: 'anchored', sheetIndex: 0, row: 0, column: 1, text: '=A9+1', anchors },
                { key: 'implicit', sheetIndex: 0, row: 1, column: 1, text: '=A4*2' },
            ],
        });
        expect(fine.refusals).toEqual([]);
        // Layout: 1 (deleted), 2, 3, p1, 4 → p1 is row 3 and old row 4 is row 4.
        expect(fine.pending_formulas.get('anchored')).toBe('=A3+1');
        expect(fine.pending_formulas.get('implicit')).toBe('=A4*2');
    });
});

describe('formula-rule-split', () => {
    it('parses and counts the way the writer splits', () => {
        expect(parse_rule_sqref('A1:A5 $C$2')).toEqual([
            { firstRow: 0, firstColumn: 0, lastRow: 4, lastColumn: 0 },
            { firstRow: 1, firstColumn: 2, lastRow: 1, lastColumn: 2 },
        ]);
        expect(parse_rule_sqref('A1:B2:C3')).toBeUndefined();
        const layout = ok(delete_rows(source_row_layout(0, 8), [source(5)], () => 0));
        const workbook = rule_split_workbook([{
            target: { sheetIndex: 0 },
            name: 'Data',
            bodyStart: 0,
            sourceRowCount: 8,
            sourceColumnCount: 2,
            changes: { appendedRows: [], tailRemovals: [], rowLayout: layout },
        }]);
        const rule = { worksheet: 0, cells: parse_rule_sqref('A1:A5')!, formulas: ['B5'] };
        expect(relative_rule_split_count(workbook, rule)).toEqual({ kind: 'count', count: 3 });
        const split = split_relative_rule(workbook, rule, parse_rule_sqref('A1:A5')!);
        expect(split.kind === 'split' && split.groups.map((group) => group.formulas[0])).toEqual(['B5', '#REF!', 'B6']);
        expect(relative_rule_split_count(workbook, { ...rule, formulas: ['A1#'] }).kind).toBe('unrenderable');
        expect(MAX_RULE_SPLIT).toBe(64);
    });
});

// ---------------------------------------------------------------------------
// End to end: restructure, render, and read back through the parser.
// ---------------------------------------------------------------------------

function build_xlsx(names: readonly string[], parts: readonly string[], workbook_xml: string): Uint8Array {
    const file = CFB.utils.cfb_new();
    const add = (name: string, text: string): void => {
        CFB.utils.cfb_add(file, `/${name}`, Buffer.from(text, 'utf8'));
    };
    add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`);
    add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${OD}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    add('xl/workbook.xml', workbook_xml);
    add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
        names.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${OD}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')
    }</Relationships>`);
    parts.forEach((text, index) => add(`xl/worksheets/sheet${index + 1}.xml`, text));
    return new Uint8Array(CFB.write(file, { type: 'buffer', fileType: 'zip' }) as ArrayBuffer);
}

type Rows = readonly (readonly ({ raw: unknown; formula?: string } | null | undefined)[])[];

/** Labels of every cell each single-cell or range reference names, per formula cell. */
function referenced_labels(sheets: readonly { name: string; rows: Rows }[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    sheets.forEach((sheet, index) => {
        sheet.rows.forEach((row) => row.forEach((cell, c) => {
            if (cell?.formula === undefined) return;
            const labels: string[] = [];
            for (const token of formula_reference_tokens(cell.formula).references) {
                const target = token.sheetName === undefined
                    ? sheets[index]
                    : sheets.find((entry) => entry.name === token.sheetName)!;
                const rows = token.corners.map((corner) => corner.row!.value - 1);
                const columns = token.corners.map((corner) => corner.column!.value - 1);
                for (let rr = Math.min(...rows); rr <= Math.max(...rows); rr++) {
                    for (let cc = Math.min(...columns); cc <= Math.max(...columns); cc++) {
                        const value = target.rows[rr]?.[cc]?.raw;
                        if (typeof value === 'string' && /^\d+-\d+$/.test(value)) labels.push(value);
                    }
                }
            }
            // Key formula cells by the label in column A of their row, which moves with them.
            const key = `${sheet.name}:${String(row[0]?.raw)}:${c}`;
            out.set(key, labels.sort());
        }));
    });
    return out;
}

describe('workbook formula stage: end to end', () => {
    it('keeps every formula naming the same cells after restructure, render, and parse', async () => {
        const formulas = {
            D1: '<f>A3&amp;B5</f>',
            D2: '<f>SUM(A1:A2)</f>',
            D4: '<f t="shared" ref="D4:D6" si="0">B4&amp;Other!A1</f>',
            D5: '<f t="shared" si="0"/>',
            D6: '<f t="shared" si="0"/>',
        };
        const data = { name: 'Data', xml: grid(8, 3, formulas), rows: 8, columns: 4 };
        const other = {
            name: 'Other',
            xml: grid(4, 3, { E1: '<f>Data!B7&amp;Data!C2</f>', E2: '<f>Data!A4&amp;Data!B6</f>' }),
            rows: 4,
            columns: 5,
        };
        const layout = {
            rowLayout: (rows: RowLayout) => ok(move_rows(
                ok(insert_rows(rows, source(3), 'before', ['p1'])),
                [source(6)],
                source(0),
            )),
            columnLayout: (columns: ColumnLayout) => ok(move_columns(
                ok(delete_columns(columns, [source_column(2)], () => 0)),
                [source_column(1)],
                source_column(0),
            )),
        };
        const before = await parse_xlsx(build_xlsx(
            ['Data', 'Other'],
            [worksheet(data.xml), worksheet(other.xml)],
            workbook(['Data', 'Other']),
        ));
        const outcome = stage({ sheets: [{ ...data, ...layout }, other] });
        expect(outcome.refusals).toEqual([]);
        const after = await parse_xlsx(build_xlsx(
            ['Data', 'Other'],
            [outcome.text(SHEET1), outcome.text(SHEET2)],
            outcome.text('xl/workbook.xml'),
        ));
        const sheets_of = (parsed: typeof before) => parsed.data.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows as Rows }));
        const old_labels = referenced_labels(sheets_of(before));
        const new_labels = referenced_labels(sheets_of(after));
        // Column C was deleted: drop its labels from the old side, and re-key Data's
        // formula column D, which is now C (old column B moved to the front).
        const removed = (label: string) => label.endsWith('-2');
        const expected = new Map<string, string[]>();
        for (const [key, labels] of old_labels) {
            const [sheet, row_label, column] = key.split(':');
            const new_column = sheet === 'Data' && column === '3' ? '2' : column;
            // Column A now holds old column B's labels.
            const new_row_label = sheet === 'Data' ? row_label.replace(/-0$/, '-1') : row_label;
            expected.set(`${sheet}:${new_row_label}:${new_column}`, labels.filter((label) => !removed(label)));
        }
        expect(new_labels.size).toBeGreaterThanOrEqual(7);
        for (const [key, labels] of expected) {
            expect([key, new_labels.get(key)]).toEqual([key, labels]);
        }
    });
});

// ---------------------------------------------------------------------------
// Generated layouts: every covered cell keeps its meaning.
// ---------------------------------------------------------------------------

function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 2 ** 32;
    };
}

describe('formula-rule-split: generated layouts', () => {
    const ROWS = 12;
    const COLUMNS = 6;
    const FORMULAS = ['B3', '$C2', 'D$4', 'SUM(A1:B3)', 'Other!C2', 'A2<>A1', 'COUNT(2:3)', 'SUM(B:C)', 'Other!$A1:B2', '$B$2'];

    function row_ops(next: () => number, layout: RowLayout): RowLayout {
        let current = layout;
        let pending = 0;
        for (let step = 0; step < 3; step++) {
            const row = Math.floor(next() * ROWS);
            const choice = next();
            const result = choice < 0.33
                ? delete_rows(current, [source(row)], () => 0)
                : choice < 0.66
                    ? insert_rows(current, source(row), next() < 0.5 ? 'before' : 'after', [`p${pending++}`])
                    : move_rows(current, [source(row)], next() < 0.2 ? 'end' : source(Math.floor(next() * ROWS)));
            if (result.ok) current = result.layout;
        }
        return current;
    }

    function column_ops(next: () => number, layout: ColumnLayout): ColumnLayout {
        let current = layout;
        let pending = 0;
        for (let step = 0; step < 2; step++) {
            const column = Math.floor(next() * COLUMNS);
            const choice = next();
            const result = choice < 0.33
                ? delete_columns(current, [source_column(column)], () => 0)
                : choice < 0.66
                    ? insert_columns(current, source_column(column), 'after', [`c${pending++}`])
                    : move_columns(current, [source_column(column)], source_column(Math.floor(next() * COLUMNS)));
            if (result.ok) current = result.layout;
        }
        return current;
    }

    it('matches the renderer at every covered cell, and the count matches the split', () => {
        let checked = 0;
        for (let seed = 1; seed <= 150; seed++) {
            const next = random(seed);
            const own_rows = row_ops(next, source_row_layout(0, ROWS));
            const own_columns = next() < 0.5 ? column_ops(next, source_column_layout(COLUMNS)) : source_column_layout(COLUMNS);
            const other_rows = next() < 0.4 ? row_ops(next, source_row_layout(0, ROWS)) : source_row_layout(0, ROWS);
            const first_row = Math.floor(next() * 4);
            const first_column = Math.floor(next() * 3);
            const cells = [{
                firstRow: first_row,
                firstColumn: first_column,
                lastRow: first_row + 2 + Math.floor(next() * 6),
                lastColumn: first_column + Math.floor(next() * 3),
            }];
            const formulas = [FORMULAS[Math.floor(next() * FORMULAS.length)], FORMULAS[Math.floor(next() * FORMULAS.length)]];
            const inputs = [
                {
                    target: { sheetIndex: 0 },
                    name: 'Data',
                    bodyStart: 0,
                    sourceRowCount: ROWS,
                    sourceColumnCount: COLUMNS,
                    changes: { appendedRows: [], tailRemovals: [], rowLayout: own_rows, columnLayout: own_columns },
                },
                {
                    target: { sheetIndex: 1 },
                    name: 'Other',
                    bodyStart: 0,
                    sourceRowCount: ROWS,
                    sourceColumnCount: COLUMNS,
                    changes: { appendedRows: [], tailRemovals: [], rowLayout: other_rows },
                },
            ];
            if (!has_live_row_layout_change(own_rows) && !has_live_column_layout_change(own_columns)) continue;
            const restructured = restructure_worksheet({
                worksheet_xml: Buffer.from(worksheet(`${grid(ROWS, COLUMNS)}<conditionalFormatting sqref="${
                    `${letters(cells[0].firstColumn)}${cells[0].firstRow + 1}:${letters(cells[0].lastColumn)}${cells[0].lastRow + 1}`
                }"><cfRule type="expression" priority="1"><formula>1</formula></cfRule></conditionalFormatting>`), 'utf8'),
                layout: { bodyStart: 0, rowLayout: own_rows, columnLayout: own_columns },
                inserted_row_formats: new Map(own_rows.runs.flatMap((run) => run.kind === 'pending' ? run.ids : [])
                    .map((id) => [id, { cellStyleIndexes: new Array(COLUMNS).fill(null) }])),
                appended_row_formats: [],
                inserted_column_formats: new Map(own_columns.columns.flatMap((column) =>
                    column.kind === 'pending' ? [[column.pendingColumnId, { kind: 'default' as const }]] : [])),
            });
            const new_cells = restructured.rule_ranges[0]?.newCells ?? [];
            const workbook = rule_split_workbook(inputs);
            const rule = { worksheet: 0, cells, formulas };
            const split = split_relative_rule(workbook, rule, new_cells);
            const count = relative_rule_split_count(workbook, rule);
            if (split.kind !== 'split') {
                expect([seed, split.kind]).toEqual([seed, 'tooMany']);
                expect(count).toEqual({ kind: 'count', count: MAX_RULE_SPLIT + 1 });
                continue;
            }
            expect([seed, count]).toEqual([seed, { kind: 'count', count: split.groups.length }]);
            // Old coordinates of each new row and column, by brute force.
            const { coordinates } = restructured;
            const old_row = new Map<number, number>();
            const old_column = new Map<number, number>();
            for (let row = 0; row < ROWS; row++) {
                const mapped = coordinates.row(row);
                if (mapped !== null) old_row.set(mapped, row);
            }
            for (let column = 0; column < COLUMNS; column++) {
                const mapped = coordinates.column(column);
                if (mapped !== null) old_column.set(mapped, column);
            }
            const context = { format: 'xlsx' as const, worksheets: workbook.anchors.worksheets, formulaWorksheet: 0 };
            for (const group of split.groups) {
                const top = Math.min(...group.cells.map((range) => range.firstRow));
                const left = Math.min(...group.cells.map((range) => range.firstColumn));
                for (const range of group.cells) {
                    for (let row = range.firstRow; row <= range.lastRow; row++) {
                        for (let column = range.firstColumn; column <= range.lastColumn; column++) {
                            const old_r = old_row.get(row);
                            const old_c = old_column.get(column);
                            if (old_r === undefined || old_c === undefined) continue; // a filled-in new cell
                            formulas.forEach((formula, at) => {
                                const evaluated = render_formula(
                                    wrap_translate_formula(`=${formula}`, old_r - cells[0].firstRow, old_c - cells[0].firstColumn),
                                    undefined,
                                    context,
                                );
                                const written = wrap_translate_formula(`=${group.formulas[at]}`, row - top, column - left);
                                expect([seed, row, column, written]).toEqual([seed, row, column, evaluated.kind === 'rendered' ? evaluated.text : '?']);
                            });
                            checked++;
                        }
                    }
                }
            }
        }
        expect(checked).toBeGreaterThan(500);
    });
});
