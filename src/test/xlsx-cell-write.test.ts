import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import CFB from 'cfb';
import {
    capture_xlsx_append_row_format,
    create_xlsx_formula_write_plan,
    xlsx_append_style_dependency_fingerprint,
    write_xlsx_cell_edits,
    write_xlsx_workbook_cell_edits,
} from '../xlsx-package';
import { parse_xlsx, worksheet_part_paths } from '../parse-xlsx';
import {
    apply_cell_edits,
    apply_utf8_splices,
    col_index_to_letter,
    formula_count,
    iso_to_serial,
    update_formula_cached_values,
    widen_dimension,
} from '../xlsx-cell-write';
import { OoxmlRefusalError, type OoxmlRefusalCode } from '../ooxml-refusal';
import { format_xlsx_edit_preview } from '../spreadsheet-format';
import { classify_xlsx_cell_value } from '../xlsx-cell-value';
import { ZipPackage } from '../zip-package';
import { plan_workbook_formula_recalculation } from '../formula-dependencies';

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

function expect_refusal(
    action: () => unknown,
    code: OoxmlRefusalCode,
    coordinate?: string,
): OoxmlRefusalError {
    let caught: unknown;
    try {
        action();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(OoxmlRefusalError);
    const refusal = caught as OoxmlRefusalError;
    expect(refusal.code).toBe(code);
    if (coordinate !== undefined) expect(refusal.coordinate).toBe(coordinate);
    return refusal;
}

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

describe('append style dependency fingerprint', () => {
    it('ignores unused root namespace declarations', () => {
        const raw = readFileSync(FORMATTED);
        const baseline = xlsx_append_style_dependency_fingerprint(raw, [1]);
        const with_unused_namespace = patched_styles(
            '<styleSheet xmlns="',
            '<styleSheet xmlns:vendor="urn:unused" xmlns="',
        );
        expect(xlsx_append_style_dependency_fingerprint(with_unused_namespace, [1]))
            .toBe(baseline);
    });

    it('tracks the selected xf and its transitive base-style resources only', () => {
        const raw = readFileSync(FORMATTED);
        const baseline = xlsx_append_style_dependency_fingerprint(raw, [1]);
        expect(xlsx_append_style_dependency_fingerprint(patched_styles(
            '<numFmt numFmtId="165" formatCode="yyyy-mm-dd"/>',
            '<numFmt numFmtId="165" formatCode="yyyy/mm/dd"/>',
        ), [1])).toBe(baseline);
        expect(xlsx_append_style_dependency_fingerprint(patched_styles(
            '<name val="Calibri"/>',
            '<name val="Aptos"/>',
        ), [1])).not.toBe(baseline);
        expect(xlsx_append_style_dependency_fingerprint(patched_styles(
            '<cellStyleXfs count="1"><xf numFmtId="0"',
            '<cellStyleXfs count="1"><xf numFmtId="164"',
        ), [1])).not.toBe(baseline);
    });

    it('distinguishes a foreign element with the same local style name', () => {
        const raw = readFileSync(FORMATTED);
        const baseline = xlsx_append_style_dependency_fingerprint(raw, [1]);
        const foreign_font = patched_parts([
            [
                '/xl/styles.xml',
                '<styleSheet xmlns="',
                '<styleSheet xmlns:v="urn:vendor" xmlns="',
            ],
            [
                '/xl/styles.xml',
                '<font><color theme="1"/><family val="2"/><scheme val="minor"/><sz val="11"/><name val="Calibri"/></font>',
                '<v:font><color theme="1"/><family val="2"/><scheme val="minor"/><sz val="11"/><name val="Calibri"/></v:font>',
            ],
        ]);
        expect(xlsx_append_style_dependency_fingerprint(foreign_font, [1]))
            .not.toBe(baseline);
    });
});

describe('append row-format capture', () => {
    it('uses the preceding body row when the physical final row is the active header', () => {
        const raw = patched_basic([[
            '/xl/worksheets/sheet1.xml',
            '<row r="2" spans="1:4" x14ac:dyDescent="0.25">',
            '<row r="2" spans="1:4" x14ac:dyDescent="0.25" s="1" customFormat="1" '
                + 'ht="21" customHeight="1" thickTop="1" thickBot="1" ph="1" '
                + 'hidden="1" collapsed="1" outlineLevel="2">',
        ]]);

        const format = capture_xlsx_append_row_format(raw, 0, 3, 4, 2);
        expect(format).toMatchObject({
            kind: 'xlsx',
            templateSourceRow: 1,
            rowStyleIndex: 1,
            nativeRowHeight: 21,
            thickTop: true,
            thickBottom: true,
            phonetic: true,
            cellStyleIndexes: [null, null, null, 1],
        });
        expect(format).not.toHaveProperty('hidden');
        expect(format).not.toHaveProperty('collapsed');
        expect(format).not.toHaveProperty('outlineLevel');
        expect(format.styleFingerprint)
            .toBe(xlsx_append_style_dependency_fingerprint(raw, [null, null, null, 1], 1));
    });

    it('rejects a style index with trailing non-numeric text', () => {
        const raw = patched_basic([[
            '/xl/worksheets/sheet1.xml',
            '<c r="D2" s="1">',
            '<c r="D2" s="1x">',
        ]]);

        expect(() => capture_xlsx_append_row_format(raw, 0, 3, 4, 2))
            .toThrow('The append format row contains an invalid style');
    });

    it.each(['', '0x1', '1e2'])(
        'rejects the coercible non-decimal cell style index %j',
        (style) => {
            const raw = patched_basic([[
                '/xl/worksheets/sheet1.xml',
                '<c r="D2" s="1">',
                `<c r="D2" s="${style}">`,
            ]]);

            expect(() => capture_xlsx_append_row_format(raw, 0, 3, 4, 2))
                .toThrow('The append format row contains an invalid style');
        },
    );

    it.each(['', '0x1', '1e2'])(
        'rejects the coercible non-decimal row style index %j',
        (style) => {
            const raw = patched_basic([[
                '/xl/worksheets/sheet1.xml',
                '<row r="2" spans="1:4" x14ac:dyDescent="0.25">',
                '<row r="2" spans="1:4" x14ac:dyDescent="0.25" '
                    + `s="${style}" customFormat="1">`,
            ]]);

            expect(() => capture_xlsx_append_row_format(raw, 0, 3, 4, 2))
                .toThrow('The append format row contains an invalid row style');
        },
    );

    it('accepts legal signed and whitespace-normalized style indices', () => {
        const raw = patched_basic([[
            '/xl/worksheets/sheet1.xml',
            '<row r="2" spans="1:4" x14ac:dyDescent="0.25">',
            '<row r="2" spans="1:4" x14ac:dyDescent="0.25" '
                + 's=" +1 " customFormat="1">',
        ], [
            '/xl/worksheets/sheet1.xml',
            '<c r="D2" s="1">',
            '<c r="D2" s="+1">',
        ]]);

        expect(capture_xlsx_append_row_format(raw, 0, 3, 4, 2)).toMatchObject({
            rowStyleIndex: 1,
            cellStyleIndexes: [null, null, null, 1],
        });
    });
});

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

describe('classify_xlsx_cell_value', () => {
    it('treats the empty string as a cleared cell', () => {
        expect(classify_xlsx_cell_value('', OPTS)).toEqual({ kind: 'empty' });
    });

    it('infers numbers', () => {
        expect(classify_xlsx_cell_value('42', OPTS)).toEqual({ kind: 'number', text: '42' });
        expect(classify_xlsx_cell_value('-1.5e3', OPTS)).toEqual({ kind: 'number', text: '-1.5e3' });
    });

    it('keeps number-adjacent strings as strings', () => {
        // Zip codes, phone extensions and account ids are typed for their
        // spelling; storing them as numbers loses the padding irreversibly, and
        // the same text in a CSV round-trips verbatim.
        expect(classify_xlsx_cell_value('007', OPTS)).toEqual({ kind: 'string', text: '007' });
        expect(classify_xlsx_cell_value('00', OPTS).kind).toBe('string');
        expect(classify_xlsx_cell_value('007.5', OPTS).kind).toBe('string');
        expect(classify_xlsx_cell_value('1,000', OPTS).kind).toBe('string');
        expect(classify_xlsx_cell_value('12abc', OPTS).kind).toBe('string');
        expect(classify_xlsx_cell_value('Infinity', OPTS).kind).toBe('string');
    });

    it('still reads a single leading zero as part of the number', () => {
        // `0`, `0.5` and `0e0` spell their value; the zero is not padding.
        for (const text of ['0', '0.5', '-0.5', '.5', '0e0', '1.']) {
            expect(classify_xlsx_cell_value(text, OPTS).kind, text).toBe('number');
        }
    });

    it('stores a date as a serial only when the cell is already date-formatted', () => {
        const date_style = { datemode: 0 as const, is_date_style: () => true };
        expect(classify_xlsx_cell_value('2024-01-15', date_style))
            .toEqual({ kind: 'number', text: '45306' });
        // Under a General style the same text stays a string, so the user does
        // not see a bare serial where they typed a date.
        expect(classify_xlsx_cell_value('2024-01-15', OPTS))
            .toEqual({ kind: 'string', text: '2024-01-15' });
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
    it('refuses to preserve a self-closing grouped formula with no source', () => {
        const xml = doc('<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0"/></c></row>'
            + '<row r="2"><c r="A2"><f t="shared" si="0"/></c></row>');

        expect(() => apply_cell_edits(xml, [{
            row: 0,
            col: 0,
            value: '=SUM([Years])',
            preserve_formula_group: true,
        }], OPTS)).toThrow(/no formula source to replace/);
    });

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

    it('refuses to replace a shared-formula follower with a fixed value', () => {
        expect(() => apply_cell_edits(
            doc(
                '<row r="2"><c r="I2"><f t="shared" ref="I2:I15" si="0">E2*F2</f><v>2</v></c></row>'
                + '<row r="5"><c r="I5" s="16"><f t="shared" si="0"/><v>18.13</v></c></row>'
                + '<row r="6"><c r="I6"><f t="shared" si="0"/><v>65.78</v></c></row>',
            ),
            [{ row: 4, col: 8, value: '19' }],
            OPTS,
        )).toThrow(
            'Cannot edit I5: this cell is calculated by a shared formula. '
            + "Edit the formula's input cells instead, or replace the formula in Excel first.",
        );
    });

    it('edits an input cell referenced by a formula without replacing the formula', () => {
        const out = apply_cell_edits(
            doc(
                '<row r="5"><c r="E5"><v>13</v></c><c r="F5"><v>4.5</v></c>'
                + '<c r="I5"><f>E5*F5</f><v>58.5</v></c></row>',
            ),
            [{ row: 4, col: 4, value: '14' }],
            OPTS,
        );
        expect(out).toContain('<c r="E5"><v>14</v></c>');
        expect(out).toContain('<c r="I5"><f>E5*F5</f></c>');
        expect(out).not.toContain('<v>58.5</v>');
    });

    it('invalidates formula caches recursively and leaves unrelated caches intact', () => {
        const out = apply_cell_edits(
            doc(
                '<row r="1"><c r="A1"><v>2</v></c>'
                + '<c r="B1"><f>A1*2</f><v>4</v></c>'
                + '<c r="C1"><f>B1*3</f><v>12</v></c>'
                + '<c r="D1"><f>Z1</f><v>99</v></c></row>',
            ),
            [{ row: 0, col: 0, value: '3' }],
            OPTS,
        );
        expect(out).toContain('<c r="B1"><f>A1*2</f></c>');
        expect(out).toContain('<c r="C1"><f>B1*3</f></c>');
        expect(out).toContain('<c r="D1"><f>Z1</f><v>99</v></c>');
    });

    it('uses the formula namespace prefix when adding a missing cache value', () => {
        const xml = Buffer.from(
            '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + '<x:sheetData><x:row r="1"><x:c r="A1"><x:f>1+1</x:f></x:c>'
            + '</x:row></x:sheetData></x:worksheet>',
        );
        const out = update_formula_cached_values(
            xml,
            [{ row: 0, column: 0 }],
            [{ row: 0, column: 0, value: '2' }],
        ).toString();

        expect(out).toContain('<x:f>1+1</x:f><x:v>2</x:v>');
        expect(out).not.toContain('<v>2</v>');
    });

    it('uses the cell namespace when a formula prefix is declared only on the formula', () => {
        const xml = Buffer.from(
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + '<sheetData><row r="1"><c r="A1">'
            + '<p:f xmlns:p="http://schemas.openxmlformats.org/spreadsheetml/2006/main">1+1</p:f>'
            + '</c></row></sheetData></worksheet>',
        );
        const out = update_formula_cached_values(
            xml,
            [{ row: 0, column: 0 }],
            [{ row: 0, column: 0, value: '2' }],
        ).toString();

        expect(out).toContain('</p:f><v>2</v>');
        expect(out).not.toContain('<p:v>');
    });

    it('preserves an existing cache element opening tag and local namespace declaration', () => {
        const xml = Buffer.from(
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + '<sheetData><row r="1"><c r="A1"><f>1+1</f>'
            + '<q:v xmlns:q="http://schemas.openxmlformats.org/spreadsheetml/2006/main" vendor="keep">1</q:v>'
            + '</c></row></sheetData></worksheet>',
        );
        const out = update_formula_cached_values(
            xml,
            [{ row: 0, column: 0 }],
            [{ row: 0, column: 0, value: '2' }],
        ).toString();

        expect(out).toContain(
            '<q:v xmlns:q="http://schemas.openxmlformats.org/spreadsheetml/2006/main" vendor="keep">2</q:v>',
        );
    });

    it('updates only a direct SpreadsheetML cache child, preserving nested foreign v elements', () => {
        const xml = Buffer.from(
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + '<sheetData><row r="1"><c r="A1"><f>1+1</f>'
            + '<extLst><ext xmlns="urn:vendor"><v>KEEP</v></ext></extLst>'
            + '</c></row></sheetData></worksheet>',
        );
        const out = update_formula_cached_values(
            xml,
            [{ row: 0, column: 0 }],
            [{ row: 0, column: 0, value: '2' }],
        ).toString();

        expect(out).toContain('<ext xmlns="urn:vendor"><v>KEEP</v></ext>');
        expect(out).toContain('<f>1+1</f><v>2</v><extLst>');
    });

    it('invalidates cache-only followers of an affected array formula', () => {
        const out = apply_cell_edits(
            doc(
                '<row r="1"><c r="A1"><v>1</v></c>'
                + '<c r="B1"><f t="array" ref="B1:C1">A1*2</f><v>2</v></c>'
                + '<c r="C1"><v>2</v></c></row>',
            ),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );

        expect(out).toContain('<c r="B1"><f t="array" ref="B1:C1">A1*2</f></c>');
        expect(out).toContain('<c r="C1"></c>');
    });

    it('keeps unrelated shared-formula follower caches exact', () => {
        const out = apply_cell_edits(
            doc(
                '<row r="1"><c r="A1"><v>1</v></c>'
                + '<c r="B1"><f t="shared" ref="B1:B2" si="0">A1*2</f><v>2</v></c></row>'
                + '<row r="2"><c r="A2"><v>3</v></c>'
                + '<c r="B2"><f t="shared" si="0"/><v>6</v></c></row>',
            ),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );

        expect(out).toContain(
            '<c r="B1"><f t="shared" ref="B1:B2" si="0">A1*2</f></c>',
        );
        expect(out).toContain('<c r="B2"><f t="shared" si="0"/><v>6</v></c>');
    });

    it('invalidates every what-if data-table cache when an input changes', () => {
        const out = apply_cell_edits(
            doc(
                '<row r="1"><c r="A1"><f t="dataTable" ref="A1:B2" r1="$D$1"/><v>1</v></c>'
                + '<c r="B1"><v>2</v></c><c r="D1"><v>5</v></c></row>'
                + '<row r="2"><c r="A2"><v>3</v></c><c r="B2"><v>4</v></c></row>',
            ),
            [{ row: 0, col: 3, value: '6' }],
            OPTS,
        );

        expect(out).toContain('<c r="A1"><f t="dataTable" ref="A1:B2" r1="$D$1"/></c>');
        expect(out).toContain('<c r="B1"></c>');
        expect(out).toContain('<c r="A2"></c>');
        expect(out).toContain('<c r="B2"></c>');
        expect(out).toContain('<c r="D1"><v>6</v></c>');
    });

    it('writes calculated values for edited and dependent formulas', () => {
        const out = apply_cell_edits(
            doc(
                '<row r="1"><c r="A1"><v>2</v></c>'
                + '<c r="B1"><f>A1*2</f><v>4</v></c>'
                + '<c r="C1"><f>B1*3</f></c></row>',
            ),
            [
                { row: 0, col: 0, value: '3' },
                { row: 0, col: 3, value: '=C1+1' },
            ],
            {
                ...OPTS,
                formula_result_invalidations: [
                    { row: 0, column: 1 },
                    { row: 0, column: 2 },
                ],
                formula_result_updates: [
                    { row: 0, column: 1, value: '6' },
                    { row: 0, column: 2, value: '18' },
                    { row: 0, column: 3, value: '19' },
                ],
            },
        );
        expect(out).toContain('<c r="B1"><f>A1*2</f><v>6</v></c>');
        expect(out).toContain('<c r="C1"><f>B1*3</f><v>18</v></c>');
        expect(out).toContain('<c r="D1"><f>C1+1</f><v>19</v></c>');
    });

    it('removes stale formula result types when writing numeric caches', () => {
        const out = apply_cell_edits(
            doc(
                '<row r="1"><c r="A1"><v>1</v></c>'
                + '<c r="B1" s="2" t="e"><f>A1+1</f><v>#VALUE!</v></c>'
                + '<c r="C1" t="str"><f>A1+2</f><v>old</v></c></row>',
            ),
            [{ row: 0, col: 0, value: '2' }],
            {
                ...OPTS,
                formula_result_invalidations: [
                    { row: 0, column: 1 },
                    { row: 0, column: 2 },
                ],
                formula_result_updates: [
                    { row: 0, column: 1, value: '3' },
                    { row: 0, column: 2, value: '4' },
                ],
            },
        );
        expect(out).toContain('<c r="B1" s="2"><f>A1+1</f><v>3</v></c>');
        expect(out).toContain('<c r="C1"><f>A1+2</f><v>4</v></c>');
        expect(out).not.toContain('t="e"');
        expect(out).not.toContain('t="str"');
    });

    it('invalidates the matching shared-formula follower and its dependents', () => {
        const out = apply_cell_edits(
            doc(
                '<row r="1"><c r="A1"><v>2</v></c>'
                + '<c r="B1"><f t="shared" ref="B1:B2" si="0">A1*2</f><v>4</v></c></row>'
                + '<row r="2"><c r="A2"><v>3</v></c>'
                + '<c r="B2"><f t="shared" si="0"/><v>6</v></c>'
                + '<c r="C2"><f>B2*3</f><v>18</v></c></row>',
            ),
            [{ row: 1, col: 0, value: '4' }],
            OPTS,
        );
        expect(out).toContain('<c r="B1"><f t="shared" ref="B1:B2" si="0">A1*2</f><v>4</v></c>');
        expect(out).toContain('<c r="B2"><f t="shared" si="0"/></c>');
        expect(out).toContain('<c r="C2"><f>B2*3</f></c>');
    });

    it('recognizes explicit current-sheet qualifiers without crossing worksheets', () => {
        const out = apply_cell_edits(
            doc(
                '<row r="1"><c r="A1"><v>2</v></c>'
                + '<c r="B1"><f>Sheet1!A1*2</f><v>4</v></c>'
                + '<c r="C1"><f>Other!A1*3</f><v>6</v></c></row>',
            ),
            [{ row: 0, col: 0, value: '3' }],
            { ...OPTS, sheet_name: 'Sheet1' },
        );
        expect(out).toContain('<c r="B1"><f>Sheet1!A1*2</f></c>');
        expect(out).toContain('<c r="C1"><f>Other!A1*3</f><v>6</v></c>');
    });

    it('writes an entered formula instead of a literal string', () => {
        const out = apply_cell_edits(
            doc('<row r="5"><c r="I5" s="16"><f>E5*F5</f><v>58.5</v></c></row>'),
            [{ row: 4, col: 8, value: '=E5*F5+1' }],
            OPTS,
        );
        expect(out).toContain('<c r="I5" s="16"><f>E5*F5+1</f></c>');
        expect(out).not.toContain('&equals;');
        expect(out).not.toContain('inlineStr');
    });

    it('refuses to write an overlong formula through the low-level seam', () => {
        expect(() => apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: `=${'1'.repeat(8_193)}` }],
            OPTS,
        )).toThrow('Formula exceeds Excel\'s maximum length');
    });

    it('writes an edited shared follower as an explicit formula', () => {
        const out = apply_cell_edits(
            doc(
                '<row r="2"><c r="I2"><f t="shared" ref="I2:I15" si="0">E2*F2</f><v>2</v></c></row>'
                + '<row r="5"><c r="I5" s="16"><f t="shared" si="0"/><v>58.5</v></c></row>'
                + '<row r="6"><c r="I6"><f t="shared" si="0"/><v>65.78</v></c></row>',
            ),
            [{ row: 4, col: 8, value: '=E5*F5+1' }],
            OPTS,
        );
        expect(out).toContain('<c r="I5" s="16"><f>E5*F5+1</f></c>');
        expect(out).toContain('<f t="shared" ref="I2:I15" si="0">E2*F2</f>');
        expect(out).toContain('<c r="I6"><f t="shared" si="0"/><v>65.78</v></c>');
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

        // An unpaired surrogate is equally illegal and arrives the same way: a
        // JavaScript string can hold one, so a paste from a program that split a
        // code point carries it in unseen, and the part stops being readable.
        const lone = apply_cell_edits(
            doc('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'),
            [{ row: 0, col: 0, value: 'p\uD800q\uDC00r' }],
            OPTS,
        );
        expect(lone).toContain('pqr');
        expect(lone).not.toContain('\uD800');
        expect(lone).not.toContain('\uDC00');

        // A *paired* surrogate is an ordinary character and must survive.
        expect(apply_cell_edits(
            doc('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'),
            [{ row: 0, col: 0, value: 'a\u{1F600}b' }],
            OPTS,
        )).toContain('a\u{1F600}b');
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

    it('edits a live cell while preserving a commented-out duplicate as text', () => {
        // Reader and writer now share the same comment-aware scanner, so the quoted
        // cell is text to both. The live cell is replaced in place and no second
        // live coordinate is synthesized.
        const quoted = '<!-- <row r="1"><c r="A1"><v>stale</v></c></row> -->';
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row>' + quoted),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).toContain('<row r="1"><c r="A1"><v>2</v></c></row>');
        expect(out).toContain(quoted);
        expect(out.replace(quoted, '').match(/<c r="A1"/g)).toHaveLength(1);
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

    it('edits in place when one unnumbered row holds cells from two rows', () => {
        // Nothing forces an unnumbered row's cells to name a single row, and the
        // reader keys purely off `<c r=…>`, so it shows A1 and B2 on the two rows
        // they name. Taking only the *first* reference called the whole row row 1,
        // so editing B2 found no row 2, synthesized one, and left the file with two
        // cells claiming B2 — the old value and the new one, and which a reader
        // believes is its own business.
        const out = apply_cell_edits(
            doc('<row><c r="A1"><v>1</v></c><c r="B2"><v>2</v></c></row>'),
            [{ row: 1, col: 1, value: '9' }],
            OPTS,
        );
        expect(out.match(/r="B2"/g)).toHaveLength(1);
        expect(out).toContain('<c r="B2"><v>9</v></c>');
        // The neighbour sharing that row element must be left alone.
        expect(out).toContain('<c r="A1"><v>1</v></c>');
    });

    it('does not hand one row an adjacent row\'s cell from a shared row element', () => {
        // The same span now serves both rows, so a cell lookup keyed on the column
        // alone would find A1 while editing row 2 and overwrite it.
        const out = apply_cell_edits(
            doc('<row><c r="A1"><v>1</v></c><c r="B2"><v>2</v></c></row>'),
            [{ row: 1, col: 0, value: '9' }],
            OPTS,
        );
        expect(out).toContain('<c r="A1"><v>1</v></c>');
        expect(out.match(/r="A2"/g)).toHaveLength(1);
    });

    it('edits the row element the reader actually shows, when two claim one row', () => {
        // The reader keys every `<c r=…>` into a map as it scans, so with two row
        // elements both naming row 1 the *later* one holds the cell the user sees —
        // confirmed for numbered and unnumbered rows alike. Preferring the earlier
        // span sent the edit into the element the reader had already overwritten:
        // the save reported success, the visible value never changed, and the file
        // gained a duplicate coordinate.
        const out = apply_cell_edits(
            doc('<row><c r="A1"><v>1</v></c></row><row><c r="A1"><v>2</v></c></row>'),
            [{ row: 0, col: 0, value: '9' }],
            OPTS,
        );
        expect(out.match(/r="A1"/g)).toHaveLength(2);
        // The edit lands in the second element; the first keeps its shadowed value.
        expect(out).toContain('<row><c r="A1"><v>1</v></c></row><row><c r="A1"><v>9</v></c></row>');
    });

    it('resolves duplicate rows per coordinate, not per row element', () => {
        // The reader settles precedence for each `<c r=…>` independently, so with a
        // styled A1 in the first element and a D1 in the second it shows *both* —
        // A1 from the earlier element, D1 from the later. Resolving a whole row to
        // one span made the writer see no A1 in the element it had picked, so the
        // edit inserted a fresh unstyled A1: the value changed, the currency format
        // vanished, and the sheet gained a duplicate coordinate.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1" s="7"><v>1234.56</v></c></row>'
                + '<row r="1"><c r="D1"><v>4</v></c></row>'),
            [{ row: 0, col: 0, value: '999.5' }],
            OPTS,
        );
        expect(out.match(/r="A1"/g)).toHaveLength(1);
        expect(out).toContain('<c r="A1" s="7"><v>999.5</v></c>');
    });

    it('inserts a new cell into the element it is spliced into, not a duplicate row', () => {
        // Positioning an insert against a higher-column cell that lives in a
        // *different* row element aims at an offset outside the element being
        // spliced, putting the new `<c>` inside the neighbouring row.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="C1"><v>3</v></c></row>'
                + '<row r="1"><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 1, value: '2' }],
            OPTS,
        );
        // C1 is the only higher-column cell, and it sits in the *first* element —
        // an offset outside the one being spliced. Positioning against it put the
        // new B1 in front of C1, in the row the reader does not read A1 from.
        expect(out).toContain('<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>');
        expect(out).toContain('<row r="1"><c r="C1"><v>3</v></c></row>');
    });

    it('keeps a self-closing sheetData\'s attributes when expanding it', () => {
        // `<sheetData/>` has nowhere to splice into, so it is expanded to a pair
        // first — and the replacement was written as a bare `<sheetData>`, dropping
        // whatever the element carried. A namespace declaration its descendants
        // rely on, or vendor metadata, silently gone from a save that was asked to
        // change one cell.
        const out = apply_cell_edits(
            '<?xml version="1.0"?><worksheet><sheetData vendor="keep"/></worksheet>',
            [{ row: 0, col: 0, value: 'x' }],
            OPTS,
        );
        expect(out).toContain('<sheetData vendor="keep">');
    });

    it('refuses a date-shaped non-date in a t="d" cell', () => {
        // `ISO_DATE_RE` describes the shape only: `2024-02-31` matches and is not a
        // date. Writing it under `t="d"` produced a cell claiming to be a date whose
        // text no date parser accepts — the workbook Excel offers to repair.
        for (const value of ['2024-02-31', '2024-01-01T25:00']) {
            const out = apply_cell_edits(
                doc('<row r="1"><c r="A1" t="d"><v>2024-01-01</v></c></row>'),
                [{ row: 0, col: 0, value }],
                OPTS,
            );
            expect(out, value).not.toContain('t="d"');
            expect(out, value).toContain(value);
        }
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

    it('does not count formula-shaped text in comments or CDATA', () => {
        // The count only exists to answer "did an edit drop a formula". Counting
        // quoted text made an edit *near* a comment look like a formula appearing
        // or vanishing, which deleted xl/calcChain.xml from a workbook whose
        // formulas were all still there.
        expect(formula_count('<!-- <f>not markup</f> --><![CDATA[<f/>]]>')).toBe(0);
        expect(formula_count('<f>SUM(A1:A2)</f><!-- <f>doc</f> -->')).toBe(1);
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
        // Cell-shaped PI text, with or without `r`, is ignored by the shared scanner
        // and preserved verbatim; the live cell remains the only edit target.
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

    it('edits a live cell while preserving cell-shaped CDATA and PI text', () => {
        for (const quoted of [
            '<![CDATA[<c r="A1" t="inlineStr"><is><t>ghost</t></is></c>]]>',
            '<?vendor <c r="A1" t="inlineStr"><is><t>ghost</t></is></c>?>',
        ]) {
            const out = apply_cell_edits(
                doc('<row r="1"><c r="A1"><v>1</v></c>' + quoted + '</row>'),
                [{ row: 0, col: 0, value: 'new' }],
                OPTS,
            );
            expect(out).toContain(quoted);
            expect(out).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">new</t></is></c>');
            expect(out.replace(quoted, '').match(/<c r="A1"/g)).toHaveLength(1);
        }
    });

    it('uses the cell reference when it disagrees with the row attribute', () => {
        // `<c r>` is the sole coordinate authority for both reader and writer. The
        // existing A2 is replaced in its original owner instead of synthesizing a
        // second row or a duplicate coordinate.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A2"><v>7</v></c></row>'),
            [{ row: 1, col: 0, value: '9' }],
            OPTS,
        );
        expect(out).toContain('<row r="1"><c r="A2"><v>9</v></c></row>');
        expect(out.match(/<c r="A2"/g)).toHaveLength(1);
        expect(out).not.toContain('<row r="2">');

        expect(apply_cell_edits(
            doc('<row><c r="A2"><v>7</v></c></row>'),
            [{ row: 1, col: 0, value: '9' }],
            OPTS,
        )).toContain('<c r="A2"><v>9</v></c>');
    });

    it('orders an inserted cell across every logical row in its owner', () => {
        // Deleting the row/c disagreement guard makes this mixed owner editable.
        // A2 must be positioned against B1 as well as C2, not inserted between
        // them from the edited logical row's partial coordinate map.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="B1"/><c r="C2"/></row>'),
            [{ row: 1, col: 0, value: '9' }],
            OPTS,
        );
        expect(out.indexOf('<c r="A2"')).toBeLessThan(out.indexOf('<c r="B1"'));
        expect(out.indexOf('<c r="B1"')).toBeLessThan(out.indexOf('<c r="C2"'));
    });

    it('coalesces inserts for logical rows sharing one physical owner', () => {
        // B2 arrives first on purpose. Planning each logical row separately left
        // B2 before A1 and, with `spans`, queued overlapping opening-tag rewrites.
        for (const spans of ['', ' spans="3:4"']) {
            const out = apply_cell_edits(
                doc(`<row r="1"${spans}><c r="C1"/><c r="D2"/></row>`),
                [
                    { row: 1, col: 1, value: '2' },
                    { row: 0, col: 0, value: '1' },
                ],
                OPTS,
            );
            expect(out).toContain(
                '<row r="1"><c r="A1"><v>1</v></c><c r="B2"><v>2</v></c>'
                + '<c r="C1"/><c r="D2"/></row>',
            );
            expect(out).not.toContain('spans=');
        }
    });

    it('refuses a namespace-prefixed formula element with a stable code', () => {
        for (const prefix of ['x', 'π']) {
            expect_refusal(
                () => apply_cell_edits(
                    doc(`<row r="1"><c r="A1"><${prefix}:f t="array" ref="A1:B2">`
                        + `SUM(1)</${prefix}:f><v>1</v></c></row>`),
                    [{ row: 0, col: 0, value: '2' }],
                    OPTS,
                ),
                'namespace-prefixed-worksheet-element',
            );
        }
    });

    it('edits single-quoted row and cell references in place', () => {
        const out = apply_cell_edits(
            doc("<row r='1'><c r='A1'><v>1</v></c></row>"),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).toContain('<c r="A1"><v>2</v></c>');
        expect(out.match(/<c r="A1"/g)).toHaveLength(1);
    });

    it('refuses a cell with no reference with a stable code', () => {
        expect_refusal(
            () => apply_cell_edits(
                doc('<row r="1"><c><v>1</v></c></row>'),
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            ),
            'missing-cell-reference',
        );
    });

    it('preserves a single-quoted style index', () => {
        const out = apply_cell_edits(
            doc("<row r=\"1\"><c r=\"A1\" s='3'><v>1</v></c></row>"),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).toContain('<c r="A1" s="3"><v>2</v></c>');
    });

    it('preserves a single-quoted boolean type', () => {
        const out = apply_cell_edits(
            doc("<row r=\"1\"><c r=\"A1\" t='b'><v>1</v></c></row>"),
            [{ row: 0, col: 0, value: 'FALSE' }],
            OPTS,
        );
        expect(out).toContain('<c r="A1" t="b"><v>0</v></c>');
    });

    it('edits an entity-spelled reference in place without a duplicate', () => {
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A&#49;"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).toContain('<c r="A1"><v>2</v></c>');
        expect(out.match(/<c r="A1"/g)).toHaveLength(1);
        expect(out).not.toContain('A&#49;');
    });

    it('refuses a foreign default namespace with a stable code', () => {
        expect_refusal(
            () => apply_cell_edits(
                doc('<row xmlns="urn:not-spreadsheet" r="1"><c r="B1"><v>1</v></c></row>'),
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            ),
            'foreign-worksheet-namespace',
        );
    });

    it('preserves single-quoted styles separated by XML whitespace', () => {
        for (const separator of ['\n', '\t']) {
            const out = apply_cell_edits(
                doc(`<row r="1"><c${separator}r="A1"${separator}s='7'><v>1</v></c></row>`),
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            );
            expect(out, JSON.stringify(separator)).toContain('<c r="A1" s="7"><v>2</v></c>');
        }
    });

    it('treats a prefixed r attribute as a missing cell reference', () => {
        expect_refusal(
            () => apply_cell_edits(
                doc('<row r="1"><c vendor:r="A1"><v>1</v></c></row>'),
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            ),
            'missing-cell-reference',
        );
    });

    it('refuses every present but invalid cell reference with one code', () => {
        for (const reference of ['a1', 'A0', 'A01', 'XFE1', 'A1048577', '1A', 'A']) {
            expect_refusal(
                () => apply_cell_edits(
                    doc(`<row r="1"><c r="${reference}"><v>1</v></c></row>`),
                    [{ row: 0, col: 0, value: '2' }],
                    OPTS,
                ),
                'invalid-cell-reference',
                reference,
            );
        }
    });

    it('accepts the last valid format row and column', () => {
        const last_column = apply_cell_edits(
            doc('<row r="1"><c r="XFD1"><v>1</v></c></row>'),
            [{ row: 0, col: 16_383, value: '2' }],
            OPTS,
        );
        expect(last_column).toContain('<c r="XFD1"><v>2</v></c>');
        expect(last_column.match(/<c r="XFD1"/g)).toHaveLength(1);

        const last_row = apply_cell_edits(
            doc('<row r="1048576"><c r="A1048576"><v>1</v></c></row>'),
            [{ row: 1_048_575, col: 0, value: '2' }],
            OPTS,
        );
        expect(last_row).toContain('<c r="A1048576"><v>2</v></c>');
        expect(last_row.match(/<c r="A1048576"/g)).toHaveLength(1);
    });

    it('keeps grouped-formula refusals for hostile attribute spellings', () => {
        const cases = [
            {
                kind: 'array formula',
                formula: '<f t = "array" ref = "A1:B2">SUM(1)</f>',
            },
            {
                kind: 'array formula',
                formula: "<f t='array' ref='A1:B2'>SUM(1)</f>",
            },
            {
                kind: 'array formula',
                formula: '<f t="arr&#97;y" ref="A&#49;:B2">SUM(1)</f>',
            },
            {
                kind: 'shared formula',
                formula: '<f t="shared" ref="A1:B1" si="0">SUM(1)</f>',
            },
            {
                kind: 'shared formula',
                formula: "<f t='shared' ref='A1:B1' si='0'>SUM(1)</f>",
            },
            {
                kind: 'shared formula',
                formula: '<f t = "shared" ref = "A1:B1" si = "0">SUM(1)</f>',
            },
        ];
        for (const { kind, formula } of cases) {
            const inner = `<row r="1"><c r="A1">${formula}<v>1</v></c></row>`;
            expect(() => apply_cell_edits(
                doc(inner),
                [{ row: 0, col: 1, value: '2' }],
                OPTS,
            ), formula).toThrow(new RegExp(`B1.*${kind}`));
        }
    });

    it('refuses foreign effective namespaces on worksheet, sheetData, and cell', () => {
        const cell = '<row r="1"><c r="A1"><v>1</v></c></row>';
        for (const xml of [
            `<worksheet xmlns="urn:other"><sheetData>${cell}</sheetData></worksheet>`,
            `<worksheet><sheetData xmlns="urn:other">${cell}</sheetData></worksheet>`,
            `<worksheet><sheetData><row r="1"><c xmlns="urn:other" r="A1"><v>1</v></c></row></sheetData></worksheet>`,
            '<worksheet><sheetData><wrapper xmlns="urn:other">'
                + `${cell}</wrapper></sheetData></worksheet>`,
        ]) {
            expect_refusal(
                () => apply_cell_edits(xml, [{ row: 0, col: 0, value: '2' }], OPTS),
                'foreign-worksheet-namespace',
            );
        }
    });

    it('refuses a foreign namespace on an empty self-closing row', () => {
        expect_refusal(
            () => apply_cell_edits(
                '<worksheet><sheetData><row xmlns="urn:other" r="1"/></sheetData></worksheet>',
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            ),
            'foreign-worksheet-namespace',
        );
    });

    it('allows either SpreadsheetML dialect at the root and redundant declarations', () => {
        for (const ns of [
            'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
            'http://purl.oclc.org/ooxml/spreadsheetml/main',
        ]) {
            const xml = `<worksheet xmlns="${ns}"><sheetData xmlns="${ns}">`
                + `<row xmlns="${ns}" r="1"><c xmlns="${ns}" r="A1"><v>1</v></c></row>`
                + '</sheetData></worksheet>';
            expect(apply_cell_edits(xml, [{ row: 0, col: 0, value: '2' }], OPTS), ns)
                .toContain('<c r="A1"><v>2</v></c>');
        }
    });

    it('refuses a cross-dialect descendant under a Transitional root', () => {
        const transitional = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
        const strict = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
        expect_refusal(
            () => apply_cell_edits(
                `<worksheet xmlns="${transitional}"><sheetData>`
                + `<row xmlns="${strict}" r="1"><c r="A1"><v>1</v></c></row>`
                + '</sheetData></worksheet>',
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            ),
            'foreign-worksheet-namespace',
        );
    });

    it('keeps the first authoritative sheetData when a prefixed one follows it', () => {
        const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
        const xml = `<worksheet xmlns:x="${ns}"><sheetData>`
            + '<row r="1"><c r="A1"><v>1</v></c></row>'
            + '</sheetData><x:sheetData/></worksheet>';

        expect(apply_cell_edits(xml, [{ row: 0, col: 0, value: '2' }], OPTS))
            .toContain('<c r="A1"><v>2</v></c>');
    });

    it('edits a structurally eligible prefixed SpreadsheetML sheetData', () => {
        const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
        for (const xml of [
            `<worksheet><x:sheetData xmlns:x="${ns}"/></worksheet>`,
            `<worksheet xmlns:x="${ns}"><x:sheetData/></worksheet>`,
        ]) {
            expect(apply_cell_edits(
                xml,
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            )).toContain('<x:row r="1"><x:c r="A1"><x:v>2</x:v></x:c></x:row>');
        }
    });

    it('leaves a foreign prefixed sheetData as the plain structural error', () => {
        let caught: unknown;
        try {
            apply_cell_edits(
                '<worksheet><v:sheetData xmlns:v="urn:vendor"/></worksheet>',
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            );
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBeInstanceOf(OoxmlRefusalError);
        expect((caught as Error).message).toMatch(/no <sheetData>/);
    });

    it('ignores similarly named elements and AlternateContent in disjoint extensions', () => {
        const extensions = '<extLst><ext xmlns:v="urn:vendor">'
            + '<v:worksheet/>'
            + '<v:sheetData/>'
            + '<v:sheetData-cache/>'
            + '<v:worksheet.meta/>'
            + '<v:AlternateContent/>'
            + '</ext><ext xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
            + '<mc:AlternateContent/>'
            + '</ext></extLst>';
        const xml = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row>'
            + `</sheetData>${extensions}</worksheet>`;
        expect(apply_cell_edits(xml, [{ row: 0, col: 0, value: '2' }], OPTS))
            .toContain('<c r="A1"><v>2</v></c>');
    });

    it('never selects a nested vendor sheetData as the worksheet body', () => {
        const nested = '<extLst><ext xmlns="urn:vendor"><sheetData marker="vendor"/></ext></extLst>';
        let caught: unknown;
        try {
            apply_cell_edits(
                `<worksheet>${nested}</worksheet>`,
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            );
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBeInstanceOf(OoxmlRefusalError);
        expect((caught as Error).message).toMatch(/no <sheetData>/);

        const xml = `<worksheet>${nested}<sheetData>`
            + '<row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';
        const out = apply_cell_edits(xml, [{ row: 0, col: 0, value: '3' }], OPTS);
        expect(out).toContain('<sheetData marker="vendor"/>');
        expect(out).toContain('<sheetData><row r="1"><c r="A1"><v>3</v></c></row></sheetData>');
    });

    it('uses document order when no unprefixed sheetData is present', () => {
        expect_refusal(
            () => apply_cell_edits(
                '<worksheet xmlns="urn:other"><x:sheetData/></worksheet>',
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            ),
            'foreign-worksheet-namespace',
        );
        expect_refusal(
            () => apply_cell_edits(
                '<x:worksheet/><worksheet xmlns="urn:other"/>',
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            ),
            'namespace-prefixed-worksheet-element',
        );
    });

    it('chooses the first offending construct in document order', () => {
        const early_invalid = '<row r="1"><c r="A0"><v>1</v></c></row>';
        const late_prefixed = '<row r="2"><c r="A2"><x:f>1</x:f><v>1</v></c></row>';
        expect_refusal(
            () => apply_cell_edits(doc(early_invalid + late_prefixed), [{ row: 0, col: 0, value: '2' }], OPTS),
            'invalid-cell-reference',
            'A0',
        );

        const late_alternate = '<mc:AlternateContent '
            + 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
            + '<mc:Choice><row r="2"><c r="A2"/></row></mc:Choice></mc:AlternateContent>';
        expect_refusal(
            () => apply_cell_edits(doc(early_invalid + late_alternate), [{ row: 0, col: 0, value: '2' }], OPTS),
            'invalid-cell-reference',
            'A0',
        );

        expect_refusal(
            () => apply_cell_edits(
                '<worksheet xmlns="urn:other"><sheetData><row r="1"><c/></row></sheetData></worksheet>',
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            ),
            'foreign-worksheet-namespace',
        );

        expect_refusal(
            () => apply_cell_edits(
                doc('<row r="1"><c xmlns="urn:other" r="A0"><v>1</v></c></row>'),
                [{ row: 0, col: 0, value: '2' }],
                OPTS,
            ),
            'foreign-worksheet-namespace',
        );

        expect_refusal(
            () => apply_cell_edits(doc(late_prefixed + early_invalid), [{ row: 0, col: 0, value: '2' }], OPTS),
            'namespace-prefixed-worksheet-element',
        );
    });

    it('refuses exact markup-compatibility AlternateContent inside sheetData', () => {
        // Both branches spell row 1 / A1, and which one a reader believes depends
        // on whether it understands `Requires`. Any legal prefix may bind the MC
        // namespace; the expanded name, not the spelling `mc:`, identifies it.
        const inner = '<z:AlternateContent'
            + ' xmlns:z="http://schemas.openxmlformats.org/markup-compatibility/2006">'
            + '<z:Choice Requires="x14">'
            + '<row r="1"><c r="A1" t="inlineStr"><is><t>choice</t></is></c></row></z:Choice>'
            + '<z:Fallback>'
            + '<row r="1"><c r="A1" t="inlineStr"><is><t>fallback</t></is></c></row></z:Fallback>'
            + '</z:AlternateContent>';
        expect_refusal(
            () => apply_cell_edits(doc(inner), [{ row: 0, col: 0, value: 'edited' }], OPTS),
            'markup-compatibility-alternate-content',
        );

        const default_bound = '<AlternateContent '
            + 'xmlns="http://schemas.openxmlformats.org/markup-compatibility/2006">'
            + '<Choice/></AlternateContent>';
        expect_refusal(
            () => apply_cell_edits(doc(default_bound), [{ row: 0, col: 0, value: '3' }], OPTS),
            'markup-compatibility-alternate-content',
        );
    });

    it('resolves inherited and rebound AlternateContent prefixes by scope', () => {
        const mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
        const inherited = '<holder xmlns:z="' + mc + '"><z:AlternateContent/></holder>';
        expect_refusal(
            () => apply_cell_edits(doc(inherited), [{ row: 0, col: 0, value: '3' }], OPTS),
            'markup-compatibility-alternate-content',
        );

        const rebound = '<holder xmlns:z="' + mc + '"><inner xmlns:z="urn:vendor">'
            + '<z:AlternateContent/></inner></holder>';
        expect(apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row>' + rebound),
            [{ row: 0, col: 0, value: '3' }],
            OPTS,
        )).toContain('<c r="A1"><v>3</v></c>');
    });

    it('does not treat bare or wrongly bound AlternateContent as markup compatibility', () => {
        for (const inner of [
            '<AlternateContent/>',
            '<mc:AlternateContent xmlns:mc="urn:vendor"/>',
        ]) {
            expect(
                apply_cell_edits(
                    doc('<row r="1"><c r="A1"><v>1</v></c></row>' + inner),
                    [{ row: 0, col: 0, value: '3' }],
                    OPTS,
                ),
                inner,
            ).toContain('<c r="A1"><v>3</v></c>');
        }
    });

    it('refuses exact markup-compatibility content that wraps sheetData', () => {
        const mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
        const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
        const wrapped = `<worksheet xmlns="${spreadsheet}"><mc:AlternateContent xmlns:mc="${mc}">`
            + '<mc:Choice><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></mc:Choice>'
            + '<mc:Fallback><sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData></mc:Fallback>'
            + '</mc:AlternateContent></worksheet>';
        expect_refusal(
            () => apply_cell_edits(wrapped, [{ row: 0, col: 0, value: '3' }], OPTS),
            'markup-compatibility-alternate-content',
        );

        const only_prefixed = `<worksheet xmlns="${spreadsheet}">`
            + `<mc:AlternateContent xmlns:mc="${mc}">`
            + `<mc:Choice><x:sheetData xmlns:x="${spreadsheet}"/></mc:Choice>`
            + '</mc:AlternateContent></worksheet>';
        expect_refusal(
            () => apply_cell_edits(only_prefixed, [{ row: 0, col: 0, value: '3' }], OPTS),
            'markup-compatibility-alternate-content',
        );
    });

    it('does not refuse alternate content quoted inside a comment', () => {
        const inner = '<row r="1"><c r="A1"><v>1</v></c></row>'
            + '<!-- <mc:AlternateContent/> -->';
        expect(apply_cell_edits(doc(inner), [{ row: 0, col: 0, value: '2' }], OPTS))
            .toContain('<c r="A1"><v>2</v></c>');
    });

    it('does not refuse ordinary attributes it never reads', () => {
        // The shared attribute lexer reads only exact requested names, so unrelated
        // vendor attributes and their entities remain untouched.
        const inner = '<row r="1" spans="1:1" customFormat="1">'
            + '<c r="A1" s="3" t="n"><v>1</v></c></row>';
        expect(apply_cell_edits(doc(inner), [{ row: 0, col: 0, value: '2' }], OPTS))
            .toContain('<c r="A1" s="3"><v>2</v></c>');
    });

    it('does not mistake namespace-shaped attribute text for a declaration', () => {
        const quoted = 'note="documentation says xmlns=urn:example"';
        const out = apply_cell_edits(
            doc(`<row r="1" ${quoted}><c r="A1"><v>1</v></c></row>`),
            [{ row: 0, col: 0, value: '2' }],
            OPTS,
        );
        expect(out).toContain(`<row r="1" ${quoted}>`);
        expect(out).toContain('<c r="A1"><v>2</v></c>');
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

    it('splices byte offsets without shifting non-ASCII surroundings', () => {
        const original = doc('<note>café</note><row r="1"><c r="A1"><v>1</v></c>'
            + '<c r="B1" t="inlineStr"><is><t>東京</t></is></c></row>');
        const bytes = Buffer.from(original, 'utf8');
        const out = apply_cell_edits(bytes, [{ row: 0, col: 0, value: '9' }], OPTS);
        const expected = original.replace('<c r="A1"><v>1</v></c>', '<c r="A1"><v>9</v></c>');

        expect(Buffer.from(out).equals(Buffer.from(expected, 'utf8'))).toBe(true);
    });

    it('keeps same-byte-offset splice ordering in one allocation', () => {
        const xml = Buffer.from('caféC', 'utf8');
        const at = xml.indexOf('C');
        const out = apply_utf8_splices(xml, [
            { start: at, end: at + 1, text: 'R' },
            { start: at, end: at, text: 'A' },
            { start: at, end: at, text: 'B' },
        ]);

        expect(Buffer.from(out).toString('utf8')).toBe('caféABR');
    });

    it('rejects invalid or overlapping splice ranges before allocation', () => {
        const xml = Buffer.from('abcdef', 'utf8');

        expect(() => apply_utf8_splices(xml, [
            { start: 1, end: 4, text: 'x' },
            { start: 3, end: 5, text: 'y' },
        ])).toThrow(/overlapping UTF-8 splice/i);
        expect(() => apply_utf8_splices(xml, [
            { start: 4, end: 3, text: 'x' },
        ])).toThrow(/invalid UTF-8 splice range/i);
        expect(() => apply_utf8_splices(xml, [
            { start: -1, end: 0, text: 'x' },
        ])).toThrow(/invalid UTF-8 splice range/i);
        expect(() => apply_utf8_splices(xml, [
            { start: 0, end: xml.length + 1, text: 'x' },
        ])).toThrow(/invalid UTF-8 splice range/i);
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

    it('refuses a cell covered by a merged range', () => {
        // The reader hides every cell of a merge except its top-left anchor, so a
        // follower coordinate is one the grid never shows and the user cannot see.
        // The edit wrote a perfectly valid `<c r="B1">` that nothing would ever
        // render: the save reported success, the reload showed A1 unchanged, and
        // Excel treats a value under a merged follower as discardable.
        const xml = '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'
            + '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells></worksheet>';
        expect(() => apply_cell_edits(xml, [{ row: 0, col: 1, value: '9' }], OPTS))
            .toThrow(/Cannot edit B1: it is covered by a merged cell/);
        // The anchor is the cell the grid does show, so it stays editable.
        expect(apply_cell_edits(xml, [{ row: 0, col: 0, value: '9' }], OPTS)).toContain('<v>9</v>');
    });

    it('normalizes a space-separated date-time in a t="d" cell', () => {
        // `2024-01-15 12:00` is what a user retypes from the grid and `ISO_DATE_RE`
        // accepts it, but a `t="d"` value is an xsd:dateTime, where the `T` is
        // required. Written verbatim it made a date cell no conforming date parser
        // accepts — strict consumers reject it, prefix-parsing ones drop the 12:00.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1" t="d"><v>2024-01-01</v></c></row>'),
            [{ row: 0, col: 0, value: '2024-01-15 12:00' }],
            OPTS,
        );
        expect(out).toContain('<v>2024-01-15T12:00</v>');
    });

    it('stores a number that underflows to zero as text', () => {
        // The other end of the precision loss the digit limit guards: `1e-400` is
        // finite as typed and zero once read back, so storing it as a number
        // replaced a nonzero value with `0`, silently and permanently.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '1e-400' }],
            OPTS,
        );
        expect(out).toContain('>1e-400<');
        expect(out).toContain('t="inlineStr"');
        // A typed zero is still a number.
        expect(apply_cell_edits(
            doc('<row r="1"><c r="A1"><v>1</v></c></row>'),
            [{ row: 0, col: 0, value: '0' }],
            OPTS,
        )).toContain('<c r="A1"><v>0</v></c>');
    });

    it('reads mergeCells exactly where the reader does', () => {
        const merged = (cells: string, close = '</mergeCells>') =>
            '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c>'
            + '<c r="B1"><v>2</v></c></row></sheetData>'
            + `<mergeCells count="1">${cells}${close}</worksheet>`;
        // A `>` inside an attribute value does not end the tag, and the reader's
        // `find_tag_end` knows that. A `[^>]*` match cut the element short, missed
        // the `ref` after it, and let an edit through to a follower the grid hides.
        expect(() => apply_cell_edits(
            merged('<mergeCell note="x > y" ref="A1:C1"/>'),
            [{ row: 0, col: 1, value: '9' }],
            OPTS,
        )).toThrow(/covered by a merged cell/);
        // And the close must be the literal spelling the reader requires. Accepting
        // `</mergeCells >` refused a cell the reader — which saw no merges at all —
        // was displaying normally.
        expect(apply_cell_edits(
            merged('<mergeCell ref="A1:C1"/>', '</mergeCells >'),
            [{ row: 0, col: 1, value: '9' }],
            OPTS,
        )).toContain('<v>9</v>');
    });

    it('keeps the date type when a t="d" value carries a timezone offset', () => {
        // An offset is the ordinary spelling of an ISO instant, and the reader shows
        // such a cell as a date. Rejecting it here meant retyping exactly what the
        // grid displayed rewrote the cell as an inline string, silently dropping its
        // date type for every formula and filter downstream.
        for (const value of ['2024-01-15T12:00:00+02:00', '2024-01-15T12:00:00-0500']) {
            const out = apply_cell_edits(
                doc('<row r="1"><c r="A1" t="d"><v>2024-01-01</v></c></row>'),
                [{ row: 0, col: 0, value }],
                OPTS,
            );
            expect(out, value).toContain('t="d"');
            expect(out, value).toContain(`<v>${value}</v>`);
        }
    });

    it('shares comment-aware and whitespace-tolerant sheetData boundaries', () => {
        for (const body of [
            '<sheetData><!-- </sheetData> --><row r="1"><c r="A1"><v>1</v></c></row></sheetData>',
            '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData >',
        ]) {
            const out = apply_cell_edits(
                `<worksheet>${body}</worksheet>`,
                [{ row: 0, col: 0, value: '9' }],
                OPTS,
            );
            expect(out, body).toContain('<c r="A1"><v>9</v></c>');
            expect(out.match(/<c r="A1"/g), body).toHaveLength(1);
        }
    });

    it('edits the live sheetData after a commented-out one', () => {
        const quoted = '<!-- <sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData> -->';
        const out = apply_cell_edits(
            '<worksheet>' + quoted
            + '<sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData>'
            + '</worksheet>',
            [{ row: 0, col: 0, value: '9' }],
            OPTS,
        );
        expect(out).toContain(quoted);
        expect(out).toContain('<sheetData><row r="1"><c r="A1"><v>9</v></c></row></sheetData>');
        expect(out.replace(quoted, '').match(/<c r="A1"/g)).toHaveLength(1);
    });
});

describe('widen_dimension', () => {
    it('widens to cover newly written cells', () => {
        const out = widen_dimension('<x><dimension ref="A1:B2"/></x>', 5, 4, 5, 4);
        expect(out).toContain('ref="A1:E6"');
    });

    it('replaces the exact ref while preserving its quote and spacing', () => {
        const out = widen_dimension(
            '<x><dimension vendor:ref="Z99" ref = \'C3:D4\'/></x>',
            0, 0, 5, 4,
        );
        expect(out).toContain('vendor:ref="Z99"');
        expect(out).toContain("ref = 'A1:E6'");
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
    it('rewrites local and qualified formulas when a Header Row column is renamed', async () => {
        const raw = patched_basic([
            [
                '/xl/worksheets/sheet1.xml',
                '<c r="C2" t="b"><v>1</v></c>',
                '<c r="C2"><f>SUM([Age])</f><v>55</v></c>',
            ],
            [
                '/xl/worksheets/sheet2.xml',
                '<c r="C2"><v>100</v></c>',
                '<c r="C2"><f>people![Age]</f><v>55</v></c>',
            ],
        ]);

        const out = write_xlsx_workbook_cell_edits(raw, [{
            sheetIndex: 0,
            edits: [{ row: 0, col: 1, value: 'Years', force_text: true }],
        }], {
            structuredColumnRenames: [{ sheetIndex: 0, oldName: 'Age', newName: 'Years' }],
        });
        const { data } = await parse_xlsx(out);

        expect(data.sheets[0].rows[0][1]?.raw).toBe('Years');
        expect(data.sheets[0].rows[1][2]?.formula).toBe('=SUM([Years])');
        expect(data.sheets[1].rows[1][2]?.formula).toBe('=people![Years]');
    });

    it('preserves shared and array formula groups while renaming their column reference', () => {
        const raw = patched_basic([
            [
                '/xl/worksheets/sheet1.xml',
                '<c r="C2" t="b"><v>1</v></c>',
                '<c r="C2"><f t="shared" ref="C2:C3" si="0">SUM([Age])</f><v>55</v></c>'
                    + '<c r="C3"><f t="shared" si="0"/><v>66</v></c>',
            ],
            [
                '/xl/worksheets/sheet2.xml',
                '<c r="C2"><v>100</v></c>',
                '<c r="C2"><f t="array" ref="C2:C3">people![Age]</f><v>55</v></c>'
                    + '<c r="C3"><v>66</v></c>',
            ],
        ]);

        const out = write_xlsx_workbook_cell_edits(raw, [{
            sheetIndex: 0,
            edits: [{ row: 0, col: 1, value: 'Years', force_text: true }],
        }], {
            structuredColumnRenames: [{ sheetIndex: 0, oldName: 'Age', newName: 'Years' }],
        });
        const shared = part(out, '/xl/worksheets/sheet1.xml')?.toString('utf8') ?? '';
        const array = part(out, '/xl/worksheets/sheet2.xml')?.toString('utf8') ?? '';

        expect(shared).toContain('<f t="shared" ref="C2:C3" si="0">SUM([Years])</f>');
        expect(shared).toContain('<f t="shared" si="0"/>');
        expect(array).toContain('<f t="array" ref="C2:C3">people![Years]</f>');
        expect(array).not.toContain('<c r="C3"><v>66</v></c>');
    });

    it('reopens saved formula dependents as unknown instead of stale cached values', async () => {
        const raw = patched_parts([[
            '/xl/worksheets/sheet1.xml',
            /<c r="B1"[^>]*>[\s\S]*?<\/c><c r="C1"[^>]*>[\s\S]*?<\/c>/,
            '<c r="B1" s="2"><f>A1*2</f><v>2469.12</v></c>'
                + '<c r="C1" s="3"><f>B1*3</f><v>7407.36</v></c>',
        ]]);

        const out = write_xlsx_cell_edits(raw, 0, [{ row: 0, col: 0, value: '2' }]);
        const row = (await parse_xlsx(out)).data.sheets[0].rows[0];

        expect(row[0]?.raw).toBe(2);
        expect(row[1]).toMatchObject({
            raw: '=A1*2',
            formatted: '??',
            formula: '=A1*2',
            formulaResultPending: true,
        });
        expect(row[2]).toMatchObject({
            raw: '=B1*3',
            formatted: '??',
            formula: '=B1*3',
            formulaResultPending: true,
        });
    });

    it('reopens recursive cross-sheet formula dependents as unknown', async () => {
        const raw = patched_basic([
            [
                '/xl/worksheets/sheet1.xml',
                '<c r="B2"><v>30</v></c><c r="C2" t="b"><v>1</v></c>',
                '<c r="B2"><v>30</v></c>'
                    + '<c r="C2"><f>Inventory!B2*3</f><v>60</v></c>',
            ],
            [
                '/xl/worksheets/sheet2.xml',
                '<c r="B2"><v>9.99</v></c>',
                '<c r="B2"><f>people!B2*2</f><v>20</v></c>',
            ],
        ]);

        const parsed_source = (await parse_xlsx(raw)).data;
        expect(parsed_source.sheets[0].formulaDependencies).toEqual([
            1, 2, 1, 1, 1, 1, 1,
        ]);
        expect(parsed_source.sheets[1].formulaDependencies).toEqual([
            1, 1, 0, 1, 1, 1, 1,
        ]);

        const out = write_xlsx_workbook_cell_edits(raw, [
            { sheetIndex: 0, edits: [{ row: 1, col: 1, value: '40' }] },
        ]);
        const { data } = await parse_xlsx(out);

        expect(data.sheets[0].rows[1][1]?.raw).toBe(40);
        expect(data.sheets[1].rows[1][1]).toMatchObject({
            raw: '=people!B2*2',
            formatted: '??',
            formula: '=people!B2*2',
            formulaResultPending: true,
        });
        expect(data.sheets[0].rows[1][2]).toMatchObject({
            raw: '=Inventory!B2*3',
            formatted: '??',
            formula: '=Inventory!B2*3',
            formulaResultPending: true,
        });

        const hinted = write_xlsx_workbook_cell_edits(raw, [
            { sheetIndex: 0, edits: [{ row: 1, col: 1, value: '40' }] },
        ], { formulaDependencies: parsed_source.sheets });
        const hinted_data = (await parse_xlsx(hinted)).data;
        expect(hinted_data.sheets[1].rows[1][1]?.formulaResultPending).toBe(true);
        expect(hinted_data.sheets[0].rows[1][2]?.formulaResultPending).toBe(true);

        const calculated = write_xlsx_workbook_cell_edits(raw, [
            { sheetIndex: 0, edits: [{ row: 1, col: 1, value: '40' }] },
        ], {
            formulaWritePlan: create_xlsx_formula_write_plan(
                plan_workbook_formula_recalculation(parsed_source.sheets, [{
                    sheetIndex: 0,
                    row: 1,
                    column: 1,
                    value: '40',
                    writesFormula: false,
                }]), [
                { sheetIndex: 1, row: 1, column: 1, value: '80' },
                { sheetIndex: 0, row: 1, column: 2, value: '240' },
                ],
            ),
        });
        const calculated_data = (await parse_xlsx(calculated)).data;
        expect(calculated_data.sheets[1].rows[1][1]).toMatchObject({
            raw: 80,
            formula: '=people!B2*2',
        });
        expect(calculated_data.sheets[0].rows[1][2]).toMatchObject({
            raw: 240,
            formula: '=Inventory!B2*3',
        });
    });

    it('retargets formulas elsewhere when cells move within a worksheet', async () => {
        const raw = patched_basic([
            [
                '/xl/worksheets/sheet1.xml',
                '<c r="B2"><v>30</v></c><c r="C2" t="b"><v>1</v></c>',
                '<c r="A1"><v>10</v></c>'
                    + '<c r="B2"><f>$A$1+A1</f><v>20</v></c>',
            ],
            [
                '/xl/worksheets/sheet2.xml',
                '<c r="B2"><v>9.99</v></c>',
                '<c r="B2"><f>people!A1*2</f><v>20</v></c>',
            ],
        ]);

        const worksheet_reads: string[] = [];
        const actual_read = ZipPackage.prototype.read;
        const read_spy = vi.spyOn(ZipPackage.prototype, 'read').mockImplementation(function (
            this: ZipPackage,
            path: string,
        ) {
            if (path.startsWith('/xl/worksheets/')) worksheet_reads.push(path);
            return actual_read.call(this, path);
        });
        let out: Uint8Array;
        try {
            out = write_xlsx_workbook_cell_edits(raw, [{
                sheetIndex: 0,
                edits: [
                    { row: 0, col: 0, value: '' },
                    { row: 2, col: 2, value: '10', movedFrom: { row: 0, col: 0 } },
                ],
            }]);
        } finally {
            read_spy.mockRestore();
        }
        expect(worksheet_reads).toEqual([
            '/xl/worksheets/sheet1.xml',
            '/xl/worksheets/sheet2.xml',
        ]);
        const { data } = await parse_xlsx(out);

        expect(data.sheets[0].rows[2][2]?.raw).toBe(10);
        expect(data.sheets[0].rows[1][1]).toMatchObject({
            formula: '=$C$3+C3',
            formatted: '??',
            formulaResultPending: true,
        });
        expect(data.sheets[1].rows[1][1]).toMatchObject({
            formula: '=people!C3*2',
            formatted: '??',
            formulaResultPending: true,
        });
    });

    it('applies chained moves in order and respects explicit formula edit order', async () => {
        const raw = patched_basic([[
            '/xl/worksheets/sheet1.xml',
            '<c r="B2"><v>30</v></c><c r="C2" t="b"><v>1</v></c>',
            '<c r="A1"><v>10</v></c>'
                + '<c r="D1"><f>A1</f><v>10</v></c>'
                + '<c r="D2"><f>A1</f><v>10</v></c>',
        ]]);
        const out = write_xlsx_workbook_cell_edits(raw, [{
            sheetIndex: 0,
            edits: [
                { row: 0, col: 0, value: '' },
                {
                    row: 0, col: 1, value: '', valueEditOrder: 2,
                    movedFrom: { row: 0, col: 0, order: 1 },
                },
                {
                    row: 0, col: 2, value: '10', valueEditOrder: 2,
                    movedFrom: { row: 0, col: 1, order: 2 },
                },
                { row: 0, col: 3, value: '=A1', valueEditOrder: 0 },
                { row: 1, col: 3, value: '=A1', valueEditOrder: 3 },
            ],
        }]);
        const { data } = await parse_xlsx(out);

        expect(data.sheets[0].rows[0][3]?.formula).toBe('=C1');
        expect(data.sheets[0].rows[1][3]?.formula).toBe('=A1');
    });

    it('allows a move source to be refilled by a later literal edit', async () => {
        const raw = patched_basic([[
            '/xl/worksheets/sheet1.xml',
            '<c r="B2"><v>30</v></c><c r="C2" t="b"><v>1</v></c>',
            '<c r="A1"><v>10</v></c>'
                + '<c r="D1"><f>A1</f><v>10</v></c>',
        ]]);
        const out = write_xlsx_workbook_cell_edits(raw, [{
            sheetIndex: 0,
            edits: [
                { row: 0, col: 0, value: 'replacement', valueEditOrder: 2 },
                {
                    row: 0,
                    col: 1,
                    value: '10',
                    movedFrom: { row: 0, col: 0, order: 1 },
                    valueEditOrder: 1,
                },
            ],
        }]);
        const { data } = await parse_xlsx(out);

        expect(data.sheets[0].rows[0][0]?.raw).toBe('replacement');
        expect(data.sheets[0].rows[0][1]?.raw).toBe(10);
        expect(data.sheets[0].rows[0][3]?.formula).toBe('=B1');
    });

    it('allows a moved source to become a later move destination', async () => {
        const raw = patched_basic([[
            '/xl/worksheets/sheet1.xml',
            '<c r="B2"><v>30</v></c><c r="C2" t="b"><v>1</v></c>',
            '<c r="A1"><v>10</v></c><c r="C1"><v>20</v></c>'
                + '<c r="D1"><f>A1+C1</f><v>30</v></c>',
        ]]);
        const out = write_xlsx_workbook_cell_edits(raw, [{
            sheetIndex: 0,
            edits: [
                {
                    row: 0,
                    col: 0,
                    value: '20',
                    movedFrom: { row: 0, col: 2, order: 2 },
                    valueEditOrder: 2,
                },
                {
                    row: 0,
                    col: 1,
                    value: '10',
                    movedFrom: { row: 0, col: 0, order: 1 },
                    valueEditOrder: 1,
                },
                { row: 0, col: 2, value: '', valueEditOrder: 2 },
            ],
        }]);
        const { data } = await parse_xlsx(out);

        expect(data.sheets[0].rows[0][0]?.raw).toBe(20);
        expect(data.sheets[0].rows[0][1]?.raw).toBe(10);
        expect(data.sheets[0].rows[0][2]?.raw).toBeNull();
        expect(data.sheets[0].rows[0][3]?.formula).toBe('=B1+A1');
    });

    it('refuses a move that would retarget a what-if data table input', () => {
        const raw = patched_basic([[
            '/xl/worksheets/sheet1.xml',
            '<c r="B2"><v>30</v></c><c r="C2" t="b"><v>1</v></c>',
            '<c r="A1"><v>10</v></c>'
                + '<c r="D1"><f t="dataTable" ref="D1:D2" r1="A1"></f><v>20</v></c>',
        ]]);
        expect(() => write_xlsx_workbook_cell_edits(raw, [{
            sheetIndex: 0,
            edits: [
                { row: 0, col: 0, value: '' },
                {
                    row: 2, col: 2, value: '10', valueEditOrder: 1,
                    movedFrom: { row: 0, col: 0, order: 1 },
                },
            ],
        }])).toThrow(/data table/i);
    });

    it('retains overwritten move provenance and leaves styled equals text literal', async () => {
        const raw = patched_basic([[
            '/xl/worksheets/sheet1.xml',
            '<c r="B2"><v>30</v></c><c r="C2" t="b"><v>1</v></c>',
            '<c r="A1"><v>10</v></c><c r="B1"><v>20</v></c>'
                + '<c r="D1"><f>A1</f><v>10</v></c>',
        ]]);
        const out = write_xlsx_workbook_cell_edits(raw, [{
            sheetIndex: 0,
            edits: [
                { row: 0, col: 0, value: '' },
                { row: 0, col: 1, value: '' },
                {
                    row: 0, col: 2, value: '20', valueEditOrder: 2,
                    movedFrom: {
                        row: 0, col: 1, order: 2,
                        previous: [{
                            sourceRow: 0, sourceCol: 0,
                            destinationRow: 0, destinationCol: 2, order: 1,
                        }],
                    },
                },
                {
                    row: 1, col: 3, value: '=A1', valueEditOrder: 0,
                    runs: [{ text: '=A1', style: { bold: true } }],
                },
            ],
        }]);
        const { data } = await parse_xlsx(out);

        expect(data.sheets[0].rows[0][3]?.formula).toBe('=C1');
        expect(data.sheets[0].rows[1][3]).toMatchObject({ raw: '=A1' });
        expect(data.sheets[0].rows[1][3]?.formula).toBeUndefined();
    });

    it('allows a blank source cell to participate in an otherwise coherent move', () => {
        const raw = readFileSync('src/test/fixtures/basic.xlsx');
        expect(() => write_xlsx_workbook_cell_edits(raw, [{
            sheetIndex: 0,
            edits: [{
                row: 20, col: 2, value: '', valueEditOrder: 1,
                movedFrom: { row: 20, col: 1, order: 1 },
            }],
        }])).not.toThrow();
    });

    it('writes several worksheets through one workbook operation', async () => {
        const raw = readFileSync('src/test/fixtures/basic.xlsx');
        const out = write_xlsx_workbook_cell_edits(raw, [
            { sheetIndex: 0, edits: [{ row: 1, col: 0, value: 'Alicia' }] },
            { sheetIndex: 1, edits: [{ row: 1, col: 0, value: 'Gadget' }] },
        ]);
        const { data } = await parse_xlsx(out);

        expect(data.sheets[0].rows[1][0]?.raw).toBe('Alicia');
        expect(data.sheets[1].rows[1][0]?.raw).toBe('Gadget');
    });

    it('rejects duplicate worksheet targets as one operation', () => {
        const raw = readFileSync('src/test/fixtures/basic.xlsx');
        expect(() => write_xlsx_workbook_cell_edits(raw, [
            { sheetIndex: 0, edits: [{ row: 1, col: 0, value: 'Alicia' }] },
            { sheetIndex: 0, edits: [{ row: 2, col: 0, value: 'Bob' }] },
        ])).toThrow('Invalid or duplicate worksheet');
    });

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

    it('makes dirty previews match the formatted result after save and reparse', async () => {
        const raw = readFileSync(FORMATTED);
        const before = (await parse_xlsx(raw)).data.sheets[0].rows[0];
        const numeric_format = before[0]!.numberFormat!;
        const date_format = before[2]!.numberFormat!;
        const numeric_preview = format_xlsx_edit_preview('9876.5', numeric_format);
        const date_preview = format_xlsx_edit_preview('2024-01-15', date_format);

        const out = write_xlsx_cell_edits(raw, 0, [
            { row: 0, col: 0, value: '9876.5' },
            { row: 0, col: 2, value: '2024-01-15' },
        ]);
        const after = (await parse_xlsx(out)).data.sheets[0].rows[0];
        expect(after[0]?.formatted).toBe(numeric_preview);
        expect(after[0]?.raw).toBe(9876.5);
        expect(after[2]?.formatted).toBe(date_preview);
        expect(String(after[2]?.raw)).toContain('2024-01-15');
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

    it('numbers xf indexes exactly as the reader does', async () => {
        // A cell's `s` indexes `cellXfs`, so both sides must agree on its length or
        // every style after the divergence means a different format to each. The
        // reader counts an `<xf>` written inside CDATA. This writer used to skip it —
        // right about XML and wrong about the file, because `s="0"` then named
        // General to the reader and a date format here, and a typed date went in as
        // the serial 45306, which is what the user saw.
        //
        // Both sides now share `parse_styles`, so the disagreement has nowhere to
        // arise: the discarded `<xf>` is index 0 to each of them and `numFmtId="14"`
        // is index 1 to each. A1 is `s="1"`, so it is a date style to *both*, the
        // serial is the right thing to store, and — the part that matters — the
        // reader hands back the date that was typed rather than a five-digit number.
        const bytes = patched_parts([['/xl/styles.xml', /<cellXfs[\s\S]*<\/cellXfs>/,
            '<cellXfs count="1"><![CDATA[<xf numFmtId="0"/>]]><xf numFmtId="14"/></cellXfs>']]);
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        const { data } = await parse_xlsx(out);
        expect(String(data.sheets[0].rows[0][0]!.raw)).toContain('2024-01-15');
    });

    it('reads a number format the reader sees, not one hidden in a comment', async () => {
        // A commented-out `<numFmt>` is text to a parser and a format to the reader,
        // whose scan is comment-blind — so a commented entry repeating a live
        // `numFmtId` *wins* there and is invisible to a comment-aware writer. Style 1
        // was a date to the writer and plain `0` to the reader, so the typed date was
        // stored as a serial the user then saw as `45306`.
        const bytes = patched_parts([[
            '/xl/styles.xml',
            '<numFmt numFmtId="164" formatCode="$#,##0.00"/>',
            '<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>'
                + '<!-- <numFmt numFmtId="164" formatCode="0"/> -->',
        ]]);
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        const { data } = await parse_xlsx(out);
        expect(data.sheets[0].rows[0][0]!.raw).toBe('2024-01-15');
    });

    it('reads the date epoch the reader reads, comments included', async () => {
        // Same blindness, on `workbookPr`. A commented `date1904="1"` is the epoch to
        // the reader and invisible to a comment-aware writer, and the two epochs are
        // 1462 days apart — so this is not a rounding error: `2024-01-15` was saved on
        // the 1900 epoch and read straight back as `2028-01-16`.
        const bytes = patched_parts([
            ['/xl/styles.xml', 'formatCode="$#,##0.00"', 'formatCode="yyyy-mm-dd"'],
            [
                '/xl/workbook.xml',
                '<workbookPr defaultThemeVersion="164011" filterPrivacy="1"/>',
                '<workbookPr defaultThemeVersion="164011" filterPrivacy="1"/>'
                    + '<!-- <workbookPr date1904="1"/> -->',
            ],
        ]);
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        const { data } = await parse_xlsx(out);
        expect(String(data.sheets[0].rows[0][0]!.raw)).toContain('2024-01-15');
    });

    it('reads an xf numFmtId exactly as the reader does, single quotes included', async () => {
        // `numFmtId='164'` is legal XML, and both sides read it through the same
        // `get_attr` — so the style is the date format 164 to reader and writer
        // alike. What matters is the agreement, not which way it goes: the typed
        // date is stored as a serial under a date format and reads back as that
        // date, never as a bare 45306.
        const bytes = patched_parts([
            ['/xl/styles.xml', 'formatCode="$#,##0.00"', 'formatCode="yyyy-mm-dd"'],
            ['/xl/styles.xml', '<xf numFmtId="164"', "<xf numFmtId='164'"],
        ]);
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        const { data } = await parse_xlsx(out);
        expect(String(data.sheets[0].rows[0][0]!.raw)).toContain('2024-01-15');
        expect(data.sheets[0].rows[0][0]!.formatted).toBe('2024-01-15');
    });

    it('stores a long identifier as text rather than rounding it away', async () => {
        // `<v>` reads back as a double, so past ~15 significant digits the digits
        // the user typed are gone from the file: an account number entered as
        // 12345678901234567890 came back 12345678901234567000.
        const out = write_xlsx_cell_edits(readFileSync(EMPTY), 0, [
            { row: 0, col: 0, value: '12345678901234567890' },
        ]);
        const { data } = await parse_xlsx(out);
        expect(String(data.sheets[0].rows[0][0]!.raw)).toBe('12345678901234567890');
    });

    it('still stores ordinary numbers as numbers', async () => {
        // The guard above must not sweep in the values that actually dominate;
        // trailing zeros and exponents cost no precision and stay numeric.
        const out = write_xlsx_cell_edits(readFileSync(EMPTY), 0, [
            { row: 0, col: 0, value: '1234.56' },
            { row: 1, col: 0, value: '-0.000125' },
            { row: 2, col: 0, value: '1.2e-30' },
            { row: 3, col: 0, value: '999999999999999' },
        ]);
        const { data } = await parse_xlsx(out);
        for (const [row, expected] of [1234.56, -0.000125, 1.2e-30, 999999999999999].entries()) {
            expect(data.sheets[0].rows[row][0]!.raw, `row ${row}`).toBe(expected);
        }
    });

    it('reads a style index exactly as the reader does, leading plus included', async () => {
        // The reader's `parseInt` takes `+3`, which is legal for the `unsignedInt`
        // this attribute is typed as. A digits-only match here made the cell styled
        // to the reader and unstyled to the writer, so a date cell the user retyped
        // came back an inline string — unchanged on screen, no longer a date to
        // anything downstream.
        const bytes = patched_parts([[
            '/xl/worksheets/sheet1.xml',
            '<c r="C1" s="3"',
            '<c r="C1" s="+3"',
        ]]);
        expect((await parse_xlsx(bytes)).data.sheets[0].rows[0][2]!.rawType).toBe('date');

        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 2, value: '2024-01-15' }]);
        expect((await parse_xlsx(out)).data.sheets[0].rows[0][2]!.rawType).toBe('date');
    });

    it('refuses to store a date before Excel\'s epoch as a serial', async () => {
        // Excel has no date before 1900, and shows a negative serial in a
        // date-formatted cell as `########`. Storing `1899-12-30` as `<v>-1</v>`
        // looked correct here — our own reader renders it back as the date — and
        // was unreadable in the application the file exists to be opened in.
        const out = write_xlsx_cell_edits(readFileSync(FORMATTED), 0, [
            { row: 0, col: 2, value: '1899-12-30' },
        ]);
        const sheet = part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8');
        expect(sheet).not.toContain('<v>-1</v>');
        expect(String((await parse_xlsx(out)).data.sheets[0].rows[0][2]!.raw)).toBe('1899-12-30');
    });

    it('keeps an ISO date cell typed as a date', async () => {
        // `t="d"` stores the date as text and the reader shows it verbatim, so the
        // user retypes what looks like the same value — and got back an inline
        // string. Identical on screen, and no longer a date to any formula, filter or
        // consumer downstream, exactly as a boolean rewritten as text would be.
        const bytes = patched_parts([[
            '/xl/worksheets/sheet1.xml',
            '<c r="A1" s="1"><v>1234.56</v></c>',
            '<c r="A1" t="d"><v>2024-01-01</v></c>',
        ]]);
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        const { data } = await parse_xlsx(out);
        expect(data.sheets[0].rows[0][0]!.rawType).toBe('date');
        expect(data.sheets[0].rows[0][0]!.raw).toBe('2024-01-15');
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

    it('reads a formatCode exactly as the reader does, single quotes included', async () => {
        // Both quote styles are legal XML, and `get_attr` now reads either — so
        // `formatCode='yyyy-mm-dd'` is a date format to reader and writer alike.
        // Being more nearly correct about XML is not the requirement; agreeing
        // with the side that renders the result is. Sharing `parse_styles`
        // settles it: the serial is stored under a format that displays it as
        // the date the user typed, never as a bare 45306.
        const bytes = patched_parts([
            ['/xl/styles.xml', /formatCode="([^"]*)"/, "formatCode='yyyy-mm-dd'"],
        ]);
        const out = write_xlsx_cell_edits(bytes, 0, [{ row: 0, col: 0, value: '2024-01-15' }]);
        const { data } = await parse_xlsx(out);
        expect(data.sheets[0].rows[0][0]!.formatted).toBe('2024-01-15');
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
        // This is the core putexcel guarantee: dependency discovery may inspect
        // worksheet formula structures, but parts with no edit or invalidated
        // cache keep their original ZIP record byte-for-byte.
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

        /**
         * The sample with a formula in B2, so that an edit there drops one — which
         * is what makes the calc chain stale and sends it through the removal.
         */
        function with_formula_at_b2(raw: Uint8Array): Uint8Array {
            const base = CFB.read(raw, { type: 'buffer' });
            const sheet = CFB.find(base, '/xl/worksheets/sheet3.xml')!;
            const patched = Buffer.from(
                Buffer.from(sheet.content as Uint8Array).toString('utf8')
                    .replace(/<c r="B2"[^>]*(?:\/>|>[\s\S]*?<\/c>)/, '<c r="B2"><f>1+1</f><v>2</v></c>'),
                'utf8',
            );
            sheet.content = patched;
            sheet.size = patched.length;
            const out = CFB.write(base, { type: 'buffer', fileType: 'zip', compression: true });
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
            const raw = with_calc_chain(
                with_formula_at_b2(readFileSync(SAMPLE)),
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
            const raw = with_calc_chain(
                with_formula_at_b2(readFileSync(SAMPLE)),
            );
            expect(text_part(raw, '/xl/worksheets/sheet3.xml')).toContain('<f>1+1</f>');

            const out = write_xlsx_cell_edits(raw, 2, [{ row: 1, col: 1, value: '42' }]);

            expect(part(out, '/xl/calcChain.xml')).toBeNull();
            expect(text_part(out, '/[Content_Types].xml')).not.toContain('/xl/calcChain.xml');
            expect(text_part(out, '/xl/_rels/workbook.xml.rels')).not.toContain('calcChain.xml');
        });

        it('removes prefixed content-type and workbook relationship references', () => {
            const file = CFB.read(
                with_calc_chain(with_formula_at_b2(readFileSync(SAMPLE))),
                { type: 'buffer' },
            );
            const content_types = CFB.find(file, '/[Content_Types].xml')!;
            const content_text = Buffer.from(content_types.content as Uint8Array)
                .toString('utf8')
                .replace(
                    /<Types xmlns="([^"]+)">/,
                    '<ct:Types xmlns:ct="$1">',
                )
                .replace(/<Override\b/g, '<ct:Override')
                .replace(/<\/Types>/, '</ct:Types>');
            content_types.content = Buffer.from(content_text, 'utf8');
            content_types.size = content_types.content.length;
            const rels = CFB.find(file, '/xl/_rels/workbook.xml.rels')!;
            const rels_text = Buffer.from(rels.content as Uint8Array).toString('utf8')
                .replace(
                    /<Relationships xmlns="([^"]+)">/,
                    '<p:Relationships xmlns:p="$1">',
                )
                .replace(/<Relationship\b/g, '<p:Relationship')
                .replace(/<\/Relationships>/, '</p:Relationships>');
            rels.content = Buffer.from(rels_text, 'utf8');
            rels.size = rels.content.length;
            const written = CFB.write(file, {
                type: 'buffer', fileType: 'zip', compression: true,
            });
            const raw = written instanceof Uint8Array
                ? written
                : new Uint8Array(written as ArrayBufferLike);

            const out = write_xlsx_cell_edits(raw, 2, [{ row: 1, col: 1, value: '42' }]);

            expect(part(out, '/xl/calcChain.xml')).toBeNull();
            expect(text_part(out, '/[Content_Types].xml')).not.toContain('/xl/calcChain.xml');
            expect(text_part(out, '/xl/_rels/workbook.xml.rels')).not.toContain('calcChain.xml');
        });

        it('is detached completely when an edit changes a formula', () => {
            const raw = with_calc_chain(
                with_formula_at_b2(readFileSync(SAMPLE)),
            );

            const out = write_xlsx_cell_edits(raw, 2, [{
                row: 1,
                col: 1,
                value: '=1+2',
            }]);

            expect(text_part(out, '/xl/worksheets/sheet3.xml'))
                .toContain('<c r="B2"><f>1+2</f></c>');
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
            const raw = with_calc_chain(
                with_formula_at_b2(readFileSync(SAMPLE)),
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
            const raw = with_calc_chain(
                with_formula_at_b2(readFileSync(SAMPLE)),
                false,
                'note="1 > 0" ',
            );

            const out = write_xlsx_cell_edits(raw, 2, [{ row: 1, col: 1, value: '42' }]);

            expect(part(out, '/xl/calcChain.xml')).toBeNull();
            expect(text_part(out, '/[Content_Types].xml')).not.toContain('/xl/calcChain.xml');
            expect(text_part(out, '/xl/_rels/workbook.xml.rels')).not.toContain('calcChain.xml');
        });

        it('leaves the package whole when a reference edit cannot be computed', () => {
            // The removal is all-or-nothing, and this is the "none" half. Every
            // *partial* removal is its own broken package: the part gone but still
            // referenced, or still present with no content type (typed by the
            // `<Default Extension="xml">` fallback instead of as a calc chain), or
            // present and unreferenced. So the reference edits are computed before
            // any is applied, and a failure to compute abandons the whole removal
            // rather than committing the half that worked.
            //
            // Injected on the *second* reference part, so a content type that
            // strips cleanly is followed by a rels part that throws: with the edits
            // applied as they were computed, the first would already be written by
            // the time the second failed.
            const raw = with_calc_chain(with_formula_at_b2(readFileSync(SAMPLE)));
            const before_types = text_part(raw, '/[Content_Types].xml');
            const before_rels = text_part(raw, '/xl/_rels/workbook.xml.rels');
            // Armed only once the calc chain removal is underway, so both reference
            // parts stay readable for the reads the edit itself needs. Which of the
            // two is hit second is deliberately *not* hard-coded: the failure has to
            // land after one reference edit has been computed, and naming a path
            // would quietly stop doing that the day the two are reordered — leaving
            // a test that passes because nothing was injected at all.
            const REFERENCE_PARTS = ['/[Content_Types].xml', '/xl/_rels/workbook.xml.rels'];
            const actual_read_text = ZipPackage.prototype.read_text;
            let removing = false;
            let first: string | null = null;
            let injected = false;
            const spy = vi.spyOn(ZipPackage.prototype, 'read_text').mockImplementation(function (
                this: ZipPackage,
                path: string,
            ) {
                // Content types are not needed by the edit itself, so their first
                // read is the start of the calc-chain removal plan.
                if (path === '/[Content_Types].xml') removing = true;
                if (removing && REFERENCE_PARTS.includes(path)) {
                    // Repeat visits to the part already reached are let through, so
                    // the removal gets as far as committing that one edit.
                    if (first === null) first = path;
                    if (path !== first) {
                        injected = true;
                        throw new Error('unreadable part');
                    }
                }
                return actual_read_text.call(this, path);
            });

            // The edit itself still succeeds — a stale calc chain is a cache Excel
            // rebuilds, and failing the save would cost the user the edit instead.
            let out: Uint8Array;
            try {
                out = write_xlsx_cell_edits(raw, 2, [{ row: 1, col: 1, value: '42' }]);
            } finally {
                spy.mockRestore();
            }

            // The failure really was injected. Without this the test would go on
            // passing if the edit stopped dropping a formula: no removal, nothing
            // thrown, and a package that is whole for the uninteresting reason.
            expect(injected).toBe(true);
            // The edit landed, in the cell it was addressed to. The whole point of
            // swallowing the failure is that the user keeps their change, so a
            // `remove_part` that gave up by discarding the edited package would
            // satisfy every check below. Pinned to B2 rather than looked for
            // anywhere in the sheet, since a coordinate that routed 42 into some
            // other cell would still drop B2's formula and still read as "the edit
            // landed".
            expect(/<c r="B2"(?![^>]*\/>)[^>]*>(?:(?!<\/c>)[\s\S])*<v>42<\/v>/.test(
                text_part(out, '/xl/worksheets/sheet3.xml'),
            )).toBe(true);
            // And nothing was half-removed: the part, its content type and its
            // relationship are all exactly as they were.
            expect(part(out, '/xl/calcChain.xml')).not.toBeNull();
            expect(text_part(out, '/[Content_Types].xml')).toBe(before_types);
            expect(text_part(out, '/xl/_rels/workbook.xml.rels')).toBe(before_rels);
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

describe('rich inline strings', () => {
    const doc = (body: string) =>
        `<worksheet><dimension ref="A1:C3"/><sheetData>${body}</sheetData><pageMargins/></worksheet>`;
    const cell = '<row r="1"><c r="A1"><v>1</v></c></row>';

    it('writes styled runs as a rich inline string, off flags absent', () => {
        const out = apply_cell_edits(
            doc(cell),
            [{
                row: 0, col: 0, value: 'plain bold',
                runs: [
                    { text: 'plain ' },
                    { text: 'bold', style: { bold: true } },
                ],
            }],
            OPTS,
        );
        expect(out).toContain(
            '<c r="A1" t="inlineStr"><is>'
            + '<r><t xml:space="preserve">plain </t></r>'
            + '<r><rPr><b/></rPr><t xml:space="preserve">bold</t></r>'
            + '</is></c>',
        );
    });

    it('emits flags in b/i/strike/u order and only the flags that are on', () => {
        const out = apply_cell_edits(
            doc(cell),
            [{
                row: 0, col: 0, value: 'x',
                runs: [{ text: 'x', style: { bold: true, italic: true, underline: true, strikethrough: true } }],
            }],
            OPTS,
        );
        expect(out).toContain('<rPr><b/><i/><strike/><u/></rPr>');
    });

    it('omits rPr on a run whose style equals the cell font, so it inherits everything', () => {
        // The cell font is itself bold: the bold run carries no information the
        // `s=` style doesn't, and MUST inherit rather than replace — an explicit
        // `<rPr><b/></rPr>` would reset the cell's name/size/color to defaults.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1" s="1"><v>1</v></c></row>'),
            [{
                row: 0, col: 0, value: 'boldplain',
                runs: [
                    { text: 'bold', style: { bold: true } },
                    { text: 'plain' },
                ],
            }],
            { ...OPTS, cell_font_style: () => ({ bold: true }) },
        );
        expect(out).toContain('<r><t xml:space="preserve">bold</t></r>');
        // The plain run diverges from the bold cell font, so it gets an explicit
        // (empty-of-flags) rPr that REPLACES the font — that is what "not bold" is.
        expect(out).toContain('<r><rPr></rPr><t xml:space="preserve">plain</t></r>');
    });

    it('starts every explicit rPr from the cell font base so styled runs keep name/size/color', () => {
        const base = '<rFont val="Cambria"/><sz val="14"/>';
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1" s="2"><v>1</v></c></row>'),
            [{
                row: 0, col: 0, value: 'big',
                runs: [{ text: 'big', style: { italic: true } }],
            }],
            { ...OPTS, run_font_base: (xf) => (xf === 2 ? base : '') },
        );
        expect(out).toContain(`<rPr>${base}<i/></rPr>`);
    });

    it('reduces runs that all match the cell font to the plain form', () => {
        // A date typed with markup that resolves to exactly the cell font's own
        // style carries no run-level information, so classification still runs:
        // under a date style it stays a serial, not an inline string.
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1" s="1"><v>1</v></c></row>'),
            [{
                row: 0, col: 0, value: '2024-01-15',
                runs: [{ text: '2024-01-15', style: { bold: true } }],
            }],
            {
                datemode: 0,
                is_date_style: () => true,
                cell_font_style: () => ({ bold: true }),
            },
        );
        expect(out).toContain('<c r="A1" s="1"><v>45306</v></c>');
        expect(out).not.toContain('inlineStr');
    });

    it('keeps styled date-looking text as text — styled text is text', () => {
        const out = apply_cell_edits(
            doc('<row r="1"><c r="A1" s="1"><v>1</v></c></row>'),
            [{
                row: 0, col: 0, value: '2024-01-15',
                runs: [{ text: '2024-01-15', style: { bold: true } }],
            }],
            { datemode: 0, is_date_style: () => true },
        );
        expect(out).toContain('t="inlineStr"');
        expect(out).not.toContain('<v>45306</v>');
    });

    it('escapes run text like any other inline string', () => {
        const out = apply_cell_edits(
            doc(cell),
            [{
                row: 0, col: 0, value: 'a<b>&c',
                runs: [{ text: 'a<b>&c', style: { bold: true } }],
            }],
            OPTS,
        );
        expect(out).toContain('<t xml:space="preserve">a&lt;b&gt;&amp;c</t>');
    });

    it('does not let a nested style element survive into a run base', () => {
        // The base is the cell font minus its style flags — the flags come from
        // the run's own style. Removing the flag elements in a single pass lets
        // `<<b/>b/>` reconstitute a `<b/>`, so a crafted styles.xml could put
        // bold back into a run the model believes is plain, and the saved file
        // would not match what the user typed.
        const file = CFB.read(readFileSync(FORMATTED), { type: 'buffer' });
        CFB.utils.cfb_add(file, '/xl/styles.xml', Buffer.from(
            '<?xml version="1.0"?><styleSheet>'
            + '<fonts count="1"><font><name val="Cambria"/><<b/>b/></font></fonts>'
            + '<cellXfs count="1"><xf numFmtId="0" fontId="0"/></cellXfs>'
            + '</styleSheet>',
        ));
        const raw = new Uint8Array(CFB.write(file, { type: 'buffer', fileType: 'zip' }) as ArrayBuffer);
        const out = write_xlsx_cell_edits(raw, 0, [{
            row: 0, col: 0, value: 'x',
            runs: [{ text: 'x', style: { italic: true } }],
        }]);
        const sheet = part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8');
        expect(sheet).toContain('<rPr>');
        expect(sheet).not.toContain('<b/>');
    });

    it('round-trips a rich edit through a real workbook back to the reader', async () => {
        const raw = readFileSync(FORMATTED);
        const out = write_xlsx_cell_edits(raw, 0, [{
            row: 0, col: 0, value: 'plain bold',
            runs: [
                { text: 'plain ' },
                { text: 'bold', style: { bold: true } },
            ],
        }]);
        const { data } = await parse_xlsx(out);
        const cell = data.sheets[0].rows[0][0]!;
        expect(cell.raw).toBe('plain bold');
        expect(cell.richText).toEqual({
            runs: [
                { text: 'plain ' },
                { text: 'bold', style: { bold: true } },
            ],
        });
        // The styled run's rPr carries the cell font's non-flag properties —
        // Calibri in this fixture — so the bold run does not fall back to the
        // default font (OOXML rPr replaces the cell font, never merges).
        const sheet = part(out, '/xl/worksheets/sheet1.xml')!.toString('utf8');
        expect(sheet).toContain('<rFont val="Calibri"/>');
        expect(sheet).not.toContain('<u val="none"/>');
    });
});
