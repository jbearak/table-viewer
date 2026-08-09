import { describe, expect, it } from 'vitest';
import {
    CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES,
    CsvDocumentBackupError,
    create_csv_document_backup_budget,
    decode_csv_document_backup,
    encode_csv_document_backup,
    type CsvDocumentBackupLimits,
} from '../csv-document-backup';
import { csv_content_digest } from '../csv-save-service';
import { create_resource_identity, type ResourceUriLike } from '../resource-identity';
import type { CsvDirtyEntry } from '../types';

const encoder = new TextEncoder();

function uri(path: string): ResourceUriLike {
    return {
        scheme: 'mem', authority: 'backup-tests', path, query: '', fragment: '', fsPath: path,
    };
}

const limits = {
    maxSourceBytes: 1_024,
    maxBackupBytes: 8_192,
    maxDirtyEntries: 10,
    maxEntryBytes: 1_024,
};

function encode(
    source = encoder.encode('a,b\n'),
    dirty: ReadonlyMap<string, CsvDirtyEntry> = new Map([
        ['0:1', { value: 'edited', base: 'b' }],
    ]),
    max_rows = 100,
    backup_limits: CsvDocumentBackupLimits = limits,
) {
    return encode_csv_document_backup({
        identity: create_resource_identity(uri('/one.csv')),
        delimiter: ',',
        targetBasis: {
            stat: { size: source.byteLength, mtime: 42 },
            digest: csv_content_digest(source),
        },
        sourceBytes: source,
        dirtyEntries: dirty,
        maxRows: max_rows,
        limits: backup_limits,
    });
}

describe('CSV document backup codec', () => {
    it('round-trips the bound identity, target basis, source bytes, and sparse edits', () => {
        const bytes = encode();
        const restored = decode_csv_document_backup(
            bytes,
            create_resource_identity(uri('/one.csv')),
            limits,
        );
        expect(restored.version).toBe(2);
        expect(restored.delimiter).toBe(',');
        expect(new TextDecoder().decode(restored.sourceBytes)).toBe('a,b\n');
        expect(restored.sourceDigest).toBe(csv_content_digest(restored.sourceBytes));
        expect(restored.targetBasis).toEqual({
            stat: { size: 4, mtime: 42 },
            digest: csv_content_digest(encoder.encode('a,b\n')),
        });
        expect(restored.recoveryLimits).toEqual({
            maxSourceBytes: limits.maxSourceBytes,
            maxRows: 100,
        });
        expect([...restored.dirtyEntries]).toEqual([
            ['0:1', { value: 'edited', base: 'b' }],
        ]);
    });

    it('round-trips lone high and low UTF-16 surrogates without replacement', () => {
        const dirty = new Map<string, CsvDirtyEntry>([
            ['0:0', { value: 'high:\ud800', base: 'a' }],
            ['0:1', { value: 'low:\udc00', base: 'b' }],
        ]);
        const restored = decode_csv_document_backup(
            encode(encoder.encode('a,b\n'), dirty),
            create_resource_identity(uri('/one.csv')),
            limits,
        );

        expect([...restored.dirtyEntries]).toEqual([
            ['0:0', { value: 'high:\ud800', base: 'a' }],
            ['0:1', { value: 'low:\udc00', base: 'b' }],
        ]);
    });

    it('rejects restoration against a different resource identity', () => {
        expect(() => decode_csv_document_backup(
            encode(),
            create_resource_identity(uri('/other.csv')),
            limits,
        )).toThrowError(expect.objectContaining({ code: 'resourceMismatch' }));
    });

    it('rejects a tampered source digest before exposing edits', () => {
        const bytes = encode();
        const copy = Uint8Array.from(bytes);
        const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
        const source_start = 24 + view.getUint32(12, true);
        copy[source_start] ^= 0xff;
        expect(() => decode_csv_document_backup(
            copy,
            create_resource_identity(uri('/one.csv')),
            limits,
        )).toThrowError(expect.objectContaining({ code: 'digestMismatch' }));
    });

    it('rejects an impossible target basis before hashing tampered source bytes', () => {
        const copy = Uint8Array.from(encode());
        const input = Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
        const marker = Buffer.from('"size":4', 'utf8');
        const marker_start = input.indexOf(marker);
        expect(marker_start).toBeGreaterThanOrEqual(0);
        copy[marker_start + marker.byteLength - 1] = '5'.charCodeAt(0);
        const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
        copy[24 + view.getUint32(12, true)] ^= 0xff;

        expect(() => decode_csv_document_backup(
            copy,
            create_resource_identity(uri('/one.csv')),
            limits,
        )).toThrowError(expect.objectContaining({ code: 'malformed' }));
    });

    it('rejects truncated, trailing, unsupported, and over-count envelopes explicitly', () => {
        const bytes = encode();
        expect(() => decode_csv_document_backup(
            bytes.subarray(0, bytes.byteLength - 1),
            create_resource_identity(uri('/one.csv')),
            limits,
        )).toThrowError(CsvDocumentBackupError);

        const trailing = new Uint8Array(bytes.byteLength + 1);
        trailing.set(bytes);
        expect(() => decode_csv_document_backup(
            trailing,
            create_resource_identity(uri('/one.csv')),
            limits,
        )).toThrowError(expect.objectContaining({ code: 'malformed' }));

        const unsupported = Uint8Array.from(bytes);
        new DataView(unsupported.buffer, unsupported.byteOffset, unsupported.byteLength)
            .setUint16(8, 3, true);
        expect(() => decode_csv_document_backup(
            unsupported,
            create_resource_identity(uri('/one.csv')),
            limits,
        )).toThrowError(expect.objectContaining({ code: 'unsupportedVersion' }));

        const impossible_prefixes = Uint8Array.from(bytes);
        new DataView(
            impossible_prefixes.buffer,
            impossible_prefixes.byteOffset,
            impossible_prefixes.byteLength,
        ).setUint32(20, 3, true);
        expect(() => decode_csv_document_backup(
            impossible_prefixes,
            create_resource_identity(uri('/one.csv')),
            limits,
        )).toThrowError(expect.objectContaining({ code: 'malformed' }));

        const too_many = Uint8Array.from(bytes);
        new DataView(too_many.buffer, too_many.byteOffset, too_many.byteLength)
            .setUint32(20, 11, true);
        expect(() => decode_csv_document_backup(
            too_many,
            create_resource_identity(uri('/one.csv')),
            limits,
        )).toThrowError(expect.objectContaining({ code: 'countLimit' }));

        const above_v2_count_ceiling = Uint8Array.from(bytes);
        new DataView(
            above_v2_count_ceiling.buffer,
            above_v2_count_ceiling.byteOffset,
            above_v2_count_ceiling.byteLength,
        ).setUint32(20, 1_000_001, true);
        expect(() => decode_csv_document_backup(
            above_v2_count_ceiling,
            create_resource_identity(uri('/one.csv')),
            { ...limits, maxDirtyEntries: Number.MAX_SAFE_INTEGER },
        )).toThrowError(expect.objectContaining({ code: 'countLimit' }));
    });

    it('clamps creation-time source admission and rejects a forged V2 ceiling increase', () => {
        const bytes = encode(
            undefined,
            undefined,
            100,
            {
                ...limits,
                maxSourceBytes: CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES + 1,
            },
        );
        const restored = decode_csv_document_backup(
            bytes,
            create_resource_identity(uri('/one.csv')),
            limits,
        );
        expect(restored.recoveryLimits.maxSourceBytes).toBe(
            CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES,
        );

        const copy = Uint8Array.from(bytes);
        const marker = Buffer.from(
            `"maxSourceBytes":${CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES}`,
            'utf8',
        );
        const marker_start = Buffer.from(
            copy.buffer,
            copy.byteOffset,
            copy.byteLength,
        ).indexOf(marker);
        expect(marker_start).toBeGreaterThanOrEqual(0);
        const forged = Buffer.from(String(
            CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES + 1,
        ));
        copy.set(forged, marker_start + marker.byteLength - forged.byteLength);

        expect(() => decode_csv_document_backup(
            copy,
            create_resource_identity(uri('/one.csv')),
            limits,
        )).toThrowError(expect.objectContaining({ code: 'sizeLimit' }));
    });

    it('rejects untrusted recovery admission above the hard CSV row limit', () => {
        const copy = Uint8Array.from(encode(undefined, undefined, 1_000_000));
        const marker = Buffer.from('"maxRows":1000000', 'utf8');
        const marker_start = Buffer.from(
            copy.buffer,
            copy.byteOffset,
            copy.byteLength,
        ).indexOf(marker);
        expect(marker_start).toBeGreaterThanOrEqual(0);
        copy[marker_start + marker.byteLength - 1] = '1'.charCodeAt(0);

        expect(() => decode_csv_document_backup(
            copy,
            create_resource_identity(uri('/one.csv')),
            limits,
        )).toThrowError(expect.objectContaining({ code: 'sizeLimit' }));
    });

    it('keeps decoded dirty admission behind immutable V2 count and memory ceilings', () => {
        const source = encoder.encode('a\n');
        const budget = create_csv_document_backup_budget({
            identity: create_resource_identity(uri('/one.csv')),
            delimiter: ',',
            targetBasis: {
                stat: { size: source.byteLength, mtime: 42 },
                digest: csv_content_digest(source),
            },
            sourceBytes: source,
            maxRows: 100,
            limits: {
                maxSourceBytes: Number.MAX_SAFE_INTEGER,
                maxBackupBytes: Number.MAX_SAFE_INTEGER,
                maxDirtyEntries: Number.MAX_SAFE_INTEGER,
                maxEntryBytes: Number.MAX_SAFE_INTEGER,
            },
        });

        expect(budget.maxDirtyEntries).toBe(1_000_000);
        expect(budget.maxEntryBytes).toBe(16 * 1024 * 1024);
        expect(budget.maxDirtySectionBytes).toBe(64 * 1024 * 1024);
    });

    it('enforces source, total, dirty-count, and entry-size bounds while encoding', () => {
        expect(() => encode(encoder.encode('x'.repeat(1_025)), new Map()))
            .toThrowError(expect.objectContaining({ code: 'sizeLimit' }));

        expect(() => encode(encoder.encode('a\n'), new Map(Array.from(
            { length: 11 },
            (_, index) => [`0:${index}`, { value: 'x', base: '' }] as const,
        )))).toThrowError(expect.objectContaining({ code: 'countLimit' }));

        expect(() => encode(encoder.encode('a\n'), new Map([
            ['0:0', { value: 'x'.repeat(1_025), base: 'a' }],
        ]))).toThrowError(expect.objectContaining({ code: 'sizeLimit' }));
    });

    it('rejects an intrinsically clean dirty entry at creation and decode', () => {
        expect(() => encode(encoder.encode('a\n'), new Map([
            ['0:0', { value: 'a', base: 'a' }],
        ]))).toThrowError(expect.objectContaining({ code: 'malformed' }));

        const copy = Uint8Array.from(encode(encoder.encode('a\n'), new Map([
            ['0:0', { value: 'x', base: 'a' }],
        ])));
        const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
        const entry_start = 24 + view.getUint32(12, true) + view.getUint32(16, true);
        const key_length = view.getUint32(entry_start, true);
        const value_start = entry_start + 12 + key_length;
        copy[value_start + 1] = 'a'.charCodeAt(0);

        expect(() => decode_csv_document_backup(
            copy,
            create_resource_identity(uri('/one.csv')),
            limits,
        )).toThrowError(expect.objectContaining({ code: 'malformed' }));
    });

    it('rejects malformed or duplicate dirty keys', () => {
        expect(() => encode(encoder.encode('a\n'), new Map([
            ['bad', { value: 'x', base: 'a' }],
        ]))).toThrowError(expect.objectContaining({ code: 'malformed' }));
    });
});
