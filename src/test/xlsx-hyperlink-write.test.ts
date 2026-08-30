import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import CFB from 'cfb';
import { apply_hyperlink_edits, scan_worksheet_hyperlinks } from '../xlsx-hyperlink-write';
import { parse_relationships } from '../ooxml-relationships';
import { write_xlsx_workbook_cell_edits } from '../xlsx-package';
import { parse_xlsx } from '../parse-xlsx';
import type { CellData } from '../types';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const OFFICE_R_NS_FOR_TEST = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HYPERLINK_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const STRICT_SPREADSHEET_NS = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const STRICT_OFFICE_R_NS = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const STRICT_PACKAGE_R_NS = 'http://purl.oclc.org/ooxml/package/relationships';
const STRICT_HYPERLINK_TYPE = `${STRICT_OFFICE_R_NS}/hyperlink`;

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

    it('uses byte offsets when non-ASCII text precedes the worksheet splice', () => {
        const source = sheet('<metadata>café 東京</metadata><sheetData/>');
        const out = apply_hyperlink_edits(Buffer.from(source), null, [
            { row: 1, col: 1, link: internal('Sheet2!B5') },
        ]);
        const expected = source.replace(
            '<sheetData/>',
            '<sheetData/><hyperlinks><hyperlink ref="B2" location="Sheet2!B5"/></hyperlinks>',
        );

        expect(Buffer.from(out.sheet_xml).equals(Buffer.from(expected))).toBe(true);
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

    it('inserts after the last schema predecessor when no follower exists', () => {
        const xml = sheet(
            '<sheetData/><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>',
        );
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: internal('A2') },
        ]);
        expect(out.sheet_xml.indexOf('<hyperlinks>'))
            .toBeGreaterThan(out.sheet_xml.indexOf('</mergeCells>'));
    });

    it('reads and writes a consistently prefixed worksheet with a non-r relationship prefix', () => {
        const xml = '<?xml version="1.0"?>'
            + `<s:worksheet xmlns:s="${NS.slice(7, -1)}" xmlns:rel="${OFFICE_R_NS_FOR_TEST}">`
            + '<s:sheetData/><s:hyperlinks><s:hyperlink ref="A1" rel:id="rId1"/></s:hyperlinks>'
            + '</s:worksheet>';
        const rels_xml = rels(
            `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" Target="https://old.example" TargetMode="External"/>`,
        );
        const out = apply_hyperlink_edits(xml, rels_xml, [
            { row: 0, col: 0, link: external('https://new.example') },
        ]);
        expect(out.sheet_xml).toContain('<s:hyperlinks>');
        expect(out.sheet_xml).toMatch(/<s:hyperlink ref="A1" rel:id="rId\d+"\/>/);
        expect(scan_worksheet_hyperlinks(out.sheet_xml)).toHaveLength(1);
    });

    it('creates and retires Strict hyperlink relationships without changing dialect', () => {
        const xml = sheet(
            '<sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks>',
            `xmlns="${STRICT_SPREADSHEET_NS}" xmlns:r="${STRICT_OFFICE_R_NS}"`,
        );
        const strict_rels = `<?xml version="1.0"?><Relationships xmlns="${STRICT_PACKAGE_R_NS}">`
            + `<Relationship Id="rId1" Type="${STRICT_HYPERLINK_TYPE}" `
            + 'Target="https://old.example" TargetMode="External"/></Relationships>';
        const replaced = apply_hyperlink_edits(xml, strict_rels, [
            { row: 0, col: 0, link: external('https://new.example') },
        ]);
        const parsed = parse_relationships(replaced.rels_xml!);
        expect(parsed.has('rId1')).toBe(false);
        expect([...parsed.values()]).toEqual([{
            type: STRICT_HYPERLINK_TYPE,
            target: 'https://new.example',
            external: true,
        }]);

        const created = apply_hyperlink_edits(
            sheet('<sheetData/>', `xmlns="${STRICT_SPREADSHEET_NS}"`),
            null,
            [{ row: 0, col: 0, link: external('https://strict.example') }],
        );
        expect(created.rels_xml).toContain(`xmlns="${STRICT_PACKAGE_R_NS}"`);
        expect([...parse_relationships(created.rels_xml!).values()][0]?.type)
            .toBe(STRICT_HYPERLINK_TYPE);
        expect(created.sheet_xml).toContain(`xmlns:r="${STRICT_OFFICE_R_NS}"`);
    });

    it.each([
        `<p:Relationships xmlns:p="http://schemas.openxmlformats.org/package/2006/relationships">`
            + '<p:Relationship Id="rId1" Type="drawing" Target="drawing.xml"/>'
            + '</p:Relationships>',
        '<p:Relationships xmlns:p="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    ])('preserves prefixed relationship roots and children (%s)', (relationships) => {
        const out = apply_hyperlink_edits(sheet('<sheetData/>'), relationships, [
            { row: 0, col: 0, link: external('https://prefixed.example') },
        ]);
        expect(out.rels_xml).toMatch(/^<p:Relationships\b/);
        expect(out.rels_xml).toContain('<p:Relationship ');
        expect(out.rels_xml).toContain('</p:Relationships>');
        expect([...parse_relationships(out.rels_xml!).values()])
            .toContainEqual(expect.objectContaining({ target: 'https://prefixed.example' }));
    });

    it('preserves a section-local prefix and scans mixed legal child prefixes', () => {
        const xml = '<?xml version="1.0"?>'
            + `<s:worksheet xmlns:s="${NS.slice(7, -1)}">`
            + '<s:sheetData/>'
            + `<h:hyperlinks xmlns:h="${NS.slice(7, -1)}">`
            + '<h:hyperlink ref="A1" location="Old!A1"/>'
            + '<s:hyperlink ref="B1" location="Keep!B1"/>'
            + '</h:hyperlinks></s:worksheet>';
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: internal('New!A1') },
        ]);
        expect(out.sheet_xml).toContain(`<h:hyperlinks xmlns:h="${NS.slice(7, -1)}">`);
        expect(out.sheet_xml).toContain('<h:hyperlink ref="A1" location="New!A1"/>');
        expect(out.sheet_xml).toContain('<s:hyperlink ref="B1" location="Keep!B1"/>');
        expect(scan_worksheet_hyperlinks(out.sheet_xml).map((link) => link.ref))
            .toEqual(['B1', 'A1']);
    });

    it('repeats a child-local relationship prefix on an appended sibling', () => {
        const namespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
        const relationships = `<Relationships xmlns="${namespace}">`
            + `<p:Relationship xmlns:p="${namespace}" Id="rId1" Type="drawing" `
            + 'Target="drawing.xml"/></Relationships>';
        const out = apply_hyperlink_edits(sheet('<sheetData/>'), relationships, [
            { row: 0, col: 0, link: external('https://child-prefix.example') },
        ]);
        expect(out.rels_xml).toContain(
            `<p:Relationship xmlns:p="${namespace}" Id="rId2"`,
        );
        expect([...parse_relationships(out.rels_xml!).values()])
            .toContainEqual(expect.objectContaining({ target: 'https://child-prefix.example' }));
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
        // The part exists: this save wrote the sheet that carries the link.
        expect(rels_entry?.content).toBeDefined();
        const txt = Buffer.from(rels_entry!.content as Uint8Array).toString('utf8');
        expect(parse_relationships(txt).size).toBe(0);
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

    it('reads single-quoted attributes, so their ids and refs are not invisible', () => {
        // A writer that only matches double quotes sees no ref (element dropped)
        // and no r:id (rel orphaned, and rId1 free to be handed out again).
        const xml = sheet(
            "<sheetData/><hyperlinks><hyperlink ref='A1' r:id='rId1'/><hyperlink ref='C3' r:id='rId2'/></hyperlinks>",
        );
        const rels_xml = rels(
            `<Relationship Id='rId1' Type="${HYPERLINK_TYPE}" Target="https://a.example" TargetMode="External"/>`
            + `<Relationship Id='rId2' Type="${HYPERLINK_TYPE}" Target="https://b.example" TargetMode="External"/>`,
        );
        const out = apply_hyperlink_edits(xml, rels_xml, [
            { row: 0, col: 0, link: external('https://new.example') },
        ]);
        // The untouched single-quoted element survives, and its rel with it.
        expect(out.sheet_xml).toContain("<hyperlink ref='C3' r:id='rId2'/>");
        const parsed = parse_relationships(out.rels_xml!);
        expect(parsed.get('rId2')?.target).toBe('https://b.example');
        // The replaced element's rel was retired, and the fresh id collides
        // with neither existing id.
        expect(parsed.has('rId1')).toBe(false);
        const fresh = /r:id="(rId\d+)"/.exec(out.sheet_xml)?.[1];
        expect(fresh).toBeDefined();
        expect(fresh).not.toBe('rId2');
        expect(parsed.get(fresh!)?.target).toBe('https://new.example');
    });

    it('re-emits a container-form element whole, close tag included', () => {
        const container = '<hyperlink ref="C3" r:id="rId2"><extLst><ext uri="x"/></extLst></hyperlink>';
        const xml = sheet(`<sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1"/>${container}</hyperlinks>`);
        const rels_xml = rels(
            `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" Target="https://a.example" TargetMode="External"/>`
            + `<Relationship Id="rId2" Type="${HYPERLINK_TYPE}" Target="https://b.example" TargetMode="External"/>`,
        );
        const out = apply_hyperlink_edits(xml, rels_xml, [{ row: 0, col: 0, link: null }]);
        expect(out.sheet_xml).toContain(container);
        // No truncated open tag left behind unclosed.
        expect(out.sheet_xml).not.toContain('<hyperlink ref="C3" r:id="rId2"/>');
    });

    it('carries a replaced element\'s display attribute across', () => {
        // `display` is the cell's visible text when the cell has no value of
        // its own; a link-only edit must not erase it.
        const xml = sheet(
            '<sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1" display="Click me"/></hyperlinks>',
        );
        const rels_xml = rels(
            `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" Target="https://old.example" TargetMode="External"/>`,
        );
        const out = apply_hyperlink_edits(xml, rels_xml, [
            { row: 0, col: 0, link: external('https://new.example') },
        ]);
        expect(out.sheet_xml).toContain('display="Click me"');
    });

    it('ignores markup that only appears inside comments and CDATA', () => {
        // A raw indexOf would splice the edit into ignored content: a save that
        // reports success while Excel sees nothing.
        const decoy = '<!-- <hyperlinks><hyperlink ref="A1" r:id="rId9"/></hyperlinks> -->';
        const xml = sheet(`<sheetData/>${decoy}`);
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: internal('B2') },
        ]);
        expect(out.sheet_xml).toContain(decoy);
        // The real section was appended, not merged into the comment.
        expect(out.sheet_xml).toContain('<hyperlinks><hyperlink ref="A1" location="B2"/></hyperlinks>');
        expect(out.sheet_xml.indexOf('<hyperlinks><hyperlink ref="A1" location="B2"/>'))
            .toBe(out.sheet_xml.indexOf('<sheetData/>') + '<sheetData/>'.length);
    });

    it('ignores a </sheetData> that only appears inside a CDATA section', () => {
        const decoy = '<f><![CDATA[</sheetData>]]></f>';
        const xml = sheet(`<sheetData><row r="1"><c r="A1">${decoy}</c></row></sheetData>`);
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: internal('B2') },
        ]);
        expect(out.sheet_xml).toContain(decoy);
        expect(out.sheet_xml.indexOf('<hyperlinks>'))
            .toBeGreaterThan(out.sheet_xml.indexOf(decoy) + decoy.length);
    });

    it('does not re-emit a commented-out element as live markup', () => {
        // Same rule as the reader: the comment is not an element the sheet
        // declares, so rebuilding the section must not resurrect it.
        const xml = sheet(
            '<sheetData/><hyperlinks><hyperlink ref="A1" location="B2"/>'
            + '<!-- <hyperlink ref="C3" location="Z9"/> --></hyperlinks>',
        );
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: internal('D4') },
        ]);
        expect(out.sheet_xml).toContain('<hyperlink ref="A1" location="D4"/>');
        expect(out.sheet_xml).not.toContain('ref="C3"');
    });

    it('scans a part dense with processing instructions in linear time', { timeout: 5000 }, () => {
        // A workbook is untrusted input, and the ignorable-range scan runs over
        // whole parts. Searching per opener kind made a part full of one kind
        // re-scan the whole remaining string for the absent kinds every
        // iteration — quadratic, so a modest file could pin the process. At
        // 40k instructions the quadratic form takes minutes; this takes ms.
        const noise = '<?x?>'.repeat(40_000);
        const xml = sheet(`<sheetData/>${noise}<hyperlinks><hyperlink ref="A1" location="B2"/></hyperlinks>`);
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: internal('D4') },
        ]);
        expect(out.sheet_xml).toContain('<hyperlink ref="A1" location="D4"/>');
    });

    it('scans a part with many candidates and many comments in linear time', () => {
        // The other half of the same hazard: each candidate position is tested
        // against the ignorable ranges, so walking the ranges made the work the
        // *product* of the two counts — and a workbook controls both. Ranges
        // are hoisted once and searched by bisection; 20k of each is
        // milliseconds here and minutes if either regresses.
        const noise = '<!-- <hyperlink ref="Z1" location="Ghost"/> -->'.repeat(20_000);
        const xml = sheet(`<sheetData/><hyperlinks>${noise}<hyperlink ref="A1" location="B2"/></hyperlinks>`);
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: internal('D4') },
        ]);
        expect(out.sheet_xml).toContain('<hyperlink ref="A1" location="D4"/>');
        expect(out.sheet_xml).not.toContain('<hyperlink ref="Z1"');
    });

    it('keeps ignored content nested inside an untouched live element', () => {
        // The rebuild re-emits untouched elements verbatim. Reading them from a
        // stripped copy would delete a vendor extension payload out of a link
        // this edit never named — silent corruption of someone else's data.
        const payload = '<extLst><ext uri="vendor"><vendor:d><![CDATA[keep me]]></vendor:d></ext></extLst>';
        const xml = sheet(
            '<sheetData/><hyperlinks><hyperlink ref="A1" location="B2"/>'
            + `<hyperlink ref="C3" location="D4">${payload}</hyperlink></hyperlinks>`,
        );
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 0, link: internal('Z9') },
        ]);
        expect(out.sheet_xml).toContain(payload);
    });

    it('writes into the live section, not a commented-out one before it', () => {
        // A section that is *wholly* commented out is not one the sheet
        // declares. The reader locates the live section the same way; if the
        // two disagreed here, a save would land in a section the next load
        // never reads, and the edit would look silently lost.
        const ghost = '<!-- <hyperlinks><hyperlink ref="A1" location="Ghost!A1"/></hyperlinks> -->';
        const xml = sheet(
            `<sheetData/>${ghost}<hyperlinks><hyperlink ref="B1" location="Live!B1"/></hyperlinks>`,
        );
        const out = apply_hyperlink_edits(xml, null, [
            { row: 0, col: 1, link: internal('Edited!B1') },
        ]);
        expect(out.sheet_xml).toContain(ghost);
        expect(out.sheet_xml).toContain('<hyperlink ref="B1" location="Edited!B1"/>');
        expect(out.sheet_xml).not.toContain('Live!B1');
        // One live section, not a second one appended past the comment.
        expect(out.sheet_xml.split('<hyperlinks>').length - 1).toBe(2);
    });

    it('never splices a Relationship that only exists inside a comment', () => {
        // The live rId1 is what the cleared element referenced; a scan that saw
        // the commented copy first would edit ignored text and leave the real
        // relationship pointing at a target we believe we retired.
        const xml = sheet('<sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks>');
        const rels_xml = rels(
            `<!-- <Relationship Id="rId1" Type="${HYPERLINK_TYPE}" Target="https://stale.example" TargetMode="External"/> -->`
            + `<Relationship Id="rId1" Type="${HYPERLINK_TYPE}" Target="https://live.example" TargetMode="External"/>`,
        );
        const out = apply_hyperlink_edits(xml, rels_xml, [{ row: 0, col: 0, link: null }]);
        const parsed = parse_relationships(out.rels_xml!);
        expect(parsed.has('rId1')).toBe(false);
        expect(out.rels_xml).not.toContain('live.example');
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
