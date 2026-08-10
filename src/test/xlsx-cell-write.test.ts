import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import CFB from 'cfb';
import { write_xlsx_cell_edits } from '../xlsx-package';
import { parse_xlsx, worksheet_part_paths } from '../parse-xlsx';
import {
    apply_cell_edits,
    classify_value,
    col_index_to_letter,
    formula_count,
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

/** `formatted.xlsx` with one substitution made in each of the named parts. */
function patched_parts(edits: Array<[part: string, from: string | RegExp, to: string]>): Uint8Array {
    return patched_in(readFileSync(FORMATTED), edits);
}

function patched_in(
    raw: Buffer,
    edits: Array<[part: string, from: string | RegExp, to: string]>,
): Uint8Array {
    const file = CFB.read(raw, { type: 'buffer' });
    for (const [path, from, to] of edits) {
        const entry = CFB.find(file, path)!;
        const before = Buffer.from(entry.content as Uint8Array).toString('utf8');
        const after = before.replace(from, to);
        // A substitution that matched nothing would leave the fixture unpatched
        // and the test passing for no reason at all.
        expect(after, `${path}: ${String(from)}`).not.toBe(before);
        const patched = Buffer.from(after, 'utf8');
        entry.content = patched;
        entry.size = patched.length;
    }
    const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
    return written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBufferLike);
}

/** `basic.xlsx` — two worksheets — with one substitution made in each named part. */
function patched_basic(edits: Array<[part: string, from: string | RegExp, to: string]>): Uint8Array {
    return patched_in(readFileSync('src/test/fixtures/basic.xlsx'), edits);
}

/** `formatted.xlsx` with one substitution made in its styles part. */
function patched_styles(from: string, to: string): Uint8Array {
    return patched_parts([['/xl/styles.xml', from, to]]);
}

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
        // Zip codes, phone extensions and account ids are typed for their
        // spelling; storing them as numbers loses the padding irreversibly, and
        // the same text in a CSV round-trips verbatim.
        expect(classify_value('007', 0, OPTS)).toEqual({ kind: 'string', text: '007' });
        expect(classify_value('00', 0, OPTS).kind).toBe('string');
        expect(classify_value('007.5', 0, OPTS).kind).toBe('string');
        expect(classify_value('1,000', 0, OPTS).kind).toBe('string');
        expect(classify_value('12abc', 0, OPTS).kind).toBe('string');
        expect(classify_value('Infinity', 0, OPTS).kind).toBe('string');
    });

    it('still reads a single leading zero as part of the number', () => {
        // `0`, `0.5` and `0e0` spell their value; the zero is not padding.
        for (const text of ['0', '0.5', '-0.5', '.5', '0e0', '1.']) {
            expect(classify_value(text, 0, OPTS).kind, text).toBe('number');
        }
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

    it('refuses a shared-formula cell rather than breaking the group', () => {
        // The master defines the formula its followers reference by `si`. Dropping
        // it leaves them pointing at a definition that no longer exists.
        expect(() => apply_cell_edits(
            doc('<row r="1"><c r="A1"><f t="shared" ref="A1:A3" si="0">B1*2</f><v>2</v></c></row>'),
            [{ row: 0, col: 0, value: '9' }],
            OPTS,
        )).toThrow(/A1.*shared formula/);
    });

    it('refuses a shared-formula follower too', () => {
        expect(() => apply_cell_edits(
            doc('<row r="2"><c r="A2"><f t="shared" si="0"/><v>4</v></c></row>'),
            [{ row: 1, col: 0, value: '9' }],
            OPTS,
        )).toThrow(/A2.*shared formula/);
    });

    it('refuses an array-formula cell', () => {
        expect(() => apply_cell_edits(
            doc('<row r="1"><c r="A1"><f t="array" ref="A1:B1">SUM(C1:D1)</f><v>3</v></c></row>'),
            [{ row: 0, col: 0, value: '9' }],
            OPTS,
        )).toThrow(/A1.*array formula/);
    });

    it('refuses a cell inside an array formula that carries no <f> of its own', () => {
        // The master holds the only `<f>`; B1 is part of the result range and has
        // just a value, so a per-cell check never meets a formula there.
        expect(() => apply_cell_edits(
            doc('<row r="1"><c r="A1"><f t="array" ref="A1:B1">SUM(C1:D1)</f><v>3</v></c>'
                + '<c r="B1"><v>4</v></c></row>'),
            [{ row: 0, col: 1, value: '9' }],
            OPTS,
        )).toThrow(/B1.*array formula/);
    });

    it('refuses a missing follower cell inside an array formula range', () => {
        // B1 is inside the `ref` but was never written — a sparse result cell. The
        // per-cell check has nothing to look at, so an edit here used to fall to
        // the insertion path and drop a literal into the middle of the range.
        expect(() => apply_cell_edits(
            doc('<row r="1"><c r="A1"><f t="array" ref="A1:B2">SUM(C1:D1)</f><v>3</v></c></row>'),
            [{ row: 0, col: 1, value: '9' }],
            OPTS,
        )).toThrow(/B1.*array formula/);
    });

    it('refuses a cell in an array range whose row is absent entirely', () => {
        // Row 2 has no `<row>` at all, so the edit took the synthesize-the-row
        // path, which never consulted a formula.
        expect(() => apply_cell_edits(
            doc('<row r="1"><c r="A1"><f t="array" ref="A1:B2">SUM(C1:D1)</f><v>3</v></c></row>'),
            [{ row: 1, col: 0, value: '9' }],
            OPTS,
        )).toThrow(/A2.*array formula/);
    });

    it('handles a whole-sheet array ref without expanding it', () => {
        // A `ref` is whatever wrote the file, and `A1:XFD1048576` is legal. Cells
        // inside it are still refused; the point is that an unrelated edit
        // elsewhere returns promptly rather than materializing 17e9 coordinates.
        const xml = doc(
            '<row r="1"><c r="A1"><f t="array" ref="A1:XFD1048576">SUM(C1:D1)</f><v>3</v></c>'
            + '</row><row r="2"><c r="A2"><v>4</v></c></row>',
        );
        expect(() => apply_cell_edits(xml, [{ row: 1, col: 0, value: '9' }], OPTS))
            .toThrow(/A2.*array formula/);

        // Same shape, ref bounded away from the edited cell: it goes through.
        const bounded = doc(
            '<row r="1"><c r="A1"><f t="array" ref="A1:B1">SUM(C1:D1)</f><v>3</v></c></row>'
            + '<row r="2"><c r="A2"><v>4</v></c></row>',
        );
        expect(apply_cell_edits(bounded, [{ row: 1, col: 0, value: '9' }], OPTS))
            .toContain('<c r="A2"><v>9</v></c>');
    });

    it('replaces a cell in a row that carries no r= attribute', () => {
        // `r` is optional in SpreadsheetML and the reader never needed it. Skipping
        // such a row made the writer synthesize a second one, so the sheet ended up
        // with two A1s and a reader free to pick either.
        const out = apply_cell_edits(
            doc('<row><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '9' }],
            OPTS,
        );
        expect(out).toContain('<v>9</v>');
        expect(out).not.toContain('<v>1</v>');
        expect(out.match(/<row\b/g)).toHaveLength(1);
        expect(out.match(/r="A1"/g)).toHaveLength(1);
    });

    it('refuses a cell inside a what-if data table', () => {
        // `t="dataTable"` is the third grouped kind: one `<f>` with a `ref`, and
        // result cells carrying only a cached value.
        const table = '<row r="1"><c r="A1"><f t="dataTable" ref="A1:B2" r1="$D$1"/><v>1</v></c>'
            + '<c r="B1"><v>2</v></c></row>';
        expect(() => apply_cell_edits(doc(table), [{ row: 0, col: 0, value: '9' }], OPTS))
            .toThrow(/A1.*data table/);
        // A follower, which carries no formula of its own.
        expect(() => apply_cell_edits(doc(table), [{ row: 1, col: 1, value: '9' }], OPTS))
            .toThrow(/B2.*data table/);
    });

    it('rejects a time whose components are out of range', () => {
        // `Date.UTC` rolls 12:60 to 13:00 and leaves the date alone, so the
        // existing calendar round-trip check cannot see it.
        expect(iso_to_serial('2024-01-15T12:60', 0)).toBeNull();
        expect(iso_to_serial('2024-01-15T25:00', 0)).toBeNull();
        expect(iso_to_serial('2024-01-15T12:30:60', 0)).toBeNull();
        // Still accepted, unchanged.
        expect(iso_to_serial('2024-01-15T12:30', 0)).toBeCloseTo(45306.5208333, 6);
        expect(iso_to_serial('2024-01-15T23:59:59', 0)).not.toBeNull();
    });

    it('drops control characters XML 1.0 cannot represent', () => {
        // Pasted from a terminal or a PDF, invisible in the grid, and fatal in the
        // part: there is no escape for these, so a numeric reference would be just
        // as invalid as the byte.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'),
            [{ row: 0, col: 0, value: 'a\u000bb\u0000c' }],
            OPTS,
        );
        expect(out).toContain('abc');
        expect(out).not.toContain('\u000b');
        expect(out).not.toContain('\u0000');

        // U+FFFE and U+FFFF are forbidden by XML 1.0 too, and survive UTF-8
        // encoding intact — a worksheet part no reader accepts.
        const noncharacters = apply_cell_edits(
            doc('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'),
            [{ row: 0, col: 0, value: 'x\uFFFEy\uFFFFz' }],
            OPTS,
        );
        expect(noncharacters).toContain('xyz');
        expect(noncharacters).not.toContain('\uFFFE');
        expect(noncharacters).not.toContain('\uFFFF');
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

    it('orders several new cells by column, whatever order they were edited in', () => {
        // Both land in the same gap, so they share a splice offset and the caller's
        // order would otherwise decide the document order.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c><c r="E1"><v>5</v></c></row>'),
            [{ row: 0, col: 3, value: '4' }, { row: 0, col: 1, value: '2' }],
            OPTS,
        );
        expect(out.indexOf('r="A1"')).toBeLessThan(out.indexOf('r="B1"'));
        expect(out.indexOf('r="B1"')).toBeLessThan(out.indexOf('r="D1"'));
        expect(out.indexOf('r="D1"')).toBeLessThan(out.indexOf('r="E1"'));
    });

    it('edits an existing cell while inserting a lower-column one beside it', () => {
        // Both splices start at C1: the insert goes before it, the replacement
        // covers it. Applied right-to-left the replacement has to win the tie, or
        // it overwrites the text just inserted.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>'),
            [{ row: 0, col: 2, value: '30' }, { row: 0, col: 1, value: '2' }],
            OPTS,
        );
        expect(out.indexOf('r="A1"')).toBeLessThan(out.indexOf('r="B1"'));
        expect(out.indexOf('r="B1"')).toBeLessThan(out.indexOf('r="C1"'));
        expect(out).toContain('<c r="B1"><v>2</v></c>');
        expect(out).toContain('<c r="C1"><v>30</v></c>');
        // Exactly three cells: a clobbered splice would drop or duplicate one.
        expect(out.match(/<c\b/g)).toHaveLength(3);
    });

    it('lets the last edit to a cell win, on an existing cell and a new one', () => {
        // Nothing upstream promises a cell is named at most once, and every stage
        // assumed it was. On an existing cell the first edit won (wrong but valid);
        // on an absent one both were spliced, emitting two `<c r="A1">` elements in
        // one row — a file Excel offers to repair.
        const existing = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '2' }, { row: 0, col: 0, value: '3' }],
            OPTS,
        );
        expect(existing).toContain('<v>3</v>');
        expect(existing).not.toContain('<v>2</v>');
        expect(existing.match(/<c\b/g)).toHaveLength(1);

        const absent = apply_cell_edits(
            doc('<row r="1"><c r="B1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '2' }, { row: 0, col: 0, value: '3' }],
            OPTS,
        );
        expect(absent.match(/r="A1"/g)).toHaveLength(1);
        expect(absent).toContain('<c r="A1"><v>3</v></c>');
    });

    it('refuses a commented-out cell that names a live one', () => {
        // A commented-out cell is text to a parser, and this writer is right about
        // that — but `parse_xlsx` scans raw substrings, so to *the reader* a
        // `<c r="A1">` inside a comment is a cell, and a later one wins over the
        // live cell before it. Splicing the live cell therefore produced a save that
        // reported success while the grid went on showing `stale`. Neither side can
        // act on the other's reading, so the shape is refused.
        expect(() => apply_cell_edits(
            doc(
                '<row r="1"><c r="A1"><v>1</v></c></row>'
                + '<!-- <row r="1"><c r="A1"><v>stale</v></c></row> -->',
            ),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        )).toThrow(/cannot\s+edit\s+safely/i);
    });

    it('edits the real row, not a commented-out one the reader also ignores', () => {
        // The scanners match raw `<row`/`<c` substrings, so a commented-out row was
        // treated as live and the new value spliced inside the comment: valid file,
        // successful save, nothing changed. Carrying no `r`, this comment is
        // invisible to the reader too, so there is nothing to refuse — the writer
        // simply has to skip it.
        const out = apply_cell_edits(
            doc(
                '<row r="1"><c r="A1"><v>1</v></c></row>'
                + '<!-- <row r="1"><c><v>stale</v></c></row> -->',
            ),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).toContain('<!-- <row r="1"><c><v>stale</v></c></row> -->');
        expect(out).toContain('<row r="1"><c r="A1"><v>2</v></c></row>');
    });

    it('does not end a row at a </row> quoted inside it', () => {
        // Skipping commented-out *opening* tags but not closing ones is the same
        // bug wearing the other shoe: the row's span ended at the comment's text,
        // so the edit landed inside the comment and the live A1 kept its value.
        const out = apply_cell_edits(
            doc('<row r="1"><!-- note: </row> --><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).toContain('<!-- note: </row> -->');
        expect(out).toContain('<c r="A1"><v>2</v></c>');
        expect(out).not.toContain('<v>1</v>');
    });

    it('does not end a cell at a </c> quoted inside it', () => {
        // Worse than a silent no-op: the replacement ran from the cell's start to
        // the comment's text, cutting the comment in half and leaving the rest of
        // it — and an orphaned `</c>` — as malformed XML in a saved workbook.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><!-- note: </c> --><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).not.toContain('-->');
        expect(out).toContain('<row r="1"><c r="A1"><v>2</v></c></row>');
    });

    it('infers an unnumbered row from a live cell, not a commented-out one', () => {
        // The inference took the first raw `<c r=…>` in the row, comment or not, so
        // the row was filed under the wrong number — and an edit to a cell plainly
        // present took the synthesize-the-row path, appending a second row with a
        // duplicate coordinate while the original kept its old value.
        // A commented reference is refused outright now (the reader reads it as a
        // cell), so the inference is exercised with a comment that carries none. The
        // hazard is the same: the scan must not take its row number from comment text.
        const out = apply_cell_edits(
            doc('<row><!-- <c/> --><c r="B2"><v>1</v></c></row>'),
            [{ row: 1, col: 1, value: '9' }],
            OPTS,
        );
        expect(out.match(/r="B2"/g)).toHaveLength(1);
        expect(out).toContain('<c r="B2"><v>9</v></c>');
    });

    it('replaces a cell whose end tag carries whitespace', () => {
        // XML permits whitespace between the name and the `>` of an end tag, so
        // `</c >` is ordinary — a pretty-printer may well write it. Matching only
        // the exact spelling `</c>` made the cell look unterminated, the edit took
        // the synthesize-a-new-one path, and the row came out with two `<c r="A1">`.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c ></row>'),
            [{ row: 0, col: 0, value: '9' }],
            OPTS,
        );
        expect(out.match(/r="A1"/g)).toHaveLength(1);
        expect(out).toContain('<v>9</v>');
        expect(out).not.toContain('<v>1</v>');
    });

    it('replaces a cell in a row whose end tag carries whitespace', () => {
        // The same spelling one level up, and the same duplicate outcome: the row
        // looked unterminated, so an edit to a cell inside it appended a second row.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row\n>'),
            [{ row: 0, col: 0, value: '9' }],
            OPTS,
        );
        expect(out.match(/<row\b/g)).toHaveLength(1);
        expect(out).toContain('<v>9</v>');
    });

    it('inserts a new cell into a row whose end tag carries whitespace', () => {
        // The insertion point was `end - '</row>'.length`, which is inside a
        // `</row\n>` rather than before it: the new cell was spliced into the middle
        // of the end tag, producing XML no reader accepts.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row\n>'),
            [{ row: 0, col: 1, value: '2' }],
            OPTS,
        );
        expect(out).toContain('<c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row\n>');
        expect(out).not.toContain('<<');
    });

    it('drops a spans hint an insertion would make stale', () => {
        // `spans` caches the row's occupied column range. Excel recomputes it, but
        // readers that trust it never see a cell outside the cached range — so a row
        // left saying `1:1` while holding C1 hides the user's own edit.
        const out = apply_cell_edits(
            doc('<row r="1" spans="1:1"><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 2, value: '3' }],
            OPTS,
        );
        expect(out).not.toContain('spans=');
        expect(out).toContain('<c r="C1"><v>3</v></c>');
    });

    it('drops a stale spans hint on an empty row too', () => {
        // The self-closing row takes the replacement path, which rebuilds the
        // opening tag from its own attributes and would otherwise carry the stale
        // hint straight through.
        const out = apply_cell_edits(
            doc('<row r="1" spans="1:1" ht="20"/>'),
            [{ row: 0, col: 2, value: '3' }],
            OPTS,
        );
        expect(out).not.toContain('spans=');
        expect(out).toContain('ht="20"');
        expect(out).toContain('<c r="C1"><v>3</v></c>');
    });

    it('keeps spans when no cell is inserted', () => {
        // Replacing a cell in place cannot move the row's range, so the hint is
        // still true and rewriting the tag would be churn in a file we promise to
        // leave alone.
        const out = apply_cell_edits(
            doc('<row r="1" spans="1:1"><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).toContain('spans="1:1"');
    });

    it('does not refuse a prefixed namespace declaration', () => {
        // Only a *default* declaration rebinds the unprefixed `<c>` this writer
        // splices. `xmlns:vendor="…"` introduces a prefix for elements that opt into
        // it and changes nothing about the cell — refusing on it rejected an
        // ordinary worksheet outright.
        const out = apply_cell_edits(
            doc('<row r="1"><c xmlns:vendor="urn:vendor" r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).toContain('<v>2</v>');
    });

    it('still refuses a default namespace override', () => {
        // The other half of the same guard: this one really does rebind the row and
        // every unprefixed child, so a spliced `<c>` would land in a foreign
        // namespace and the save would report success having written nothing.
        expect(() => apply_cell_edits(
            doc('<row r="1" xmlns="urn:other"><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        )).toThrow(/different XML namespace/);
    });

    it('does not count formula-shaped text in comments or CDATA', () => {
        // The count only exists to answer "did an edit drop a formula". Counting
        // quoted text made an edit *near* a comment look like a formula appearing
        // or vanishing, which deleted xl/calcChain.xml from a workbook whose
        // formulas were all still there.
        expect(formula_count('<!-- <f>not markup</f> --><![CDATA[<f/>]]>')).toBe(0);
        expect(formula_count('<f>SUM(A1:A2)</f><!-- <f>doc</f> -->')).toBe(1);
    });

    it('edits the live sheetData, not a commented-out one before it', () => {
        // The element the whole splice is scoped to. Found by raw indexOf, a
        // commented-out `<sheetData>` ahead of the live one took every edit into
        // the comment: the worksheet never changed and the save reported success.
        const out = apply_cell_edits(
            '<?xml version="1.0"?><worksheet>'
            + '<!-- <sheetData><row r="1"><c r="A1"><v>stale</v></c></row></sheetData> -->'
            + '<sheetData><row r="1"><c r="A1"><v>live</v></c></row></sheetData></worksheet>',
            [{ row: 0, col: 0, value: 'new' }],
            OPTS,
        );
        expect(out).toContain('<!-- <sheetData><row r="1"><c r="A1"><v>stale</v></c></row></sheetData> -->');
        expect(out).toContain('<t xml:space="preserve">new</t>');
        expect(out).not.toContain('<v>live</v>');
    });

    it('widens the live dimension, not a commented-out one before it', () => {
        const out = widen_dimension(
            '<?xml version="1.0"?><worksheet>'
            + '<!-- <dimension ref="A1"/> --><dimension ref="A1"/>'
            + '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
            0, 0, 4, 4,
        );
        expect(out).toContain('<!-- <dimension ref="A1"/> -->');
        expect(out).toContain('<dimension ref="A1:E5"/>');
    });

    it('does not refuse an edit over an array formula quoted inside the cell', () => {
        // The per-cell grouped-formula check, unlike the sheet-wide one, still read
        // comments — so an ordinary literal cell that merely documents an array
        // formula refused an edit that was never part of a group.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><!-- <f t="array" ref="A1:B2"/> --><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: 'x' }],
            OPTS,
        );
        expect(out).toContain('<t xml:space="preserve">x</t>');
    });

    it('accepts a legal raw > inside a quoted attribute value', () => {
        // `>` needs no escaping inside an attribute value, so `[^>]*` cut the tag
        // mid-attribute; the fragment left an unbalanced quote, failed the guard's
        // subtraction, and refused a worksheet that edits perfectly well.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1" x:note="1 > 0"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: 'x' }],
            OPTS,
        );
        expect(out).toContain('<t xml:space="preserve">x</t>');
    });

    it('does not refuse a cell whose only array formula is commented out', () => {
        // No `r` in the comment, so the reader ignores it too and there is nothing to
        // refuse; what must not happen is the *formula* being read out of comment text
        // and the live cell declined as part of an array range.
        const out = apply_cell_edits(
            doc(
                '<!-- <row r="1"><c><f t="array" ref="A1:B2">X</f></c></row> -->'
                + '<row r="1"><c r="A1"><v>1</v></c></row>',
            ),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).toContain('<row r="1"><c r="A1"><v>2</v></c></row>');
    });

    it('edits the live cell, not element-shaped data inside a processing instruction', () => {
        // Everything between `<?` and `?>` is opaque to a parser and its content is
        // unconstrained, so a PI carrying element-shaped text is text. Scanning it
        // as markup put the edit *inside the PI* and left the live A1 untouched:
        // the save reports success and the cell on screen never changes.
        //
        // No `r` in the quoted text: one that carries a reference is refused, because
        // the reader's raw scan reads it as a real cell that beats the live one.
        const out = apply_cell_edits(
            doc(
                '<row r="1"><c r="A1"><v>1</v></c></row>'
                + '<?note <row r="1"><c><v>quoted</v></c></row> ?>',
            ),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).toContain('<row r="1"><c r="A1"><v>2</v></c></row>');
        expect(out).toContain('<?note <row r="1"><c><v>quoted</v></c></row> ?>');
    });

    it('refuses a cell reference quoted inside CDATA or a processing instruction', () => {
        // The reader draws no distinction between text a parser discards and markup:
        // it scans raw substrings, so a `<c r="A1">` in any of the three is a cell to
        // it, and a later one beats the live cell before it. The writer edited the
        // live cell and the grid went on showing the ghost after a successful save.
        for (const inner of [
            '<row r="1"><c r="A1" t="inlineStr"><is><t>old</t></is></c>'
            + '<![CDATA[<c r="A1" t="inlineStr"><is><t>ghost</t></is></c>]]></row>',
            '<row r="1"><c r="A1" t="inlineStr"><is><t>old</t></is></c>'
            + '<?vendor <c r="A1" t="inlineStr"><is><t>ghost</t></is></c>?></row>',
        ]) {
            expect(() => apply_cell_edits(doc(inner), [{ row: 0, col: 0, value: 'new' }], OPTS))
                .toThrow(/cannot\s+edit\s+safely/i);
        }
    });

    it('refuses a cell whose reference disagrees with the row holding it', () => {
        // `<row r="1"><c r="A2"/></row>` is legal, and the two sides read it
        // oppositely: the reader keys cells off `<c r>` alone and shows A2, while the
        // writer filed it under its container. Editing what the user sees as A2 found
        // no such cell, synthesized a new row, and left two `<c r="A2">` behind —
        // duplicate coordinates whose displayed value depends on which one wins.
        expect(() => apply_cell_edits(
            doc('<row r="1"><c r="A2"><v>7</v></c></row>'),
            [{ row: 1, col: 0, value: '9' }],
            OPTS,
        )).toThrow(/cannot\s+edit\s+safely/i);
        // An unnumbered row has nothing to disagree with — the reader infers its
        // number from the first cell, exactly as the writer does.
        expect(apply_cell_edits(
            doc('<row><c r="A2"><v>7</v></c></row>'),
            [{ row: 1, col: 0, value: '9' }],
            OPTS,
        )).toContain('<c r="A2"><v>9</v></c>');
    });

    it('refuses a worksheet whose markup it cannot read the way a parser would', () => {
        // Each of these scans as something other than what it is, and the failure
        // is silent: the prefixed formula is overwritten unseen (and calcChain is
        // left stale, since `formula_count` sees no loss), while the other two
        // append a *second* cell carrying a reference that already exists.
        const cases = [
            '<row r="1"><c r="A1"><x:f t="array" ref="A1:B2">SUM(1)</x:f><v>1</v></c></row>',
            "<row r='1'><c r='A1'><v>1</v></c></row>",
            '<row r="1"><c><v>1</v></c></row>',
            // Not just `r`: an unreadable `s` silently drops the cell's formatting,
            // an unreadable `t="b"` turns a boolean into a string, and an unreadable
            // `t`/`ref` on `<f>` hides an array formula the writer then overwrites.
            `<row r="1"><c r="A1" s='3'><v>1</v></c></row>`,
            `<row r="1"><c r="A1" t='b'><v>1</v></c></row>`,
            '<row r="1"><c r="A1"><f t = "array" ref = "A1:B2">SUM(1)</f><v>1</v></c></row>',
            "<row r=\"1\"><c r=\"A1\"><f t='shared' si='0'>SUM(1)</f><v>1</v></c></row>",
            // Parses as `A1`, so the scanner misses the cell and appends a duplicate.
            '<row r="1"><c r="A&#49;"><v>1</v></c></row>',
            // A default-namespace override rebinds the row and every unprefixed
            // child, so a `<c>` spliced in is not a SpreadsheetML cell at all — the
            // save would report success having written nothing Excel can see.
            '<row xmlns="urn:not-spreadsheet" r="1"><c r="B1"><v>1</v></c></row>',
            // Any whitespace separates a tag name from its attributes, and a
            // pretty-printer that writes one attribute per line uses a newline.
            // Looking for a space alone found no attributes at all, so the
            // subtraction examined an empty string and this unreadable `s` passed
            // unexamined — the edit then dropped the cell's formatting.
            '<row r="1"><c\nr="A1"\ns=\'7\'><v>1</v></c></row>',
            '<row r="1"><c\tr="A1"\ts=\'7\'><v>1</v></c></row>',
        ];
        for (const inner of cases) {
            expect(() => apply_cell_edits(
                doc(inner),
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            )).toThrow(/cannot\s+edit\s+safely/i);
        }
    });

    it('refuses markup-compatibility alternate content', () => {
        // Both branches spell row 1 / A1, and which one a reader believes depends
        // on whether it understands `Requires`. The scans are flat coordinate maps,
        // so the last branch won: the edit landed in `mc:Fallback` alone, every
        // application honouring the `mc:Choice` kept showing the old value, and the
        // save reported success.
        const inner = '<mc:AlternateContent'
            + ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
            + '<mc:Choice Requires="x14">'
            + '<row r="1"><c r="A1" t="inlineStr"><is><t>choice</t></is></c></row></mc:Choice>'
            + '<mc:Fallback>'
            + '<row r="1"><c r="A1" t="inlineStr"><is><t>fallback</t></is></c></row></mc:Fallback>'
            + '</mc:AlternateContent>';
        expect(() => apply_cell_edits(doc(inner), [{ row: 0, col: 0, value: 'edited' }], OPTS))
            .toThrow(/cannot\s+edit\s+safely/i);
        // The prefix is a convention, not a rule; an unprefixed default-namespace
        // spelling is the same element and the same hazard.
        const bare = '<AlternateContent><Choice Requires="x14">'
            + '<row r="1"><c r="A1"><v>1</v></c></row></Choice>'
            + '<Fallback><row r="1"><c r="A1"><v>2</v></c></row></Fallback></AlternateContent>';
        expect(() => apply_cell_edits(doc(bare), [{ row: 0, col: 0, value: '3' }], OPTS))
            .toThrow(/cannot\s+edit\s+safely/i);
    });

    it('does not refuse alternate content quoted inside a comment', () => {
        const inner = '<row r="1"><c r="A1"><v>1</v></c></row>'
            + '<!-- <mc:AlternateContent/> -->';
        expect(apply_cell_edits(doc(inner), [{ row: 0, col: 0, value: '2' }], OPTS))
            .toContain('<c r="A1"><v>2</v></c>');
    });

    it('does not refuse ordinary attributes it never reads', () => {
        // The guard is a subtraction — anything left after canonical `name="value"`
        // pairs are removed is unreadable — so it has to leave attributes the writer
        // does not consume alone, entities and all.
        const inner = '<row r="1" spans="1:1" customFormat="1">'
            + '<c r="A1" s="3" t="n"><v>1</v></c></row>';
        expect(apply_cell_edits(doc(inner), [{ row: 0, col: 0, value: '2' }], OPTS))
            .toContain('<c r="A1" s="3"><v>2</v></c>');
    });

    it('does not refuse over markup quoted inside a comment', () => {
        // The guard scans raw text like the scanners do, so it has the same hazard
        // in the opposite direction: refusing a worksheet that edits perfectly well
        // because a comment happens to quote a shape it rejects.
        for (const inner of [
            '<row r="1"><c r="A1"><v>1</v></c></row><!-- <row r="2"><c><v>x</v></c></row> -->',
            '<row r="1"><c r="A1"><v>1</v></c></row><!-- <x:row><x:c/></x:row> -->',
        ]) {
            expect(apply_cell_edits(doc(inner), [{ row: 0, col: 0, value: '2' }], OPTS))
                .toContain('<c r="A1"><v>2</v></c>');
        }
    });

    it('writes a carriage return as a numeric reference', () => {
        // XML 1.0 requires every parser to normalize a raw `\r` in content to `\n`
        // before the application sees it, so a literal one is not preserved — it comes
        // back a line feed, and `\r\n` loses a character outright. The numeric
        // reference is exempt from that normalization and is the only spelling that
        // round-trips.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: 'left\r\nright' }],
            OPTS,
        );
        expect(out).toContain('left&#13;\nright');
        expect(out).not.toMatch(/left\r/);
    });

    it('keeps a boolean cell boolean', () => {
        // The reader renders `t="b"` as TRUE/FALSE, so that is the text the user
        // retypes. Storing it as an inline string looks identical in the grid and
        // silently changes the cell's type for every consumer of the file.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1" t="b"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: 'FALSE' }],
            OPTS,
        );
        expect(out).toContain('<c r="A1" t="b"><v>0</v></c>');
        expect(out).not.toContain('inlineStr');

        // Only for a cell that was already boolean, and only for those two words.
        expect(apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: 'TRUE' }],
            OPTS,
        )).toContain('inlineStr');
        expect(apply_cell_edits(
            doc('<row r="1"><c r="A1" t="b"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: 'maybe' }],
            OPTS,
        )).toContain('inlineStr');
    });

    it('orders several new rows by row, whatever order they were edited in', () => {
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row>'),
            [{ row: 9, col: 0, value: 'ten' }, { row: 4, col: 0, value: 'five' }],
            OPTS,
        );
        expect(out.indexOf('r="A5"')).toBeLessThan(out.indexOf('r="A10"'));
    });

    it('gives a self-closing row a body rather than splicing into its tag', () => {
        // `<row r="2" ht="20" customHeight="1"/>` is what a row with a height but
        // no cells looks like. There is no `</row>` to insert before.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row><row r="2" ht="20" customHeight="1"/>'),
            [{ row: 1, col: 0, value: 'here' }],
            OPTS,
        );
        expect(out).toContain('<row r="2" ht="20" customHeight="1">');
        expect(out).toContain('r="A2"');
        expect(out).not.toContain('customHeight="1"/>');
        // Still well-formed: one open and one close for every row.
        expect(out.match(/<row\b/g)).toHaveLength(2);
        expect(out.match(/<\/row>/g)).toHaveLength(2);
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
        const out = widen_dimension('<x><dimension ref="A1:B2"/></x>', 5, 4, 5, 4);
        expect(out).toContain('ref="A1:E6"');
    });

    it('never shrinks an existing extent', () => {
        const xml = '<x><dimension ref="A1:Z100"/></x>';
        expect(widen_dimension(xml, 1, 1, 1, 1)).toBe(xml);
    });

    it('grows the top-left corner too', () => {
        // A used range that does not start at A1 is ordinary — a table with a
        // margin above and to the left. Writing into that margin has to move the
        // start, or the recorded range excludes the cell just written.
        const out = widen_dimension('<x><dimension ref="C3:D4"/></x>', 0, 0, 0, 0);
        expect(out).toContain('ref="A1:D4"');
    });

    it('tolerates a single-cell ref', () => {
        expect(widen_dimension('<x><dimension ref="A1"/></x>', 2, 2, 2, 2)).toContain('ref="A1:C3"');
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

    it('reads a format code as it means, not as it is escaped', async () => {
        // `formatCode` is an XML attribute, so an ordinary custom format that
        // happens to contain a quote or an ampersand — `0 "&"` — is stored escaped.
        // `SSF.is_date` answers *true* for the escaped text and false for what it
        // means, so a cell under that format took a typed date as a serial and
        // showed the user a five-digit number under a format that is not a date.
        const raw = readFileSync(FORMATTED);
        const file = CFB.read(raw, { type: 'buffer' });
        const entry = CFB.find(file, '/xl/styles.xml')!;
        const patched = Buffer.from(
            Buffer.from(entry.content as Uint8Array).toString('utf8')
                .replace('formatCode="$#,##0.00"', 'formatCode="0 &quot;&amp;&quot;"'),
            'utf8',
        );
        entry.content = patched;
        entry.size = patched.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        const bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        // A1 carries style 1, which is that format.
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        const { data } = await parse_xlsx(out);
        expect(data.sheets[0].rows[0][0]!.raw).toBe('2024-01-15');
    });

    it('does not treat a date section other than the first as a date cell', async () => {
        // `0;0;yyyy-mm-dd` displays positives as plain numbers and only *zero* as a
        // date, but `SSF.is_date` is true for the whole code. Storing a typed date
        // as a serial under it showed the user `45306` — the format's own positive
        // section rendering the serial it was just given.
        const raw = readFileSync(FORMATTED);
        const file = CFB.read(raw, { type: 'buffer' });
        const entry = CFB.find(file, '/xl/styles.xml')!;
        const patched = Buffer.from(
            Buffer.from(entry.content as Uint8Array).toString('utf8')
                .replace('formatCode="$#,##0.00"', 'formatCode="0;0;yyyy-mm-dd"'),
            'utf8',
        );
        entry.content = patched;
        entry.size = patched.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        const bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        const { data } = await parse_xlsx(out);
        expect(data.sheets[0].rows[0][0]!.raw).toBe('2024-01-15');
    });

    it('reads a condition that follows a colour in the same section', async () => {
        // `[Red][>50000]yyyy-mm-dd;0` is a date only above 50000; 45306 falls to the
        // plain-number section. Requiring the condition to be the section's very
        // first bracket made the colour hide it, so the code read as unconditional,
        // took the positive section, and stored a serial the cell showed as 45306.
        const raw = readFileSync(FORMATTED);
        const file = CFB.read(raw, { type: 'buffer' });
        const entry = CFB.find(file, '/xl/styles.xml')!;
        const patched = Buffer.from(
            Buffer.from(entry.content as Uint8Array).toString('utf8')
                .replace(
                    'formatCode="$#,##0.00"',
                    'formatCode="[Red][&gt;50000]yyyy-mm-dd;0"',
                ),
            'utf8',
        );
        entry.content = patched;
        entry.size = patched.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        const bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        const { data } = await parse_xlsx(out);
        expect(data.sheets[0].rows[0][0]!.raw).toBe('2024-01-15');
    });

    it('still writes a serial when only the trailing text section differs', () => {
        // `mm/dd/yy;@` is how Excel spells "date, and show text as typed" — the
        // positive section is the date, so narrowing to it must not lose this.
        const raw = readFileSync(FORMATTED);
        const file = CFB.read(raw, { type: 'buffer' });
        const entry = CFB.find(file, '/xl/styles.xml')!;
        const patched = Buffer.from(
            Buffer.from(entry.content as Uint8Array).toString('utf8')
                .replace('formatCode="$#,##0.00"', 'formatCode="mm/dd/yy;@"'),
            'utf8',
        );
        entry.content = patched;
        entry.size = patched.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        const bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        expect(part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8'))
            .toContain('<v>45306</v>');
    });

    it('numbers worksheets correctly when a sheet name contains a raw >', () => {
        // `Welcome > Intro` is a legal sheet name and needs no escaping in the
        // attribute. Under `[^>]*` the `<sheet>` tag was cut before its `name=`,
        // the entry was skipped as unnamed, every later worksheet shifted down one
        // — and an edit aimed at sheet 0 was written into sheet 1. Valid on disk,
        // and wrong.
        const raw = readFileSync(FORMATTED);
        const file = CFB.read(raw, { type: 'buffer' });
        const wb = CFB.find(file, '/xl/workbook.xml')!;
        const text = Buffer.from(wb.content as Uint8Array).toString('utf8');
        const first = /<sheet\b[^>]*name="([^"]*)"/.exec(text)![1];
        const patched = Buffer.from(
            text.replace(`name="${first}"`, 'name="Welcome > Intro"'),
            'utf8',
        );
        wb.content = patched;
        wb.size = patched.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        const bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: 'MARK' }]);
        expect(part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('MARK');
    });

    it('reads a number format containing a legal raw >', () => {
        // The same defect one part over: `<numFmts>` and its `<numFmt>` entries were
        // matched with `[^>]*`, so a format code as ordinary as `yyyy>mm` cut its
        // own tag short. The format went unread, the cell's date style was
        // invisible, and a typed date was stored as an inline string under a format
        // that renders dates.
        const bytes = patched_styles('formatCode="$#,##0.00"', 'formatCode="yyyy>mm"');
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        expect(part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8'))
            .toContain('<v>45306</v>');
    });

    it('reads date1904 past a legal raw > in an earlier workbookPr attribute', () => {
        // The two epochs are 1462 days apart, so misreading the mode writes a date
        // four years off. `[^>]*` cut `<workbookPr>` before `date1904`, and a 1904
        // workbook read as 1900.
        const file = CFB.read(
            patched_styles('formatCode="$#,##0.00"', 'formatCode="yyyy-mm-dd"'),
            { type: 'buffer' },
        );
        const wb = CFB.find(file, '/xl/workbook.xml')!;
        const patched = Buffer.from(
            Buffer.from(wb.content as Uint8Array).toString('utf8')
                .replace('<workbookPr ', '<workbookPr note="1 > 0" date1904="1" '),
            'utf8',
        );
        wb.content = patched;
        wb.size = patched.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        const bytes = written instanceof Uint8Array
            ? written
            : new Uint8Array(written as ArrayBufferLike);

        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        expect(part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8'))
            .toContain('<v>43844</v>');
    });

    it('resolves a relationship target containing a dot segment', () => {
        // `./worksheets/sheet1.xml` names the same part as `worksheets/sheet1.xml`.
        // Concatenated without resolving, it became `xl/./worksheets/sheet1.xml`,
        // matched no entry, and the save failed outright on a file Excel opens fine.
        // `resolve_part_path` now lives in the reader and is shared, because the two
        // resolving it differently was worse than either being wrong alone: the reader
        // displayed the worksheet empty while the writer happily spliced into it.
        const bytes = patched_parts([[
            '/xl/_rels/workbook.xml.rels',
            'Target="worksheets/sheet1.xml"',
            'Target="./worksheets/sheet1.xml"',
        ]]);
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '9' }]);
        expect(part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('>9<');
    });

    it('refuses styles whose xf indexes it would number differently than the reader', () => {
        // A cell's `s` indexes `cellXfs`, so both sides must agree on its length or
        // every style after the divergence means a different format to each. The
        // reader counts an `<xf>` written inside CDATA; this writer skips it, which
        // is right about XML and wrong about the file — `s="0"` named General to the
        // reader and a date format here, so a typed date went in as the serial 45306
        // and that is what the user saw.
        const bytes = patched_parts([['/xl/styles.xml', /<cellXfs[\s\S]*<\/cellXfs>/,
            '<cellXfs count="1"><![CDATA[<xf numFmtId="0"/>]]><xf numFmtId="14"/></cellXfs>']]);
        expect(() => write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]))
            .toThrow(/cannot\s+read\s+safely/i);
    });

    it('numbers worksheets exactly as the reader does', () => {
        // `sheet_index` is the index of the worksheet the *user* was looking at, so
        // any enumeration difference saves into a different sheet: a valid file with
        // the edit in the wrong place and no error. The writer had its own copy of the
        // enumeration and drifted twice — it read both quote styles where the reader's
        // `get_attr` reads only `"…"`, and it skipped `<sheet>` tags in comments where
        // the reader counts them. Both are the writer being *more* nearly correct, and
        // both wrote to the wrong worksheet, so the two now share one enumeration.
        // Two sheets, so a numbering shift has somewhere wrong to land.
        for (const patch of [
            // A legally single-quoted name: unreadable to the reader, so it drops the
            // sheet, and its index 0 is the *second* worksheet.
            ['name="People"', "name='People'"],
            // A commented-out entry: text to a parser, a sheet to the reader. Pointed
            // at the *second* worksheet's relationship, so the reader's sheet 0 is
            // `Inventory` while a comment-skipping writer's is `People` — a wrong-sheet
            // write with both parts present to tell them apart.
            ['<sheets>', '<sheets><!-- <sheet name="Gone" sheetId="9" r:id="rId5"/> -->'],
        ] as const) {
            const bytes = patched_basic([['/xl/workbook.xml', patch[0], patch[1]]]);
            const reader_paths = worksheet_part_paths(bytes);
            const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: 'MARK' }]);
            // Whatever the reader calls sheet 0 is the part that changed, and no other.
            // Deduplicated: a workbook may legally list one part twice, and these
            // patches do, so "every other entry" would otherwise include sheet 0.
            expect(part(out, `/${reader_paths[0]}`)!.toString('utf8')).toContain('MARK');
            for (const other of new Set(reader_paths.slice(1))) {
                if (other === reader_paths[0]) continue;
                expect(part(out, `/${other}`)!.toString('utf8')).not.toContain('MARK');
            }
        }
    });

    it('reads a number-format condition whose bound is written +N', () => {
        // `[>+50000]` is the same condition as `[>50000]`. Read as unconditional, the
        // date section was picked for a value the cell displays with the fallback, so
        // a typed date went in as a serial the user then sees as 45306.
        const bytes = patched_parts([
            ['/xl/styles.xml', 'formatCode="$#,##0.00"', 'formatCode="[>+50000]yyyy-mm-dd;0"'],
        ]);
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        // 45306 is below the bound, so the fallback `0` section applies — not a date
        // format, so the date stays text rather than becoming a bare serial.
        expect(part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8'))
            .toContain('2024-01-15');
    });

    it('reads a formatCode written with single quotes', () => {
        // Both quote styles are legal XML, and calling one of them malformed was
        // this module's own invention: `formatCode='yyyy-mm-dd'` went unread, so the
        // style did not look like a date and a typed date was written as text.
        const bytes = patched_parts([
            ['/xl/styles.xml', /formatCode="([^"]*)"/, "formatCode='yyyy-mm-dd'"],
        ]);
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        expect(part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8'))
            .toContain('<v>45306</v>');
    });

    it('matches a relationship id spelled with a character reference', () => {
        // `Id="R1&#54;f42588a6664ec0"` and `r:id="R16f42588a6664ec0"` are one
        // relationship to a parser and two strings to a raw compare. The lookup
        // missed, the first worksheet was skipped as unresolvable, and the edit
        // aimed at sheet 0 landed in sheet2.xml — a valid file, wrong sheet.
        const file = CFB.read(readFileSync(SAMPLE), { type: 'buffer' });
        const rels = CFB.find(file, '/xl/_rels/workbook.xml.rels')!;
        const before = Buffer.from(rels.content as Uint8Array).toString('utf8');
        const after = before.replace('Id="R16f42588a6664ec0"', 'Id="R1&#54;f42588a6664ec0"');
        expect(after).not.toBe(before);
        const patched = Buffer.from(after, 'utf8');
        rels.content = patched;
        rels.size = patched.length;
        const w = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        const bytes = w instanceof Uint8Array ? w : new Uint8Array(w as ArrayBufferLike);

        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: 'MARK' }]);
        expect(part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('MARK');
        expect(part(out, '/xl/worksheets/sheet2.xml')!.toString('utf8')).not.toContain('MARK');
    });

    it('reads date1904 spelled with a character reference', () => {
        const bytes = patched_parts([
            ['/xl/styles.xml', 'formatCode="$#,##0.00"', 'formatCode="yyyy-mm-dd"'],
            ['/xl/workbook.xml', '<workbookPr ', '<workbookPr date1904="&#49;" '],
        ]);
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        // 1904 epoch. Read as 1900 it is 45306 — a date four years off, not a
        // rounding error.
        expect(part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8'))
            .toContain('<v>43844</v>');
    });

    it('reads a numFmtId spelled with a character reference', () => {
        // An encoded digit is still a digit: `numFmtId="16&#52;"` is 164, the
        // custom date format. Matched raw, `"(\d+)"` failed, the index fell back
        // to 0, and a typed date was stored as an inline string under a format
        // that renders dates.
        const bytes = patched_parts([
            ['/xl/styles.xml', 'formatCode="$#,##0.00"', 'formatCode="yyyy-mm-dd"'],
            ['/xl/styles.xml', '<xf numFmtId="164"', '<xf numFmtId="16&#52;"'],
        ]);
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        expect(part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8'))
            .toContain('<v>45306</v>');
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

    it('numbers sheets exactly as the reader does', async () => {
        // The one way this can be wrong without anything failing: the writer
        // resolves `sheet_index` through a different enumeration than
        // `parse_xlsx`, and the edit lands in a valid file, on the wrong sheet.
        // The 8-sheet sample is the check, one sheet at a time.
        const raw = readFileSync(SAMPLE);
        const before = (await parse_xlsx(raw)).data.sheets;
        for (let index = 0; index < before.length; index += 1) {
            const out = write_xlsx_cell_edits(raw, index, [
                { row: 0, col: 0, value: `marker-${index}` },
            ]);
            const after = (await parse_xlsx(out)).data.sheets;
            expect(after[index].rows[0][0]!.raw, before[index].name).toBe(`marker-${index}`);
        }
    });

    describe('calcChain.xml', () => {
        /**
         * A workbook carrying a calculation chain, built rather than committed as a
         * fixture: none of the sample files has one, and the point of the test is
         * the three references (part, content type, relationship) moving together.
         */
        function with_calc_chain(
            raw: Uint8Array,
            paired: false | 'tight' | 'pretty' | 'commented' = false,
            /**
             * An extra attribute placed ahead of the ones that matter, on both
             * references. `note="1 > 0"` is legal XML — a raw `>` inside a quoted
             * value needs no escaping — and it is exactly what a `[^>]*` match cuts
             * the tag short on.
             */
            extra = '',
        ): Uint8Array {
            const file = CFB.read(raw, { type: 'buffer' });
            CFB.utils.cfb_add(
                file,
                '/xl/calcChain.xml',
                Buffer.from('<?xml version="1.0"?><calcChain><c r="B2" i="1"/></calcChain>'),
            );
            // XML lets an empty element be written either way, and writers in the
            // wild use both. `paired` produces the `<X ...></X>` spelling —
            // 'pretty' with the newline a pretty-printer puts between the halves.
            const empty = (tag: string, attrs: string) => {
                const all = `${extra}${attrs}`;
                if (!paired) return `<${tag} ${all}/>`;
                // 'commented' puts the element's own end-tag spelling inside a
                // comment — text, not markup, and the raw `indexOf` that used to
                // locate the real one stopped there instead.
                const gap = paired === 'pretty'
                    ? '\n    '
                    : paired === 'commented' ? `<!-- </${tag}> -->` : '';
                return `<${tag} ${all}>${gap}</${tag}>`;
            };
            for (const [path, insert] of [
                ['/[Content_Types].xml', empty(
                    'Override',
                    'PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"',
                )],
                ['/xl/_rels/workbook.xml.rels', empty(
                    'Relationship',
                    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml" Id="RcalcChain"',
                )],
            ] as const) {
                const entry = CFB.find(file, path)!;
                const text = Buffer.from(entry.content as Uint8Array).toString('utf8');
                const at = text.lastIndexOf('</');
                const next = Buffer.from(text.slice(0, at) + insert + text.slice(at), 'utf8');
                entry.content = next;
                entry.size = next.length;
            }
            const out = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
            return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBufferLike);
        }

        function text_part(bytes: Uint8Array, path: string): string {
            return part(bytes, path)?.toString('utf8') ?? '';
        }

        it('survives an edit that overwrites no formula', () => {
            const raw = with_calc_chain(readFileSync(SAMPLE));
            const out = write_xlsx_cell_edits(raw, 2, [{ row: 1, col: 1, value: '42' }]);
            expect(part(out, '/xl/calcChain.xml')).toEqual(part(raw, '/xl/calcChain.xml'));
            expect(text_part(out, '/[Content_Types].xml'))
                .toContain('/xl/calcChain.xml');
        });

        // Same as below, with `<Override ...></Override>` and
        // `<Relationship ...></Relationship>`. Matching only the self-closing
        // spelling left the package naming a part it no longer contains — and
        // matching only a *tight* pair left a pretty-printed package the same way.
        it.each(['tight', 'pretty'] as const)(
            'is detached completely when its references use %s paired empty elements',
            (spelling) => {
            const base = CFB.read(readFileSync(SAMPLE), { type: 'buffer' });
            const sheet = CFB.find(base, '/xl/worksheets/sheet3.xml')!;
            const patched = Buffer.from(
                Buffer.from(sheet.content as Uint8Array).toString('utf8')
                    .replace(/<c r="B2"[^>]*(?:\/>|>[\s\S]*?<\/c>)/, '<c r="B2"><f>1+1</f><v>2</v></c>'),
                'utf8',
            );
            sheet.content = patched;
            sheet.size = patched.length;
            const written = CFB.write(base, { type: 'buffer', fileType: 'zip', compression: true });
            const raw = with_calc_chain(
                written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBufferLike),
                spelling,
            );

            const out = write_xlsx_cell_edits(raw, 2, [{ row: 1, col: 1, value: '42' }]);

            expect(part(out, '/xl/calcChain.xml')).toBeNull();
            expect(text_part(out, '/[Content_Types].xml')).not.toContain('/xl/calcChain.xml');
            expect(text_part(out, '/xl/_rels/workbook.xml.rels')).not.toContain('calcChain.xml');
            },
        );

        it('is detached completely when an edit drops a formula', () => {
            // The chain caches recalculation order; a literal written over a
            // formula makes it stale, and a stale chain is what Excel offers to
            // repair. Every reference has to go with it, or the package points at
            // a part it no longer contains.
            const base = CFB.read(readFileSync(SAMPLE), { type: 'buffer' });
            const sheet = CFB.find(base, '/xl/worksheets/sheet3.xml')!;
            const patched = Buffer.from(
                Buffer.from(sheet.content as Uint8Array).toString('utf8')
                    .replace(/<c r="B2"[^>]*(?:\/>|>[\s\S]*?<\/c>)/, '<c r="B2"><f>1+1</f><v>2</v></c>'),
                'utf8',
            );
            sheet.content = patched;
            sheet.size = patched.length;
            const written = CFB.write(base, { type: 'buffer', fileType: 'zip', compression: true });
            const raw = with_calc_chain(
                written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBufferLike),
            );
            expect(text_part(raw, '/xl/worksheets/sheet3.xml')).toContain('<f>1+1</f>');

            const out = write_xlsx_cell_edits(raw, 2, [{ row: 1, col: 1, value: '42' }]);

            expect(part(out, '/xl/calcChain.xml')).toBeNull();
            expect(text_part(out, '/[Content_Types].xml')).not.toContain('/xl/calcChain.xml');
            expect(text_part(out, '/xl/_rels/workbook.xml.rels')).not.toContain('calcChain.xml');
        });

        it('is detached completely when its references contain a comment', () => {
            // `<Override ...><!-- </Override> --></Override>` is one element: the
            // text inside a comment is not markup. Locating the end tag with a raw
            // `indexOf` stopped at the commented one, so the element looked like it
            // had content, the removal declined to touch it, and the part was
            // deleted with both references still naming it.
            const base = CFB.read(readFileSync(SAMPLE), { type: 'buffer' });
            const sheet = CFB.find(base, '/xl/worksheets/sheet3.xml')!;
            const patched = Buffer.from(
                Buffer.from(sheet.content as Uint8Array).toString('utf8')
                    .replace(/<c r="B2"[^>]*(?:\/>|>[\s\S]*?<\/c>)/, '<c r="B2"><f>1+1</f><v>2</v></c>'),
                'utf8',
            );
            sheet.content = patched;
            sheet.size = patched.length;
            const written = CFB.write(base, { type: 'buffer', fileType: 'zip', compression: true });
            const raw = with_calc_chain(
                written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBufferLike),
                'commented',
            );

            const out = write_xlsx_cell_edits(raw, 2, [{ row: 1, col: 1, value: '42' }]);

            expect(part(out, '/xl/calcChain.xml')).toBeNull();
            expect(text_part(out, '/[Content_Types].xml')).not.toContain('/xl/calcChain.xml');
            expect(text_part(out, '/xl/_rels/workbook.xml.rels')).not.toContain('calcChain.xml');
        });

        it('is detached completely when its references carry a legal raw >', () => {
            // `<Override note="1 > 0" PartName=.../>` is ordinary XML: a raw `>`
            // inside a quoted attribute value needs no escaping. Matching it with
            // `[^>]*` cut the tag at that `>`, so neither reference matched, and the
            // part was deleted while the content type and the relationship both went
            // on naming it — a dangling reference, which is the repair prompt this
            // removal exists to avoid.
            const base = CFB.read(readFileSync(SAMPLE), { type: 'buffer' });
            const sheet = CFB.find(base, '/xl/worksheets/sheet3.xml')!;
            const patched = Buffer.from(
                Buffer.from(sheet.content as Uint8Array).toString('utf8')
                    .replace(/<c r="B2"[^>]*(?:\/>|>[\s\S]*?<\/c>)/, '<c r="B2"><f>1+1</f><v>2</v></c>'),
                'utf8',
            );
            sheet.content = patched;
            sheet.size = patched.length;
            const written = CFB.write(base, { type: 'buffer', fileType: 'zip', compression: true });
            const raw = with_calc_chain(
                written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBufferLike),
                false,
                'note="1 > 0" ',
            );

            const out = write_xlsx_cell_edits(raw, 2, [{ row: 1, col: 1, value: '42' }]);

            expect(part(out, '/xl/calcChain.xml')).toBeNull();
            expect(text_part(out, '/[Content_Types].xml')).not.toContain('/xl/calcChain.xml');
            expect(text_part(out, '/xl/_rels/workbook.xml.rels')).not.toContain('calcChain.xml');
        });
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
