import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const scan_counts = vi.hoisted(() => ({ worksheetRoots: 0, styleSections: 0 }));

vi.mock('../ooxml-worksheet-scan', async (import_original) => {
    const original = await import_original<typeof import('../ooxml-worksheet-scan')>();
    return {
        ...original,
        find_first_element_by_local_name: (
            ...args: Parameters<typeof original.find_first_element_by_local_name>
        ) => {
            if (args[1] === 'worksheet') scan_counts.worksheetRoots += 1;
            return original.find_first_element_by_local_name(...args);
        },
    };
});

vi.mock('../ooxml-xml', async (import_original) => {
    const original = await import_original<typeof import('../ooxml-xml')>();
    const style_sections = new Set([
        'cellXfs', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'numFmts',
    ]);
    return {
        ...original,
        get_text: (...args: Parameters<typeof original.get_text>) => {
            if (style_sections.has(args[1])) scan_counts.styleSections += 1;
            return original.get_text(...args);
        },
    };
});

import { update_formula_cached_values } from '../xlsx-cell-write';
import { apply_hyperlink_edits } from '../xlsx-hyperlink-write';
import { capture_xlsx_append_row_format } from '../xlsx-package';

const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

describe('OOXML save scan reuse', () => {
    beforeEach(() => {
        scan_counts.worksheetRoots = 0;
        scan_counts.styleSections = 0;
    });

    it.each([
        {
            label: 'default namespace',
            xml: `<worksheet xmlns="${SPREADSHEET_NS}"><sheetData><row r="1">`
                + '<c r="A1"><f>1+1</f></c></row></sheetData></worksheet>',
            expected: '<f>1+1</f><v>2</v>',
        },
        {
            label: 'prefixed namespace',
            xml: `<s:worksheet xmlns:s="${SPREADSHEET_NS}"><s:sheetData><s:row r="1">`
                + '<s:c r="A1"><s:f>1+1</s:f></s:c></s:row></s:sheetData></s:worksheet>',
            expected: '<s:f>1+1</s:f><s:v>2</s:v>',
        },
    ])('resolves $label formula markup once across the two rewrite passes', ({ xml, expected }) => {
        const out = update_formula_cached_values(
            Buffer.from(xml),
            [{ row: 0, column: 0 }],
            [{ row: 0, column: 0, value: '2' }],
        );

        expect(out.toString()).toContain(expected);
        expect(scan_counts.worksheetRoots).toBe(1);
    });

    it('reuses prefixed worksheet markup and its hyperlink section', () => {
        const worksheet_noise = '<?vendor keep?>'.repeat(40_000);
        const xml = `<s:worksheet xmlns:s="${SPREADSHEET_NS}">`
            + `<s:sheetData/>${worksheet_noise}<s:hyperlinks>`
            + '<s:hyperlink ref="A1" location="Old!A1"/>'
            + '</s:hyperlinks></s:worksheet>';

        const out = apply_hyperlink_edits(xml, null, [{
            row: 0,
            col: 0,
            link: { kind: 'internal', location: 'New!A1' },
        }]);

        expect(out.sheet_xml).toContain('<s:hyperlink ref="A1" location="New!A1"/>');
        expect(scan_counts.worksheetRoots).toBe(1);
    });

    it('still refuses a malformed worksheet while locating reusable markup', () => {
        const malformed = `<worksheet xmlns="${SPREADSHEET_NS}"><sheetData/>`;

        expect(() => apply_hyperlink_edits(malformed, null, [{
            row: 0,
            col: 0,
            link: { kind: 'internal', location: 'A2' },
        }])).toThrow('Worksheet has no worksheet element');
    });

    it('parses each style fingerprint table once for a maximum-width append capture', () => {
        const format = capture_xlsx_append_row_format(
            readFileSync('src/test/fixtures/formatted.xlsx'),
            0,
            1,
            256,
            undefined,
        );

        expect(format.cellStyleFingerprints).toHaveLength(256);
        // Six fingerprint tables are scanned once. parse_styles performs the
        // three semantic reads used for number and font formatting.
        expect(scan_counts.styleSections).toBe(9);
    });
});
