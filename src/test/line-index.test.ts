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
});
