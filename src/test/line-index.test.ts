// src/test/line-index.test.ts
import { describe, it, expect } from 'vitest';
import { build_line_index, split_csv_rows } from '../data-source/line-index';

const enc = (s: string) => new TextEncoder().encode(s);

describe('build_line_index', () => {
    it('indexes simple LF rows', () => {
        const idx = build_line_index(enc('a,b\nc,d\ne,f\n'));
        expect(idx.rowCount).toBe(3);
        expect(idx.offsetOf(0)).toBe(0);
        expect(idx.offsetOf(1)).toBe(4);
        expect(idx.offsetOf(2)).toBe(8);
    });
    it('handles CRLF', () => {
        const idx = build_line_index(enc('a\r\nb\r\n'));
        expect(idx.rowCount).toBe(2);
        expect(idx.offsetOf(1)).toBe(3);
    });
    it('treats a quoted multiline field as one row', () => {
        // row 0 = `"x\ny",z` spans two physical lines; row 1 = `p,q`
        const src = '"x\ny",z\np,q\n';
        const idx = build_line_index(enc(src));
        expect(idx.rowCount).toBe(2);
        expect(idx.offsetOf(1)).toBe('"x\ny",z\n'.length);
    });
    it('handles no trailing newline', () => {
        const idx = build_line_index(enc('a\nb'));
        expect(idx.rowCount).toBe(2);
        expect(idx.offsetOf(1)).toBe(2);
    });
    it('endOffset of last row is buffer length', () => {
        const buf = enc('a\nb\n');
        const idx = build_line_index(buf);
        expect(idx.endOffsetOf(idx.rowCount - 1)).toBe(buf.length);
    });
    it('empty buffer has rowCount 0', () => {
        const idx = build_line_index(enc(''));
        expect(idx.rowCount).toBe(0);
    });
    it('doubled-quote escape keeps parity correct', () => {
        // Row 0: `"a,""b"",c"` (quoted field with escaped quotes), row 1: `x,y`
        const src = '"a,""b"",c"\nx,y\n';
        const idx = build_line_index(enc(src));
        expect(idx.rowCount).toBe(2);
        expect(idx.offsetOf(1)).toBe(enc('"a,""b"",c"\n').length);
    });
    it('treats a quote in the middle of an unquoted field as a literal (newline still splits)', () => {
        // PapaParse only enters quoted mode when `"` starts a field. Here `a"b`
        // is an unquoted field, so the following `\n` is a real row boundary —
        // the old parity-toggle scanner wrongly swallowed it.
        const src = 'a"b\nc,d\n';
        const idx = build_line_index(enc(src));
        expect(idx.rowCount).toBe(2);
        expect(idx.offsetOf(1)).toBe('a"b\n'.length);
    });
    it('does not merge rows when a quoted field is left unbalanced mid-buffer', () => {
        // `"x` opens a quoted field that never closes; everything after stays
        // "in quotes" through EOF, matching PapaParse swallowing the rest.
        const src = 'a,b\n"x\ny\nz';
        const idx = build_line_index(enc(src));
        expect(idx.rowCount).toBe(2);
        expect(idx.offsetOf(1)).toBe('a,b\n'.length);
    });
    it('honours the delimiter for field-start detection (TSV)', () => {
        // Tab-delimited: the `"` after the tab starts a quoted field, so its
        // embedded newline must not split the row. With the comma default this
        // would (incorrectly) not be treated as a field start.
        const TAB = 0x09;
        const src = 'a\t"x\ny"\np\tq\n';
        const idx = build_line_index(enc(src), TAB);
        expect(idx.rowCount).toBe(2);
        expect(idx.offsetOf(1)).toBe('a\t"x\ny"\n'.length);
    });

    describe('fieldCountOf', () => {
        it('counts fields per row (delimiters + 1)', () => {
            const idx = build_line_index(enc('a,b\nc,d,e\nf\n'));
            expect(idx.fieldCountOf(0)).toBe(2);
            expect(idx.fieldCountOf(1)).toBe(3);
            expect(idx.fieldCountOf(2)).toBe(1);
        });
        it('counts an empty middle field', () => {
            const idx = build_line_index(enc('a,,c\n'));
            expect(idx.fieldCountOf(0)).toBe(3);
        });
        it('counts a blank line as a single empty field', () => {
            const idx = build_line_index(enc('a\n\nb\n'));
            expect(idx.rowCount).toBe(3);
            expect(idx.fieldCountOf(0)).toBe(1);
            expect(idx.fieldCountOf(1)).toBe(1);
            expect(idx.fieldCountOf(2)).toBe(1);
        });
        it('ignores delimiters and newlines inside a quoted field', () => {
            // `"x,y\nz",w` is two fields: the quoted field swallows the comma
            // and newline, then `w` follows the closing delimiter.
            const idx = build_line_index(enc('"x,y\nz",w\np,q,r\n'));
            expect(idx.rowCount).toBe(2);
            expect(idx.fieldCountOf(0)).toBe(2);
            expect(idx.fieldCountOf(1)).toBe(3);
        });
        it('counts the final row when there is no trailing newline', () => {
            const idx = build_line_index(enc('a,b\nc,d,e'));
            expect(idx.fieldCountOf(0)).toBe(2);
            expect(idx.fieldCountOf(1)).toBe(3);
        });
        it('treats a doubled-quote escape as one field', () => {
            const idx = build_line_index(enc('"a,""b"",c"\nx,y\n'));
            expect(idx.fieldCountOf(0)).toBe(1);
            expect(idx.fieldCountOf(1)).toBe(2);
        });
        it('counts an unbalanced quoted tail as one field', () => {
            const idx = build_line_index(enc('a,b\n"x\ny\nz'));
            expect(idx.fieldCountOf(0)).toBe(2);
            expect(idx.fieldCountOf(1)).toBe(1);
        });
        it('honours the delimiter when counting fields (TSV)', () => {
            const TAB = 0x09;
            const idx = build_line_index(enc('a\tb\tc\np\tq\n'), TAB);
            expect(idx.fieldCountOf(0)).toBe(3);
            expect(idx.fieldCountOf(1)).toBe(2);
        });
    });
});

describe('split_csv_rows', () => {
    it('splits simple LF rows into fields', () => {
        expect(split_csv_rows('a,b\nc,d\n', ',')).toEqual([['a', 'b'], ['c', 'd']]);
    });
    it('does not emit a phantom empty row after a trailing newline', () => {
        expect(split_csv_rows('a,b\n', ',')).toEqual([['a', 'b']]);
    });
    it('keeps the final row when there is no trailing newline', () => {
        expect(split_csv_rows('a,b\nc,d', ',')).toEqual([['a', 'b'], ['c', 'd']]);
    });
    it('returns no rows for an empty string', () => {
        expect(split_csv_rows('', ',')).toEqual([]);
    });
    it('treats CR, LF, and CRLF all as row terminators', () => {
        expect(split_csv_rows('a,b\r\nc,d\nx,y\r\n', ',')).toEqual([
            ['a', 'b'], ['c', 'd'], ['x', 'y'],
        ]);
    });
    it('preserves a quoted field containing the delimiter and a newline', () => {
        expect(split_csv_rows('"x,y\nz",w\np,q\n', ',')).toEqual([
            ['x,y\nz', 'w'], ['p', 'q'],
        ]);
    });
    it('unescapes a doubled quote inside a quoted field', () => {
        expect(split_csv_rows('"a,""b"",c"\nx,y\n', ',')).toEqual([
            ['a,"b",c'], ['x', 'y'],
        ]);
    });
    it('treats a stray quote in the middle of an unquoted field as literal', () => {
        // `"a"b` is one field whose value is `ab`: the quoted part `a` plus the
        // trailing literal `b`. Crucially it is ONE field, matching build_line_index.
        expect(split_csv_rows('"a"b,c\n', ',')).toEqual([['ab', 'c']]);
    });
    it('counts an empty trailing field after a delimiter', () => {
        expect(split_csv_rows('a,\n', ',')).toEqual([['a', '']]);
    });
    it('emits a blank line as one empty field', () => {
        expect(split_csv_rows('a\n\nb\n', ',')).toEqual([['a'], [''], ['b']]);
    });
    it('honours the delimiter for field-start quote detection (TSV)', () => {
        expect(split_csv_rows('a\t"x\ny"\np\tq\n', '\t')).toEqual([
            ['a', 'x\ny'], ['p', 'q'],
        ]);
    });

    // The save path relies on build_line_index's per-row field counts matching
    // exactly the cells split_csv_rows produces. If they ever diverge, serialize
    // emits spurious or missing columns. Pin them together across awkward inputs.
    describe('agrees with build_line_index on shape', () => {
        const cases = [
            'a,b\nc,d\ne,f\n',
            'a,b\nc,d,e\nf\n',
            'a,b\nc,d',
            '"x\ny",z\np,q\n',
            '"a,""b"",c"\nx,y\n',
            'a"b\nc,d\n',
            'a,b\n"x\ny\nz',
            'a,b\r\nc,d\nx,y\r\n',
            '"a"b,c\n',
            'a,\n',
            'a\n\nb\n',
            'café,x\n1,2\n',
            '',
        ];
        for (const src of cases) {
            it(`matches for ${JSON.stringify(src)}`, () => {
                const idx = build_line_index(enc(src));
                const rows = split_csv_rows(src, ',');
                expect(rows.length).toBe(idx.rowCount);
                for (let r = 0; r < idx.rowCount; r++) {
                    expect(rows[r].length).toBe(idx.fieldCountOf(r));
                }
            });
        }
    });
});
