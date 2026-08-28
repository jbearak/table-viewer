import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import CFB from 'cfb';
import {
    parse_finite_number_utf8,
    parse_workbook_xml,
    parse_xlsx,
    parse_xlsx_streaming,
} from '../parse-xlsx';
import { ColumnarStore } from '../data-source/columnar-store';
import { XlsxDataSource } from '../data-source/xlsx-source';
import { ExcelHeaderDataSource } from '../data-source/excel-header-source';

const FIXTURES = path.join(__dirname, 'fixtures');

function read_fixture(name: string): Uint8Array {
    return fs.readFileSync(path.join(FIXTURES, name));
}

function build_test_xlsx(sheet_xml: string, opts?: { styles_xml?: string; sst_xml?: string }): Uint8Array {
    const cfb_file = CFB.utils.cfb_new();
    const styles_xml = opts?.styles_xml;
    const sst_xml = opts?.sst_xml;

    const styles_override = styles_xml
        ? '\n  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        : '';
    const sst_override = sst_xml
        ? '\n  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
        : '';

    const content_types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${styles_override}${sst_override}
</Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

    const workbook_rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

    CFB.utils.cfb_add(cfb_file, '/[Content_Types].xml', Buffer.from(content_types));
    CFB.utils.cfb_add(cfb_file, '/_rels/.rels', Buffer.from(rels));
    CFB.utils.cfb_add(cfb_file, '/xl/workbook.xml', Buffer.from(workbook));
    CFB.utils.cfb_add(cfb_file, '/xl/_rels/workbook.xml.rels', Buffer.from(workbook_rels));
    CFB.utils.cfb_add(cfb_file, '/xl/worksheets/sheet1.xml', Buffer.from(sheet_xml));
    if (styles_xml) {
        CFB.utils.cfb_add(cfb_file, '/xl/styles.xml', Buffer.from(styles_xml));
    }
    if (sst_xml) {
        CFB.utils.cfb_add(cfb_file, '/xl/sharedStrings.xml', Buffer.from(sst_xml));
    }

    const out = CFB.write(cfb_file, { type: 'buffer', fileType: 'zip' });
    return new Uint8Array(out as ArrayBuffer);
}

describe('parse_xlsx', () => {
    it('rejects an overlong source formula before dependency parsing', async () => {
        const formula = "'".repeat(8_193);
        const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetData><row r="1"><c r="A1"><f>${formula}</f><v>0</v></c></row></sheetData>
</worksheet>`;

        await expect(parse_xlsx(build_test_xlsx(sheet)))
            .rejects.toThrow('Formula exceeds Excel\'s maximum length');
    });

    it('rejects entity-heavy source formula markup before decoding it', async () => {
        const formula = '&amp;'.repeat(14_000);
        const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetData><row r="1"><c r="A1"><f>${formula}</f><v>0</v></c></row></sheetData>
</worksheet>`;

        await expect(parse_xlsx(build_test_xlsx(sheet)))
            .rejects.toThrow('Formula XML encoding exceeds the safe length limit');
    });

    it('exposes the effective formula for a shared-formula follower', async () => {
        const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="E2:I5"/>
  <sheetData>
    <row r="2">
      <c r="I2"><f t="shared" ref="I2:I5" si="0">E2*F2</f><v>2</v></c>
    </row>
    <row r="5">
      <c r="I5"><f t="shared" si="0"/><v>58.5</v></c>
    </row>
  </sheetData>
</worksheet>`;
        const bytes = build_test_xlsx(sheet);
        const { data } = await parse_xlsx(bytes);

        expect(data.sheets[0].rows[1][8]).toMatchObject({
            raw: 2,
            formula: '=E2*F2',
        });
        expect(data.sheets[0].rows[4][8]).toMatchObject({
            raw: 58.5,
            formula: '=E5*F5',
        });

        const streaming = await parse_xlsx_streaming(bytes);
        const builder = new ColumnarStore.Builder(
            streaming.sheets[0].rowCount,
            streaming.sheets[0].columnCount,
        );
        streaming.sheets[0].fill(builder);
        expect(builder.build().read_window(4, 1)[0][8]).toMatchObject({
            raw: '58.5',
            formula: '=E5*F5',
        });
    });

    it('translates whole-axis references for shared-formula followers', async () => {
        const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="B1:C1"/>
  <sheetData><row r="1">
    <c r="B1"><f t="shared" ref="B1:C1" si="0">SUM(A:A)+SUM(1:1)</f><v>1</v></c>
    <c r="C1"><f t="shared" si="0"/><v>2</v></c>
  </row></sheetData>
</worksheet>`;
        const { data } = await parse_xlsx(build_test_xlsx(sheet));

        expect(data.sheets[0].rows[0][2]?.formula).toBe('=SUM(B:B)+SUM(1:1)');
    });

    it('marks a formula with no cached value as an unknown result', async () => {
        const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetData><row r="1"><c r="A1"><f>1+1</f></c></row></sheetData>
</worksheet>`;
        const bytes = build_test_xlsx(sheet);
        const { data } = await parse_xlsx(bytes);

        expect(data.sheets[0].rows[0][0]).toMatchObject({
            raw: '=1+1',
            formatted: '??',
            formula: '=1+1',
            formulaResultPending: true,
        });
        expect(data.sheets[0].pendingFormulaCells).toEqual([0, 0]);
        expect(data.sheets[0].formulaCells).toEqual([0, 0]);

        const streaming = await parse_xlsx_streaming(bytes);
        expect(streaming.sheets[0].pendingFormulaCells).toEqual([0, 0]);
        expect(streaming.sheets[0].formulaCells).toEqual([0, 0]);
        const builder = new ColumnarStore.Builder(1, 1);
        streaming.sheets[0].fill(builder);
        expect(builder.build().read_window(0, 1)[0][0]).toMatchObject({
            raw: '=1+1',
            formatted: '??',
            formula: '=1+1',
            formulaResultPending: true,
        });
        const source = await XlsxDataSource.create(bytes);
        expect(source.meta().sheets[0].pendingFormulaCells).toEqual([0, 0]);
        expect(source.meta().sheets[0].formulaCells).toEqual([0, 0]);
        expect(new ExcelHeaderDataSource(source).meta().sheets[0].pendingFormulaCells)
            .toEqual([0, 0]);
        expect(new ExcelHeaderDataSource(source).meta().sheets[0].formulaCells)
            .toEqual([0, 0]);
    });

    it('does not fabricate false for a boolean formula with no cached value', async () => {
        const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetData><row r="1"><c r="A1" t="b"><f>B1=1</f></c></row></sheetData>
</worksheet>`;
        const { data } = await parse_xlsx(build_test_xlsx(sheet));

        expect(data.sheets[0].rows[0][0]).toMatchObject({
            raw: '=B1=1',
            formatted: '??',
            formulaResultPending: true,
        });
        expect(data.sheets[0].pendingFormulaCells).toEqual([0, 0]);
    });

    it('records formula references for dependency invalidation before rows load', async () => {
        const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:C2"/>
  <sheetData>
    <row r="1">
      <c r="A1"><v>2</v></c>
      <c r="B1"><f>A1*2</f><v>4</v></c>
      <c r="C1"><f>SUM(A1:B2)</f><v>9</v></c>
    </row>
  </sheetData>
</worksheet>`;
        const bytes = build_test_xlsx(sheet);
        const { data } = await parse_xlsx(bytes);
        const streaming = await parse_xlsx_streaming(bytes);
        const source = await XlsxDataSource.create(bytes);
        const projected = new ExcelHeaderDataSource(source);

        const expected = [
            0, 1, 0, 0, 0, 0, 0,
            0, 2, 0, 0, 0, 1, 1,
        ];
        expect(data.sheets[0].formulaDependencies).toEqual(expected);
        expect(streaming.sheets[0].formulaDependencies).toEqual(expected);
        expect(source.meta().sheets[0].formulaDependencies).toEqual(expected);
        expect(projected.meta().sheets[0].formulaDependencies).toEqual(expected);
    });

    it('records what-if data-table inputs as dependencies of the table master', async () => {
        const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:D1"/>
  <sheetData><row r="1">
    <c r="A1"><f t="dataTable" ref="A1:B2" r1="$D$1"/><v>1</v></c>
    <c r="D1"><v>5</v></c>
  </row></sheetData>
</worksheet>`;
        const bytes = build_test_xlsx(sheet);
        const { data } = await parse_xlsx(bytes);
        const streaming = await parse_xlsx_streaming(bytes);

        const expected = [0, 0, 0, 0, 3, 0, 3];
        expect(data.sheets[0].formulaDependencies).toEqual(expected);
        expect(streaming.sheets[0].formulaDependencies).toEqual(expected);
        expect(data.sheets[0].formulaCells).toEqual([0, 0]);
        expect(streaming.sheets[0].formulaCells).toEqual([0, 0]);
    });

    it('exposes the OOXML sheetId as worksheet identity', async () => {
        const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData>
</worksheet>`;
        const bytes = build_test_xlsx(sheet);
        const { data } = await parse_xlsx(bytes);
        const streaming = await parse_xlsx_streaming(bytes);

        expect(data.sheets[0].worksheetId).toBe('1');
        expect(streaming.sheets[0].worksheetId).toBe('1');
    });

    it('drops colliding OOXML sheet IDs so names remain distinct identities', () => {
        const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="First" sheetId="1" r:id="rId1"/>
    <sheet name="Second" sheetId="1" r:id="rId2"/>
    <sheet name="Third" sheetId="3" r:id="rId3"/>
  </sheets>
</workbook>`;

        expect(parse_workbook_xml(workbook).sheets).toEqual([
            { name: 'First', rId: 'rId1' },
            { name: 'Second', rId: 'rId2' },
            { name: 'Third', rId: 'rId3', worksheetId: '3' },
        ]);
    });

    describe('bold formatting from Excel-style XML', () => {
        it('detects bold cells using shared strings with s attribute', async () => {
            // Mimics real Excel output: cells reference shared strings AND have style index
            const styles = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  mc:Ignorable="x14ac"
  xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">
  <fonts count="3" x14ac:knownFonts="1">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
    <font><b/><i/><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
  </fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
</styleSheet>`;

            const sst = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>Normal</t></si>
  <si><t>Bold</t></si>
  <si><t>BoldItalic</t></si>
</sst>`;

            const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:C1"/>
  <sheetData>
    <row r="1" spans="1:3">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" s="1" t="s"><v>1</v></c>
      <c r="C1" s="2" t="s"><v>2</v></c>
    </row>
  </sheetData>
</worksheet>`;

            const buffer = build_test_xlsx(sheet, { styles_xml: styles, sst_xml: sst });
            const { data } = await parse_xlsx(buffer);
            const row = data.sheets[0].rows[0];

            // Normal cell
            expect(row[0]?.bold).toBe(false);
            expect(row[0]?.italic).toBe(false);
            expect(row[0]?.raw).toBe('Normal');

            // Bold cell
            expect(row[1]?.bold).toBe(true);
            expect(row[1]?.italic).toBe(false);
            expect(row[1]?.raw).toBe('Bold');

            // Bold+Italic cell
            expect(row[2]?.bold).toBe(true);
            expect(row[2]?.italic).toBe(true);
            expect(row[2]?.raw).toBe('BoldItalic');
        });

        it('includes bold/italic in workbook hasFormatting flag', async () => {
            // A workbook where cells ONLY have bold formatting (no number formatting)
            // should still report hasFormatting=true so the formatting toggle appears
            const styles = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/></font>
    <font><b/><sz val="11"/></font>
  </fonts>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0"/>
    <xf numFmtId="0" fontId="1"/>
  </cellXfs>
</styleSheet>`;

            const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A1"/>
  <sheetData>
    <row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Bold text</t></is></c></row>
  </sheetData>
</worksheet>`;

            const buffer = build_test_xlsx(sheet, { styles_xml: styles });
            const { data } = await parse_xlsx(buffer);

            expect(data.sheets[0].rows[0][0]?.bold).toBe(true);
            expect(data.hasFormatting).toBe(true);
        });
    });

    describe('basic.xlsx', () => {
        it('parses two sheets with correct names', async () => {
            const { data, warnings } = await parse_xlsx(read_fixture('basic.xlsx'));
            expect(data.sheets).toHaveLength(2);
            expect(data.sheets[0].name).toBe('People');
            expect(data.sheets[1].name).toBe('Inventory');
            expect(warnings).toHaveLength(0);
        });

        it('parses string, number, and boolean cell values', async () => {
            const { data } = await parse_xlsx(read_fixture('basic.xlsx'));
            const people = data.sheets[0];

            // Header row
            expect(people.rows[0][0]?.raw).toBe('Name');
            expect(people.rows[0][1]?.raw).toBe('Age');
            // Data row
            expect(people.rows[1][0]?.raw).toBe('Alice');
            expect(people.rows[1][1]?.raw).toBe(30);
            expect(people.rows[1][2]?.raw).toBe(true);
        });

        it('parses date values as ISO strings', async () => {
            const { data } = await parse_xlsx(read_fixture('basic.xlsx'));
            const people = data.sheets[0];
            // Dates should be ISO strings
            const joined = people.rows[1][3]?.raw;
            expect(typeof joined).toBe('string');
            expect(String(joined)).toContain('2024-01-15');
            expect(people.rows[1][3]?.rawType).toBe('date');
            expect(people.rows[1][3]?.numericRaw).toBe(45_306);
        });

        it('retains formula error typing', async () => {
            const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A1"/>
  <sheetData><row r="1"><c r="A1" t="e"><v>#DIV/0!</v></c></row></sheetData>
</worksheet>`;
            const { data } = await parse_xlsx(build_test_xlsx(sheet));

            expect(data.sheets[0].rows[0][0]).toMatchObject({
                raw: '#DIV/0!',
                rawType: 'error',
            });
        });

        it('preserves native OOXML date typing', async () => {
            const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A1"/>
  <sheetData><row r="1"><c r="A1" t="d"><v>2024-03-01T00:00:00Z</v></c></row></sheetData>
</worksheet>`;
            const { data } = await parse_xlsx(build_test_xlsx(sheet));

            expect(data.sheets[0].rows[0][0]).toMatchObject({
                raw: '2024-03-01T00:00:00Z',
                rawType: 'date',
                xlsxIsoDate: true,
                numericRaw: 45_352,
            });
        });

        it('returns correct row and column counts', async () => {
            const { data } = await parse_xlsx(read_fixture('basic.xlsx'));
            const people = data.sheets[0];
            expect(people.rowCount).toBe(3);
            expect(people.columnCount).toBe(4);
        });

        it('parses the second sheet correctly', async () => {
            const { data } = await parse_xlsx(read_fixture('basic.xlsx'));
            const inv = data.sheets[1];
            expect(inv.rows[0][0]?.raw).toBe('Product');
            expect(inv.rows[1][0]?.raw).toBe('Widget');
            expect(inv.rows[1][1]?.raw).toBe(9.99);
            expect(inv.rows[1][2]?.raw).toBe(100);
        });
    });

    describe('merged.xlsx', () => {
        it('detects merge ranges', async () => {
            const { data } = await parse_xlsx(read_fixture('merged.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.merges).toHaveLength(2);
            expect(sheet.merges).toContainEqual({
                startRow: 0, startCol: 0, endRow: 0, endCol: 2,
            });
            expect(sheet.merges).toContainEqual({
                startRow: 2, startCol: 0, endRow: 3, endCol: 0,
            });
        });

        it('returns null for non-anchor merged cells', async () => {
            const { data } = await parse_xlsx(read_fixture('merged.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][0]?.raw).toBe('Merged Header');
            expect(sheet.rows[0][1]).toBeNull();
            expect(sheet.rows[0][2]).toBeNull();
        });

        it('returns correct data in non-merged cells', async () => {
            const { data } = await parse_xlsx(read_fixture('merged.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[1][0]?.raw).toBe('A');
            expect(sheet.rows[1][1]?.raw).toBe('B');
            expect(sheet.rows[1][2]?.raw).toBe('C');
            expect(sheet.rows[2][0]?.raw).toBe('Tall');
            expect(sheet.rows[2][1]?.raw).toBe('D');
            expect(sheet.rows[2][2]?.raw).toBe('E');
        });

        it('returns null for vertically merged non-anchor cell', async () => {
            const { data } = await parse_xlsx(read_fixture('merged.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[3][0]).toBeNull();
            expect(sheet.rows[3][1]?.raw).toBe('F');
            expect(sheet.rows[3][2]?.raw).toBe('G');
        });
    });

    describe('styled.xlsx', () => {
        it('detects bold cells', async () => {
            const { data } = await parse_xlsx(read_fixture('styled.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][1]?.bold).toBe(true);
            expect(sheet.rows[1][1]?.bold).toBe(true);
            expect(sheet.rows[0][0]?.bold).toBe(false);
        });

        it('detects italic cells', async () => {
            const { data } = await parse_xlsx(read_fixture('styled.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][2]?.italic).toBe(true);
            expect(sheet.rows[1][2]?.italic).toBe(true);
        });

        it('detects bold+italic cells', async () => {
            const { data } = await parse_xlsx(read_fixture('styled.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][3]?.bold).toBe(true);
            expect(sheet.rows[0][3]?.italic).toBe(true);
        });

        it('marks normal cells as not bold and not italic', async () => {
            const { data } = await parse_xlsx(read_fixture('styled.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][0]?.bold).toBe(false);
            expect(sheet.rows[0][0]?.italic).toBe(false);
        });
    });

    describe('empty-sheet.xlsx', () => {
        it('handles empty sheets', async () => {
            const { data } = await parse_xlsx(read_fixture('empty-sheet.xlsx'));
            expect(data.sheets).toHaveLength(2);
            const empty = data.sheets.find(s => s.name === 'EmptySheet');
            expect(empty).toBeDefined();
            expect(empty!.rowCount).toBe(0);
            expect(empty!.columnCount).toBe(0);
        });

        it('parses filled sheet alongside empty sheet', async () => {
            const { data } = await parse_xlsx(read_fixture('empty-sheet.xlsx'));
            const filled = data.sheets.find(s => s.name === 'FilledSheet');
            expect(filled).toBeDefined();
            expect(filled!.rows[0][0]?.raw).toBe('Hello');
        });
    });

    describe('formatted.xlsx', () => {
        it('preserves raw numeric values', async () => {
            const { data } = await parse_xlsx(read_fixture('formatted.xlsx'));
            const sheet = data.sheets[0];
            expect(sheet.rows[0][0]?.raw).toBe(1234.56);
            expect(sheet.rows[0][1]?.raw).toBe(0.75);
        });

        it('parses the ordinary fixture numbers without decoding fallbacks', () => {
            const diagnostics = { fallback_count: 0 };
            for (const text of ['1234.56', '0.75']) {
                expect(parse_finite_number_utf8(Buffer.from(text), diagnostics)).toBe(Number(text));
            }
            expect(diagnostics.fallback_count).toBe(0);
        });

        it('preserves Number fallback spellings outside the byte fast path', () => {
            const diagnostics = { fallback_count: 0 };
            expect(parse_finite_number_utf8(Buffer.from('0x10'), diagnostics)).toBe(16);
            expect(parse_finite_number_utf8(Buffer.from('Infinity'), diagnostics)).toBeNull();
            expect(parse_finite_number_utf8(Buffer.from(' 42 '), diagnostics)).toBe(42);
            expect(parse_finite_number_utf8(Buffer.from('1.2e-30'), diagnostics)).toBe(1.2e-30);
            expect(diagnostics.fallback_count).toBe(4);
        });

        it('applies number formatting via SSF', async () => {
            const { data } = await parse_xlsx(read_fixture('formatted.xlsx'));
            const sheet = data.sheets[0];
            // Currency format
            const currency = sheet.rows[0][0]?.formatted;
            expect(currency).toContain('1,234.56');
            // Percentage format
            const pct = sheet.rows[0][1]?.formatted;
            expect(pct).toContain('75');
            expect(pct).toContain('%');
        });

        it('keeps numeric raw values when a conditional format selects a numeric section', async () => {
            const styles = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="[&gt;50000]yyyy-mm-dd;0"/></numFmts>
  <fonts count="1"><font/></fonts>
  <cellXfs count="1"><xf numFmtId="164" fontId="0"/></cellXfs>
</styleSheet>`;
            const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetData><row r="1"><c r="A1" s="0"><v>12</v></c></row></sheetData>
</worksheet>`;

            const { data } = await parse_xlsx(build_test_xlsx(sheet, { styles_xml: styles }));
            expect(data.sheets[0].rows[0][0]).toMatchObject({
                raw: 12,
                rawType: undefined,
                formatted: '12',
                numberFormat: { code: '[>50000]yyyy-mm-dd;0' },
            });
        });

        it('uses SSF precedence when only the second section is conditional', async () => {
            const styles = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="0;[&gt;40000]yyyy-mm-dd"/></numFmts>
  <fonts count="1"><font/></fonts>
  <cellXfs count="1"><xf numFmtId="164" fontId="0"/></cellXfs>
</styleSheet>`;
            const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetData><row r="1"><c r="A1" s="0"><v>45306</v></c></row></sheetData>
</worksheet>`;

            const { data } = await parse_xlsx(build_test_xlsx(sheet, { styles_xml: styles }));
            expect(data.sheets[0].rows[0][0]).toMatchObject({
                raw: '2024-01-15T00:00:00.000Z',
                rawType: 'date',
                numericRaw: 45_306,
                formatted: '2024-01-15',
            });
        });

        it('retains resolved recipes on physical cells in dense and streaming parses', async () => {
            const styles = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
  <fonts count="1"><font/></fonts>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0"/>
    <xf numFmtId="164" fontId="0"/>
    <xf numFmtId="10" fontId="0"/>
  </cellXfs>
</styleSheet>`;
            const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:D1"/>
  <sheetData><row r="1">
    <c r="A1" s="1"><v>1234.5</v></c>
    <c r="B1" s="2"><v>0.75</v></c>
    <c r="C1" s="1"/>
  </row></sheetData>
</worksheet>`;
            const bytes = build_test_xlsx(sheet, { styles_xml: styles });
            const { data } = await parse_xlsx(bytes);
            const dense = data.sheets[0].rows[0];
            expect(dense[0]?.numberFormat).toEqual({ code: '#,##0.00' });
            expect(dense[1]?.numberFormat).toEqual({ code: '0.00%' });
            expect(dense[2]).toMatchObject({
                raw: null,
                numberFormat: { code: '#,##0.00' },
            });
            expect(dense[3]?.numberFormat).toBeUndefined();

            const streaming = await parse_xlsx_streaming(bytes);
            const builder = new ColumnarStore.Builder(
                streaming.sheets[0].rowCount,
                streaming.sheets[0].columnCount,
            );
            streaming.sheets[0].fill(builder);
            const streamed = builder.build().read_window(0, 1)[0];
            expect(streamed[0]?.numberFormat).toEqual({ code: '#,##0.00' });
            expect(streamed[1]?.numberFormat).toEqual({ code: '0.00%' });
            expect(streamed[2]?.numberFormat).toEqual({ code: '#,##0.00' });
            expect(streamed[3]?.numberFormat).toBeUndefined();
        });
    });

    describe('defensive parsing', () => {
        it('skips invalid cell refs instead of writing to A1', async () => {
            const buffer = build_test_xlsx(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="B2"/>
  <sheetData>
    <row r="2">
      <c r="not-a-ref" t="inlineStr"><is><t>poison</t></is></c>
      <c r="B2" t="inlineStr"><is><t>ok</t></is></c>
    </row>
  </sheetData>
</worksheet>`);

            const { data } = await parse_xlsx(buffer);
            const sheet = data.sheets[0];
            expect(sheet.rows[0][0]?.raw).toBeNull();
            expect(sheet.rows[1][1]?.raw).toBe('ok');
        });

        it('rejects permissive numeric strings like 1oops', async () => {
            const buffer = build_test_xlsx(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetData>
    <row r="1"><c r="A1"><v>1oops</v></c></row>
  </sheetData>
</worksheet>`);

            const { data } = await parse_xlsx(buffer);
            const cell = data.sheets[0].rows[0][0];
            expect(cell?.raw).toBeNull();
            expect(cell?.formatted).toBe('');
        });

        it('keeps out-of-range date serials as numbers without throwing', async () => {
            const styles = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font/></fonts>
  <cellXfs count="1"><xf numFmtId="14" fontId="0"/></cellXfs>
</styleSheet>`;
            const buffer = build_test_xlsx(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetData>
    <row r="1"><c r="A1" s="0"><v>1000000000000</v></c></row>
  </sheetData>
</worksheet>`, { styles_xml: styles });

            const { data } = await parse_xlsx(buffer);
            const cell = data.sheets[0].rows[0][0];
            expect(cell?.raw).toBe(1000000000000);
        });
    });
});
