import CFB from 'cfb';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse_xlsx, parse_xlsx_streaming } from '../parse-xlsx';
import { ColumnarStore } from '../data-source/columnar-store';
import { build_store_old_way } from './helpers/build-store-old-way';

const load = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

const FIXTURES = ['basic.xlsx', 'merged.xlsx', 'styled.xlsx', 'formatted.xlsx', 'empty-sheet.xlsx'];

function with_sheet_xml(xml: string): Uint8Array {
    const file = CFB.read(load('basic.xlsx'), { type: 'buffer' });
    const entry = CFB.find(file, '/xl/worksheets/sheet1.xml')!;
    const content = Buffer.from(xml, 'utf8');
    entry.content = content;
    entry.size = content.length;
    const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
    return written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBufferLike);
}

async function expect_streaming_parity(buf: Uint8Array) {
    const legacy = await parse_xlsx(buf);
    const streaming = await parse_xlsx_streaming(buf);

    expect(streaming.sheets.length).toBe(legacy.data.sheets.length);
    expect(streaming.hasFormatting).toBe(legacy.data.hasFormatting);
    expect(streaming.warnings).toEqual(legacy.warnings);

    for (let si = 0; si < legacy.data.sheets.length; si++) {
        const ls = legacy.data.sheets[si];
        const ss = streaming.sheets[si];

        expect(ss.name).toBe(ls.name);
        expect(ss.rowCount).toBe(ls.rowCount);
        expect(ss.columnCount).toBe(ls.columnCount);
        expect(ss.merges).toEqual(ls.merges);

        const oldStore = build_store_old_way(ls.rows, ls.rowCount, ls.columnCount);

        const newBuilder = new ColumnarStore.Builder(ss.rowCount, ss.columnCount);
        ss.fill(newBuilder);
        const newStore = newBuilder.build();

        // The whole-sheet read_window must be deeply equal — covers merged
        // cells (null), blank cells, bold/italic flags, and numeric/string raw.
        const oldWin = oldStore.read_window(0, ls.rowCount);
        const newWin = newStore.read_window(0, ss.rowCount);
        expect(newWin).toEqual(oldWin);
    }

    return legacy;
}

describe('xlsx streaming parity (Task A7)', () => {
    for (const name of FIXTURES) {
        it(`produces byte-identical ColumnarStore output for ${name}`, async () => {
            await expect_streaming_parity(load(name));
        });
    }

    it('agrees on markup-hostile worksheet cells', async () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:G1"/>
  <!-- <sheetData><row r="96"><c r="W96"><v>96</v></c></row></sheetData> -->
  <sheetData>
    <!-- <row r="99"><c r="Z99"><v>99</v></c></row> -->
    <![CDATA[<row r="98"><c r="Y98"><v>98</v></c></row>]]>
    <?ghost <row r="97"><c r="X97"><v>97</v></c></row>?>
    <row r="200">
      <c r='A1'><v>1</v></c>
      <c r="A&#49;"><v>2</v ></c >
      <c r='B1'/>
      <c r="C1" t="inlineStr"><is><t>first</t></is></c>
      <c r="D1"><!-- <v>44</v> --><v>4</v ></c>
      <c r="E1"><![CDATA[<v>55</v>]]><v>5</v></c>
      <c r="F1"><?ghost <v>66</v>?><v>6</v></c>
      <c r="G1" t="inlineStr">
        <!-- <is><t>comment ghost</t></is> -->
        <![CDATA[<is><t>CDATA ghost</t></is>]]>
        <?ghost <is><t>PI ghost</t></is>?>
        <is><t>live</t></is >
      </c >
    </row >
    <row r="1"><c r="C1" t="inlineStr"><is><t>last</t></is></c></row>
  </sheetData >
</worksheet>`;

        const parsed = await expect_streaming_parity(with_sheet_xml(xml));
        const sheet = parsed.data.sheets[0];

        // `<c r>` alone chooses the coordinate. Ghost markup is absent, and the
        // last live cell for a duplicate coordinate wins.
        expect(sheet.rowCount).toBe(1);
        expect(sheet.columnCount).toBe(7);
        expect(sheet.rows[0].map((cell) => cell?.raw ?? null)).toEqual([
            2,
            null,
            'last',
            4,
            5,
            6,
            'live',
        ]);
    });
});
