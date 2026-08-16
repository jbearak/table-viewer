import { describe, it, expect } from 'vitest';
import CFB from 'cfb';
import { parse_xlsx, parse_xlsx_streaming } from '../parse-xlsx';
import {
    parse_font_properties,
    parse_xlsx_string_item,
    font_to_style,
    resolve_rich_text_runs,
    type ParsedRichString,
} from '../xlsx-rich-text';
import { parse_relationships, rels_path_for_part } from '../ooxml-relationships';
import { ColumnarStore } from '../data-source/columnar-store';
import type { CellData } from '../types';

// --- Unit: run-property parsing ---

describe('parse_font_properties', () => {
    it('parses the four supported properties', () => {
        expect(parse_font_properties('<b/><i/><u/><strike/>')).toEqual({
            bold: true, italic: true, underline: true, strikethrough: true,
        });
    });

    it('returns undefined for a plain rPr', () => {
        expect(parse_font_properties('<sz val="11"/><color theme="1"/>')).toBeUndefined();
    });

    it('honors explicit-false values', () => {
        expect(parse_font_properties('<b val="0"/><i val="false"/>')).toBeUndefined();
    });

    it('treats u val="none" as off and other u values as on', () => {
        expect(parse_font_properties('<u val="none"/>')).toBeUndefined();
        expect(parse_font_properties('<u val="double"/>')).toEqual({ underline: true });
        expect(parse_font_properties('<u val="singleAccounting"/>')).toEqual({ underline: true });
    });
});

// --- Unit: string-item parsing ---

describe('parse_xlsx_string_item', () => {
    it('parses a plain <t> string to a bare string', () => {
        expect(parse_xlsx_string_item('<t>hello &amp; bye</t>')).toBe('hello & bye');
    });

    it('parses rich runs: absent style inherits, explicit empty rPr is null', () => {
        const parsed = parse_xlsx_string_item(
            '<r><t>plain </t></r><r><rPr><b/></rPr><t>bold</t></r><r><rPr><sz val="11"/></rPr><t>reset</t></r>'
        ) as ParsedRichString;
        expect(parsed.text).toBe('plain boldreset');
        expect(parsed.runs).toEqual([
            { text: 'plain ' },
            { text: 'bold', style: { bold: true } },
            { text: 'reset', style: null },
        ]);
    });

    it('detects <r> runs whose tag name is followed by tab or newline', () => {
        const parsed = parse_xlsx_string_item('<r\n><t>a</t></r><r><t>b</t></r>') as ParsedRichString;
        expect(parsed.text).toBe('ab');
        expect(parsed.runs).toHaveLength(2);
    });

    it('skips <rPh> phonetic runs', () => {
        const parsed = parse_xlsx_string_item(
            '<r><t>漢字</t></r><rPh sb="0" eb="2"><t>かんじ</t></rPh>'
        ) as ParsedRichString;
        expect(parsed.text).toBe('漢字');
        expect(parsed.runs).toHaveLength(1);
    });
});

// --- Unit: cell-font binding ---

describe('resolve_rich_text_runs', () => {
    const parsed = parse_xlsx_string_item(
        '<r><t>plain </t></r><r><rPr><b/></rPr><t>bold</t></r>'
    ) as ParsedRichString;

    it('binds inheriting runs to the cell font', () => {
        const rich = resolve_rich_text_runs(parsed, font_to_style({ bold: false, italic: true }));
        expect(rich?.runs).toEqual([
            { text: 'plain ', style: { italic: true } },
            { text: 'bold', style: { bold: true } },
        ]);
    });

    it('returns undefined when every run equals the cell style', () => {
        const all_bold = parse_xlsx_string_item('<r><rPr><b/></rPr><t>x</t></r>') as ParsedRichString;
        expect(resolve_rich_text_runs(all_bold, { bold: true })).toBeUndefined();
        const all_inherit = parse_xlsx_string_item('<r><t>a</t></r><r><t>b</t></r>') as ParsedRichString;
        expect(resolve_rich_text_runs(all_inherit, { bold: true })).toBeUndefined();
    });

    it('a present rPr REPLACES the cell font rather than merging', () => {
        // Bold cell font; the run's rPr says only italic — the run is italic, NOT bold+italic.
        const one_run = parse_xlsx_string_item('<r><rPr><i/></rPr><t>x</t></r>') as ParsedRichString;
        const rich = resolve_rich_text_runs(one_run, { bold: true });
        expect(rich?.runs).toEqual([{ text: 'x', style: { italic: true } }]);
        // Explicit plain rPr on a bold cell: the run resets to plain.
        const reset = parse_xlsx_string_item('<r><t>a</t></r><r><rPr><sz val="1"/></rPr><t>b</t></r>') as ParsedRichString;
        expect(resolve_rich_text_runs(reset, { bold: true })?.runs).toEqual([
            { text: 'a', style: { bold: true } },
            { text: 'b' },
        ]);
    });
});

// --- Unit: relationships ---

describe('ooxml-relationships', () => {
    it('parses relationships and TargetMode', () => {
        const rels = parse_relationships(`<Relationships>
            <Relationship Id="rId1" Type="t/hyperlink" Target="https://example.com" TargetMode="External"/>
            <Relationship Id="rId2" Type="t/image" Target="../media/image1.png"/>
        </Relationships>`);
        expect(rels.get('rId1')).toEqual({
            type: 't/hyperlink', target: 'https://example.com', external: true,
        });
        expect(rels.get('rId2')?.external).toBe(false);
    });

    it('maps a part path to its .rels path', () => {
        expect(rels_path_for_part('xl/worksheets/sheet1.xml'))
            .toBe('xl/worksheets/_rels/sheet1.xml.rels');
    });
});

// --- Integration: full-package parsing ---

interface FixtureOpts {
    sheet_xml: string;
    styles_xml?: string;
    sst_xml?: string;
    sheet_rels_xml?: string;
}

function build_xlsx(opts: FixtureOpts): Uint8Array {
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
    CFB.utils.cfb_add(cfb_file, '/xl/worksheets/sheet1.xml', Buffer.from(opts.sheet_xml));
    if (opts.styles_xml) CFB.utils.cfb_add(cfb_file, '/xl/styles.xml', Buffer.from(opts.styles_xml));
    if (opts.sst_xml) CFB.utils.cfb_add(cfb_file, '/xl/sharedStrings.xml', Buffer.from(opts.sst_xml));
    if (opts.sheet_rels_xml) {
        CFB.utils.cfb_add(cfb_file, '/xl/worksheets/_rels/sheet1.xml.rels', Buffer.from(opts.sheet_rels_xml));
    }
    return new Uint8Array(CFB.write(cfb_file, { type: 'buffer', fileType: 'zip' }) as ArrayBuffer);
}

function worksheet(inner: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${inner}
</worksheet>`;
}

const UNDERLINE_STRIKE_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><u/><sz val="11"/><name val="Calibri"/></font>
    <font><strike/><sz val="11"/><name val="Calibri"/></font>
    <font><b/><u val="none"/><strike val="0"/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0"/>
    <xf numFmtId="0" fontId="1" applyFont="1"/>
    <xf numFmtId="0" fontId="2" applyFont="1"/>
    <xf numFmtId="0" fontId="3" applyFont="1"/>
  </cellXfs>
</styleSheet>`;

describe('parse_xlsx rich text and hyperlinks', () => {
    it('reads whole-cell underline and strikethrough from styles.xml', async () => {
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" s="1" t="inlineStr"><is><t>under</t></is></c>
            <c r="B1" s="2" t="inlineStr"><is><t>struck</t></is></c>
            <c r="C1" s="3" t="inlineStr"><is><t>bold only</t></is></c>
        </row></sheetData>`);
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet, styles_xml: UNDERLINE_STRIKE_STYLES }));
        const [a, b, c] = data.sheets[0].rows[0] as CellData[];
        expect(a.underline).toBe(true);
        expect(a.strikethrough).toBeUndefined();
        expect(b.strikethrough).toBe(true);
        expect(c.bold).toBe(true);
        expect(c.underline).toBeUndefined();
        expect(c.strikethrough).toBeUndefined();
        expect(data.hasFormatting).toBe(true);
    });

    it('parses rich runs from shared strings, bound per referencing cell', async () => {
        const sst = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">
  <si><r><t xml:space="preserve">plain </t></r><r><rPr><b/></rPr><t>bold</t></r></si>
</sst>`;
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="B1" s="1" t="s"><v>0</v></c>
        </row></sheetData>`);
        const { data } = await parse_xlsx(build_xlsx({
            sheet_xml: sheet, sst_xml: sst, styles_xml: UNDERLINE_STRIKE_STYLES,
        }));
        const [a, b] = data.sheets[0].rows[0] as CellData[];
        expect(a.raw).toBe('plain bold');
        expect(a.richText?.runs).toEqual([
            { text: 'plain ' },
            { text: 'bold', style: { bold: true } },
        ]);
        // B1's cell font is underline: the inheriting run picks that up.
        expect(b.richText?.runs).toEqual([
            { text: 'plain ', style: { underline: true } },
            { text: 'bold', style: { bold: true } },
        ]);
    });

    it('caches resolution: two same-style cells share one RichText object', async () => {
        const sst = `<sst><si><r><t>a</t></r><r><rPr><i/></rPr><t>b</t></r></si></sst>`;
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>0</v></c>
        </row></sheetData>`);
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet, sst_xml: sst }));
        const [a, b] = data.sheets[0].rows[0] as CellData[];
        expect(a.richText).toBeDefined();
        expect(a.richText).toBe(b.richText);
    });

    it('omits richText when runs add nothing beyond whole-cell flags', async () => {
        const sst = `<sst><si><r><rPr><b/></rPr><t>all</t></r><r><rPr><b/></rPr><t> bold</t></r></si></sst>`;
        const styles = `<styleSheet>
  <fonts count="2"><font/><font><b/></font></fonts>
  <cellXfs count="2"><xf numFmtId="0" fontId="0"/><xf numFmtId="0" fontId="1"/></cellXfs>
</styleSheet>`;
        const sheet = worksheet(`<sheetData><row r="1"><c r="A1" s="1" t="s"><v>0</v></c></row></sheetData>`);
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet, sst_xml: sst, styles_xml: styles }));
        const a = data.sheets[0].rows[0][0] as CellData;
        expect(a.raw).toBe('all bold');
        expect(a.bold).toBe(true);
        expect(a.richText).toBeUndefined();
    });

    it('parses rich runs in inline strings', async () => {
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="inlineStr"><is><r><t>x</t></r><r><rPr><u/><strike/></rPr><t>y</t></r></is></c>
        </row></sheetData>`);
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet }));
        const a = data.sheets[0].rows[0][0] as CellData;
        expect(a.raw).toBe('xy');
        expect(a.richText?.runs).toEqual([
            { text: 'x' },
            { text: 'y', style: { underline: true, strikethrough: true } },
        ]);
        expect(data.hasFormatting).toBe(true);
    });

    it('attaches external hyperlinks resolved through the sheet rels', async () => {
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="inlineStr"><is><t>site</t></is></c>
        </row></sheetData>
        <hyperlinks><hyperlink ref="A1" r:id="rId1" tooltip="Example"/></hyperlinks>`);
        const sheet_rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>
</Relationships>`;
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet, sheet_rels_xml: sheet_rels }));
        const a = data.sheets[0].rows[0][0] as CellData;
        expect(a.hyperlink).toEqual({
            kind: 'external', target: 'https://example.com/', tooltip: 'Example',
        });
        // A hyperlink alone must not flip workbook formatting on.
        expect(data.hasFormatting).toBe(false);
    });

    it('ignores a hyperlink that only exists inside a comment', async () => {
        // A commented-out element is not a link the sheet declares. Attaching
        // it would show the user a link Excel does not — and hand the writer a
        // live element to rebuild the section from.
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="inlineStr"><is><t>go</t></is></c>
        </row></sheetData>
        <hyperlinks><!-- <hyperlink ref="A1" location="Sheet9!Z9"/> --></hyperlinks>`);
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet }));
        expect((data.sheets[0].rows[0][0] as CellData).hyperlink).toBeUndefined();
    });

    it('ignores a whole hyperlinks section that is commented out', async () => {
        // Extracting the inner text first and filtering afterwards cannot catch
        // this: the comment delimiters are outside the substring. The writer
        // locates the live section the same way, so a reader that read the
        // ghost would show a link that no save could ever change.
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="inlineStr"><is><t>go</t></is></c>
            <c r="B1" t="inlineStr"><is><t>real</t></is></c>
        </row></sheetData>
        <!-- <hyperlinks><hyperlink ref="A1" location="Ghost!A1"/></hyperlinks> -->
        <hyperlinks><hyperlink ref="B1" location="Live!B1"/></hyperlinks>`);
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet }));
        expect((data.sheets[0].rows[0][0] as CellData).hyperlink).toBeUndefined();
        expect((data.sheets[0].rows[0][1] as CellData).hyperlink)
            .toEqual({ kind: 'internal', location: 'Live!B1' });
    });

    it('attaches internal location hyperlinks without any rel', async () => {
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="inlineStr"><is><t>go</t></is></c>
        </row></sheetData>
        <hyperlinks><hyperlink ref="A1" location="Sheet2!B5"/></hyperlinks>`);
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet }));
        const a = data.sheets[0].rows[0][0] as CellData;
        expect(a.hyperlink).toEqual({ kind: 'internal', location: 'Sheet2!B5' });
    });

    it('synthesizes a blank cell for a hyperlink with no cell entry', async () => {
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="inlineStr"><is><t>x</t></is></c>
        </row></sheetData>
        <hyperlinks><hyperlink ref="C1" location="Sheet1!A1"/></hyperlinks>`);
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet }));
        expect(data.sheets[0].columnCount).toBe(3);
        const c = data.sheets[0].rows[0][2] as CellData;
        expect(c.raw).toBeNull();
        expect(c.hyperlink).toEqual({ kind: 'internal', location: 'Sheet1!A1' });
    });

    it('uses the display attribute as text for a link-only cell', async () => {
        const sheet = worksheet(`<sheetData/>
        <hyperlinks><hyperlink ref="B2" location="Sheet2!A1" display="Go there"/></hyperlinks>`);
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet }));
        const b2 = data.sheets[0].rows[1][1] as CellData;
        expect(b2.raw).toBe('Go there');
        expect(b2.formatted).toBe('Go there');
        expect(b2.hyperlink).toEqual({ kind: 'internal', location: 'Sheet2!A1' });
    });

    it('ignores an r:id pointing at a non-hyperlink relationship', async () => {
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="inlineStr"><is><t>x</t></is></c>
        </row></sheetData>
        <hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks>`);
        const sheet_rels = `<Relationships>
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://evil.example/x.png" TargetMode="External"/>
</Relationships>`;
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet, sheet_rels_xml: sheet_rels }));
        expect((data.sheets[0].rows[0][0] as CellData).hyperlink).toBeUndefined();
    });

    it('skips range refs, dangling rels, and internal-part rels', async () => {
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="inlineStr"><is><t>a</t></is></c>
            <c r="B1" t="inlineStr"><is><t>b</t></is></c>
        </row></sheetData>
        <hyperlinks>
            <hyperlink ref="A1:B1" location="Sheet1!A1"/>
            <hyperlink ref="A1" r:id="rIdMissing"/>
            <hyperlink ref="B1" r:id="rId9"/>
        </hyperlinks>`);
        const sheet_rels = `<Relationships>
  <Relationship Id="rId9" Type="t/hyperlink" Target="../media/doc.pdf"/>
</Relationships>`;
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet, sheet_rels_xml: sheet_rels }));
        const [a, b] = data.sheets[0].rows[0] as CellData[];
        expect(a.hyperlink).toBeUndefined();
        expect(b.hyperlink).toBeUndefined();
    });

    it('appends the location fragment to an external target', async () => {
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="inlineStr"><is><t>x</t></is></c>
        </row></sheetData>
        <hyperlinks><hyperlink ref="A1" r:id="rId1" location="section2"/></hyperlinks>`);
        const sheet_rels = `<Relationships>
  <Relationship Id="rId1" Type="t/hyperlink" Target="https://example.com/page" TargetMode="External"/>
</Relationships>`;
        const { data } = await parse_xlsx(build_xlsx({ sheet_xml: sheet, sheet_rels_xml: sheet_rels }));
        const a = data.sheets[0].rows[0][0] as CellData;
        expect(a.hyperlink).toEqual({ kind: 'external', target: 'https://example.com/page#section2' });
    });

    it('streaming parse carries richText and hyperlink into the store', async () => {
        const sst = `<sst><si><r><t>a</t></r><r><rPr><b/></rPr><t>b</t></r></si></sst>`;
        const sheet = worksheet(`<sheetData><row r="1">
            <c r="A1" t="s"><v>0</v></c>
        </row></sheetData>
        <hyperlinks><hyperlink ref="A1" location="Sheet1!Z9"/></hyperlinks>`);
        const streaming = await parse_xlsx_streaming(build_xlsx({ sheet_xml: sheet, sst_xml: sst }));
        const meta = streaming.sheets[0];
        const builder = new ColumnarStore.Builder(meta.rowCount, meta.columnCount);
        meta.fill(builder);
        const store = builder.build();
        const cell = store.read_window(0, 1)[0][0];
        expect(cell?.richText?.runs).toEqual([
            { text: 'a' },
            { text: 'b', style: { bold: true } },
        ]);
        expect(cell?.hyperlink).toEqual({ kind: 'internal', location: 'Sheet1!Z9' });
        expect(cell?.raw).toBe('ab');
    });
});
