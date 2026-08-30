import { describe, expect, it } from 'vitest';
import * as ooxml_surgery from '../ooxml-surgery';
import type {
    CellHyperlink,
    CellTextStyle,
    RichTextRun,
    WorksheetEditRequest,
    WorksheetEditResult,
    XlsxCellEdit,
    XlsxHyperlinkEdit,
    XlsxWriteOptions,
} from '../ooxml-surgery';

describe('OOXML surgery public API', () => {
    it('exposes only the extraction-ready runtime surface', () => {
        expect(Object.keys(ooxml_surgery).sort()).toEqual([
            'OOXML_CONFORMANCE_VERSION',
            'OOXML_SURGERY_API_VERSION',
            'OoxmlRefusalError',
            'apply_worksheet_edits',
        ]);
        expect(ooxml_surgery.OOXML_SURGERY_API_VERSION).toBe(1);
        expect(ooxml_surgery.OOXML_CONFORMANCE_VERSION).toBe('1.1.0');
    });

    it('edits worksheet bytes without package or scanner internals', () => {
        const options: XlsxWriteOptions = {
            datemode: 0,
            is_date_style: () => false,
        };
        const edits: readonly XlsxCellEdit[] = [{ row: 0, col: 0, value: '2' }];
        const request: WorksheetEditRequest = {
            worksheet_xml: Buffer.from(
                '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
            ),
            relationships_xml: null,
            cell_edits: edits,
            write_options: options,
        };
        const result: WorksheetEditResult = ooxml_surgery.apply_worksheet_edits(request);
        expect(Buffer.from(result.worksheet_xml).toString('utf8'))
            .toContain('<c r="A1"><v>2</v></c>');
        expect(result).toMatchObject({
            relationships_xml: null,
            formula_removed: false,
            calculation_chain_stale: false,
        });

        // Compile-time checks keep the supporting structural types reachable
        // from the public root without adding runtime exports.
        const style: CellTextStyle = { bold: true };
        const runs: readonly RichTextRun[] = [{ text: 'x', style }];
        const link: CellHyperlink = { kind: 'internal', location: 'Sheet2!A1' };
        const link_edit: XlsxHyperlinkEdit = { row: 0, col: 0, link };
        expect([runs, link_edit]).toHaveLength(2);
    });

    it('reports structured refusals through the public error type', () => {
        expect(() => ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<worksheet><sheetData><row r="1"><c r="A0"/></row></sheetData></worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [{ row: 0, col: 0, value: '2' }],
            write_options: { datemode: 0, is_date_style: () => false },
        })).toThrow(ooxml_surgery.OoxmlRefusalError);
    });

    it('marks the calculation chain stale when a formula changes', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<worksheet><sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [{ row: 0, col: 0, value: '=1+2' }],
            write_options: { datemode: 0, is_date_style: () => false },
        });

        expect(Buffer.from(result.worksheet_xml).toString('utf8'))
            .toContain('<c r="A1"><f>1+2</f></c>');
        expect(result.formula_removed).toBe(false);
        expect(result.calculation_chain_stale).toBe(true);
    });

    it('expands a namespaced self-closing sheetData for a blank appended row', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                + '<x:dimension ref="A1:A1"/><x:sheetData/></x:worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [],
            row_changes: {
                sourceRowCount: 0,
                removeRows: [],
                appendRows: [{ row: 0, cellStyleIndexes: [null] }],
            },
            write_options: { datemode: 0, is_date_style: () => false },
        });
        expect(Buffer.from(result.worksheet_xml).toString('utf8')).toContain(
            '<x:sheetData><x:row r="1"></x:row></x:sheetData>',
        );
    });

    it('inherits a row style for null cells and emits an explicit style-zero override', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<worksheet><dimension ref="A1:B1"/><sheetData>'
                + '<row r="1"><c r="A1"><v>1</v></c></row>'
                + '</sheetData></worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [],
            row_changes: {
                sourceRowCount: 1,
                removeRows: [],
                appendRows: [{
                    row: 1,
                    rowStyleIndex: 1,
                    cellStyleIndexes: [null, 0],
                }],
            },
            write_options: { datemode: 0, is_date_style: () => false },
        });
        const xml = Buffer.from(result.worksheet_xml).toString('utf8');
        expect(xml).toContain('<row r="2" s="1" customFormat="1">');
        expect(xml).not.toContain('<c r="A2"');
        expect(xml).toContain('<c r="B2" s="0"/>');
    });

    it('emits only the captured safe row-format attributes on appended rows', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<worksheet><sheetData><row r="1" hidden="1" outlineLevel="2"/>'
                + '</sheetData></worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [],
            row_changes: {
                sourceRowCount: 1,
                removeRows: [],
                appendRows: [{
                    row: 1,
                    cellStyleIndexes: [null],
                    rowStyleIndex: 3,
                    height: 22,
                    thickTop: true,
                    thickBottom: true,
                    phonetic: true,
                }],
            },
            write_options: { datemode: 0, is_date_style: () => false },
        });
        const xml = Buffer.from(result.worksheet_xml).toString('utf8');
        expect(xml).toContain(
            '<row r="2" s="3" customFormat="1" ht="22" customHeight="1" '
            + 'thickTop="1" thickBot="1" ph="1"></row>',
        );
        expect(xml.match(/hidden="1"/g)).toHaveLength(1);
        expect(xml.match(/outlineLevel="2"/g)).toHaveLength(1);
    });

    it('ignores sheetData lookalikes in comments and CDATA', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                + '<!--<fake:sheetData/>-->'
                + '<x:ignored><![CDATA[<decoy:sheetData/>]]></x:ignored>'
                + '<x:sheetData/></x:worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [],
            row_changes: {
                sourceRowCount: 0,
                removeRows: [],
                appendRows: [{ row: 0, cellStyleIndexes: [null] }],
            },
            write_options: { datemode: 0, is_date_style: () => false },
        });
        const xml = Buffer.from(result.worksheet_xml).toString('utf8');
        expect(xml).toContain('<!--<fake:sheetData/>-->');
        expect(xml).toContain('<![CDATA[<decoy:sheetData/>]]>');
        expect(xml).toContain('<x:sheetData><x:row r="1"></x:row></x:sheetData>');
    });

    it('replaces a removed tail row at the same physical coordinate', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<worksheet><dimension ref="A1:B2"/><sheetData>'
                + '<row r="1"><c r="A1"><v>1</v></c></row>'
                + '<row r="2"><c r="A2"><v>old</v></c></row>'
                + '</sheetData></worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [{ row: 1, col: 0, value: 'new' }],
            row_changes: {
                sourceRowCount: 2,
                removeRows: [1],
                appendRows: [{ row: 1, cellStyleIndexes: [null, 3] }],
            },
            write_options: { datemode: 0, is_date_style: () => false },
        });
        const xml = Buffer.from(result.worksheet_xml).toString('utf8');
        expect(xml).not.toContain('<v>old</v>');
        expect(xml).toContain('<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">new</t></is></c>');
        expect(xml).toContain('<c r="B2" s="3"/>');
    });

    it('updates same-sheet formula caches for a structural-only row change', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<worksheet><dimension ref="A1"/><sheetData><row r="1">'
                + '<c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [],
            row_changes: {
                sourceRowCount: 1,
                removeRows: [],
                appendRows: [{ row: 1, cellStyleIndexes: [null] }],
            },
            write_options: {
                datemode: 0,
                is_date_style: () => false,
                formula_result_invalidations: [{ row: 0, column: 0 }],
                formula_result_updates: [{ row: 0, column: 0, value: '3' }],
            },
        });
        const xml = Buffer.from(result.worksheet_xml).toString('utf8');
        expect(xml).toContain('<c r="A1"><f>1+1</f><v>3</v></c>');
        expect(xml).toContain('<row r="2"></row>');
    });

    it('edits and replaces populated rows in a consistently prefixed worksheet', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                + '<x:dimension ref="A1:B2"/><x:sheetData>'
                + '<x:row r="1"><x:c r="A1" s="2"><x:v>1</x:v></x:c></x:row>'
                + '<x:row r="2"><x:c r="A2"><x:v>old</x:v></x:c></x:row>'
                + '</x:sheetData></x:worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [{ row: 1, col: 0, value: 'new' }],
            row_changes: {
                sourceRowCount: 2,
                removeRows: [1],
                appendRows: [{ row: 1, cellStyleIndexes: [2, 3] }],
            },
            write_options: { datemode: 0, is_date_style: () => false },
        });
        const xml = Buffer.from(result.worksheet_xml).toString('utf8');
        expect(xml).not.toContain('<x:v>old</x:v>');
        expect(xml).toContain(
            '<x:row r="2"><x:c r="A2" s="2" t="inlineStr">'
            + '<x:is><x:t xml:space="preserve">new</x:t></x:is></x:c><x:c r="B2" s="3"/>'
            + '</x:row>',
        );
        expect(xml).not.toMatch(/<(?:row|c|v|is|t)(?:\s|>)/);
    });

    it('writes hyperlink markup with the worksheet namespace prefix', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                + '<x:sheetData><x:row r="1"><x:c r="A1"/></x:row></x:sheetData>'
                + '</x:worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [],
            hyperlink_edits: [{
                row: 0,
                col: 0,
                link: { kind: 'internal', location: 'Sheet2!A1' },
            }],
            write_options: { datemode: 0, is_date_style: () => false },
        });
        const xml = Buffer.from(result.worksheet_xml).toString('utf8');
        expect(xml).toContain(
            '<x:hyperlinks><x:hyperlink ref="A1" location="Sheet2!A1"/></x:hyperlinks>',
        );
        expect(xml).not.toMatch(/<(?:hyperlinks|hyperlink)(?:\s|>)/);
    });

    it('appends at the authoritative extent of a sparse worksheet', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<worksheet><dimension ref="A1:A10"/><sheetData>'
                + '<row r="1"><c r="A1"><v>1</v></c></row>'
                + '</sheetData></worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [],
            row_changes: {
                sourceRowCount: 10,
                removeRows: [],
                appendRows: [{ row: 10, cellStyleIndexes: [null] }],
            },
            write_options: { datemode: 0, is_date_style: () => false },
        });
        const xml = Buffer.from(result.worksheet_xml).toString('utf8');
        expect(xml).toContain('<row r="11"></row>');
        expect(xml).toContain('<dimension ref="A1:A11"/>');
    });

    it('restores the logical extent after removing an append from a sparse worksheet', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<worksheet><dimension ref="A1:A11"/><sheetData>'
                + '<row r="1"><c r="A1"><v>1</v></c></row><row r="11"/>'
                + '</sheetData></worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [],
            row_changes: {
                sourceRowCount: 11,
                removeRows: [10],
                appendRows: [],
            },
            write_options: { datemode: 0, is_date_style: () => false },
        });
        const xml = Buffer.from(result.worksheet_xml).toString('utf8');
        expect(xml).toContain('<dimension ref="A1:A10"/>');
    });

    it('updates a consistently prefixed SpreadsheetML dimension', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                + '<x:dimension ref="A1:A1"/><x:sheetData><x:row r="1"/></x:sheetData>'
                + '</x:worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [],
            row_changes: {
                sourceRowCount: 1,
                removeRows: [],
                appendRows: [{ row: 1, cellStyleIndexes: [null] }],
            },
            write_options: { datemode: 0, is_date_style: () => false },
        });
        expect(Buffer.from(result.worksheet_xml).toString('utf8'))
            .toContain('<x:dimension ref="A1:A2"/>');
    });

    it('does not treat a foreign sheetData lookalike as worksheet data', () => {
        expect(() => ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                + 'xmlns:ext="urn:extension"><ext:sheetData><ext:row r="1"/></ext:sheetData>'
                + '<sheetData/></worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [],
            row_changes: {
                sourceRowCount: 0,
                removeRows: [],
                appendRows: [{ row: 0, cellStyleIndexes: [null] }],
            },
            write_options: { datemode: 0, is_date_style: () => false },
        })).not.toThrow();
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                + 'xmlns:ext="urn:extension"><ext:sheetData><ext:row r="1"/></ext:sheetData>'
                + '<sheetData/></worksheet>',
            ),
            relationships_xml: null,
            cell_edits: [],
            row_changes: { sourceRowCount: 0, removeRows: [], appendRows: [{ row: 0, cellStyleIndexes: [null] }] },
            write_options: { datemode: 0, is_date_style: () => false },
        });
        const xml = Buffer.from(result.worksheet_xml).toString('utf8');
        expect(xml).toContain('<ext:sheetData><ext:row r="1"/></ext:sheetData>');
        expect(xml).toContain('<sheetData><row r="1"></row></sheetData>');
    });

    it('does not recreate a removed tail row while clearing its hyperlink', () => {
        const result = ooxml_surgery.apply_worksheet_edits({
            worksheet_xml: Buffer.from(
                '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                + '<dimension ref="A1:A2"/><sheetData><row r="1"/><row r="2"/></sheetData>'
                + '<hyperlinks><hyperlink ref="A2" r:id="rId1" display="link"/></hyperlinks>'
                + '</worksheet>',
            ),
            relationships_xml: '<Relationships><Relationship Id="rId1" '
                + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
                + 'Target="https://example.com" TargetMode="External"/></Relationships>',
            cell_edits: [],
            hyperlink_edits: [{ row: 1, col: 0, link: null }],
            row_changes: {
                sourceRowCount: 2,
                removeRows: [1],
                appendRows: [],
            },
            write_options: { datemode: 0, is_date_style: () => false },
        });
        const xml = Buffer.from(result.worksheet_xml).toString('utf8');
        expect(xml).not.toContain('r="2"');
        expect(xml).not.toContain('<hyperlink');
        expect(result.relationships_xml).not.toContain('rId1');
    });
});
