import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type PackageResult = { error?: Error; signal?: string | null; status: number | null };
type PackageOptions = {
    attempts?: number;
    version?: string;
    run_builder?: (arch: string) => PackageResult;
    build_helper?: (arch: string) => void;
    helper_path?: (arch: string) => string;
    copy_file?: (source: string, target: string) => void;
    exists?: (path: string) => boolean;
    remove?: (path: string, options: { force: boolean }) => void;
    select_manifest?: (source: string, expected_asset: string, target?: string) => void;
    validate?: (path: string, options: Record<string, unknown>) => void;
    log?: { info(message: string): void; warn(message: string): void };
};

let package_desktop_windows: (options?: PackageOptions) => void;
let select_windows_update_asset: (metadata: unknown, expected_asset: string) => Record<string, unknown>;
let build_arguments: (arch: string) => string[];

beforeAll(async () => {
    const package_specifier = '../../scripts/package-desktop-windows.mjs';
    ({ build_arguments, package_desktop_windows, select_windows_update_asset } = await import(package_specifier));
});

function options(run_builder: (arch: string) => PackageResult): PackageOptions {
    return {
        version: '1.2.3', run_builder, exists: () => true,
        build_helper: vi.fn(), helper_path: (arch) => `/helpers/${arch}.exe`,
        copy_file: vi.fn(), remove: vi.fn(), select_manifest: vi.fn(), validate: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn() },
    };
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
    });

    it('selects one requested executable from multi-target update metadata', () => {
        const setup = { url: 'table-viewer-1.2.3-x64-setup.exe', sha512: 'setup-digest', size: 12 };
        const portable = { url: 'table-viewer-1.2.3-x64-portable.exe', sha512: 'portable-digest', size: 34 };
        const metadata = { version: '1.2.3', files: [portable, setup], path: portable.url, sha512: portable.sha512 };

        expect(select_windows_update_asset(metadata, setup.url)).toEqual({
            version: '1.2.3', files: [setup], path: setup.url, sha512: setup.sha512,
        });
        expect(select_windows_update_asset(metadata, portable.url)).toEqual({
            version: '1.2.3', files: [portable], path: portable.url, sha512: portable.sha512,
        });
    });

    it('rejects metadata without exactly one expected setup executable', () => {
        expect(() => select_windows_update_asset({ files: [] }, 'setup.exe')).toThrow(
            'Windows update metadata must reference setup.exe exactly once',
        );
    });

    it('packages each architecture separately and preserves setup and portable manifests', () => {
        const run_builder = vi.fn().mockReturnValue({ status: 0 });
        const config = options(run_builder);
        package_desktop_windows(config);

        expect(run_builder.mock.calls.map(([arch]) => arch)).toEqual(['x64', 'arm64']);
        expect(config.select_manifest).toHaveBeenCalledTimes(4);
        expect(config.select_manifest).toHaveBeenNthCalledWith(
            1, expect.stringMatching(/latest\.yml$/), 'table-viewer-1.2.3-x64-portable.exe',
            expect.stringMatching(/latest-portable\.yml$/),
        );
        expect(config.select_manifest).toHaveBeenNthCalledWith(
            2, expect.stringMatching(/latest\.yml$/), 'table-viewer-1.2.3-x64-setup.exe',
        );
        expect(config.select_manifest).toHaveBeenNthCalledWith(
            3, expect.stringMatching(/latest\.yml$/), 'table-viewer-1.2.3-arm64-portable.exe',
            expect.stringMatching(/latest-portable-arm64\.yml$/),
        );
        expect(config.select_manifest).toHaveBeenNthCalledWith(
            4, expect.stringMatching(/latest\.yml$/), 'table-viewer-1.2.3-arm64-setup.exe',
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
        const x64_setup_validation = (config.validate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
        const saved_x64_copy = (config.copy_file as ReturnType<typeof vi.fn>).mock.invocationCallOrder.find((_, index) => {
            const [, target] = (config.copy_file as ReturnType<typeof vi.fn>).mock.calls[index];
            return /latest-x64\.yml$/.test(target);
        });
        const x64_portable_validation = (config.validate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1];
        expect(x64_setup_validation).toBeLessThan(saved_x64_copy!);
        expect(saved_x64_copy).toBeLessThan(x64_portable_validation);
        expect(config.copy_file).toHaveBeenCalledWith(
            expect.stringMatching(/latest-x64\.yml$/), expect.stringMatching(/latest\.yml$/),
        );
        expect(config.remove).toHaveBeenCalledWith(expect.stringMatching(/latest-x64\.yml$/), { force: true });
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

    it('rejects an invalid retry bound before invoking electron-builder', () => {
        const run_builder = vi.fn();
        expect(() => package_desktop_windows({ attempts: 0, run_builder })).toThrow(
            'Windows packaging attempts must be a positive integer',
        );
        expect(run_builder).not.toHaveBeenCalled();
    });
});
