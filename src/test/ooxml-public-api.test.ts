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
        expect(ooxml_surgery.OOXML_CONFORMANCE_VERSION).toBe('1.0.0');
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
});
