import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import CFB from 'cfb';
import { describe, expect, it } from 'vitest';
import { parse_xlsx, worksheet_part_paths } from '../parse-xlsx';
import { write_xlsx_cell_edits } from '../xlsx-package';
import { ZipPackage } from '../zip-package';

function u16(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
    return (bytes[offset]
        | (bytes[offset + 1] << 8)
        | (bytes[offset + 2] << 16)
        | (bytes[offset + 3] << 24)) >>> 0;
}

interface ZipMemberLocation {
    readonly central: number;
    readonly local: number;
    readonly data: number;
    readonly compressed_size: number;
    readonly name_length: number;
}

function zip_member(bytes: Uint8Array, wanted: string): ZipMemberLocation {
    let eocd = bytes.length - 22;
    while (eocd >= 0
        && !(u32(bytes, eocd) === 0x06054b50
            && eocd + 22 + u16(bytes, eocd + 20) === bytes.length)) eocd -= 1;
    if (eocd < 0) throw new Error('test ZIP has no EOCD');
    let central = u32(bytes, eocd + 16);
    const entries = u16(bytes, eocd + 10);
    for (let index = 0; index < entries; index += 1) {
        if (u32(bytes, central) !== 0x02014b50) throw new Error('bad test central directory');
        const name_length = u16(bytes, central + 28);
        const extra_length = u16(bytes, central + 30);
        const comment_length = u16(bytes, central + 32);
        const name = Buffer.from(bytes.subarray(central + 46, central + 46 + name_length))
            .toString('utf8');
        if (name === wanted) {
            const compressed_size = u32(bytes, central + 20);
            const local = u32(bytes, central + 42);
            const data = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
            return { central, local, data, compressed_size, name_length };
        }
        central += 46 + name_length + extra_length + comment_length;
    }
    throw new Error(`test ZIP has no ${wanted}`);
}

function compressed_member(bytes: Uint8Array, wanted: string): Uint8Array {
    const { data, compressed_size } = zip_member(bytes, wanted);
    return bytes.subarray(data, data + compressed_size);
}

function put_u32(bytes: Uint8Array, offset: number, value: number): void {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
}

function put_u16(bytes: Uint8Array, offset: number, value: number): void {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
}

function test_crc32(bytes: Uint8Array): number {
    let value = 0xffffffff;
    for (const byte of bytes) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
    }
    return (value ^ 0xffffffff) >>> 0;
}

function single_member_zip(options: {
    readonly content: Uint8Array;
    readonly descriptor?: 'signed' | 'unsigned';
    readonly invalid_crc?: boolean;
    readonly trailing_compressed_byte?: boolean;
}): Buffer {
    const name = Buffer.from('xl/member.bin');
    const method = options.trailing_compressed_byte ? 8 : 0;
    const deflated = method === 8 ? deflateRawSync(options.content) : Buffer.from(options.content);
    const compressed = options.trailing_compressed_byte
        ? Buffer.concat([deflated, Buffer.from([0xff])])
        : deflated;
    const crc = (test_crc32(options.content) ^ (options.invalid_crc ? 1 : 0)) >>> 0;
    const descriptor_length = options.descriptor === 'signed'
        ? 16
        : options.descriptor === 'unsigned' ? 12 : 0;
    const local_length = 30 + name.length + compressed.length + descriptor_length;
    const central_length = 46 + name.length;
    const out = Buffer.alloc(local_length + central_length + 22);
    put_u32(out, 0, 0x04034b50);
    put_u16(out, 4, 20);
    put_u16(out, 6, options.descriptor ? 0x0008 : 0);
    put_u16(out, 8, method);
    if (!options.descriptor) {
        put_u32(out, 14, crc);
        put_u32(out, 18, compressed.length);
        put_u32(out, 22, options.content.length);
    }
    put_u16(out, 26, name.length);
    out.set(name, 30);
    const data = 30 + name.length;
    out.set(compressed, data);
    let descriptor = data + compressed.length;
    if (options.descriptor === 'signed') {
        put_u32(out, descriptor, 0x08074b50);
        descriptor += 4;
    }
    if (options.descriptor) {
        put_u32(out, descriptor, crc);
        put_u32(out, descriptor + 4, compressed.length);
        put_u32(out, descriptor + 8, options.content.length);
    }
    const central = local_length;
    put_u32(out, central, 0x02014b50);
    put_u16(out, central + 4, 0x031e);
    put_u16(out, central + 6, 20);
    put_u16(out, central + 8, options.descriptor ? 0x0008 : 0);
    put_u16(out, central + 10, method);
    put_u32(out, central + 16, crc);
    put_u32(out, central + 20, compressed.length);
    put_u32(out, central + 24, options.content.length);
    put_u16(out, central + 28, name.length);
    out.set(name, central + 46);
    const eocd = central + central_length;
    put_u32(out, eocd, 0x06054b50);
    put_u16(out, eocd + 8, 1);
    put_u16(out, eocd + 10, 1);
    put_u32(out, eocd + 12, central_length);
    put_u32(out, eocd + 16, central);
    return out;
}

describe('lazy XLSX ZIP packages', () => {
    it('never inflates or recompresses an unrelated member', async () => {
        const file = CFB.read(readFileSync('src/test/fixtures/basic.xlsx'), { type: 'buffer' });
        CFB.utils.cfb_add(file, '/xl/media/opaque.bin', Buffer.alloc(32 * 1024, 0x61));
        const generated = Buffer.from(CFB.write(file, {
            type: 'buffer',
            fileType: 'zip',
            compression: true,
        }));

        // Deliberately make the opaque member impossible to inflate. The workbook
        // must still open and save because nothing in the model asks for it.
        const corrupt = Buffer.from(generated);
        const opaque = compressed_member(corrupt, 'xl/media/opaque.bin');
        opaque[Math.floor(opaque.length / 2)] ^= 0xff;
        const before = Buffer.from(compressed_member(corrupt, 'xl/media/opaque.bin'));

        const parsed = await parse_xlsx(corrupt);
        expect(parsed.data.sheets.length).toBeGreaterThan(0);
        expect(() => ZipPackage.open(corrupt).read('/xl/media/opaque.bin')).toThrow();
        const saved = write_xlsx_cell_edits(corrupt, 0, [
            { row: 0, col: 0, value: 'zip streaming' },
        ]);

        expect(Buffer.from(compressed_member(saved, 'xl/media/opaque.bin'))).toEqual(before);
    });

    it('rejects a local header that disagrees with the central directory', async () => {
        const corrupt = Buffer.from(readFileSync('src/test/fixtures/basic.xlsx'));
        const { local } = zip_member(corrupt, 'xl/workbook.xml');
        corrupt[local + 14] ^= 0xff;
        expect(() => ZipPackage.open(corrupt)).toThrow('ZIP local and central sizes disagree');
        await expect(parse_xlsx(corrupt)).rejects.toThrow('Not a valid .xlsx file');
        expect(() => write_xlsx_cell_edits(corrupt, 0, [
            { row: 0, col: 0, value: 'rejected' },
        ])).toThrow('Not a valid .xlsx file');
    });

    it('normalizes invalid packages in the worksheet-path helper', () => {
        expect(() => worksheet_part_paths(Buffer.from('not a ZIP')))
            .toThrow('Not a valid .xlsx file');
    });

    it('uses the inflater actual length rather than trusting a declared size', () => {
        const corrupt = Buffer.from(readFileSync('src/test/fixtures/basic.xlsx'));
        const { central, local } = zip_member(corrupt, 'xl/workbook.xml');
        const declared = u32(corrupt, central + 24) + 64;
        put_u32(corrupt, central + 24, declared);
        put_u32(corrupt, local + 22, declared);
        const zip = ZipPackage.open(corrupt);
        expect(() => zip.read('/xl/workbook.xml')).toThrow('Invalid ZIP entry size');
    });

    it('rejects duplicate normalized package names', () => {
        const file = CFB.read(readFileSync('src/test/fixtures/basic.xlsx'), { type: 'buffer' });
        CFB.utils.cfb_add(file, '/xl/media/a.bin', Buffer.from('a'));
        CFB.utils.cfb_add(file, '/xl/media/b.bin', Buffer.from('b'));
        const corrupt = Buffer.from(CFB.write(file, { type: 'buffer', fileType: 'zip' }));
        const { central, local, name_length } = zip_member(corrupt, 'xl/media/b.bin');
        const central_name = corrupt.subarray(central + 46, central + 46 + name_length);
        const local_name = corrupt.subarray(local + 30, local + 30 + name_length);
        central_name[central_name.length - 5] = 'a'.charCodeAt(0);
        local_name[local_name.length - 5] = 'a'.charCodeAt(0);
        expect(() => ZipPackage.open(corrupt)).toThrow('Duplicate ZIP entry name');
    });

    it('rejects a new member name that cannot fit a classic ZIP header', () => {
        const zip = ZipPackage.open(readFileSync('src/test/fixtures/basic.xlsx'));
        expect(() => zip.add(`/${'a'.repeat(0x10000)}`, Buffer.from('x')))
            .toThrow('ZIP entry name exceeds classic ZIP limits');
    });

    it('gives a newly added member a valid DOS epoch date', () => {
        const zip = ZipPackage.open(readFileSync('src/test/fixtures/basic.xlsx'));
        zip.add('/xl/new-part.xml', Buffer.from('<new/>'));
        const saved = zip.write();
        const { central, local } = zip_member(saved, 'xl/new-part.xml');
        expect(u16(saved, central + 14)).toBe(0x0021);
        expect(u16(saved, local + 12)).toBe(0x0021);
        expect(Buffer.from(ZipPackage.open(saved).read('/xl/new-part.xml')!))
            .toEqual(Buffer.from('<new/>'));
    });

    it.each(['signed', 'unsigned'] as const)(
        'accepts and preserves a valid %s data descriptor',
        (descriptor) => {
            const content = Buffer.from('descriptor data longer than sixteen bytes');
            const raw = single_member_zip({ content, descriptor });
            const zip = ZipPackage.open(raw);
            expect(Buffer.from(zip.read('/xl/member.bin')!)).toEqual(content);
            expect(Buffer.from(zip.write())).toEqual(raw);
        },
    );

    it('rejects a malformed data descriptor', () => {
        const raw = single_member_zip({
            content: Buffer.from('malformed descriptor'),
            descriptor: 'signed',
        });
        const { data, compressed_size } = zip_member(raw, 'xl/member.bin');
        raw[data + compressed_size + 4] ^= 0xff;
        expect(() => ZipPackage.open(raw)).toThrow('Invalid ZIP data descriptor');
    });

    it('rejects a stored member whose bytes do not match its CRC', () => {
        const raw = single_member_zip({
            content: Buffer.from('stored CRC check longer than sixteen bytes'),
            invalid_crc: true,
        });
        const zip = ZipPackage.open(raw);
        expect(() => zip.read('/xl/member.bin')).toThrow('Invalid ZIP entry checksum');
    });

    it('rejects inconsistent stored-entry sizes before copying the payload', () => {
        const raw = single_member_zip({
            content: Buffer.from('stored size check longer than sixteen bytes'),
        });
        const { central, local } = zip_member(raw, 'xl/member.bin');
        const declared = u32(raw, central + 24) - 1;
        put_u32(raw, central + 24, declared);
        put_u32(raw, local + 22, declared);
        expect(() => ZipPackage.open(raw)).toThrow('Invalid stored ZIP entry size');
    });

    it('preserves an unread encrypted stored member verbatim', () => {
        const raw = single_member_zip({
            content: Buffer.from('encrypted framing plus stored content'),
        });
        const { central, local } = zip_member(raw, 'xl/member.bin');
        put_u16(raw, central + 8, 0x0001);
        put_u16(raw, local + 6, 0x0001);
        // Traditional ZIP encryption adds a 12-byte header to the stored payload.
        const declared = u32(raw, central + 24) - 12;
        put_u32(raw, central + 24, declared);
        put_u32(raw, local + 22, declared);
        const zip = ZipPackage.open(raw);
        expect(Buffer.from(zip.write())).toEqual(raw);
        expect(() => zip.read('/xl/member.bin'))
            .toThrow('Encrypted ZIP entries are not supported');
    });

    it('rejects trailing bytes after a complete DEFLATE stream', () => {
        const raw = single_member_zip({
            content: Buffer.from('compressed content'),
            trailing_compressed_byte: true,
        });
        const zip = ZipPackage.open(raw);
        expect(() => zip.read('/xl/member.bin')).toThrow('ZIP entry has trailing compressed data');
    });

    it('rejects a member payload that overlaps the next local header', () => {
        const file = CFB.read(readFileSync('src/test/fixtures/basic.xlsx'), { type: 'buffer' });
        CFB.utils.cfb_add(file, '/xl/media/a.bin', Buffer.from('a'));
        CFB.utils.cfb_add(file, '/xl/media/b.bin', Buffer.from('b'));
        const corrupt = Buffer.from(CFB.write(file, { type: 'buffer', fileType: 'zip' }));
        const locations = [
            zip_member(corrupt, 'xl/media/a.bin'),
            zip_member(corrupt, 'xl/media/b.bin'),
        ].sort((left, right) => left.local - right.local);
        const first = locations[0];
        const overlapping_size = locations[1].local - first.data + 1;
        put_u32(corrupt, first.central + 20, overlapping_size);
        put_u32(corrupt, first.central + 24, overlapping_size);
        put_u32(corrupt, first.local + 18, overlapping_size);
        put_u32(corrupt, first.local + 22, overlapping_size);
        expect(() => ZipPackage.open(corrupt)).toThrow('Overlapping ZIP entries');
    });
});
