import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import CFB from 'cfb';
import { apply_hyperlink_edits } from '../xlsx-hyperlink-write';
import { parse_relationships } from '../ooxml-relationships';
import { write_xlsx_workbook_cell_edits } from '../xlsx-package';
import { parse_xlsx } from '../parse-xlsx';
import type { CellData } from '../types';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HYPERLINK_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

function sheet(inner: string, ns = `${NS} ${R_NS}`): string {
    return `<?xml version="1.0"?><worksheet ${ns}>${inner}</worksheet>`;
}

const RELS_OPEN = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';

function rels(inner: string): string {
    return `<?xml version="1.0"?>${RELS_OPEN}${inner}</Relationships>`;
}

const external = (target: string, tooltip?: string) =>
    ({ kind: 'external' as const, target, ...(tooltip !== undefined ? { tooltip } : {}) });
const internal = (location: string, tooltip?: string) =>
    ({ kind: 'internal' as const, location, ...(tooltip !== undefined ? { tooltip } : {}) });

describe('apply_hyperlink_edits', () => {
    it('adds an external link: sheet element plus a fresh External relationship', () => {
        const xml = sheet('<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData>');
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: external('https://example.com/a') },
        ]);
        expect(out.sheet_xml).toContain('<hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks>');
        // Inserted after </sheetData>.
        expect(out.sheet_xml.indexOf('<hyperlinks>'))
            .toBeGreaterThan(out.sheet_xml.indexOf('</sheetData>'));
        // A null rels input with a non-null result is the creation signal.
        expect(out.rels_xml).not.toBeNull();
        const parsed = parse_relationships(out.rels_xml!);
        expect(parsed.get('rId1')).toEqual({
            type: HYPERLINK_TYPE,
            target: 'https://example.com/a',
            external: true,
        });
    });

    it('adds an internal link with no relationship at all', () => {
        const xml = sheet('<sheetData/>');
        const out = apply_hyperlink_edits(xml, null, [
            { row: 1, col: 1, link: internal('Sheet2!B5', 'jump') },
        ]);
        expect(out.sheet_xml).toContain('<hyperlink ref="B2" location="Sheet2!B5" tooltip="jump"/>');
        expect(out.rels_xml).toBeNull();
    });

    it('inserts the section before schema-later elements, not after them', () => {
        const xml = sheet('<sheetData/><pageMargins left="0.7"/>');
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: internal('A2') },
        ]);
        expect(out.sheet_xml.indexOf('<hyperlinks>'))
            .toBeLessThan(out.sheet_xml.indexOf('<pageMargins'));
    });

    it('replaces an existing external link, retiring its orphaned relationship', () => {
        const xml = sheet('<sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks>');
        const rels_xml = rels(
            `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" Target="https://old.example" TargetMode="External"/>`,
        );
        const out = apply_hyperlink_edits(xml, rels_xml, [
            { row: 0, col: 0, link: external('https://new.example') },
        ]);
        const parsed = parse_relationships(out.rels_xml!);
        expect([...parsed.values()].map((rel) => rel.target)).toEqual(['https://new.example']);
        expect(parsed.has('rId1')).toBe(false);
        // The new id avoided the (removed) old one is not required; it must
        // simply be the one the sheet references.
        const m = out.sheet_xml.match(/<hyperlink ref="A1" r:id="(rId\d+)"\/>/);
        expect(m).not.toBeNull();
        expect(parsed.has(m![1])).toBe(true);
    });

    it('clears a link and drops an empty section entirely', () => {
        const xml = sheet('<sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks><pageMargins left="0.7"/>');
        const rels_xml = rels(
            `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" Target="https://x.example" TargetMode="External"/>`,
        );
        const out = apply_hyperlink_edits(xml, rels_xml, [{ row: 0, col: 0, link: null }]);
        expect(out.sheet_xml).not.toContain('<hyperlinks');
        expect(out.sheet_xml).toContain('<pageMargins left="0.7"/>');
        expect(parse_relationships(out.rels_xml!).size).toBe(0);
    });

    it('keeps untouched hyperlink elements byte-for-byte and their rels alive', () => {
        const untouched = '<hyperlink ref="C3" r:id="rId2" tooltip="keep &amp; hold"/>';
        const xml = sheet(`<sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1"/>${untouched}</hyperlinks>`);
        const rels_xml = rels(
            `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" Target="https://a.example" TargetMode="External"/>`
            + `<Relationship Id="rId2" Type="${HYPERLINK_TYPE}" Target="https://b.example" TargetMode="External"/>`,
        );
        const out = apply_hyperlink_edits(xml, rels_xml, [{ row: 0, col: 0, link: null }]);
        expect(out.sheet_xml).toContain(untouched);
        const parsed = parse_relationships(out.rels_xml!);
        expect(parsed.has('rId2')).toBe(true);
        expect(parsed.has('rId1')).toBe(false);
    });

    it('never removes a non-hyperlink relationship, even when displaced', () => {
        // A malformed sheet pointing a hyperlink at a drawing rel: clearing the
        // link must not delete the drawing relationship.
        const drawing_type = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
        const xml = sheet('<sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks>');
        const rels_xml = rels(
            `<Relationship Id="rId1" Type="${drawing_type}" Target="../drawings/drawing1.xml"/>`,
        );
        const out = apply_hyperlink_edits(xml, rels_xml, [{ row: 0, col: 0, link: null }]);
        expect(out.rels_xml).toBeNull();
        expect(out.sheet_xml).not.toContain('<hyperlinks');
    });

    it('keeps a shared relationship while any surviving element references it', () => {
        const xml = sheet(
            '<sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1"/><hyperlink ref="B1" r:id="rId1"/></hyperlinks>',
        );
        const rels_xml = rels(
            `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" Target="https://shared.example" TargetMode="External"/>`,
        );
        const out = apply_hyperlink_edits(xml, rels_xml, [{ row: 0, col: 0, link: null }]);
        expect(out.sheet_xml).toContain('<hyperlink ref="B1" r:id="rId1"/>');
        expect(out.rels_xml).toBeNull();
    });

    it('allocates fresh rel ids that avoid every existing id of any type', () => {
        const xml = sheet('<sheetData/>');
        const rels_xml = rels(
            '<Relationship Id="rId1" Type="t" Target="a"/><Relationship Id="rId3" Type="t" Target="b"/>',
        );
        const out = apply_hyperlink_edits(xml, rels_xml, [
            { row: 0, col: 0, link: external('https://one.example') },
            { row: 0, col: 1, link: external('https://two.example') },
        ]);
        const ids = [...out.sheet_xml.matchAll(/r:id="(rId\d+)"/g)].map((m) => m[1]);
        expect(new Set(ids).size).toBe(2);
        expect(ids).not.toContain('rId1');
        expect(ids).not.toContain('rId3');
        const parsed = parse_relationships(out.rels_xml!);
        for (const id of ids) expect(parsed.get(id)?.external).toBe(true);
    });

    it('adds xmlns:r to a worksheet that lacks it, only when an external link needs it', () => {
        const bare = sheet('<sheetData/>', NS);
        const with_external = apply_hyperlink_edits(bare, null, [
            { row: 0, col: 0, link: external('https://x.example') },
        ]);
        expect(with_external.sheet_xml)
            .toContain('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
        const with_internal = apply_hyperlink_edits(bare, null, [
            { row: 0, col: 0, link: internal('A2') },
        ]);
        expect(with_internal.sheet_xml).not.toContain('xmlns:r=');
    });

    it('escapes attribute values in targets, locations, and tooltips', () => {
        const xml = sheet('<sheetData/>');
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: external('https://x.example/?a=1&b="q"', 'see & hear') },
            { row: 1, col: 0, link: internal("Sheet'1'!A1<>", 'multi\nline') },
        ]);
        expect(out.rels_xml).toContain('Target="https://x.example/?a=1&amp;b=&quot;q&quot;"');
        expect(out.sheet_xml).toContain('tooltip="see &amp; hear"');
        expect(out.sheet_xml).toContain('location="Sheet&#39;1&#39;!A1&lt;&gt;"'.replace(/&#39;/g, "'"));
        expect(out.sheet_xml).toContain('tooltip="multi&#10;line"');
    });

    it('resolves duplicate coordinates last-edit-wins, like apply_cell_edits', () => {
        const xml = sheet('<sheetData/>');
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: external('https://first.example') },
            { row: 0, col: 0, link: internal('A2') },
        ]);
        expect(out.sheet_xml).toContain('<hyperlink ref="A1" location="A2"/>');
        expect(out.sheet_xml).not.toContain('r:id');
        expect(out.rels_xml).toBeNull();
    });

    it('clearing a cell that has no link is a no-op on both parts', () => {
        const xml = sheet('<sheetData/>');
        const out = apply_hyperlink_edits(xml, null, [{ row: 4, col: 4, link: null }]);
        expect(out.sheet_xml).toBe(xml);
        expect(out.rels_xml).toBeNull();
    });

    it('rejects invalid coordinates', () => {
        const xml = sheet('<sheetData/>');
        for (const bad of [
            { row: -1, col: 0, link: null },
            { row: 0, col: 2.5, link: null },
            { row: Number.NaN, col: 0, link: null },
        ]) {
            expect(() => apply_hyperlink_edits(xml, null, [bad])).toThrow();
        }
    });

    it('appends to a self-closing Relationships root', () => {
        const xml = sheet('<sheetData/>');
        const self_closing = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
        const out = apply_hyperlink_edits(xml, self_closing, [
            { row: 0, col: 0, link: external('https://x.example') },
        ]);
        const parsed = parse_relationships(out.rels_xml!);
        expect(parsed.size).toBe(1);
    });

    it('round-trips through the package writer and our own parser', async () => {
        // formatted.xlsx ships no worksheet .rels, so this covers rels
        // creation, sheet splice, and read-back in one pass.
        const raw = new Uint8Array(readFileSync('src/test/fixtures/formatted.xlsx'));
        const written = write_xlsx_workbook_cell_edits(raw, [{
            sheetIndex: 0,
            edits: [],
            link_edits: [
                { row: 0, col: 0, link: external('https://example.com/x', 'tip') },
                { row: 1, col: 0, link: internal('Sheet1!B2') },
            ],
        }]);
        expect(written).not.toBe(raw);
        const { data } = await parse_xlsx(written);
        const rows = data.sheets[0].rows;
        expect((rows[0][0] as CellData).hyperlink).toEqual({
            kind: 'external', target: 'https://example.com/x', tooltip: 'tip',
        });
        expect((rows[1][0] as CellData).hyperlink).toEqual({
            kind: 'internal', location: 'Sheet1!B2',
        });
        // Untouched parts are byte-identical.
        const before = CFB.read(raw, { type: 'buffer' });
        const after = CFB.read(written, { type: 'buffer' });
        for (const path of ['/xl/styles.xml', '/xl/workbook.xml', '/xl/theme/theme1.xml']) {
            expect(Buffer.from(CFB.find(after, path)!.content as Uint8Array))
                .toEqual(Buffer.from(CFB.find(before, path)!.content as Uint8Array));
        }
    });

    it('a link-only save is no longer a no-op, and clearing round-trips too', async () => {
        const raw = new Uint8Array(readFileSync('src/test/fixtures/formatted.xlsx'));
        const linked = write_xlsx_workbook_cell_edits(raw, [{
            sheetIndex: 0,
            edits: [],
            link_edits: [{ row: 0, col: 0, link: external('https://example.com/') }],
        }]);
        const cleared = write_xlsx_workbook_cell_edits(linked, [{
            sheetIndex: 0,
            edits: [],
            link_edits: [{ row: 0, col: 0, link: null }],
        }]);
        const { data } = await parse_xlsx(cleared);
        expect((data.sheets[0].rows[0][0] as CellData).hyperlink).toBeUndefined();
        // The now-orphaned hyperlink relationship is gone from the created rels.
        const rels_entry = CFB.find(
            CFB.read(cleared, { type: 'buffer' }),
            '/xl/worksheets/_rels/sheet1.xml.rels',
        );
        if (rels_entry?.content) {
            const txt = Buffer.from(rels_entry.content as Uint8Array).toString('utf8');
            expect(parse_relationships(txt).size).toBe(0);
        }
    });

    it('value edits and link edits on the same sheet compose in one save', async () => {
        const raw = new Uint8Array(readFileSync('src/test/fixtures/formatted.xlsx'));
        const written = write_xlsx_workbook_cell_edits(raw, [{
            sheetIndex: 0,
            edits: [{ row: 0, col: 0, value: 'renamed' }],
            link_edits: [{ row: 0, col: 0, link: external('https://example.com/renamed') }],
        }]);
        const { data } = await parse_xlsx(written);
        const cell = data.sheets[0].rows[0][0] as CellData;
        expect(cell.raw).toBe('renamed');
        expect(cell.hyperlink).toEqual({ kind: 'external', target: 'https://example.com/renamed' });
    });

    it('preserves everything outside the spliced ranges verbatim', () => {
        const before = '<sheetPr filterMode="1"/><dimension ref="A1:C3"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="B2:C3"/></mergeCells>';
        const after = '<pageMargins left="0.7" right="0.7"/><extLst><ext uri="x"/></extLst>';
        const xml = sheet(`${before}${after}`);
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: internal('B2') },
        ]);
        expect(out.sheet_xml).toContain(before);
        expect(out.sheet_xml).toContain(after);
        expect(out.sheet_xml.indexOf('<hyperlinks>')).toBeGreaterThan(out.sheet_xml.indexOf('</mergeCells>'));
        expect(out.sheet_xml.indexOf('<hyperlinks>')).toBeLessThan(out.sheet_xml.indexOf('<pageMargins'));
    });
});
