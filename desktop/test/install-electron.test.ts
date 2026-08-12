import { beforeAll, describe, expect, it, vi } from 'vitest';

type InstallResult = {
    error?: Error;
    signal?: string | null;
    status: number | null;
};

type InstallOptions = {
    attempts?: number;
    run_installer?: () => InstallResult;
    log?: { info(message: string): void; warn(message: string): void };
};

let install_electron: (options?: InstallOptions) => void;

beforeAll(async () => {
    // The installer is an untyped executable .mjs file, so keep its specifier
    // indirect rather than asking the TypeScript project to resolve declarations.
    const installer_specifier = '../../scripts/install-electron.mjs';
    ({ install_electron } = await import(installer_specifier));
});

describe('Electron installer retry wrapper', () => {
    it('retries a failed install and stops at the first success', () => {
        const run_installer = vi.fn()
            .mockReturnValueOnce({ status: 1 })
            .mockReturnValueOnce({ status: 0 });
        const log = { info: vi.fn(), warn: vi.fn() };

        expect(() => install_electron({ run_installer, log })).not.toThrow();

        expect(run_installer).toHaveBeenCalledTimes(2);
        expect(log.warn).toHaveBeenCalledWith(
            'Electron install failed with exit code 1; retrying.',
        );
    });

    it('reports the last observable failure after exhausting the bound', () => {
        const run_installer = vi.fn()
            .mockReturnValueOnce({ status: 1 })
            .mockReturnValueOnce({ status: null, signal: 'SIGTERM' })
            .mockReturnValueOnce({ status: null, error: new Error('could not spawn') });
        const log = { info: vi.fn(), warn: vi.fn() };

        expect(() => install_electron({ run_installer, log })).toThrow(
            'Electron install failed after 3 attempts (last failure: could not spawn)',
        );
        expect(run_installer).toHaveBeenCalledTimes(3);
    });

    it('rejects an invalid retry bound before invoking the installer', () => {
        const run_installer = vi.fn();

        expect(() => install_electron({ attempts: 0, run_installer })).toThrow(
            'Electron install attempts must be a positive integer',
        );
        expect(run_installer).not.toHaveBeenCalled();
    });
});
