import { describe, it, expect } from 'vitest';
import { decode_rk, read_biff8_string } from '../parse-xls';

describe('decode_rk', () => {
    it('decodes IEEE 754 float (flags=0x00)', () => {
        const rk = 0x3FF80000;
        expect(decode_rk(rk)).toBeCloseTo(1.5);
    });

    it('decodes IEEE 754 float / 100 (flags=0x01)', () => {
        const rk = 0x4062C001;
        expect(decode_rk(rk)).toBeCloseTo(1.5);
    });

    it('decodes integer (flags=0x02)', () => {
        const rk = (42 << 2) | 0x02;
        expect(decode_rk(rk)).toBe(42);
    });

    it('decodes integer / 100 (flags=0x03)', () => {
        const rk = (150 << 2) | 0x03;
        expect(decode_rk(rk)).toBeCloseTo(1.5);
    });
});

describe('read_biff8_string', () => {
    it('reads a compressed (Latin-1) string', () => {
        const buf = Buffer.from([0x00, 0x48, 0x69]);
        const result = read_biff8_string(buf, 0, 2);
        expect(result.value).toBe('Hi');
        expect(result.bytesRead).toBe(3);
    });

    it('reads a UTF-16LE string', () => {
        const buf = Buffer.from([0x01, 0x48, 0x00, 0x69, 0x00]);
        const result = read_biff8_string(buf, 0, 2);
        expect(result.value).toBe('Hi');
        expect(result.bytesRead).toBe(5);
    });

    it('skips rich text run data', () => {
        const buf = Buffer.alloc(10);
        buf[0] = 0x08;
        buf.writeUInt16LE(1, 1);
        buf[3] = 0x41;
        buf[4] = 0x42;
        buf[5] = 0x00; buf[6] = 0x00; buf[7] = 0x02; buf[8] = 0x00;

        const result = read_biff8_string(buf, 0, 2);
        expect(result.value).toBe('AB');
        expect(result.bytesRead).toBe(9);
    });
});
