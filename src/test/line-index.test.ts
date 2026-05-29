// src/test/line-index.test.ts
import { describe, it, expect } from 'vitest';
import { build_line_index } from '../data-source/line-index';

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
});
