import { describe, it, expect } from 'vitest';
import CFB from 'cfb';
import { parse_xlsx } from '../parse-xlsx';
import {
    assert_safe_file_size,
    assert_safe_sheet_shape,
    create_workbook_budget,
    MAX_WORKBOOK_FILE_BYTES,
    MAX_SHEET_COLUMNS,
    MAX_SHEET_MERGES,
    MAX_SHEET_ROWS,
    MAX_WORKBOOK_SHEETS,
    assert_safe_sheet_count,
} from '../spreadsheet-safety';

/** Build a minimal .xlsx (ZIP) with one sheet containing a single cell at the given row. */
function build_minimal_xlsx(row: number): Uint8Array {
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
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="__proto__" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

    const wb_rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

    const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A${row}"/>
  <sheetData>
    <row r="${row}"><c r="A${row}" t="inlineStr"><is><t>hostile</t></is></c></row>
  </sheetData>
</worksheet>`;

    CFB.utils.cfb_add(cfb_file, '/[Content_Types].xml', Buffer.from(content_types));
    CFB.utils.cfb_add(cfb_file, '/_rels/.rels', Buffer.from(rels));
    CFB.utils.cfb_add(cfb_file, '/xl/workbook.xml', Buffer.from(workbook));
    CFB.utils.cfb_add(cfb_file, '/xl/_rels/workbook.xml.rels', Buffer.from(wb_rels));
    CFB.utils.cfb_add(cfb_file, '/xl/worksheets/sheet1.xml', Buffer.from(sheet));

    const out = CFB.write(cfb_file, { type: 'buffer', fileType: 'zip' });
    return new Uint8Array(out as ArrayBuffer);
}

describe('spreadsheet safety limits', () => {
    it('rejects oversized files before parsing', () => {
        expect(() =>
            assert_safe_file_size(MAX_WORKBOOK_FILE_BYTES + 1)
        ).toThrow('File is too large to open safely');
    });

    it('rejects excessive sheet counts', () => {
        expect(() =>
            assert_safe_sheet_count(MAX_WORKBOOK_SHEETS + 1)
        ).toThrow('Workbook has too many sheets to open safely');
    });

    it('rejects excessive row counts', () => {
        expect(() =>
            assert_safe_sheet_shape(
                create_workbook_budget(),
                MAX_SHEET_ROWS + 1,
                1,
                0
            )
        ).toThrow('Worksheet has too many rows to open safely');
    });

    it('rejects excessive column counts', () => {
        expect(() =>
            assert_safe_sheet_shape(
                create_workbook_budget(),
                1,
                MAX_SHEET_COLUMNS + 1,
                0
            )
        ).toThrow('Worksheet has too many columns to open safely');
    });

    it('rejects excessive merge counts', () => {
        expect(() =>
            assert_safe_sheet_shape(
                create_workbook_budget(),
                1,
                1,
                MAX_SHEET_MERGES + 1
            )
        ).toThrow('Worksheet has too many merged ranges to open safely');
    });

    it('rejects excessive total cell counts across a workbook', () => {
        const budget = create_workbook_budget();
        assert_safe_sheet_shape(budget, 1000, 250, 0);
        expect(() =>
            assert_safe_sheet_shape(budget, 1, 1, 0)
        ).toThrow('Workbook is too large to render safely');
    });

    it('assert_safe_file_size accepts a custom limit', () => {
        // 1 MiB custom limit
        expect(() =>
            assert_safe_file_size(2 * 1024 * 1024, 1)
        ).toThrow('File is too large to open safely');

        // Should not throw at 0.5 MiB with 1 MiB limit
        expect(() =>
            assert_safe_file_size(0.5 * 1024 * 1024, 1)
        ).not.toThrow();
    });

    it('assert_safe_file_size uses default when no custom limit given', () => {
        expect(() =>
            assert_safe_file_size(MAX_WORKBOOK_FILE_BYTES + 1)
        ).toThrow('File is too large to open safely');
    });
});

describe('parse_xlsx safety', () => {
    it('rejects workbooks whose row count exceeds the safe limit', async () => {
        const buffer = build_minimal_xlsx(MAX_SHEET_ROWS + 1);

        await expect(
            parse_xlsx(buffer)
        ).rejects.toThrow('Worksheet has too many rows to open safely');
    });
});
