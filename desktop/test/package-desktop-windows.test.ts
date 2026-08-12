import { beforeAll, describe, expect, it, vi } from 'vitest';

type PackageResult = {
    error?: Error;
    signal?: string | null;
    status: number | null;
};

type PackageOptions = {
    attempts?: number;
    run_builder?: () => PackageResult;
    log?: { info(message: string): void; warn(message: string): void };
};

let package_desktop_windows: (options?: PackageOptions) => void;

beforeAll(async () => {
    // The packaging wrapper is an untyped executable .mjs file, so keep its
    // specifier indirect rather than asking TypeScript to resolve declarations.
    const package_specifier = '../../scripts/package-desktop-windows.mjs';
    ({ package_desktop_windows } = await import(package_specifier));
});

describe('Windows desktop packaging retry wrapper', () => {
    it('retries a failed build and stops at the first success', () => {
        const run_builder = vi.fn()
            .mockReturnValueOnce({ status: 1 })
            .mockReturnValueOnce({ status: 0 });
        const log = { info: vi.fn(), warn: vi.fn() };

        expect(() => package_desktop_windows({ run_builder, log })).not.toThrow();

        expect(run_builder).toHaveBeenCalledTimes(2);
        expect(log.warn).toHaveBeenCalledWith(
            'Windows packaging failed with exit code 1; retrying.',
        );
    });

    it('reports the last observable failure after exhausting the bound', () => {
        const run_builder = vi.fn()
            .mockReturnValueOnce({ status: 1 })
            .mockReturnValueOnce({ status: null, signal: 'SIGTERM' })
            .mockReturnValueOnce({ status: null, error: new Error('could not spawn') });
        const log = { info: vi.fn(), warn: vi.fn() };

        expect(() => package_desktop_windows({ run_builder, log })).toThrow(
            'Windows packaging failed after 3 attempts (last failure: could not spawn)',
        );
        expect(run_builder).toHaveBeenCalledTimes(3);
    });

    it('rejects an invalid retry bound before invoking electron-builder', () => {
        const run_builder = vi.fn();

        expect(() => package_desktop_windows({ attempts: 0, run_builder })).toThrow(
            'Windows packaging attempts must be a positive integer',
        );
        expect(run_builder).not.toHaveBeenCalled();
    });
});
