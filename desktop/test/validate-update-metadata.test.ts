import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

type ValidateOptions = {
    expected_version: string;
    expected_asset: string;
    strict?: boolean;
    require_blockmap?: boolean;
    read_file?: (path: string, encoding: string) => string;
    stat?: (path: string) => { size: number };
    digest_file?: (path: string) => string;
};

let validate_update_metadata: (
    metadata_path: string,
    options: ValidateOptions,
) => Record<string, unknown>;

beforeAll(async () => {
    const validator_specifier = '../../scripts/validate-update-metadata.mjs';
    ({ validate_update_metadata } = await import(validator_specifier));
});

const digest = Buffer.alloc(64, 7).toString('base64');
const manifest = (overrides = {}) => ({
    version: '1.2.3',
    files: [{ url: 'app.exe', sha512: digest, size: 100, blockMapSize: 20 }],
    path: 'app.exe', sha512: digest, ...overrides,
});

function validate(document: unknown, sizes: Record<string, number> = { 'app.exe': 100, 'app.exe.blockmap': 20 }) {
    return validate_update_metadata('/release/latest.yml', {
        expected_version: '1.2.3', expected_asset: 'app.exe', strict: true, require_blockmap: true,
        read_file: () => JSON.stringify(document),
        stat: (path: string) => ({ size: sizes[path.split('/').pop()!] }),
        digest_file: () => digest,
    });
}

describe('update metadata validator', () => {
    it('accepts an exact manifest, asset, and blockmap', () => {
        expect(validate(manifest()).version).toBe('1.2.3');
    });

    it('rejects a manifest that points outside its release directory', () => {
        expect(() => validate(manifest({ files: [{ url: '../app.exe', sha512: digest, size: 100, blockMapSize: 20 }] }))).toThrow(
            'unsafe asset path',
        );
    });

    it('accepts a manifest stored at the filesystem root', () => {
        expect(validate_update_metadata('/latest.yml', {
            expected_version: '1.2.3', expected_asset: 'app.exe',
            read_file: () => JSON.stringify(manifest()),
            stat: () => ({ size: 100 }),
            digest_file: () => digest,
        }).version).toBe('1.2.3');
    });

    it('accepts extra macOS artifacts while validating the expected updater payload', () => {
        expect(validate_update_metadata('/release/latest-mac.yml', {
            expected_version: '1.2.3', expected_asset: 'app.exe',
            read_file: () => JSON.stringify(manifest({
                files: [
                    { url: 'fresh-install.dmg', sha512: digest, size: 100 },
                    { url: 'app.exe', sha512: digest, size: 100 },
                ],
            })),
            stat: () => ({ size: 100 }),
            digest_file: () => digest,
        }).version).toBe('1.2.3');
    });

    it('rejects stale asset sizes', () => {
        expect(() => validate(manifest(), { 'app.exe': 99, 'app.exe.blockmap': 20 })).toThrow(
            'app.exe size is 100, expected 99',
        );
    });

    it('rejects competing Windows executables even when the expected setup is present', () => {
        expect(() => validate(manifest({
            files: [
                { url: 'helper-x64.exe', sha512: digest, size: 100 },
                { url: 'app.exe', sha512: digest, size: 100, blockMapSize: 20 },
            ],
        }))).toThrow('must describe exactly one update asset');
    });

    it('strictly validates a portable manifest without accessing a blockmap', () => {
        const requested_paths: string[] = [];
        expect(validate_update_metadata('/release/latest-portable.yml', {
            expected_version: '1.2.3', expected_asset: 'app.exe', strict: true,
            read_file: () => JSON.stringify(manifest({
                files: [{ url: 'app.exe', sha512: digest, size: 100 }],
            })),
            stat: (path: string) => {
                requested_paths.push(path);
                return { size: 100 };
            },
            digest_file: () => digest,
        }).version).toBe('1.2.3');
        expect(requested_paths).toEqual(['/release/app.exe']);
    });

    it('strict mode rejects an additional asset without requiring a blockmap', () => {
        expect(() => validate_update_metadata('/release/latest-portable.yml', {
            expected_version: '1.2.3', expected_asset: 'app.exe', strict: true,
            read_file: () => JSON.stringify(manifest({
                files: [
                    { url: 'helper.exe', sha512: digest, size: 100 },
                    { url: 'app.exe', sha512: digest, size: 100 },
                ],
            })),
            stat: () => ({ size: 100 }),
            digest_file: () => digest,
        })).toThrow('must describe exactly one update asset');
    });

    it('accepts an external NSIS blockmap without an embedded blockMapSize', () => {
        expect(validate(manifest({ files: [{ url: 'app.exe', sha512: digest, size: 100 }] })).version)
            .toBe('1.2.3');
    });

    it('rejects a digest that does not match the asset', () => {
        expect(() => validate_update_metadata('/release/latest.yml', {
            expected_version: '1.2.3', expected_asset: 'app.exe',
            read_file: () => JSON.stringify(manifest()),
            stat: () => ({ size: 100 }),
            digest_file: () => Buffer.alloc(64, 8).toString('base64'),
        })).toThrow('sha512 does not match the asset');
    });

    it('parses strict and blockmap CLI flags in either order and rejects invalid flags', () => {
        const directory = mkdtempSync(join(tmpdir(), 'update-metadata-'));
        try {
            const asset = Buffer.from('portable-or-setup');
            const asset_digest = createHash('sha512').update(asset).digest('base64');
            writeFileSync(join(directory, 'app.exe'), asset);
            writeFileSync(join(directory, 'app.exe.blockmap'), 'blockmap');
            writeFileSync(join(directory, 'latest.yml'), JSON.stringify({
                version: '1.2.3',
                files: [{ url: 'app.exe', sha512: asset_digest, size: asset.length }],
                path: 'app.exe', sha512: asset_digest,
            }));
            const script = join(__dirname, '..', '..', 'scripts', 'validate-update-metadata.mjs');
            const run = (...flags: string[]) => spawnSync(
                process.execPath,
                [script, join(directory, 'latest.yml'), '1.2.3', 'app.exe', ...flags],
                { encoding: 'utf8' },
            );

            expect(run('--strict').status).toBe(0);
            expect(run('--strict', '--require-blockmap').status).toBe(0);
            expect(run('--require-blockmap', '--strict').status).toBe(0);
            for (const invalid of [
                run('--unknown'),
                run('--strict', '--strict'),
                run('extra-position'),
            ]) {
                expect(invalid.status).toBe(2);
                expect(invalid.stderr).toContain('Usage: validate-update-metadata.mjs');
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
