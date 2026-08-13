import { beforeAll, describe, expect, it, vi } from 'vitest';

type PackageResult = { error?: Error; signal?: string | null; status: number | null };
type PackageOptions = {
    attempts?: number;
    version?: string;
    run_builder?: (arch: string) => PackageResult;
    copy_file?: (source: string, target: string) => void;
    exists?: (path: string) => boolean;
    remove?: (path: string, options: { force: boolean }) => void;
    validate?: (path: string, options: Record<string, unknown>) => void;
    log?: { info(message: string): void; warn(message: string): void };
};

let package_desktop_windows: (options?: PackageOptions) => void;

beforeAll(async () => {
    const package_specifier = '../../scripts/package-desktop-windows.mjs';
    ({ package_desktop_windows } = await import(package_specifier));
});

function options(run_builder: (arch: string) => PackageResult): PackageOptions {
    return {
        version: '1.2.3', run_builder, exists: () => true,
        copy_file: vi.fn(), remove: vi.fn(), validate: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn() },
    };
}

describe('Windows desktop packaging wrapper', () => {
    it('packages each architecture separately and preserves both manifests', () => {
        const run_builder = vi.fn().mockReturnValue({ status: 0 });
        const config = options(run_builder);
        package_desktop_windows(config);

        expect(run_builder.mock.calls.map(([arch]) => arch)).toEqual(['x64', 'arm64']);
        expect(config.validate).toHaveBeenCalledTimes(2);
        expect(config.validate).toHaveBeenNthCalledWith(1, expect.stringMatching(/latest\.yml$/), {
            expected_version: '1.2.3', expected_asset: 'table-viewer-1.2.3-x64-setup.exe', require_blockmap: true,
        });
        expect(config.validate).toHaveBeenNthCalledWith(2, expect.stringMatching(/latest-arm64\.yml$/), {
            expected_version: '1.2.3', expected_asset: 'table-viewer-1.2.3-arm64-setup.exe', require_blockmap: true,
        });
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
