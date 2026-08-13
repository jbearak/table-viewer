import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type PackageResult = { error?: Error; signal?: string | null; status: number | null };
type PackageOptions = {
    attempts?: number;
    version?: string;
    run_builder?: (arch: string) => PackageResult;
    build_helper?: (arch: string) => void;
    packages_dir?: string;
    release_date?: () => string;
    copy_file?: (source: string, target: string) => void;
    exists?: (path: string) => boolean;
    remove?: (path: string, options: { force: boolean }) => void;
    select_manifest?: (source: string, expected_asset: string, target?: string) => void;
    write_portable?: (asset_path: string, manifest_path: string, version: string, asset: string, release_date: string) => void;
    validate?: (path: string, options: Record<string, unknown>) => void;
    log?: { info(message: string): void; warn(message: string): void };
};

let package_desktop_windows: (options?: PackageOptions) => void;
let select_windows_update_asset: (metadata: unknown, expected_asset: string) => Record<string, unknown>;
let create_portable_update_metadata: (version: string, asset: string, bytes: Buffer, release_date: string) => Record<string, unknown>;
let validate_update_metadata: (path: string, options: Record<string, unknown>) => unknown;
let build_arguments: (arch: string) => string[];

beforeAll(async () => {
    const package_specifier = '../../scripts/package-desktop-windows.mjs';
    ({ build_arguments, create_portable_update_metadata, package_desktop_windows, select_windows_update_asset }
        = await import(package_specifier));
    const validator_specifier = '../../scripts/validate-update-metadata.mjs';
    ({ validate_update_metadata } = await import(validator_specifier));
});

function options(run_builder: (arch: string) => PackageResult): PackageOptions {
    return {
        version: '1.2.3', run_builder, exists: () => true,
        build_helper: vi.fn(), copy_file: vi.fn(), remove: vi.fn(),
        select_manifest: vi.fn(), write_portable: vi.fn(), validate: vi.fn(),
        release_date: () => '2026-08-13T20:00:00.000Z',
        log: { info: vi.fn(), warn: vi.fn() },
    };
}

function digest(bytes: Buffer): string {
    return createHash('sha512').update(bytes).digest('base64');
}

describe('Windows desktop packaging wrapper', () => {
    it('selects one architecture per builder invocation', () => {
        expect(build_arguments('x64')).toEqual(expect.arrayContaining(['--win', '--x64']));
        expect(build_arguments('arm64')).toEqual(expect.arrayContaining(['--win', '--arm64']));

        const config = readFileSync('desktop/electron-builder.yml', 'utf8');
        const windows_config = config.slice(config.indexOf('\nwin:'), config.indexOf('\nnsis:'));
        expect(windows_config).toMatch(/^    - nsis$/m);
        expect(windows_config).toMatch(/^    - portable$/m);
        expect(windows_config).not.toMatch(/^\s+arch:/m);
        expect(windows_config).toMatch(
            /^    - from: dist\/native\/win32-\$\{arch\}\/windows-portable-update-helper\.exe$/m,
        );
        expect(windows_config).not.toMatch(/from: dist\/native\/windows-portable-update-helper\.exe/);
    });

    it('selects one requested setup executable from update metadata', () => {
        const setup = { url: 'table-viewer-1.2.3-x64-setup.exe', sha512: 'setup-digest', size: 12 };
        const metadata = { version: '1.2.3', files: [setup], path: setup.url, sha512: setup.sha512 };

        expect(select_windows_update_asset(metadata, setup.url)).toEqual({
            version: '1.2.3', files: [setup], path: setup.url, sha512: setup.sha512,
        });
    });

    it('rejects metadata without exactly one expected setup executable', () => {
        expect(() => select_windows_update_asset({ files: [] }, 'setup.exe')).toThrow(
            'Windows update metadata must reference setup.exe exactly once',
        );
    });

    it('creates portable metadata from the executable bytes', () => {
        const bytes = Buffer.from('portable executable fixture');
        const asset = 'table-viewer-1.2.3-x64-portable.exe';
        const release_date = '2026-08-13T20:00:00.000Z';

        expect(create_portable_update_metadata('1.2.3', asset, bytes, release_date)).toEqual({
            version: '1.2.3',
            files: [{ url: asset, sha512: digest(bytes), size: bytes.byteLength }],
            path: asset,
            sha512: digest(bytes),
            releaseDate: release_date,
        });
    });

    it('packages each architecture separately and preserves setup and portable manifests', () => {
        const run_builder = vi.fn().mockReturnValue({ status: 0 });
        const config = options(run_builder);
        package_desktop_windows(config);

        expect(run_builder.mock.calls.map(([arch]) => arch)).toEqual(['x64', 'arm64']);
        expect(config.build_helper).toHaveBeenCalledTimes(2);
        expect(config.build_helper).toHaveBeenNthCalledWith(1, 'x64');
        expect(config.build_helper).toHaveBeenNthCalledWith(2, 'arm64');
        expect(config.remove).toHaveBeenCalledTimes(13);
        for (const manifest of ['latest-arm64.yml', 'latest-portable.yml', 'latest-portable-arm64.yml']) {
            expect(config.remove).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${manifest.replace('.', '\\.')}$`)), { force: true });
        }
        expect(config.remove).toHaveBeenCalledWith(
            expect.stringMatching(/table-viewer-1\.2\.3-x64-portable\.exe$/), { force: true },
        );
        expect(config.remove).toHaveBeenCalledWith(
            expect.stringMatching(/table-viewer-1\.2\.3-arm64-portable\.exe$/), { force: true },
        );
        expect(config.select_manifest).toHaveBeenCalledTimes(2);
        expect(config.select_manifest).toHaveBeenNthCalledWith(
            1, expect.stringMatching(/latest\.yml$/), 'table-viewer-1.2.3-x64-setup.exe',
        );
        expect(config.select_manifest).toHaveBeenNthCalledWith(
            2, expect.stringMatching(/latest\.yml$/), 'table-viewer-1.2.3-arm64-setup.exe',
        );
        expect(config.write_portable).toHaveBeenCalledTimes(2);
        expect(config.write_portable).toHaveBeenNthCalledWith(
            1, expect.stringMatching(/table-viewer-1\.2\.3-x64-portable\.exe$/),
            expect.stringMatching(/latest-portable\.yml$/), '1.2.3',
            'table-viewer-1.2.3-x64-portable.exe', '2026-08-13T20:00:00.000Z',
        );
        expect(config.write_portable).toHaveBeenNthCalledWith(
            2, expect.stringMatching(/table-viewer-1\.2\.3-arm64-portable\.exe$/),
            expect.stringMatching(/latest-portable-arm64\.yml$/), '1.2.3',
            'table-viewer-1.2.3-arm64-portable.exe', '2026-08-13T20:00:00.000Z',
        );
        expect(config.validate).toHaveBeenCalledTimes(4);
        expect(config.validate).toHaveBeenNthCalledWith(1, expect.stringMatching(/latest\.yml$/), {
            expected_version: '1.2.3', expected_asset: 'table-viewer-1.2.3-x64-setup.exe',
            strict: true, require_blockmap: true,
        });
        expect(config.validate).toHaveBeenNthCalledWith(2, expect.stringMatching(/latest-portable\.yml$/), {
            expected_version: '1.2.3', expected_asset: 'table-viewer-1.2.3-x64-portable.exe',
            strict: true, require_blockmap: false,
        });
        expect(config.validate).toHaveBeenNthCalledWith(3, expect.stringMatching(/latest-arm64\.yml$/), {
            expected_version: '1.2.3', expected_asset: 'table-viewer-1.2.3-arm64-setup.exe',
            strict: true, require_blockmap: true,
        });
        expect(config.validate).toHaveBeenNthCalledWith(4, expect.stringMatching(/latest-portable-arm64\.yml$/), {
            expected_version: '1.2.3', expected_asset: 'table-viewer-1.2.3-arm64-portable.exe',
            strict: true, require_blockmap: false,
        });
        expect(config.copy_file).toHaveBeenCalledWith(
            expect.stringMatching(/latest-x64\.yml$/), expect.stringMatching(/latest\.yml$/),
        );
        expect(config.remove).toHaveBeenCalledWith(expect.stringMatching(/latest-x64\.yml$/), { force: true });
    });

    it('creates four valid manifests from setup-only electron-builder metadata', () => {
        const packages_dir = mkdtempSync(join(tmpdir(), 'table-viewer-windows-package-'));
        const release_date = '2026-08-13T20:00:00.000Z';
        try {
            const run_builder = (arch: string): PackageResult => {
                const setup = `table-viewer-1.2.3-${arch}-setup.exe`;
                const portable = `table-viewer-1.2.3-${arch}-portable.exe`;
                const setup_bytes = Buffer.from(`${arch} setup executable`);
                writeFileSync(join(packages_dir, setup), setup_bytes);
                writeFileSync(join(packages_dir, `${setup}.blockmap`), Buffer.from(`${arch} blockmap`));
                writeFileSync(join(packages_dir, portable), Buffer.from(`${arch} portable executable`));
                writeFileSync(join(packages_dir, 'latest.yml'), [
                    'version: 1.2.3',
                    'files:',
                    `  - url: ${setup}`,
                    `    sha512: ${digest(setup_bytes)}`,
                    `    size: ${setup_bytes.byteLength}`,
                    `path: ${setup}`,
                    `sha512: ${digest(setup_bytes)}`,
                    `releaseDate: ${release_date}`,
                    '',
                ].join('\n'));
                return { status: 0 };
            };

            package_desktop_windows({
                version: '1.2.3', packages_dir, run_builder,
                build_helper: vi.fn(), release_date: () => release_date,
                log: { info: vi.fn(), warn: vi.fn() },
            });

            for (const [manifest, asset, require_blockmap] of [
                ['latest.yml', 'table-viewer-1.2.3-x64-setup.exe', true],
                ['latest-arm64.yml', 'table-viewer-1.2.3-arm64-setup.exe', true],
                ['latest-portable.yml', 'table-viewer-1.2.3-x64-portable.exe', false],
                ['latest-portable-arm64.yml', 'table-viewer-1.2.3-arm64-portable.exe', false],
            ] as const) {
                validate_update_metadata(join(packages_dir, manifest), {
                    expected_version: '1.2.3', expected_asset: asset, strict: true, require_blockmap,
                });
            }
        } finally {
            rmSync(packages_dir, { recursive: true, force: true });
        }
    });

    it('requires a custom builder with a custom packages directory', () => {
        expect(() => package_desktop_windows({ packages_dir: '/custom/packages' })).toThrow(
            'A custom Windows packages directory requires a custom builder',
        );
    });

    it('rejects a non-function builder before removing outputs', () => {
        const remove = vi.fn();
        expect(() => package_desktop_windows({ run_builder: null as unknown as PackageOptions['run_builder'], remove })).toThrow(
            'Windows package builder must be a function',
        );
        expect(remove).not.toHaveBeenCalled();
    });

    it('rejects a missing portable executable', () => {
        expect(() => package_desktop_windows({
            ...options(() => ({ status: 0 })),
            exists: (path) => path.endsWith('latest.yml'),
        })).toThrow('Windows x64 packaging did not produce table-viewer-1.2.3-x64-portable.exe');
    });

    it('retries only the failing architecture and stops at success', () => {
        const run_builder = vi.fn()
            .mockReturnValueOnce({ status: 1 })
            .mockReturnValueOnce({ status: 0 })
            .mockReturnValueOnce({ status: 0 });
        const config = options(run_builder);
        package_desktop_windows(config);
        expect(run_builder.mock.calls.map(([arch]) => arch)).toEqual(['x64', 'x64', 'arm64']);
        expect(config.log?.warn).toHaveBeenCalledWith('Windows x64 packaging failed with exit code 1; retrying.');
    });

    it('reports the architecture and last failure after exhausting retries', () => {
        const run_builder = vi.fn()
            .mockReturnValueOnce({ status: 1 })
            .mockReturnValueOnce({ status: null, signal: 'SIGTERM' })
            .mockReturnValueOnce({ status: null, error: new Error('could not spawn') });
        expect(() => package_desktop_windows({ ...options(run_builder), attempts: 3 })).toThrow(
            'Windows x64 packaging failed after 3 attempts (last failure: could not spawn)',
        );
    });

    it('restores the x64 setup manifest when arm64 packaging fails', () => {
        const files = new Set<string>();
        const copy_file = vi.fn((source: string, target: string) => {
            if (files.has(source)) files.add(target);
        });
        const remove = vi.fn((path: string) => files.delete(path));
        const run_builder = vi.fn((arch: string) => {
            if (arch === 'x64') {
                files.add('/packages/latest.yml');
                files.add('/packages/table-viewer-1.2.3-x64-portable.exe');
                return { status: 0 };
            }
            return { status: 1 };
        });
        const config = options(run_builder);
        expect(() => package_desktop_windows({
            ...config, attempts: 1, packages_dir: '/packages',
            exists: (path) => files.has(path), copy_file, remove,
        })).toThrow('Windows arm64 packaging failed after 1 attempts');
        expect(copy_file).toHaveBeenCalledWith('/packages/latest-x64.yml', '/packages/latest.yml');
        expect(remove).toHaveBeenLastCalledWith('/packages/latest-x64.yml', { force: true });
    });

    it('rejects an invalid retry bound before invoking electron-builder', () => {
        const run_builder = vi.fn();
        expect(() => package_desktop_windows({ attempts: 0, run_builder })).toThrow(
            'Windows packaging attempts must be a positive integer',
        );
        expect(run_builder).not.toHaveBeenCalled();
    });
});
