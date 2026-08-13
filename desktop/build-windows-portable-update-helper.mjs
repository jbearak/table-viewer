import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORTABLE_UPDATE_HELPER_NAME = 'windows-portable-update-helper.exe';
export const SUPPORTED_ARCHITECTURES = ['x64', 'arm64'];

const desktop_dir = dirname(fileURLToPath(import.meta.url));
const repo_dir = join(desktop_dir, '..');
const source_dir = join(desktop_dir, 'native', 'windows-portable-update-helper');

export function helper_build_paths(arch) {
    if (!SUPPORTED_ARCHITECTURES.includes(arch)) throw new Error(`Unsupported helper architecture: ${arch}`);
    const build_dir = join(repo_dir, 'dist', 'native-build', `windows-portable-update-helper-${arch}`);
    const output_dir = join(repo_dir, 'dist', 'native', `win32-${arch}`);
    return { build_dir, output_dir, output_path: join(output_dir, PORTABLE_UPDATE_HELPER_NAME) };
}

export function build_windows_portable_update_helper(arch, run = spawnSync) {
    if (process.platform !== 'win32') throw new Error('The Windows portable update helper must be built on Windows');
    const { build_dir, output_dir, output_path } = helper_build_paths(arch);
    mkdirSync(build_dir, { recursive: true });
    mkdirSync(output_dir, { recursive: true });
    const cmake_arch = arch === 'x64' ? 'x64' : 'ARM64';
    run_checked(run, 'cmake', ['-S', source_dir, '-B', build_dir, '-A', cmake_arch], repo_dir);
    run_checked(run, 'cmake', ['--build', build_dir, '--config', 'Release', '--target', 'windows-portable-update-helper'], repo_dir);
    run_checked(run, 'cmake', ['--install', build_dir, '--config', 'Release', '--prefix', output_dir], repo_dir);
    if (statSync(output_path).size === 0) throw new Error(`Windows portable update helper is empty: ${output_path}`);
}

function run_checked(run, executable, args, cwd) {
    const result = run(executable, args, { cwd, stdio: 'inherit', windowsHide: true, shell: false });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`${executable} terminated by signal ${result.signal}`);
    if (result.status !== 0) throw new Error(`${executable} exited with status ${result.status}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const architectures = process.argv.slice(2);
    if (architectures.length === 0) architectures.push(...SUPPORTED_ARCHITECTURES);
    for (const arch of architectures) build_windows_portable_update_helper(arch);
}
