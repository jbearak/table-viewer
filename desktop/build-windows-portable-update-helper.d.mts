export const PORTABLE_UPDATE_HELPER_NAME: 'windows-portable-update-helper.exe';
export const SUPPORTED_ARCHITECTURES: readonly ['x64', 'arm64'];

export interface HelperBuildPaths {
    readonly build_dir: string;
    readonly output_dir: string;
    readonly output_path: string;
}

export function helper_build_paths(arch: string): HelperBuildPaths;
export function build_windows_portable_update_helper(arch: string): void;
