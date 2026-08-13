import { describe, expect, it, vi } from 'vitest';
import {
    build_windows_portable_update_helper,
    helper_build_paths,
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
});
