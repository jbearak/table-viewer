import { describe, it, expect } from 'vitest';
import { get_attr, remove_attr } from '../ooxml-xml';
import {
    find_first_element,
    ignorable_end,
    ignorable_ranges,
    scan_cells,
    scan_rows,
} from '../ooxml-worksheet-scan';

describe('get_attr', () => {
    it('reads a double-quoted attribute', () => {
        expect(get_attr('<c r="A1">', 'r')).toBe('A1');
    });

    it('reads a single-quoted attribute', () => {
        expect(get_attr("<c r='A1'>", 'r')).toBe('A1');
    });

    it('allows XML whitespace around the equals sign', () => {
        expect(get_attr('<c r = "A1">', 'r')).toBe('A1');
    });

    it('ignores attribute-shaped text inside a double-quoted value', () => {
        expect(get_attr('<c note="text containing r=\'Z99\'" r="A1">', 'r')).toBe('A1');
    });

    it('ignores attribute-shaped text inside a single-quoted value', () => {
        expect(get_attr('<c note=\'has r="Z99" inside\' r="A1">', 'r')).toBe('A1');
    });

    it('recognizes any XML whitespace after the element name', () => {
        expect(get_attr('<c\nr="A1"\ns="7">', 'r')).toBe('A1');
    });

    it('decodes entities in the attribute value', () => {
        expect(get_attr('<c r="A&#49;">', 'r')).toBe('A1');
    });

    it('does not confuse a prefixed attribute with an unqualified one', () => {
        expect(get_attr('<c vendor:r="A1">', 'r')).toBeNull();
    });
});

describe('remove_attr', () => {
    it('removes the exact attribute in either quote form', () => {
        expect(remove_attr('<row vendor:spans="9:9" spans = \'1:1\' r="1">', 'spans'))
            .toBe('<row vendor:spans="9:9" r="1">');
    });
});


describe('worksheet element bounds', () => {
    it('keeps repeated unterminated child lookups inside each cell span', () => {
        const count = 10_000;
        const cases = [
            { fragment: '<f></c>', finalClose: '</f>' },
            { fragment: '<!--<f></c>', finalClose: '-->' },
            { fragment: '<![CDATA[<f></c>', finalClose: ']]>' },
            { fragment: '<?<f></c>', finalClose: '?>' },
        ];

        for (const { fragment, finalClose } of cases) {
            const xml = Buffer.from(fragment.repeat(count) + finalClose, 'utf8');
            for (let index = 0; index < count; index += 1) {
                const start = index * fragment.length;
                expect(find_first_element(xml, 'f', start, start + fragment.length)).toBeNull();
            }
        }
    });

    it('keeps repeated row and cell scans inside their requested spans', () => {
        const count = 10_000;
        const rowCases = [
            { fragment: '<x/>', finalClose: '<row r="1"/>' },
            { fragment: '<row r="1"', finalClose: '>' },
            { fragment: '<row r="1">', finalClose: '</row>' },
        ];
        for (const { fragment, finalClose } of rowCases) {
            const xml = Buffer.from(fragment.repeat(count) + finalClose, 'utf8');
            for (let index = 0; index < count; index += 1) {
                const start = index * fragment.length;
                expect(scan_rows(xml, start, start + fragment.length).size).toBe(0);
            }
        }

        const cellFragment = '<c r="A1"';
        const cells = Buffer.from(cellFragment.repeat(count) + '>', 'utf8');
        for (let index = 0; index < count; index += 1) {
            const start = index * cellFragment.length;
            expect(scan_cells(cells, start, start + cellFragment.length).size).toBe(0);
        }
    });

    it('retains ranges rather than opener-shaped text inside CDATA', () => {
        const nestedOpeners = '<![CDATA['.repeat(100_000);
        const xml = Buffer.from(`<![CDATA[${nestedOpeners}]]><f>1</f>`, 'utf8');
        const close = xml.indexOf(']]>') + 3;

        const ranges = ignorable_ranges(xml, 0, xml.length);
        expect(ranges.length).toBe(1);
        expect(ignorable_end(ranges, 0)).toBe(close);
        expect(find_first_element(xml, 'f')).toMatchObject({ start: close });
    });

    it('coalesces dense adjacent ignored ranges', () => {
        const comments = '<!---->'.repeat(100_000);
        const xml = Buffer.from(`${comments}<f>1</f>`, 'utf8');
        const ranges = ignorable_ranges(xml, 0, xml.length);

        expect(ranges.length).toBe(1);
        expect(ignorable_end(ranges, 0)).toBe(comments.length);
        expect(find_first_element(xml, 'f')).toMatchObject({ start: comments.length });
    });

    it('does not scan a row that closes beyond sheetData', () => {
        const source = '<worksheet><sheetData><row r="1"></sheetData>'
            + '<c r="A1"><v>outside</v></c></row></worksheet>';
        const xml = Buffer.from(source, 'utf8');
        const sheet_data = find_first_element(xml, 'sheetData')!;
        const coordinates: string[] = [];

        const rows = scan_rows(xml, sheet_data.inner_start, sheet_data.inner_end, {
            on_coordinate: (row, col) => coordinates.push(`${row}:${col}`),
        });

        expect(rows.size).toBe(0);
        expect(coordinates).toEqual([]);
    });

    it('reports valid, missing, and invalid cell references with start offsets', () => {
        const source = '<worksheet><sheetData><row r="1">'
            + '<c/><c r="A0"/><c r="XFD1048576"/>'
            + '</row></sheetData></worksheet>';
        const xml = Buffer.from(source, 'utf8');
        const sheet_data = find_first_element(xml, 'sheetData')!;
        const references: unknown[] = [];
        const coordinates: string[] = [];

        scan_rows(xml, sheet_data.inner_start, sheet_data.inner_end, {
            on_reference: (reference) => references.push(reference),
            on_coordinate: (row, col) => coordinates.push(`${row}:${col}`),
        });

        expect(references).toEqual([
            { kind: 'missing', start: xml.indexOf('<c/>') },
            { kind: 'invalid', reference: 'A0', start: xml.indexOf('<c r="A0"') },
            {
                kind: 'valid',
                row: 1_048_575,
                col: 16_383,
                start: xml.indexOf('<c r="XFD1048576"'),
            },
        ]);
        expect(coordinates).toEqual(['1048575:16383']);
    });

    it('reports true UTF-8 byte offsets after non-ASCII text', () => {
        const source = '<worksheet><note>café</note><sheetData>'
            + '<row r="1"><c r="A1"><v>1</v></c></row>'
            + '</sheetData></worksheet>';
        const xml = Buffer.from(source, 'utf8');
        const sheet_data = find_first_element(xml, 'sheetData')!;
        let cell_start = -1;

        scan_rows(xml, sheet_data.inner_start, sheet_data.inner_end, {
            on_reference: (reference) => { cell_start = reference.start; },
        });

        expect(cell_start).toBe(xml.indexOf('<c r="A1"'));
        expect(cell_start).toBeGreaterThan(source.indexOf('<c r="A1"'));
    });
});
