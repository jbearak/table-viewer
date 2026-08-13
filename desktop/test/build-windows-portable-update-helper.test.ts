import { describe, expect, it, vi } from 'vitest';
import {
    build_windows_portable_update_helper,
    helper_build_paths,
    is_direct_entry,
    PORTABLE_UPDATE_HELPER_NAME,
} from '../build-windows-portable-update-helper.mjs';

describe('Windows portable update helper build', () => {
    it('uses architecture-specific output paths with the runtime resource name', () => {
        expect(helper_build_paths('x64').output_path).toMatch(
            new RegExp(`dist[/\\\\]native[/\\\\]win32-x64[/\\\\]${PORTABLE_UPDATE_HELPER_NAME}$`),
        );
        expect(helper_build_paths('arm64').output_path).toMatch(
            new RegExp(`dist[/\\\\]native[/\\\\]win32-arm64[/\\\\]${PORTABLE_UPDATE_HELPER_NAME}$`),
        );
    });

    it('rejects unsupported architectures before launching tools', () => {
        const run = vi.fn();
        expect(() => build_windows_portable_update_helper('ia32', run)).toThrow();
        expect(run).not.toHaveBeenCalled();
    });

    it('detects direct entry after normalizing equivalent Windows paths', () => {
        const canonical_path = 'C:\\Repo\\desktop\\build-windows-portable-update-helper.mjs';
        const realpath = vi.fn(() => canonical_path);
        expect(is_direct_entry(
            'C:\\Repo\\desktop\\..\\desktop\\build-windows-portable-update-helper.mjs',
            'file:///C:/Repo/desktop/build-windows-portable-update-helper.mjs',
            realpath,
        )).toBe(true);
        expect(realpath).toHaveBeenCalledTimes(2);
    });

    it('does not treat a different module as direct entry', () => {
        const realpath = vi.fn((path: string) => path);
        expect(is_direct_entry(
            '/repo/desktop/test/importer.mjs',
            'file:///repo/desktop/build-windows-portable-update-helper.mjs',
            realpath,
        )).toBe(false);
    });
});
