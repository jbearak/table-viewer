import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import CFB from 'cfb';
import { parse_xlsx } from '../parse-xlsx';

const FIXTURES = path.join(__dirname, 'fixtures');

function read_fixture(name: string): Uint8Array {
    return fs.readFileSync(path.join(FIXTURES, name));
}

function build_test_xlsx(sheet_xml: string, styles_xml?: string): Uint8Array {
    const cfb_file = CFB.utils.cfb_new();
    const styles_override = styles_xml
        ? '\n  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        : '';

    const content_types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${styles_override}
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

    const out = CFB.write(cfb_file, { type: 'buffer', fileType: 'zip' });
    return new Uint8Array(out as ArrayBuffer);
}

describe('parse_xlsx', () => {
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
</worksheet>`, styles);

            const { data } = await parse_xlsx(buffer);
            const cell = data.sheets[0].rows[0][0];
            expect(cell?.raw).toBe(1000000000000);
        });
    });
});
