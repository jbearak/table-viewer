#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

function fail(message) {
    throw new Error(`Invalid update metadata: ${message}`);
}

function safe_asset_path(metadata_path, asset_path) {
    if (typeof asset_path !== 'string' || asset_path.length === 0) fail('asset path is missing');
    if (asset_path !== basename(asset_path) || asset_path.includes('\\')) {
        fail(`unsafe asset path: ${asset_path}`);
    }
    const directory = resolve(dirname(metadata_path));
    const resolved = resolve(directory, asset_path);
    const from_directory = relative(directory, resolved);
    if (from_directory === '' || from_directory === '..' || from_directory.startsWith(`..${sep}`)
        || isAbsolute(from_directory)) {
        fail(`asset escapes metadata directory: ${asset_path}`);
    }
    return resolved;
}

function validate_sha512(value, label) {
    if (typeof value !== 'string') fail(`${label} sha512 is missing`);
    let decoded;
    try {
        decoded = Buffer.from(value, 'base64');
    } catch {
        fail(`${label} sha512 is not base64`);
    }
    if (decoded.length !== 64 || decoded.toString('base64') !== value) {
        fail(`${label} sha512 is not a canonical SHA-512 digest`);
    }
}

export function validate_update_metadata(metadata_path, {
    expected_version,
    expected_asset,
    strict = false,
    require_blockmap = false,
    read_file = readFileSync,
    stat = statSync,
    digest_file = (path) => createHash('sha512').update(readFileSync(path)).digest('base64'),
} = {}) {
    let metadata;
    try {
        metadata = yaml.load(read_file(metadata_path, 'utf8'));
    } catch (error) {
        fail(`${basename(metadata_path)} cannot be read: ${error instanceof Error ? error.message : error}`);
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('document must be a mapping');
    if (metadata.version !== expected_version) {
        fail(`${basename(metadata_path)} version is ${String(metadata.version)}, expected ${expected_version}`);
    }
    if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
        fail(`${basename(metadata_path)} must describe at least one update asset`);
    }
    for (const candidate of metadata.files) {
        if (!candidate || typeof candidate !== 'object' || typeof candidate.url !== 'string') {
            fail(`${basename(metadata_path)} contains an invalid file entry`);
        }
        safe_asset_path(metadata_path, candidate.url);
    }
    const matching_files = metadata.files.filter((candidate) => candidate.url === expected_asset);
    if (matching_files.length !== 1) {
        fail(`${basename(metadata_path)} must reference ${expected_asset} exactly once`);
    }
    // macOS metadata may also describe the fresh-install DMG, but each
    // architecture-specific Windows channel must contain only its intended
    // setup or portable executable.
    if (strict && metadata.files.length !== 1) {
        fail(`${basename(metadata_path)} must describe exactly one update asset`);
    }
    const file = matching_files[0];
    validate_sha512(file.sha512, expected_asset);
    const asset_path = safe_asset_path(metadata_path, file.url);
    const actual_size = stat(asset_path).size;
    if (!Number.isSafeInteger(file.size) || file.size !== actual_size) {
        fail(`${expected_asset} size is ${String(file.size)}, expected ${actual_size}`);
    }
    const actual_digest = digest_file(asset_path);
    if (file.sha512 !== actual_digest) {
        fail(`${expected_asset} sha512 does not match the asset`);
    }
    if (metadata.path !== expected_asset || metadata.sha512 !== file.sha512) {
        fail(`${basename(metadata_path)} top-level path/digest does not match its file entry`);
    }
    if (require_blockmap) {
        const blockmap_path = safe_asset_path(metadata_path, `${expected_asset}.blockmap`);
        const blockmap_size = stat(blockmap_path).size;
        if (blockmap_size <= 0) fail(`${expected_asset}.blockmap is empty`);
        // ZIP metadata embeds its blockmap and records blockMapSize. NSIS emits
        // an external .blockmap, whose file entry intentionally has no such field.
        if (file.blockMapSize !== undefined
            && (!Number.isSafeInteger(file.blockMapSize) || file.blockMapSize !== blockmap_size)) {
            fail(`${expected_asset}.blockmap size is ${String(file.blockMapSize)}, expected ${blockmap_size}`);
        }
    }
    return metadata;
}

const invoked_path = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invoked_path === import.meta.url) {
    const [metadata_path, expected_version, expected_asset, ...flags] = process.argv.slice(2);
    const allowed_flags = new Set(['--strict', '--require-blockmap']);
    const valid_flags = flags.every((flag) => allowed_flags.has(flag)) && new Set(flags).size === flags.length;
    if (!metadata_path || !expected_version || !expected_asset || !valid_flags) {
        console.error('Usage: validate-update-metadata.mjs <manifest> <version> <asset> [--strict] [--require-blockmap]');
        process.exitCode = 2;
    } else {
        try {
            validate_update_metadata(metadata_path, {
                expected_version,
                expected_asset,
                strict: flags.includes('--strict'),
                require_blockmap: flags.includes('--require-blockmap'),
            });
        } catch (error) {
            console.error(error instanceof Error ? error.message : error);
            process.exitCode = 1;
        }
    }
}
