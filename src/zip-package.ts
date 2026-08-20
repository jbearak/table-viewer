import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const MAX_EOCD_SEARCH = 0xffff + 22;
const MAX_INFLATED_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 512 * 1024 * 1024;
const INFLATE_CHUNK_BYTES = 1024 * 1024;
const CHANGED_ENTRY_DEFLATE_LEVEL = 5;

interface ZipEntry {
    readonly name: string;
    readonly name_bytes: Uint8Array;
    readonly flags: number;
    readonly method: number;
    readonly crc32: number;
    readonly compressed_size: number;
    readonly uncompressed_size: number;
    readonly local_offset: number;
    readonly data_end: number;
    local_end: number;
    readonly central_record: Uint8Array;
    readonly local_extra: Uint8Array;
    replacement?: Uint8Array;
    removed?: boolean;
}

export class ZipPackageError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ZipPackageError';
    }
}

function normalized_path(path: string): string {
    return path.replace(/^\/+/, '');
}

function u16(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
    return (bytes[offset]
        | (bytes[offset + 1] << 8)
        | (bytes[offset + 2] << 16)
        | (bytes[offset + 3] << 24)) >>> 0;
}

function put_u16(bytes: Uint8Array, offset: number, value: number): void {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
}

function put_u32(bytes: Uint8Array, offset: number, value: number): void {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
}

function copy(bytes: Uint8Array): Uint8Array {
    return Uint8Array.from(bytes);
}

function find_eocd(bytes: Uint8Array): number {
    const first = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
    for (let offset = bytes.length - 22; offset >= first; offset -= 1) {
        if (u32(bytes, offset) !== END_OF_CENTRAL_DIRECTORY) continue;
        const comment_length = u16(bytes, offset + 20);
        if (offset + 22 + comment_length === bytes.length) return offset;
    }
    return -1;
}

const CRC_TABLES = (() => {
    const tables: Uint32Array[] = [new Uint32Array(256)];
    for (let n = 0; n < tables[0].length; n += 1) {
        let value = n;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        tables[0][n] = value >>> 0;
    }
    for (let slice = 1; slice < 16; slice += 1) {
        const table = new Uint32Array(256);
        const previous = tables[slice - 1];
        for (let n = 0; n < table.length; n += 1) {
            const value = previous[n];
            table[n] = (value >>> 8) ^ tables[0][value & 0xff];
        }
        tables.push(table);
    }
    return tables;
})();

function crc32(bytes: Uint8Array): number {
    let value = 0xffffffff;
    let offset = 0;
    const sliced_end = bytes.length - 15;
    while (offset < sliced_end) {
        value = CRC_TABLES[15][bytes[offset++] ^ (value & 0xff)]
            ^ CRC_TABLES[14][bytes[offset++] ^ ((value >>> 8) & 0xff)]
            ^ CRC_TABLES[13][bytes[offset++] ^ ((value >>> 16) & 0xff)]
            ^ CRC_TABLES[12][bytes[offset++] ^ (value >>> 24)]
            ^ CRC_TABLES[11][bytes[offset++]]
            ^ CRC_TABLES[10][bytes[offset++]]
            ^ CRC_TABLES[9][bytes[offset++]]
            ^ CRC_TABLES[8][bytes[offset++]]
            ^ CRC_TABLES[7][bytes[offset++]]
            ^ CRC_TABLES[6][bytes[offset++]]
            ^ CRC_TABLES[5][bytes[offset++]]
            ^ CRC_TABLES[4][bytes[offset++]]
            ^ CRC_TABLES[3][bytes[offset++]]
            ^ CRC_TABLES[2][bytes[offset++]]
            ^ CRC_TABLES[1][bytes[offset++]]
            ^ CRC_TABLES[0][bytes[offset++]];
    }
    while (offset < bytes.length) {
        value = CRC_TABLES[0][(value ^ bytes[offset++]) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[], total_length: number): Uint8Array {
    const out = Buffer.allocUnsafe(total_length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function inflate_into_sized_buffer(compressed: Uint8Array, size: number): Uint8Array {
    // Incremental fixed-size chunks ensure an attacker-controlled declared size
    // never becomes an up-front allocation. maxOutputLength remains the hard
    // bound, and read() independently enforces per-entry and package budgets.
    let result: { buffer: Uint8Array; engine: { bytesWritten: number } };
    try {
        result = inflateRawSync(compressed, {
            chunkSize: INFLATE_CHUNK_BYTES,
            info: true,
            maxOutputLength: Math.max(1, size),
        }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
    } catch (error) {
        throw new ZipPackageError('Invalid compressed ZIP entry', { cause: error });
    }
    if (result.engine.bytesWritten !== compressed.length) {
        throw new ZipPackageError('ZIP entry has trailing compressed data');
    }
    return result.buffer;
}

/**
 * A lazy, mutation-aware ZIP package for OOXML files.
 *
 * Opening indexes only the central directory. Reading a part inflates just that
 * part, and serialization copies every unchanged local record (header, compressed
 * payload and data descriptor) verbatim. Only replaced or newly-created parts are
 * deflated. ZIP64 and multi-disk archives are refused: XLSX files accepted by the
 * application are bounded far below their 4 GiB thresholds.
 */
export class ZipPackage {
    private readonly raw: Uint8Array;
    private readonly entries: ZipEntry[];
    private readonly by_name = new Map<string, ZipEntry>();
    private readonly eocd_comment: Uint8Array;
    private readonly inflated_entries = new Set<ZipEntry>();
    private inflated_bytes = 0;

    private constructor(raw: Uint8Array, entries: ZipEntry[], eocd_comment: Uint8Array) {
        this.raw = raw;
        this.entries = entries;
        this.eocd_comment = eocd_comment;
        for (const entry of entries) this.by_name.set(entry.name, entry);
    }

    static open(raw: Uint8Array): ZipPackage {
        const eocd = find_eocd(raw);
        if (eocd === -1) throw new ZipPackageError('ZIP end record not found');
        const disk = u16(raw, eocd + 4);
        const central_disk = u16(raw, eocd + 6);
        const disk_entries = u16(raw, eocd + 8);
        const entry_count = u16(raw, eocd + 10);
        const central_size = u32(raw, eocd + 12);
        const central_offset = u32(raw, eocd + 16);
        if (disk !== 0 || central_disk !== 0 || disk_entries !== entry_count) {
            throw new ZipPackageError('Multi-disk ZIP archives are not supported');
        }
        if (entry_count === 0xffff || central_size === 0xffffffff || central_offset === 0xffffffff) {
            throw new ZipPackageError('ZIP64 archives are not supported');
        }
        if (central_offset + central_size > eocd) {
            throw new ZipPackageError('Invalid ZIP central directory');
        }

        const entries: ZipEntry[] = [];
        const names = new Set<string>();
        let offset = central_offset;
        for (let index = 0; index < entry_count; index += 1) {
            if (offset + 46 > raw.length || u32(raw, offset) !== CENTRAL_FILE_HEADER) {
                throw new ZipPackageError('Invalid ZIP central directory entry');
            }
            const flags = u16(raw, offset + 8);
            const method = u16(raw, offset + 10);
            const compressed_size = u32(raw, offset + 20);
            const uncompressed_size = u32(raw, offset + 24);
            const name_length = u16(raw, offset + 28);
            const extra_length = u16(raw, offset + 30);
            const comment_length = u16(raw, offset + 32);
            const local_offset = u32(raw, offset + 42);
            const central_end = offset + 46 + name_length + extra_length + comment_length;
            if (central_end > raw.length) {
                throw new ZipPackageError('Truncated ZIP central directory entry');
            }
            if (compressed_size === 0xffffffff
                || uncompressed_size === 0xffffffff
                || local_offset === 0xffffffff) {
                throw new ZipPackageError('ZIP64 entries are not supported');
            }
            if (local_offset + 30 > central_offset || u32(raw, local_offset) !== LOCAL_FILE_HEADER) {
                throw new ZipPackageError('Invalid ZIP local entry');
            }
            const local_flags = u16(raw, local_offset + 6);
            const local_method = u16(raw, local_offset + 8);
            const local_name_length = u16(raw, local_offset + 26);
            const local_extra_length = u16(raw, local_offset + 28);
            const data_offset = local_offset + 30 + local_name_length + local_extra_length;
            if (data_offset + compressed_size > central_offset) {
                throw new ZipPackageError('Truncated ZIP entry data');
            }
            const name_bytes = raw.subarray(offset + 46, offset + 46 + name_length);
            const local_name = raw.subarray(local_offset + 30, local_offset + 30 + local_name_length);
            if (local_flags !== flags
                || local_method !== method
                || !Buffer.from(local_name).equals(Buffer.from(name_bytes))) {
                throw new ZipPackageError('ZIP local and central entries disagree');
            }
            if ((flags & 0x0008) === 0
                && (u32(raw, local_offset + 14) !== u32(raw, offset + 16)
                    || u32(raw, local_offset + 18) !== compressed_size
                    || u32(raw, local_offset + 22) !== uncompressed_size)) {
                throw new ZipPackageError('ZIP local and central sizes disagree');
            }
            const name = normalized_path(Buffer.from(name_bytes).toString('utf8'));
            if (names.has(name)) throw new ZipPackageError('Duplicate ZIP entry name');
            names.add(name);
            entries.push({
                name,
                name_bytes: copy(name_bytes),
                flags,
                method,
                crc32: u32(raw, offset + 16),
                compressed_size,
                uncompressed_size,
                local_offset,
                data_end: data_offset + compressed_size,
                local_end: 0,
                central_record: copy(raw.subarray(offset, central_end)),
                local_extra: copy(raw.subarray(
                    local_offset + 30 + local_name_length,
                    data_offset,
                )),
            });
            offset = central_end;
        }
        if (offset !== central_offset + central_size) {
            throw new ZipPackageError('Unsupported records in ZIP central directory');
        }

        const physical = [...entries].sort((left, right) => left.local_offset - right.local_offset);
        for (let index = 0; index < physical.length; index += 1) {
            const current = physical[index];
            const local_end = physical[index + 1]?.local_offset ?? central_offset;
            if (local_end < current.data_end) throw new ZipPackageError('Overlapping ZIP entries');
            if ((current.flags & 0x0008) !== 0) {
                const descriptor_matches = (at: number): boolean => at + 12 <= local_end
                    && u32(raw, at) === current.crc32
                    && u32(raw, at + 4) === current.compressed_size
                    && u32(raw, at + 8) === current.uncompressed_size;
                const plain = descriptor_matches(current.data_end);
                const signed = u32(raw, current.data_end) === 0x08074b50
                    && descriptor_matches(current.data_end + 4);
                if (!plain && !signed) throw new ZipPackageError('Invalid ZIP data descriptor');
            }
            current.local_end = local_end;
        }
        const comment_length = u16(raw, eocd + 20);
        return new ZipPackage(
            raw,
            entries,
            copy(raw.subarray(eocd + 22, eocd + 22 + comment_length)),
        );
    }

    has(path: string): boolean {
        const entry = this.by_name.get(normalized_path(path));
        return entry !== undefined && entry.removed !== true;
    }

    read(path: string): Uint8Array | null {
        const entry = this.by_name.get(normalized_path(path));
        if (!entry || entry.removed) return null;
        if (entry.replacement !== undefined) return entry.replacement;
        if (entry.uncompressed_size > MAX_INFLATED_ENTRY_BYTES) {
            throw new ZipPackageError('ZIP entry is too large to inflate safely');
        }
        if (!this.inflated_entries.has(entry)
            && this.inflated_bytes + entry.uncompressed_size > MAX_TOTAL_INFLATED_BYTES) {
            throw new ZipPackageError('ZIP package expands beyond the safe read limit');
        }
        if ((entry.flags & 0x2041) !== 0) {
            throw new ZipPackageError('Encrypted ZIP entries are not supported');
        }
        if (entry.method !== 0 && entry.method !== 8) {
            throw new ZipPackageError(`Unsupported ZIP method ${entry.method}`);
        }
        const local_name_length = u16(this.raw, entry.local_offset + 26);
        const local_extra_length = u16(this.raw, entry.local_offset + 28);
        const data_offset = entry.local_offset + 30 + local_name_length + local_extra_length;
        const compressed = this.raw.subarray(data_offset, data_offset + entry.compressed_size);
        const content = entry.method === 0
            ? copy(compressed)
            : inflate_into_sized_buffer(compressed, entry.uncompressed_size);
        if (content.length !== entry.uncompressed_size) {
            throw new ZipPackageError('Invalid ZIP entry size');
        }
        if (crc32(content) !== entry.crc32) {
            throw new ZipPackageError('Invalid ZIP entry checksum');
        }
        if (!this.inflated_entries.has(entry)) {
            this.inflated_entries.add(entry);
            this.inflated_bytes += entry.uncompressed_size;
        }
        return content;
    }

    read_text(path: string): string | null {
        const bytes = this.read(path);
        return bytes === null ? null : Buffer.from(bytes).toString('utf8');
    }

    replace(path: string, bytes: Uint8Array): boolean {
        const entry = this.by_name.get(normalized_path(path));
        if (!entry || entry.removed) return false;
        entry.replacement = bytes;
        return true;
    }

    add(path: string, bytes: Uint8Array): void {
        const name = normalized_path(path);
        const existing = this.by_name.get(name);
        if (existing) {
            existing.removed = false;
            existing.replacement = bytes;
            return;
        }
        const name_bytes = Buffer.from(name, 'utf8');
        if (name_bytes.length > 0xffff) {
            throw new ZipPackageError('ZIP entry name exceeds classic ZIP limits');
        }
        const central_record = new Uint8Array(46 + name_bytes.length);
        put_u32(central_record, 0, CENTRAL_FILE_HEADER);
        put_u16(central_record, 4, 0x031e);
        put_u16(central_record, 6, 20);
        put_u16(central_record, 8, 0x0800);
        put_u16(central_record, 10, 8);
        put_u16(central_record, 28, name_bytes.length);
        central_record.set(name_bytes, 46);
        const entry: ZipEntry = {
            name,
            name_bytes,
            flags: 0x0800,
            method: 8,
            crc32: 0,
            compressed_size: 0,
            uncompressed_size: 0,
            local_offset: 0,
            data_end: 0,
            local_end: 0,
            central_record,
            local_extra: new Uint8Array(),
            replacement: bytes,
        };
        this.entries.push(entry);
        this.by_name.set(name, entry);
    }

    remove(path: string): boolean {
        const entry = this.by_name.get(normalized_path(path));
        if (!entry || entry.removed) return false;
        entry.removed = true;
        return true;
    }

    write(): Uint8Array {
        const local_parts: Uint8Array[] = [];
        const central_parts: Uint8Array[] = [];
        const output_offsets = new Map<ZipEntry, number>();
        const replacements = new Map<ZipEntry, {
            readonly content: Uint8Array;
            readonly compressed: Uint8Array;
            readonly crc32: number;
            readonly flags: number;
            readonly method: number;
        }>();
        for (const entry of this.entries) {
            if (entry.removed || entry.replacement === undefined) continue;
            const content = entry.replacement;
            const method = entry.method === 0 ? 0 : 8;
            if (content.length > 0xffffffff) {
                throw new ZipPackageError('ZIP entry exceeds classic ZIP limits');
            }
            const compressed = method === 0
                ? content
                : deflateRawSync(content, { level: CHANGED_ENTRY_DEFLATE_LEVEL });
            if (compressed.length > 0xffffffff) {
                throw new ZipPackageError('ZIP entry exceeds classic ZIP limits');
            }
            replacements.set(entry, {
                content,
                compressed,
                crc32: crc32(content),
                flags: entry.flags & ~0x0008,
                method,
            });
        }
        let local_length = 0;
        const physical = [...this.entries].sort((left, right) => left.local_offset - right.local_offset);
        for (const entry of physical) {
            if (entry.removed) continue;
            output_offsets.set(entry, local_length);
            let record: Uint8Array;
            const replacement = replacements.get(entry);
            if (replacement === undefined) {
                record = this.raw.subarray(entry.local_offset, entry.local_end);
            } else {
                record = new Uint8Array(
                    30 + entry.name_bytes.length + entry.local_extra.length + replacement.compressed.length,
                );
                put_u32(record, 0, LOCAL_FILE_HEADER);
                put_u16(record, 4, 20);
                put_u16(record, 6, replacement.flags);
                put_u16(record, 8, replacement.method);
                // Preserve DOS time/date from the original central record.
                record.set(entry.central_record.subarray(12, 16), 10);
                put_u32(record, 14, replacement.crc32);
                put_u32(record, 18, replacement.compressed.length);
                put_u32(record, 22, replacement.content.length);
                put_u16(record, 26, entry.name_bytes.length);
                put_u16(record, 28, entry.local_extra.length);
                record.set(entry.name_bytes, 30);
                record.set(entry.local_extra, 30 + entry.name_bytes.length);
                record.set(
                    replacement.compressed,
                    30 + entry.name_bytes.length + entry.local_extra.length,
                );
            }
            local_parts.push(record);
            local_length += record.length;
        }

        let central_length = 0;
        for (const entry of this.entries) {
            if (entry.removed) continue;
            const record = copy(entry.central_record);
            const output_offset = output_offsets.get(entry);
            if (output_offset === undefined || output_offset > 0xffffffff) {
                throw new ZipPackageError('ZIP output exceeds classic ZIP limits');
            }
            const replacement = replacements.get(entry);
            if (replacement !== undefined) {
                put_u16(record, 8, replacement.flags);
                put_u16(record, 10, replacement.method);
                put_u32(record, 16, replacement.crc32);
                put_u32(record, 20, replacement.compressed.length);
                put_u32(record, 24, replacement.content.length);
            }
            put_u32(record, 42, output_offset);
            central_parts.push(record);
            central_length += record.length;
        }
        if (central_length > 0xffffffff || local_length > 0xffffffff || central_parts.length >= 0xffff) {
            throw new ZipPackageError('ZIP output exceeds classic ZIP limits');
        }
        const eocd = new Uint8Array(22 + this.eocd_comment.length);
        put_u32(eocd, 0, END_OF_CENTRAL_DIRECTORY);
        put_u16(eocd, 8, central_parts.length);
        put_u16(eocd, 10, central_parts.length);
        put_u32(eocd, 12, central_length);
        put_u32(eocd, 16, local_length);
        put_u16(eocd, 20, this.eocd_comment.length);
        eocd.set(this.eocd_comment, 22);
        return concat([...local_parts, ...central_parts, eocd], local_length + central_length + eocd.length);
    }
}
