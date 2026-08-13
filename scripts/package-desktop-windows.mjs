#!/usr/bin/env node

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { validate_update_metadata } from './validate-update-metadata.mjs';
import { build_windows_portable_update_helper } from '../desktop/build-windows-portable-update-helper.mjs';

const DEFAULT_ATTEMPTS = 3;
const repo_dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const output_dir = join(repo_dir, 'dist', 'desktop-packages');
const electron_builder_cli = join(repo_dir, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

function describe_failure(result) {
    if (result.error) return result.error.message;
    if (result.signal) return `signal ${result.signal}`;
    return `exit code ${result.status ?? 'unknown'}`;
}

export function build_arguments(arch) {
    return [electron_builder_cli, '--config', 'desktop/electron-builder.yml', '--publish', 'never', '--win', `--${arch}`];
}

export function select_windows_update_asset(metadata, expected_asset) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !Array.isArray(metadata.files)) {
        throw new Error('Windows update metadata has no file list');
    }
    const matches = metadata.files.filter((candidate) => candidate?.url === expected_asset);
    if (matches.length !== 1) {
        throw new Error(`Windows update metadata must reference ${expected_asset} exactly once`);
    }
    const selected = matches[0];
    return { ...metadata, files: [selected], path: expected_asset, sha512: selected.sha512 };
}

function select_manifest_asset(metadata_path, expected_asset, target_path = metadata_path) {
    const metadata = yaml.load(readFileSync(metadata_path, 'utf8'));
    const selected = select_windows_update_asset(metadata, expected_asset);
    writeFileSync(target_path, yaml.dump(selected, { lineWidth: -1 }), 'utf8');
}

export function package_desktop_windows({
    attempts = DEFAULT_ATTEMPTS,
    version = process.env.npm_package_version || JSON.parse(readFileSync(join(repo_dir, 'package.json'), 'utf8')).version,
    run_builder = (arch) => spawnSync(process.execPath, build_arguments(arch), { cwd: repo_dir, stdio: 'inherit' }),
    build_helper = build_windows_portable_update_helper,
    copy_file = copyFileSync,
    exists = existsSync,
    remove = rmSync,
    select_manifest = select_manifest_asset,
    validate = validate_update_metadata,
    log = console,
} = {}) {
    if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('Windows packaging attempts must be a positive integer');

    for (const arch of ['x64', 'arm64']) {
        build_helper(arch);
        let last_failure = 'unknown failure';
        let succeeded = false;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            log.info(`Packaging Windows ${arch} desktop app (attempt ${attempt}/${attempts})...`);
            const result = run_builder(arch);
            if (!result.error && result.status === 0) {
                succeeded = true;
                break;
            }
            last_failure = describe_failure(result);
            if (attempt < attempts) log.warn(`Windows ${arch} packaging failed with ${last_failure}; retrying.`);
        }
        if (!succeeded) throw new Error(`Windows ${arch} packaging failed after ${attempts} attempts (last failure: ${last_failure})`);

        const source_manifest = join(output_dir, 'latest.yml');
        const setup_manifest = join(output_dir, arch === 'x64' ? 'latest.yml' : 'latest-arm64.yml');
        const portable_manifest = join(output_dir, arch === 'x64' ? 'latest-portable.yml' : 'latest-portable-arm64.yml');
        const setup = `table-viewer-${version}-${arch}-setup.exe`;
        const portable = `table-viewer-${version}-${arch}-portable.exe`;
        if (!exists(source_manifest)) throw new Error(`Windows ${arch} packaging did not produce latest.yml`);
        // electron-builder combines both .exe targets in latest.yml. Preserve a
        // portable-only channel before rewriting the source to the setup channel.
        select_manifest(source_manifest, portable, portable_manifest);
        select_manifest(source_manifest, setup);
        if (source_manifest !== setup_manifest) copy_file(source_manifest, setup_manifest);
        validate(setup_manifest, {
            expected_version: version, expected_asset: setup, strict: true, require_blockmap: true,
        });
        if (arch === 'x64') copy_file(source_manifest, join(output_dir, 'latest-x64.yml'));
        validate(portable_manifest, {
            expected_version: version, expected_asset: portable, strict: true, require_blockmap: false,
        });
    }
    const saved_x64_manifest = join(output_dir, 'latest-x64.yml');
    copy_file(saved_x64_manifest, join(output_dir, 'latest.yml'));
    remove(saved_x64_manifest, { force: true });
}

const invoked_path = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invoked_path === import.meta.url) {
    try {
        package_desktop_windows();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
