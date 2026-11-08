import { describe, expect, it } from 'vitest';
import CFB from 'cfb';
import { parse_xlsx } from '../parse-xlsx';
import { OoxmlRefusalError } from '../ooxml-refusal';
import {
    delete_columns,
    delete_rows,
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
import {
    restructure_worksheet,
    worksheet_coordinate_map,
    WorksheetStructureRefusalError,
    type WorksheetRestructureResult,
    type XlsxColumnFormat,
    type XlsxRowFormat,
} from '../ooxml-surgery/worksheet-structure';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function worksheet(inner: string, root_attributes = ''): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
        + `<worksheet xmlns="${NS}" xmlns:r="${R_NS}"${root_attributes}>${inner}</worksheet>`;
}

function ok<L>(result: LayoutResult<L>): L {
    if (!result.ok) throw new Error(result.refusal.message);
    return result.layout;
}

const source = (sourceRow: number) => ({ kind: 'source', sourceRow }) as const;
const source_column = (sourceColumn: number) => ({ kind: 'source', sourceColumn }) as const;

interface Run {
    readonly bodyStart?: number;
    readonly bodyRows: number;
    readonly columns: number;
    readonly rowLayout?: (layout: RowLayout) => RowLayout;
    readonly columnLayout?: (layout: ColumnLayout) => ColumnLayout;
    readonly insertedRows?: Readonly<Record<string, XlsxRowFormat>>;
    readonly appended?: readonly XlsxRowFormat[];
    readonly insertedColumns?: Readonly<Record<string, XlsxColumnFormat>>;
}

function restructure(xml: string, run: Run): WorksheetRestructureResult & { text: string } {
    const body_start = run.bodyStart ?? 1;
    const row_layout = (run.rowLayout ?? ((layout) => layout))(source_row_layout(body_start, run.bodyRows));
    const column_layout = (run.columnLayout ?? ((layout) => layout))(source_column_layout(run.columns));
    const result = restructure_worksheet({
        worksheet_xml: Buffer.from(xml, 'utf8'),
        layout: { bodyStart: body_start, rowLayout: row_layout, columnLayout: column_layout },
        inserted_row_formats: new Map(Object.entries(run.insertedRows ?? {})),
        appended_row_formats: run.appended ?? [],
        inserted_column_formats: new Map(Object.entries(run.insertedColumns ?? {})),
    });
    return { ...result, text: Buffer.from(result.worksheet_xml).toString('utf8') };
}

function build_xlsx(sheet_xml: string, sheet_rels_xml?: string): Uint8Array {
    const cfb_file = CFB.utils.cfb_new();
    const content_types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
    const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="${NS}" xmlns:r="${R_NS}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const workbook_rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
    CFB.utils.cfb_add(cfb_file, '/[Content_Types].xml', Buffer.from(content_types));
    CFB.utils.cfb_add(cfb_file, '/_rels/.rels', Buffer.from(rels));
    CFB.utils.cfb_add(cfb_file, '/xl/workbook.xml', Buffer.from(workbook));
    CFB.utils.cfb_add(cfb_file, '/xl/_rels/workbook.xml.rels', Buffer.from(workbook_rels));
    CFB.utils.cfb_add(cfb_file, '/xl/worksheets/sheet1.xml', Buffer.from(sheet_xml));
    if (sheet_rels_xml) {
        CFB.utils.cfb_add(cfb_file, '/xl/worksheets/_rels/sheet1.xml.rels', Buffer.from(sheet_rels_xml));
    }
    return new Uint8Array(CFB.write(cfb_file, { type: 'buffer', fileType: 'zip' }) as ArrayBuffer);
}

/** A dense grid whose every cell holds its own old coordinate as text, `r-c`. */
function labelled_grid(rows: number, columns: number, extra = ''): string {
    const body = Array.from({ length: rows }, (_, row) =>
        `<row r="${row + 1}" spans="1:${columns}">${Array.from({ length: columns }, (_, column) =>
            `<c r="${String.fromCharCode(65 + column)}${row + 1}" t="inlineStr"><is><t>${row}-${column}</t></is></c>`,
        ).join('')}</row>`).join('');
    return worksheet(`<dimension ref="A1:${String.fromCharCode(64 + columns)}${rows}"/>`
        + `<sheetData>${body}</sheetData>${extra}`);
}

async function parsed_rows(xml: string): Promise<readonly (readonly ({ raw: unknown } | null | undefined)[])[]> {
    return (await parse_xlsx(build_xlsx(xml))).data.sheets[0].rows as never;
}

const TEMPLATE: XlsxRowFormat = { cellStyleIndexes: [null, 4, null] };

describe('restructure_worksheet: sheetData', () => {
    const sheet = worksheet('<dimension ref="A1:C5"/><sheetData>'
        + '<row r="1" spans="1:3"><c r="A1" t="inlineStr"><is><t>head</t></is></c></row>'
        + '<row r="2" spans="1:3"><c r="A2"><v>1</v></c><c r="B2" s="2"><v>10</v></c></row>'
        + '<row r="3" spans="1:3" ht="30" customHeight="1"><c r="A3"><v>2</v></c></row>'
        + '<row r="4"><c r="A4"><v>3</v></c><c r="C4" s="3"><f>A4*2</f><v>6</v></c></row>'
        + '<row r="5"><c r="A5"><v>4</v></c></row>'
        + '</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>');

    it('deletes a body row, renumbers the rows below it, and drops spans', () => {
        const result = restructure(sheet, {
            bodyRows: 4,
            columns: 3,
            rowLayout: (layout) => ok(delete_rows(layout, [source(2)], () => 0)),
        });
        expect(result.text).toContain('<sheetData>'
            + '<row r="1"><c r="A1" t="inlineStr"><is><t>head</t></is></c></row>'
            + '<row r="2"><c r="A2"><v>1</v></c><c r="B2" s="2"><v>10</v></c></row>'
            + '<row r="3"><c r="A3"><v>3</v></c><c r="C3" s="3"><f>A4*2</f><v>6</v></c></row>'
            + '<row r="4"><c r="A4"><v>4</v></c></row>'
            + '</sheetData>');
        expect(result.text).toContain('<dimension ref="A1:C4"/>');
        expect(result.coordinates.row(2)).toBeNull();
        expect(result.coordinates.row(3)).toBe(2);
        expect(result.coordinates.row(0)).toBe(0);
    });

    it('writes a Pending Inserted Row from its template, in prospective columns', () => {
        const result = restructure(sheet, {
            bodyRows: 4,
            columns: 3,
            rowLayout: (layout) => ok(insert_rows(layout, source(2), 'after', ['p1'])),
            insertedRows: { p1: { ...TEMPLATE, height: 30, rowStyleIndex: 5, thickBottom: true } },
        });
        expect(result.text).toContain('<row r="3" ht="30" customHeight="1"><c r="A3"><v>2</v></c></row>'
            + '<row r="4" s="5" customFormat="1" ht="30" customHeight="1" thickBot="1"><c r="B4" s="4"/></row>'
            + '<row r="5"><c r="A5"><v>3</v></c>');
        expect(result.coordinates.inserted_row('p1')).toBe(3);
        expect(result.coordinates.row(4)).toBe(5);
        expect(result.coordinates.rowCount).toBe(6);
        expect(result.text).toContain('<dimension ref="A1:C6"/>');
    });

    it('moves rows, carrying every byte of each row but its numbers', () => {
        const result = restructure(sheet, {
            bodyRows: 4,
            columns: 3,
            rowLayout: (layout) => ok(move_rows(layout, [source(2)], 'end')),
        });
        expect(result.text).toContain('<row r="3"><c r="A3"><v>3</v></c><c r="C3" s="3"><f>A4*2</f><v>6</v></c></row>'
            + '<row r="4"><c r="A4"><v>4</v></c></row>'
            + '<row r="5" ht="30" customHeight="1"><c r="A5"><v>2</v></c></row>');
    });

    it('deletes, inserts, and moves columns, keeping cells in ascending column order', () => {
        const result = restructure(sheet, {
            bodyRows: 4,
            columns: 3,
            columnLayout: (layout) => {
                const deleted = ok(delete_columns(layout, [source_column(1)], () => 0));
                const inserted = ok(insert_columns(deleted, source_column(0), 'before', ['pc']));
                return ok(move_columns(inserted, [source_column(2)], source_column(0)));
            },
            insertedColumns: { pc: { kind: 'default' } },
        });
        // Prospective columns: new, C (old), A (old). B is removed.
        expect(result.coordinates.inserted_column('pc')).toBe(0);
        expect(result.coordinates.column(2)).toBe(1);
        expect(result.coordinates.column(0)).toBe(2);
        expect(result.coordinates.column(1)).toBeNull();
        expect(result.text).toContain('<row r="2"><c r="C2"><v>1</v></c></row>');
        expect(result.text).toContain('<row r="4"><c r="B4" s="3"><f>A4*2</f><v>6</v></c><c r="C4"><v>3</v></c></row>');
    });

    it('gives a Pending Column the inherited column\'s per-row style, and a Pending Row the template\'s', () => {
        const result = restructure(sheet, {
            bodyRows: 4,
            columns: 3,
            rowLayout: (layout) => ok(insert_rows(layout, source(1), 'before', ['p1'])),
            columnLayout: (layout) => ok(insert_columns(layout, source_column(1), 'after', ['pc'])),
            insertedRows: { p1: TEMPLATE },
            insertedColumns: { pc: { kind: 'source', sourceColumn: 1 } },
        });
        // Row 2 is the new row: B from the template, and the new column C also
        // takes the template's style for B.
        expect(result.text).toContain('<row r="2"><c r="B2" s="4"/><c r="C2" s="4"/></row>');
        // Old row 2 (now 3) has B2 s="2": the new column copies it.
        expect(result.text).toContain('<row r="3"><c r="A3"><v>1</v></c><c r="B3" s="2"><v>10</v></c><c r="C3" s="2"/></row>');
        // Old row 4's C moves to D; it has no B, so no new cell.
        expect(result.text).toContain('<row r="5"><c r="A5"><v>3</v></c><c r="D5" s="3"><f>A4*2</f><v>6</v></c></row>');
    });

    it('writes the append band after the live layout', () => {
        const result = restructure(sheet, {
            bodyRows: 4,
            columns: 3,
            rowLayout: (layout) => ok(delete_rows(layout, [source(1)], () => 0)),
            appended: [TEMPLATE, { cellStyleIndexes: [7, null, null] }],
        });
        expect(result.coordinates.appended_row(0)).toBe(4);
        expect(result.text).toContain('<row r="4"><c r="A4"><v>4</v></c></row>'
            + '<row r="5"><c r="B5" s="4"/></row><row r="6"><c r="A6" s="7"/></row></sheetData>');
    });

    it('keeps sparse rows sparse', () => {
        const sparse = worksheet('<sheetData><row r="1"><c r="A1"><v>0</v></c></row>'
            + '<row r="4"><c r="B4"><v>3</v></c></row><row r="9"><c r="A9"><v>8</v></c></row></sheetData>');
        const result = restructure(sparse, {
            bodyRows: 8,
            columns: 2,
            rowLayout: (layout) => ok(move_rows(layout, [source(8)], source(2))),
        });
        expect(result.text).toContain('<sheetData><row r="1"><c r="A1"><v>0</v></c></row>'
            + '<row r="3"><c r="A3"><v>8</v></c></row><row r="5"><c r="B5"><v>3</v></c></row></sheetData>');
    });

    it('splits a row element that owns cells naming other rows', () => {
        const owner = worksheet('<sheetData><row r="1"><c r="A1"><v>0</v></c></row>'
            + '<row r="2" ht="20"><c r="A2"><v>1</v></c><c r="A3"><v>2</v></c></row></sheetData>');
        const result = restructure(owner, {
            bodyRows: 2,
            columns: 1,
            rowLayout: (layout) => ok(move_rows(layout, [source(2)], source(1))),
        });
        expect(result.text).toContain('<row r="1"><c r="A1"><v>0</v></c></row>'
            + '<row r="2"><c r="A2"><v>2</v></c></row>'
            + '<row r="3" ht="20"><c r="A3"><v>1</v></c></row>');
    });

    it('keeps a self-closing row and expands it only when it gains cells', () => {
        const rows = worksheet('<sheetData><row r="1"><c r="A1" s="1"><v>0</v></c></row>'
            + '<row r="2" ht="25" customHeight="1"/><row r="3"><c r="A3" s="2"><v>2</v></c></row></sheetData>');
        const plain = restructure(rows, {
            bodyRows: 2,
            columns: 1,
            rowLayout: (layout) => ok(move_rows(layout, [source(2)], source(1))),
        });
        expect(plain.text).toContain('<row r="2"><c r="A2" s="2"><v>2</v></c></row><row r="3" ht="25" customHeight="1"/>');
        const widened = restructure(rows, {
            bodyRows: 2,
            columns: 1,
            columnLayout: (layout) => ok(insert_columns(layout, source_column(0), 'after', ['pc'])),
            insertedColumns: { pc: { kind: 'source', sourceColumn: 0 } },
        });
        expect(widened.text).toContain('<row r="2" ht="25" customHeight="1"/>');
        expect(widened.text).toContain('<row r="3"><c r="A3" s="2"><v>2</v></c><c r="B3" s="2"/></row>');
    });

    it('expands a self-closing sheetData to hold new rows', () => {
        const empty = worksheet('<dimension ref="A1"/><sheetData/>');
        const result = restructure(empty, {
            bodyStart: 0,
            bodyRows: 0,
            columns: 1,
            appended: [{ cellStyleIndexes: [3] }],
        });
        expect(result.text).toContain('<dimension ref="A1"/><sheetData><row r="1"><c r="A1" s="3"/></row></sheetData>');
    });

    it('handles namespace-prefixed worksheets the way the cell writer does', () => {
        const prefixed = `<x:worksheet xmlns:x="${NS}"><x:dimension ref="A1:A3"/><x:sheetData>`
            + '<x:row r="1"><x:c r="A1"><x:v>0</x:v></x:c></x:row>'
            + '<x:row r="2"><x:c r="A2"><x:v>1</x:v></x:c></x:row>'
            + '<x:row r="3"><x:c r="A3"><x:v>2</x:v></x:c></x:row>'
            + '</x:sheetData><x:mergeCells count="1"><x:mergeCell ref="A2:A3"/></x:mergeCells></x:worksheet>';
        const result = restructure(prefixed, {
            bodyRows: 2,
            columns: 1,
            rowLayout: (layout) => ok(insert_rows(layout, source(1), 'after', ['p1'])),
            insertedRows: { p1: { cellStyleIndexes: [6] } },
        });
        expect(result.text).toContain('<x:row r="2"><x:c r="A2"><x:v>1</x:v></x:c></x:row>'
            + '<x:row r="3"><x:c r="A3" s="6"/></x:row>'
            + '<x:row r="4"><x:c r="A4"><x:v>2</x:v></x:c></x:row>');
        expect(result.text).toContain('<x:mergeCell ref="A2:A4"/>');
    });

    it('refuses a namespace-prefixed cell whose prefix is unbound, as the cell writer does', () => {
        const unbound = worksheet('<sheetData><row r="1"><y:c r="A1"><v>0</v></y:c></row></sheetData>');
        expect(() => restructure(unbound, { bodyRows: 0, columns: 1 })).toThrow(OoxmlRefusalError);
    });

    it('preserves every byte the layout does not change', () => {
        const rich = worksheet('<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>'
            + '<sheetFormatPr   defaultRowHeight="15" x14ac:dyDescent="0.25"/>'
            + '<sheetData>\n  <row r="1" x14ac:dyDescent="0.25"><!-- note --><c r="A1" s="1" t="s"><v>0</v></c>\n  </row>'
            + '\n  <row r="2" x14ac:dyDescent="0.25"><c r="A2" t="inlineStr"><is><t xml:space="preserve"> a  b </t></is></c></row>\n'
            + '</sheetData><pageMargins  left="0.7" right="0.7"   top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
            + '<pageSetup orientation="landscape"/>', ' xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"');
        const result = restructure(rich, {
            bodyRows: 1,
            columns: 1,
            rowLayout: (layout) => ok(insert_rows(layout, source(1), 'before', ['p1'])),
            insertedRows: { p1: { cellStyleIndexes: [null] } },
        });
        expect(result.text).toContain('<sheetFormatPr   defaultRowHeight="15" x14ac:dyDescent="0.25"/>');
        expect(result.text).toContain('<pageMargins  left="0.7" right="0.7"   top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup orientation="landscape"/>');
        expect(result.text).toContain('\n  <row r="1" x14ac:dyDescent="0.25"><!-- note --><c r="A1" s="1" t="s"><v>0</v></c>\n  </row>'
            + '<row r="2"></row>'
            + '\n  <row r="3" x14ac:dyDescent="0.25"><c r="A3" t="inlineStr"><is><t xml:space="preserve"> a  b </t></is></c></row>\n'
            + '</sheetData>');
        expect(result.text.startsWith(rich.slice(0, rich.indexOf('<sheetData>')))).toBe(true);
    });

    it('reports shared formula groups whose cells changed coordinates', () => {
        const shared = worksheet('<sheetData><row r="1"><c r="A1"><v>0</v></c></row>'
            + '<row r="2"><c r="B2"><f t="shared" ref="B2:B4" si="0">A2*2</f><v>2</v></c></row>'
            + '<row r="3"><c r="B3"><f t="shared" si="0"/><v>4</v></c></row>'
            + '<row r="4"><c r="B4"><f t="shared" si="0"/><v>6</v></c></row>'
            + '<row r="5"><c r="B5"><f t="shared" ref="B5" si="1">1</f></c></row></sheetData>');
        const moved = restructure(shared, {
            bodyRows: 4,
            columns: 2,
            rowLayout: (layout) => ok(move_rows(layout, [source(3)], source(1))),
        });
        expect(moved.text).toContain('<c r="B2"><f t="shared" si="0"/><v>6</v></c>');
        expect(moved.shared_formula_groups).toEqual([{
            sharedIndex: '0',
            relativePositionsKept: false,
            cells: [
                { row: 1, column: 1, to: { row: 2, column: 1 }, master: true },
                { row: 2, column: 1, to: { row: 3, column: 1 }, master: false },
                { row: 3, column: 1, to: { row: 1, column: 1 }, master: false },
            ],
        }]);
        const shifted = restructure(shared, {
            bodyRows: 4,
            columns: 2,
            rowLayout: (layout) => ok(insert_rows(layout, source(1), 'before', ['p1'])),
            insertedRows: { p1: { cellStyleIndexes: [null, null] } },
        });
        expect(shifted.shared_formula_groups.map((group) => [group.sharedIndex, group.relativePositionsKept]))
            .toEqual([['0', true], ['1', true]]);
        // `<f>` bytes, including the master's ref, are the formula stage's to rewrite.
        expect(shifted.text).toContain('<c r="B3"><f t="shared" ref="B2:B4" si="0">A2*2</f><v>2</v></c>');
    });

    it('round-trips through the reader with every value where the layout puts it', async () => {
        const xml = labelled_grid(6, 4);
        const result = restructure(xml, {
            bodyRows: 5,
            columns: 4,
            rowLayout: (layout) => {
                const deleted = ok(delete_rows(layout, [source(3)], () => 0));
                const inserted = ok(insert_rows(deleted, source(1), 'after', ['p1']));
                return ok(move_rows(inserted, [source(5)], source(2)));
            },
            columnLayout: (layout) => {
                const deleted = ok(delete_columns(layout, [source_column(2)], () => 0));
                const inserted = ok(insert_columns(deleted, source_column(3), 'after', ['pc']));
                return ok(move_columns(inserted, [source_column(0)], source_column(3)));
            },
            insertedRows: { p1: { cellStyleIndexes: [null, null, null, null] } },
            insertedColumns: { pc: { kind: 'default' } },
        });
        const rows = await parsed_rows(result.text);
        const { coordinates } = result;
        let checked = 0;
        for (let row = 0; row < 6; row++) {
            for (let column = 0; column < 4; column++) {
                const to_row = coordinates.row(row);
                const to_column = coordinates.column(column);
                if (to_row === null || to_column === null) continue;
                expect(rows[to_row]?.[to_column]?.raw).toBe(`${row}-${column}`);
                checked++;
            }
        }
        expect(checked).toBe(15);
        expect(rows.length).toBe(coordinates.rowCount);
        expect(coordinates.rowCount).toBe(6);
        expect(coordinates.columnCount).toBe(4);
        const blank_row = coordinates.inserted_row('p1')!;
        expect(rows[blank_row]?.every((cell) => cell == null || cell.raw == null) ?? true).toBe(true);
    });
});

describe('restructure_worksheet: the rest of the worksheet', () => {
    const grid = (extra: string, before = '') => worksheet(`${before}<sheetData>`
        + Array.from({ length: 6 }, (_, row) => `<row r="${row + 1}"><c r="A${row + 1}"><v>${row}</v></c></row>`).join('')
        + `</sheetData>${extra}`);

    it('splits, shifts, and re-merges <cols>, copying an inherited column\'s attributes', () => {
        const xml = grid('', '<cols><col min="1" max="1" width="9" customWidth="1"/>'
            + '<col min="2" max="4" width="20" customWidth="1"/><col min="5" max="16384" width="8" style="3"/></cols>');
        const deleted = restructure(xml, {
            bodyRows: 5,
            columns: 4,
            columnLayout: (layout) => ok(delete_columns(layout, [source_column(2)], () => 0)),
        });
        expect(deleted.text).toContain('<cols><col min="1" max="1" width="9" customWidth="1"/>'
            + '<col min="2" max="3" width="20" customWidth="1"/><col min="4" max="16384" width="8" style="3"/></cols>');
        const inserted = restructure(xml, {
            bodyRows: 5,
            columns: 4,
            columnLayout: (layout) => {
                const first = ok(insert_columns(layout, source_column(0), 'after', ['inherit']));
                return ok(insert_columns(first, source_column(2), 'after', ['plain']));
            },
            insertedColumns: { inherit: { kind: 'source', sourceColumn: 0 }, plain: { kind: 'default' } },
        });
        expect(inserted.text).toContain('<cols><col min="1" max="2" width="9" customWidth="1"/>'
            + '<col min="3" max="4" width="20" customWidth="1"/><col min="6" max="6" width="20" customWidth="1"/>'
            + '<col min="7" max="16384" width="8" style="3"/></cols>');
    });

    it('applies cell-set semantics to merges', () => {
        const xml = grid('<mergeCells count="3"><mergeCell ref="A2:B4"/><mergeCell ref="A5:A6"/><mergeCell ref="C1:D1"/></mergeCells>');
        const expanded = restructure(xml, {
            bodyRows: 5,
            columns: 4,
            rowLayout: (layout) => ok(insert_rows(layout, source(2), 'after', ['p1'])),
            insertedRows: { p1: { cellStyleIndexes: [null, null, null, null] } },
        });
        expect(expanded.text).toContain('<mergeCells count="3"><mergeCell ref="A2:B5"/><mergeCell ref="A6:A7"/><mergeCell ref="C1:D1"/></mergeCells>');
        const shrunk = restructure(xml, {
            bodyRows: 5,
            columns: 4,
            rowLayout: (layout) => ok(delete_rows(layout, [source(3), source(5)], () => 0)),
            columnLayout: (layout) => ok(delete_columns(layout, [source_column(3)], () => 0)),
        });
        // A5:A6 loses A6 and is left as one cell; C1:D1 loses D1.
        expect(shrunk.text).toContain('<mergeCells count="1"><mergeCell ref="A2:B3"/></mergeCells>');
        const gone = restructure(grid('<mergeCells count="1"><mergeCell ref="A5:A6"/></mergeCells>'), {
            bodyRows: 5,
            columns: 4,
            rowLayout: (layout) => ok(delete_rows(layout, [source(5)], () => 0)),
        });
        expect(gone.text).not.toContain('mergeCell');
    });

    it('refuses a merge that a move would leave non-rectangular', () => {
        const xml = grid('<mergeCells count="1"><mergeCell ref="A2:A4"/></mergeCells>');
        let caught: unknown;
        try {
            restructure(xml, { bodyRows: 5, columns: 1, rowLayout: (layout) => ok(move_rows(layout, [source(2)], 'end')) });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(WorksheetStructureRefusalError);
        expect((caught as WorksheetStructureRefusalError).code).toBe('non-rectangular-merge');
    });

    it('drops the links of removed cells and reports their relationships', () => {
        const xml = grid('<hyperlinks><hyperlink ref="A2" r:id="rId1"/><hyperlink ref="A3" r:id="rId2"/>'
            + '<hyperlink ref="A4" location="Sheet1!A1" display="x"/><hyperlink ref="A5" r:id="rId2"/></hyperlinks>');
        const result = restructure(xml, {
            bodyRows: 5,
            columns: 1,
            rowLayout: (layout) => ok(delete_rows(layout, [source(1), source(2)], () => 0)),
        });
        expect(result.text).toContain('<hyperlinks><hyperlink ref="A2" location="Sheet1!A1" display="x"/>'
            + '<hyperlink ref="A3" r:id="rId2"/></hyperlinks>');
        // rId2 still has a surviving link; only rId1 is unreferenced.
        expect(result.removed_relationship_ids).toEqual(['rId1']);
        const all = restructure(grid('<hyperlinks><hyperlink ref="A2" r:id="rId1"/></hyperlinks>'), {
            bodyRows: 5,
            columns: 1,
            rowLayout: (layout) => ok(delete_rows(layout, [source(1)], () => 0)),
        });
        expect(all.text).not.toContain('hyperlinks');
        expect(all.removed_relationship_ids).toEqual(['rId1']);
    });

    it('rewrites conditional-formatting and validation sqrefs by cell-set semantics and reports them', () => {
        const xml = grid('<conditionalFormatting sqref="A2:A6"><cfRule type="expression" dxfId="0" priority="1"><formula>A2&gt;3</formula></cfRule></conditionalFormatting>'
            + '<conditionalFormatting sqref="A3"><cfRule type="expression" dxfId="0" priority="2"><formula>$A$1&gt;0</formula></cfRule></conditionalFormatting>'
            + '<dataValidations count="2"><dataValidation type="whole" sqref="A2:A3 A6"><formula1>0</formula1><formula2>10</formula2></dataValidation>'
            + '<dataValidation type="list" sqref="A3"><formula1>$B$1:$B$4</formula1></dataValidation></dataValidations>');
        const moved = restructure(xml, {
            bodyRows: 5,
            columns: 1,
            rowLayout: (layout) => ok(move_rows(layout, [source(5)], source(1))),
        });
        expect(moved.text).toContain('<conditionalFormatting sqref="A2:A6">');
        expect(moved.text).toContain('<conditionalFormatting sqref="A4">');
        expect(moved.text).toContain('<dataValidation type="whole" sqref="A2:A4">');
        expect(moved.text).toContain('<dataValidation type="list" sqref="A4">');
        expect(moved.rule_ranges.map((rule) => [rule.kind, rule.index, rule.needsFormulaStage])).toEqual([
            ['conditionalFormatting', 0, true],
            ['conditionalFormatting', 1, false],
            ['dataValidation', 0, false],
            ['dataValidation', 1, false],
        ]);
        expect(moved.rule_ranges[0].formulas).toEqual(['A2>3']);
        expect(moved.rule_ranges[2].oldCells).toEqual([
            { firstRow: 1, firstColumn: 0, lastRow: 2, lastColumn: 0 },
            { firstRow: 5, firstColumn: 0, lastRow: 5, lastColumn: 0 },
        ]);
        expect(moved.rule_ranges[2].newCells).toEqual([{ firstRow: 1, firstColumn: 0, lastRow: 3, lastColumn: 0 }]);

        const deleted = restructure(xml, {
            bodyRows: 5,
            columns: 1,
            rowLayout: (layout) => ok(delete_rows(layout, [source(2)], () => 0)),
        });
        // An insert or delete alone is not a move, so nothing needs the formula stage.
        expect(deleted.rule_ranges.every((rule) => !rule.needsFormulaStage)).toBe(true);
        expect(deleted.text).not.toContain('sqref="A3"><cfRule');
        expect(deleted.text).toContain('<dataValidations count="1"><dataValidation type="whole" sqref="A2 A5">');
    });

    it('keeps a whole-column rule reaching the last row after rows are deleted or inserted', () => {
        const xml = grid('<conditionalFormatting sqref="A1:A1048576"><cfRule type="expression" dxfId="0" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting>');
        for (const rowLayout of [
            (layout: RowLayout) => ok(delete_rows(layout, [source(2)], () => 0)),
            (layout: RowLayout) => ok(insert_rows(layout, source(2), 'after', ['p1'])),
        ]) {
            const result = restructure(xml, {
                bodyRows: 5,
                columns: 1,
                rowLayout,
                insertedRows: { p1: { cellStyleIndexes: [null] } },
            });
            expect(result.text).toContain('<conditionalFormatting sqref="A1:A1048576">');
        }
    });

    it('shifts <autoFilter>, renumbering and dropping filter columns', () => {
        const xml = grid('<autoFilter ref="B1:E6"><filterColumn colId="1"><filters><filter val="1"/></filters></filterColumn>'
            + '<filterColumn colId="3"><filters><filter val="2"/></filters></filterColumn>'
            + '<sortState ref="B2:E6"><sortCondition ref="C2:C6"/><sortCondition descending="1" ref="E2:E6"/></sortState></autoFilter>');
        const result = restructure(xml, {
            bodyRows: 5,
            columns: 6,
            columnLayout: (layout) => ok(delete_columns(layout, [source_column(0), source_column(2)], () => 0)),
        });
        expect(result.text).toContain('<autoFilter ref="A1:C6"><filterColumn colId="2"><filters><filter val="2"/></filters></filterColumn>'
            + '<sortState ref="A2:C6"><sortCondition descending="1" ref="C2:C6"/></sortState></autoFilter>');
    });

    it('refuses a move that carries a filtered column outside the filter range', () => {
        const xml = grid('<autoFilter ref="A1:C6"><filterColumn colId="1"><filters><filter val="1"/></filters></filterColumn></autoFilter>');
        // Moving a corner carries the range with it, so B to the end is fine
        // for A1:B6; here C stays the last corner and B leaves the range.
        expect(() => restructure(xml, {
            bodyRows: 5,
            columns: 4,
            columnLayout: (layout) => ok(move_columns(layout, [source_column(1)], 'end')),
        })).toThrow(expect.objectContaining({ code: 'filtered-column-outside-range' }));
    });

    it('drops a worksheet sortState whose range is removed and shifts one that survives', () => {
        const xml = grid('<sortState ref="A3:A4"><sortCondition ref="A3:A4"/></sortState>');
        const removed = restructure(xml, {
            bodyRows: 5,
            columns: 1,
            rowLayout: (layout) => ok(delete_rows(layout, [source(2), source(3)], () => 0)),
        });
        expect(removed.text).not.toContain('sortState');
        const shrunk = restructure(xml, {
            bodyRows: 5,
            columns: 1,
            rowLayout: (layout) => ok(delete_rows(layout, [source(1), source(2)], () => 0)),
        });
        expect(shrunk.text).toContain('<sortState ref="A2"><sortCondition ref="A2"/></sortState>');
    });

    it('shifts sheet views, clamps a frozen pane, and resets removed targets', () => {
        const xml = grid('', '<sheetViews><sheetView workbookViewId="0" topLeftCell="A3">'
            + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
            + '<selection pane="bottomLeft" activeCell="A3" activeCellId="1" sqref="A5:A6 A3"/></sheetView></sheetViews>');
        const result = restructure(xml, {
            bodyRows: 5,
            columns: 1,
            rowLayout: (layout) => ok(delete_rows(layout, [source(1), source(2)], () => 0)),
        });
        expect(result.text).toContain('<sheetView workbookViewId="0" topLeftCell="A2">'
            + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
            + '<selection pane="bottomLeft" activeCell="A2" sqref="A3:A4"/></sheetView>');
    });

    it('shifts page breaks and ignored errors, dropping entries on removed rows', () => {
        const xml = grid('<rowBreaks count="2" manualBreakCount="2"><brk id="2" max="16383" man="1"/><brk id="4" max="16383" man="1"/></rowBreaks>'
            + '<colBreaks count="1" manualBreakCount="1"><brk id="1" max="1048575" man="1"/></colBreaks>'
            + '<ignoredErrors><ignoredError sqref="A3" numberStoredAsText="1"/><ignoredError sqref="A5:A6" formula="1"/></ignoredErrors>');
        const result = restructure(xml, {
            bodyRows: 5,
            columns: 2,
            rowLayout: (layout) => ok(delete_rows(layout, [source(2)], () => 0)),
            columnLayout: (layout) => ok(insert_columns(layout, source_column(0), 'before', ['pc'])),
            insertedColumns: { pc: { kind: 'default' } },
        });
        expect(result.text).toContain('<rowBreaks count="1" manualBreakCount="1"><brk id="3" max="16383" man="1"/></rowBreaks>');
        expect(result.text).toContain('<colBreaks count="1" manualBreakCount="1"><brk id="2" max="1048575" man="1"/></colBreaks>');
        expect(result.text).toContain('<ignoredErrors><ignoredError sqref="B4:B5" formula="1"/></ignoredErrors>');
    });
});

describe('restructure_worksheet: refusals', () => {
    const body = '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row></sheetData>';
    const delete_first = { bodyRows: 1, columns: 1, rowLayout: (layout: RowLayout) => ok(delete_rows(layout, [source(1)], () => 0)) };

    it.each([
        ['an Excel table', `${body}<tableParts count="1"><tablePart r:id="rId1"/></tableParts>`, 'unsupported-worksheet-content'],
        ['an extension list', `${body}<extLst><ext uri="{x}"/></extLst>`, 'unsupported-worksheet-content'],
        ['protected ranges', `${body}<protectedRanges><protectedRange name="p" sqref="A1"/></protectedRanges>`, 'unsupported-worksheet-content'],
        ['a row without a number', '<sheetData><row><c r="A1"><v>1</v></c></row></sheetData>', 'missing-row-reference'],
        ['an invalid row number', '<sheetData><row r="0"/></sheetData>', 'invalid-row-reference'],
        ['an array formula', '<sheetData><row r="2"><c r="A2"><f t="array" ref="A2">1</f></c></row></sheetData>', 'grouped-formula'],
        ['an unreadable merge', `${body}<mergeCells count="1"><mergeCell ref="A1:"/></mergeCells>`, 'invalid-structure-reference'],
    ])('refuses %s', (_label, inner, code) => {
        expect(() => restructure(worksheet(inner), delete_first))
            .toThrow(expect.objectContaining({ code }));
    });

    it('refuses what the cell writer refuses', () => {
        const missing = worksheet('<sheetData><row r="1"><c><v>1</v></c></row></sheetData>');
        expect(() => restructure(missing, delete_first)).toThrow(OoxmlRefusalError);
    });

    it('refuses a layout that would push rows past the last row of the sheet', () => {
        expect(() => restructure(worksheet('<sheetData/>'), {
            bodyStart: 0,
            bodyRows: 1_048_576,
            columns: 1,
            rowLayout: (layout) => ok(insert_rows(layout, source(0), 'before', ['p1'])),
            insertedRows: { p1: { cellStyleIndexes: [null] } },
        })).toThrow(expect.objectContaining({ code: 'content-past-sheet-end' }));
    });
});

describe('worksheet_coordinate_map', () => {
    it('maps fixed, body, and trailing coordinates and every new row and column', () => {
        const row_layout = ok(move_rows(ok(insert_rows(ok(delete_rows(
            source_row_layout(2, 4), [source(3)], () => 0)), source(4), 'before', ['p1'])), [source(2)], 'end'));
        const column_layout = ok(insert_columns(source_column_layout(2), source_column(1), 'after', ['pc']));
        const map = worksheet_coordinate_map({ bodyStart: 2, rowLayout: row_layout, columnLayout: column_layout }, 2);
        // Fixed rows 0-1. The insert lands after row 3's tombstone, which then
        // moves with row 2: full order p1, 4, 5, 2, (3); then the band.
        expect([0, 1, 2, 3, 4, 5].map((row) => map.row(row))).toEqual([0, 1, 5, null, 3, 4]);
        expect(map.inserted_row('p1')).toBe(2);
        expect(map.appended_row(0)).toBe(6);
        expect(map.appended_row(2)).toBeUndefined();
        expect(map.rowCount).toBe(8);
        // A row past the body shifts by the body's change in size (none here).
        expect(map.row(9)).toBe(9);
        expect([0, 1, 2, 5].map((column) => map.column(column))).toEqual([0, 1, 3, 6]);
        expect(map.inserted_column('pc')).toBe(2);
        expect(map.columnCount).toBe(3);
    });
});
