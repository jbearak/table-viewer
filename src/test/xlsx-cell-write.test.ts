import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import CFB from 'cfb';
import { write_xlsx_cell_edits } from '../xlsx-package';
import { parse_xlsx } from '../parse-xlsx';
import {
    apply_cell_edits,
    classify_value,
    col_index_to_letter,
    iso_to_serial,
    widen_dimension,
} from '../xlsx-cell-write';

const FORMATTED = 'src/test/fixtures/formatted.xlsx';
const EMPTY = 'src/test/fixtures/empty-sheet.xlsx';
const MERGED = 'src/test/fixtures/merged.xlsx';
const SAMPLE = 'docs/examples/garden-cafe-sample.xlsx';

/** Read one part's bytes out of an .xlsx, for byte-identity assertions. */
function part(bytes: Uint8Array, path: string): Buffer | null {
    const entry = CFB.find(CFB.read(bytes, { type: 'buffer' }), path);
    return entry?.content ? Buffer.from(entry.content as Uint8Array) : null;
}

const OPTS = { datemode: 0 as const, is_date_style: () => false };

describe('iso_to_serial', () => {
    it('converts plain ISO dates in the 1900 system', () => {
        expect(iso_to_serial('2024-01-15', 0)).toBe(45306);
        expect(iso_to_serial('1970-01-01', 0)).toBe(25569);
    });

    it('applies the fictitious-1900-leap-day tie-break', () => {
        // Serial 60 is Excel's non-existent 1900-02-29, kept for Lotus
        // compatibility. Nothing may round-trip to it: the real 1900-02-28 is 59
        // and the next real day is 61.
        expect(iso_to_serial('1900-02-28', 0)).toBe(59);
        expect(iso_to_serial('1900-03-01', 0)).toBe(61);
    });

    it('uses the 1904 epoch when the workbook does', () => {
        expect(iso_to_serial('1904-01-01', 1)).toBe(0);
        expect(iso_to_serial('1904-01-02', 1)).toBe(1);
    });

    it('carries a time component as a fractional day', () => {
        expect(iso_to_serial('2024-01-15T12:00:00', 0)).toBe(45306.5);
    });

    it('rejects rollovers rather than silently shifting the date', () => {
        expect(iso_to_serial('2024-02-31', 0)).toBeNull();
        expect(iso_to_serial('2024-13-01', 0)).toBeNull();
    });

    it('rejects ambiguous and non-date input', () => {
        // Locale-ambiguous spellings must stay strings: guessing between
        // March 4th and April 3rd would corrupt data invisibly.
        expect(iso_to_serial('03/04/2024', 0)).toBeNull();
        expect(iso_to_serial('hello', 0)).toBeNull();
        expect(iso_to_serial('', 0)).toBeNull();
    });
});

describe('classify_value', () => {
    it('treats the empty string as a cleared cell', () => {
        expect(classify_value('', 0, OPTS)).toEqual({ kind: 'empty' });
    });

    it('infers numbers', () => {
        expect(classify_value('42', 0, OPTS)).toEqual({ kind: 'number', text: '42' });
        expect(classify_value('-1.5e3', 0, OPTS)).toEqual({ kind: 'number', text: '-1.5e3' });
    });

    it('keeps number-adjacent strings as strings', () => {
        // Leading zeros, phone numbers and IDs must survive as typed.
        expect(classify_value('007', 0, OPTS).kind).toBe('number');
        expect(classify_value('1,000', 0, OPTS).kind).toBe('string');
        expect(classify_value('12abc', 0, OPTS).kind).toBe('string');
        expect(classify_value('Infinity', 0, OPTS).kind).toBe('string');
    });

    it('stores a date as a serial only when the cell is already date-formatted', () => {
        const date_style = { datemode: 0 as const, is_date_style: () => true };
        expect(classify_value('2024-01-15', 3, date_style)).toEqual({ kind: 'number', text: '45306' });
        // Under a General style the same text stays a string, so the user does
        // not see a bare serial where they typed a date.
        expect(classify_value('2024-01-15', 0, OPTS)).toEqual({ kind: 'string', text: '2024-01-15' });
    });
});

describe('col_index_to_letter', () => {
    it('maps indices to spreadsheet column letters', () => {
        expect(col_index_to_letter(0)).toBe('A');
        expect(col_index_to_letter(25)).toBe('Z');
        expect(col_index_to_letter(26)).toBe('AA');
        expect(col_index_to_letter(701)).toBe('ZZ');
        expect(col_index_to_letter(702)).toBe('AAA');
    });
});

describe('apply_cell_edits', () => {
    const doc = (body: string) =>
        `<worksheet><dimension ref="A1:C3"/><sheetData>${body}</sheetData><pageMargins/></worksheet>`;

    it('replaces an existing cell and keeps its style index', () => {
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1" s="4"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '9' }],
            OPTS,
        );
        expect(out).toContain('<c r="A1" s="4"><v>9</v></c>');
    });

    it('drops a formula when a literal overwrites it', () => {
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><f>SUM(B1:C1)</f><v>3</v></c></row>'),
            [{ row: 0, col: 0, value: '9' }],
            OPTS,
        );
        expect(out).not.toContain('<f>');
        expect(out).toContain('<c r="A1"><v>9</v></c>');
    });

    it('inserts a new cell in ascending column order', () => {
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>'),
            [{ row: 0, col: 1, value: '2' }],
            OPTS,
        );
        expect(out.indexOf('r="A1"')).toBeLessThan(out.indexOf('r="B1"'));
        expect(out.indexOf('r="B1"')).toBeLessThan(out.indexOf('r="C1"'));
    });

    it('inserts a new row in ascending row order', () => {
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row><row r="3"><c r="A3"><v>3</v></c></row>'),
            [{ row: 1, col: 0, value: '2' }],
            OPTS,
        );
        expect(out.indexOf('r="1"')).toBeLessThan(out.indexOf('r="2"'));
        expect(out.indexOf('r="2"')).toBeLessThan(out.indexOf('r="3"'));
    });

    it('escapes XML metacharacters in string values', () => {
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"/></row>'),
            [{ row: 0, col: 0, value: 'a & b < c > d' }],
            OPTS,
        );
        expect(out).toContain('a &amp; b &lt; c &gt; d');
    });

    it('preserves leading and trailing whitespace in strings', () => {
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"/></row>'),
            [{ row: 0, col: 0, value: '  padded  ' }],
            OPTS,
        );
        expect(out).toContain('xml:space="preserve"');
        expect(out).toContain('>  padded  <');
    });

    it('leaves a cleared cell present so it keeps its formatting', () => {
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1" s="7"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '' }],
            OPTS,
        );
        expect(out).toContain('<c r="A1" s="7"/>');
    });

    it('leaves untouched regions byte-identical', () => {
        const original = doc('<row r="1"><c r="A1"><v>1</v></c><c r="B1" t="s"><v>5</v></c></row>');
        const out = apply_cell_edits(original, [{ row: 0, col: 0, value: '9' }], OPTS);
        expect(out).toContain('<c r="B1" t="s"><v>5</v></c>');
        expect(out).toContain('<pageMargins/>');
    });

    it('applies several edits across rows in one pass', () => {
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="B2"><v>2</v></c></row>'),
            [
                { row: 0, col: 0, value: 'x' },
                { row: 1, col: 1, value: 'y' },
                { row: 4, col: 0, value: 'z' },
            ],
            OPTS,
        );
        expect(out).toContain('>x<');
        expect(out).toContain('>y<');
        expect(out).toContain('r="A5"');
    });

    it('expands a self-closing sheetData before writing into it', () => {
        const out = apply_cell_edits(
            '<worksheet><sheetData/></worksheet>',
            [{ row: 0, col: 0, value: '1' }],
            OPTS,
        );
        expect(out).toContain('<c r="A1"><v>1</v></c>');
    });

    it('returns the document unchanged when there are no edits', () => {
        const original = doc('<row r="1"><c r="A1"><v>1</v></c></row>');
        expect(apply_cell_edits(original, [], OPTS)).toBe(original);
    });

    it('refuses a document with no sheetData rather than emitting a broken part', () => {
        expect(() => apply_cell_edits('<worksheet/>', [{ row: 0, col: 0, value: '1' }], OPTS))
            .toThrow(/sheetData/);
    });
});

describe('widen_dimension', () => {
    it('widens to cover newly written cells', () => {
        const out = widen_dimension('<x><dimension ref="A1:B2"/></x>', 5, 4);
        expect(out).toContain('ref="A1:E6"');
    });

    it('never shrinks an existing extent', () => {
        const xml = '<x><dimension ref="A1:Z100"/></x>';
        expect(widen_dimension(xml, 1, 1)).toBe(xml);
    });

    it('tolerates a single-cell ref', () => {
        expect(widen_dimension('<x><dimension ref="A1"/></x>', 2, 2)).toContain('ref="A1:C3"');
    });
});

describe('write_xlsx_cell_edits', () => {
    it('writes values that read back through the parser', async () => {
        const raw = readFileSync(FORMATTED);
        const out = write_xlsx_cell_edits(raw, 0, [
            { row: 0, col: 0, value: '999.5' },
            { row: 3, col: 1, value: 'hello & <world>' },
        ]);
        const { data } = await parse_xlsx(out);
        expect(data.sheets[0].rows[0][0]!.raw).toBe(999.5);
        expect(data.sheets[0].rows[3][1]!.raw).toBe('hello & <world>');
    });

    it('round-trips a date through a date-formatted cell', async () => {
        const raw = readFileSync(FORMATTED);
        // C1 carries a date style in this fixture.
        const out = write_xlsx_cell_edits(raw, 0, [{ row: 0, col: 2, value: '2024-01-15' }]);
        const { data } = await parse_xlsx(out);
        const cell = data.sheets[0].rows[0][2]!;
        expect(cell.rawType).toBe('date');
        expect(String(cell.raw)).toContain('2024-01-15');
    });

    it('leaves every part it did not edit byte-identical', () => {
        const raw = readFileSync(SAMPLE);
        const out = write_xlsx_cell_edits(raw, 2, [{ row: 1, col: 1, value: '42' }]);
        // This is the core putexcel guarantee: parts we never touch are never
        // even parsed, so unmodelled features survive by construction.
        for (const path of [
            '/xl/styles.xml',
            '/xl/theme/theme1.xml',
            '/xl/sharedStrings.xml',
            '/xl/workbook.xml',
            '/xl/worksheets/sheet1.xml',
            '/xl/tables/table1.xml',
            '/[Content_Types].xml',
        ]) {
            expect(part(out, path), path).toEqual(part(raw, path));
        }
    });

    it('keeps every sheet readable after an edit', async () => {
        const raw = readFileSync(SAMPLE);
        const out = write_xlsx_cell_edits(raw, 2, [{ row: 1, col: 1, value: '42' }]);
        const { data } = await parse_xlsx(out);
        expect(data.sheets.length).toBe(8);
        expect(data.sheets[2].rows[1][1]!.raw).toBe(42);
    });

    it('preserves merges on the edited sheet', async () => {
        const raw = readFileSync(MERGED);
        const before = (await parse_xlsx(raw)).data.sheets[0].merges;
        const out = write_xlsx_cell_edits(raw, 0, [{ row: 0, col: 0, value: 'anchor' }]);
        const after = (await parse_xlsx(out)).data.sheets[0];
        expect(after.merges).toEqual(before);
        expect(after.rows[0][0]!.raw).toBe('anchor');
    });

    it('writes into a sheet that had no cells at all', async () => {
        const raw = readFileSync(EMPTY);
        const out = write_xlsx_cell_edits(raw, 0, [{ row: 5, col: 3, value: 'far' }]);
        const { data } = await parse_xlsx(out);
        expect(data.sheets[0].rows[5][3]!.raw).toBe('far');
    });

    it('returns the input untouched when there are no edits', () => {
        const raw = readFileSync(FORMATTED);
        expect(write_xlsx_cell_edits(raw, 0, [])).toBe(raw);
    });

    it('refuses a sheet index the workbook does not have', () => {
        const raw = readFileSync(FORMATTED);
        expect(() => write_xlsx_cell_edits(raw, 99, [{ row: 0, col: 0, value: 'x' }]))
            .toThrow(/worksheet/i);
    });

    it('refuses bytes that are not an .xlsx', () => {
        expect(() => write_xlsx_cell_edits(new Uint8Array([1, 2, 3]), 0, [{ row: 0, col: 0, value: 'x' }]))
            .toThrow(/valid \.xlsx/);
    });
});
