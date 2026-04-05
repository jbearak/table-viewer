import { describe, it, expect } from 'vitest';
import { scan_records } from '../parse-xls';

describe('scan_records', () => {
    it('reads a single record', () => {
        const buf = Buffer.alloc(8);
        buf.writeUInt16LE(0x0809, 0);
        buf.writeUInt16LE(4, 2);
        buf[4] = 0x01; buf[5] = 0x02; buf[6] = 0x03; buf[7] = 0x04;

        const { records, truncated } = scan_records(buf);
        expect(records).toHaveLength(1);
        expect(records[0].type).toBe(0x0809);
        expect(records[0].data).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
        expect(truncated).toBe(false);
    });

    it('reads multiple records sequentially', () => {
        const buf = Buffer.alloc(10);
        buf.writeUInt16LE(0x0085, 0);
        buf.writeUInt16LE(2, 2);
        buf[4] = 0xAA; buf[5] = 0xBB;
        buf.writeUInt16LE(0x000A, 6);
        buf.writeUInt16LE(0, 8);

        const { records } = scan_records(buf);
        expect(records).toHaveLength(2);
        expect(records[0].type).toBe(0x0085);
        expect(records[1].type).toBe(0x000A);
    });

    it('stitches Continue records into preceding record', () => {
        const buf = Buffer.alloc(13);
        buf.writeUInt16LE(0x00FC, 0);
        buf.writeUInt16LE(3, 2);
        buf[4] = 0x01; buf[5] = 0x02; buf[6] = 0x03;
        buf.writeUInt16LE(0x003C, 7);
        buf.writeUInt16LE(2, 9);
        buf[11] = 0x04; buf[12] = 0x05;

        const { records } = scan_records(buf);
        expect(records).toHaveLength(1);
        expect(records[0].type).toBe(0x00FC);
        expect(records[0].data).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]));
    });

    it('returns empty records for empty buffer', () => {
        const { records, truncated } = scan_records(Buffer.alloc(0));
        expect(records).toEqual([]);
        expect(truncated).toBe(false);
    });

    it('stops gracefully on truncated record header', () => {
        const buf = Buffer.alloc(2);
        buf.writeUInt16LE(0x0809, 0);
        const { records, truncated } = scan_records(buf);
        expect(records).toEqual([]);
        expect(truncated).toBe(false); // incomplete header is not a truncated payload
    });

    it('flags truncation when payload extends past buffer end', () => {
        const buf = Buffer.alloc(8);
        buf.writeUInt16LE(0x0809, 0);
        buf.writeUInt16LE(100, 2); // claims 100 bytes of payload but buffer is only 8
        buf[4] = 0x01; buf[5] = 0x02; buf[6] = 0x03; buf[7] = 0x04;

        const { records, truncated } = scan_records(buf);
        expect(records).toEqual([]);
        expect(truncated).toBe(true);
    });
});
