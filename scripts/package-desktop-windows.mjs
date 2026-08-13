#!/usr/bin/env node

import { createHash } from 'node:crypto';
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
    writeFileSync(target_path, yaml.dump(selected, { lineWidth: -1, noRefs: true }), 'utf8');
}

export function create_portable_update_metadata(version, asset, bytes, release_date) {
    const sha512 = createHash('sha512').update(bytes).digest('base64');
    return {
        version,
        files: [{ url: asset, sha512, size: bytes.byteLength }],
        path: asset,
        sha512,
        releaseDate: release_date,
    };
}

function write_portable_manifest(asset_path, manifest_path, version, asset, release_date) {
    const metadata = create_portable_update_metadata(version, asset, readFileSync(asset_path), release_date);
    writeFileSync(manifest_path, yaml.dump(metadata, { lineWidth: -1, noRefs: true }), 'utf8');
}

export function package_desktop_windows({
    attempts = DEFAULT_ATTEMPTS,
    version = process.env.npm_package_version || JSON.parse(readFileSync(join(repo_dir, 'package.json'), 'utf8')).version,
    run_builder,
    build_helper = build_windows_portable_update_helper,
    packages_dir = output_dir,
    release_date = () => new Date().toISOString(),
    copy_file = copyFileSync,
    exists = existsSync,
    remove = rmSync,
    select_manifest = select_manifest_asset,
    write_portable = write_portable_manifest,
    validate = validate_update_metadata,
    log = console,
} = {}) {
    if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('Windows packaging attempts must be a positive integer');
    if (run_builder !== undefined && typeof run_builder !== 'function') {
        throw new TypeError('Windows package builder must be a function');
    }
    const invoke_builder = run_builder
        ?? ((arch) => spawnSync(process.execPath, build_arguments(arch), { cwd: repo_dir, stdio: 'inherit' }));
    const resolved_packages_dir = resolve(packages_dir);
    if (resolved_packages_dir !== resolve(output_dir) && run_builder === undefined) {
        throw new Error('A custom Windows packages directory requires a custom builder');
    }

    const saved_x64_manifest = join(resolved_packages_dir, 'latest-x64.yml');
    for (const manifest of [
        saved_x64_manifest,
        join(resolved_packages_dir, 'latest-arm64.yml'),
        join(resolved_packages_dir, 'latest-portable.yml'),
        join(resolved_packages_dir, 'latest-portable-arm64.yml'),
    ]) {
        remove(manifest, { force: true });
    }
    try {
        for (const arch of ['x64', 'arm64']) {
            const source_manifest = join(resolved_packages_dir, 'latest.yml');
            const setup_manifest = join(resolved_packages_dir, arch === 'x64' ? 'latest.yml' : 'latest-arm64.yml');
            const portable_manifest = join(resolved_packages_dir, arch === 'x64' ? 'latest-portable.yml' : 'latest-portable-arm64.yml');
            const setup = `table-viewer-${version}-${arch}-setup.exe`;
            const portable = `table-viewer-${version}-${arch}-portable.exe`;
            const setup_path = join(resolved_packages_dir, setup);
            const portable_path = join(resolved_packages_dir, portable);
            build_helper(arch);
            let last_failure = 'unknown failure';
            let succeeded = false;
            for (let attempt = 1; attempt <= attempts; attempt += 1) {
                // A reused workspace may contain outputs from an earlier build of the
                // same version. Remove every required output so success proves this
                // invocation produced the bytes that its manifests describe.
                for (const path of [source_manifest, setup_path, `${setup_path}.blockmap`, portable_path]) {
                    remove(path, { force: true });
                }
                log.info(`Packaging Windows ${arch} desktop app (attempt ${attempt}/${attempts})...`);
                const result = invoke_builder(arch);
                if (!result.error && result.status === 0) {
                    succeeded = true;
                    break;
                }
                last_failure = describe_failure(result);
                if (attempt < attempts) log.warn(`Windows ${arch} packaging failed with ${last_failure}; retrying.`);
            }
            if (!succeeded) throw new Error(`Windows ${arch} packaging failed after ${attempts} attempts (last failure: ${last_failure})`);

            if (!exists(source_manifest)) throw new Error(`Windows ${arch} packaging did not produce latest.yml`);
            if (!exists(portable_path)) throw new Error(`Windows ${arch} packaging did not produce ${portable}`);
            // electron-builder owns the setup channel. Portable update metadata is
            // derived from the completed executable because latest.yml omits it.
            select_manifest(source_manifest, setup);
            write_portable(portable_path, portable_manifest, version, portable, release_date());
            if (source_manifest !== setup_manifest) copy_file(source_manifest, setup_manifest);
            validate(setup_manifest, {
                expected_version: version, expected_asset: setup, strict: true, require_blockmap: true,
            });
            if (arch === 'x64') copy_file(source_manifest, saved_x64_manifest);
            validate(portable_manifest, {
                expected_version: version, expected_asset: portable, strict: true, require_blockmap: false,
            });
        }
    } finally {
        if (exists(saved_x64_manifest)) copy_file(saved_x64_manifest, join(resolved_packages_dir, 'latest.yml'));
        remove(saved_x64_manifest, { force: true });
    }
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
