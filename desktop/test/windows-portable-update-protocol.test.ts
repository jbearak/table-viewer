import { describe, expect, it } from 'vitest';
import {
    compare_release_versions,
    expected_portable_asset,
    parse_portable_update_manifest,
    portable_update_acknowledgement,
    portable_update_channel,
    without_portable_update_arguments,
} from '../main/windows-portable-update-protocol';

const digest = Buffer.alloc(64, 7).toString('base64');

function manifest(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        version: '1.2.3',
        files: [{
            url: 'table-viewer-1.2.3-x64-portable.exe',
            sha512: digest,
            size: 123,
        }],
        path: 'table-viewer-1.2.3-x64-portable.exe',
        sha512: digest,
        ...overrides,
    });
}

describe('Windows portable update protocol', () => {
    it('selects an isolated channel and artifact for each architecture', () => {
        expect(portable_update_channel('x64')).toBe('latest-portable');
        expect(portable_update_channel('arm64')).toBe('latest-portable-arm64');
        expect(expected_portable_asset('1.2.3', 'arm64'))
            .toBe('table-viewer-1.2.3-arm64-portable.exe');
    });

    it('accepts exact portable metadata from the fixed GitHub feed', () => {
        expect(parse_portable_update_manifest(
            manifest(),
            'https://github.com/jbearak/table-viewer/releases/latest/download/latest-portable.yml',
            'x64',
        )).toEqual({
            version: '1.2.3',
            asset: 'table-viewer-1.2.3-x64-portable.exe',
            size: 123,
            sha512: digest,
            manifest_url: 'https://github.com/jbearak/table-viewer/releases/latest/download/latest-portable.yml',
            asset_url: 'https://github.com/jbearak/table-viewer/releases/download/v1.2.3/table-viewer-1.2.3-x64-portable.exe',
        });
    });

    it('rejects competing files, wrong artifacts, and arbitrary metadata hosts', () => {
        expect(() => parse_portable_update_manifest(manifest({ files: [] }), 'https://github.com/x', 'x64'))
            .toThrow('invalid shape');
        expect(() => parse_portable_update_manifest(manifest({
            files: [
                { url: 'table-viewer-1.2.3-x64-portable.exe', sha512: digest, size: 123 },
                { url: 'other.exe', sha512: digest, size: 123 },
            ],
        }), 'https://github.com/x', 'x64')).toThrow('invalid shape');
        expect(() => parse_portable_update_manifest(manifest({ path: '../app.exe' }), 'https://github.com/x', 'x64'))
            .toThrow('wrong artifact');
        expect(() => parse_portable_update_manifest(manifest(), 'https://example.com/latest.yml', 'x64'))
            .toThrow('unexpected host');
    });

    it('rejects invalid sizes, digest disagreement, and architecture mismatches', () => {
        expect(() => parse_portable_update_manifest(manifest({
            files: [{ url: 'table-viewer-1.2.3-x64-portable.exe', sha512: digest, size: 0 }],
        }), 'https://github.com/x', 'x64')).toThrow('invalid size');
        expect(() => parse_portable_update_manifest(manifest({ sha512: Buffer.alloc(64, 8).toString('base64') }),
            'https://github.com/x', 'x64')).toThrow('digests disagree');
        expect(() => parse_portable_update_manifest(manifest(), 'https://github.com/x', 'arm64'))
            .toThrow('wrong artifact');
    });

    it('compares release versions without allowing lexical mistakes', () => {
        expect(compare_release_versions('1.10.0', '1.9.9')).toBe(1);
        expect(compare_release_versions('1.2.0', '1.2.0')).toBe(0);
        expect(compare_release_versions('1.1.9', '1.2.0')).toBe(-1);
    });

    it('isolates and validates the internal acknowledgement argument', () => {
        const token = 'a'.repeat(32);
        expect(portable_update_acknowledgement([`--portable-update-ack=${token}`])).toBe(token);
        expect(portable_update_acknowledgement(['--portable-update-ack=no'])).toBeUndefined();
        expect(without_portable_update_arguments(['file.csv', `--portable-update-ack=${token}`]))
            .toEqual(['file.csv']);
    });
});
