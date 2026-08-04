import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo_dir = fileURLToPath(new URL('..', import.meta.url));

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

export function extension_id(manifest) {
    return `${manifest.publisher}.${manifest.name}`;
}

export function expected_vsix_paths(main_manifest, companion_manifest) {
    assert(main_manifest.version === companion_manifest.version,
        `main and companion versions differ: ${main_manifest.version} != ${companion_manifest.version}`);
    assert(extension_id(main_manifest) === 'jbearak.table-viewer',
        `unexpected main extension id: ${extension_id(main_manifest)}`);
    assert(extension_id(companion_manifest) === 'jbearak.table-viewer-companion',
        `unexpected companion extension id: ${extension_id(companion_manifest)}`);

    return {
        version: main_manifest.version,
        main: `table-viewer-${main_manifest.version}.vsix`,
        companion: `companion/table-viewer-companion-${companion_manifest.version}.vsix`,
    };
}

function has_entry(entries, path) {
    return entries.includes(path);
}

export function validate_main_entries(entries) {
    for (const required of [
        'extension/package.json',
        'extension/dist/extension.js',
        'extension/dist/webview/index.js',
        'extension/dist/webview/index.css',
    ]) {
        assert(has_entry(entries, required), `main VSIX is missing ${required}`);
    }
    assert(!entries.some((entry) => entry.startsWith('extension/companion/')),
        'main VSIX contains separately packaged companion files');
    assert(!entries.some((entry) => entry.endsWith('.vsix')),
        'main VSIX contains a nested VSIX artifact');
}

export function validate_companion_entries(entries) {
    for (const required of [
        'extension/package.json',
        'extension/LICENSE.txt',
        'extension/dist/extension.js',
    ]) {
        assert(has_entry(entries, required), `companion VSIX is missing ${required}`);
    }

    const forbidden = entries.find((entry) => (
        entry.startsWith('extension/src/')
        || entry.startsWith('extension/test/')
        || entry.startsWith('extension/dist-types/')
        || entry === 'extension/tsconfig.json'
        || entry.endsWith('.vsix')
    ));
    assert(forbidden === undefined, `companion VSIX contains excluded source/test artifact: ${forbidden}`);
}

export function validate_archived_manifest(actual, expected, label) {
    assert(actual.name === expected.name,
        `${label} archived package name is ${actual.name}, expected ${expected.name}`);
    assert(actual.publisher === expected.publisher,
        `${label} archived publisher is ${actual.publisher}, expected ${expected.publisher}`);
    assert(actual.version === expected.version,
        `${label} archived version is ${actual.version}, expected ${expected.version}`);
}

export function validate_externalized_sqlite(bundle, label = 'companion bundle') {
    assert(bundle.includes('require("node:sqlite")'),
        `${label} does not retain the node:sqlite runtime import`);
}

const MAX_ARCHIVE_OUTPUT_BYTES = 64 * 1024 * 1024;

export function unzip_text(args, exec_file = execFileSync) {
    try {
        return exec_file('unzip', args, {
            encoding: 'utf8',
            maxBuffer: MAX_ARCHIVE_OUTPUT_BYTES,
            windowsHide: true,
        });
    } catch (error) {
        if (error instanceof Error && error.code === 'ENOENT') {
            throw new Error(
                'required `unzip` executable was not found; install unzip and ensure it is on PATH',
                { cause: error },
            );
        }
        throw error;
    }
}

function archive_entries(path) {
    return unzip_text(['-Z1', path])
        .split(/\r?\n/u)
        .filter(Boolean);
}

function archive_text(path, entry) {
    return unzip_text(['-p', path, entry]);
}

export async function check_vsix_packages(root = repo_dir) {
    const main_manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const companion_manifest = JSON.parse(await readFile(join(root, 'companion', 'package.json'), 'utf8'));
    const expected = expected_vsix_paths(main_manifest, companion_manifest);
    const main_path = join(root, expected.main);
    const companion_path = join(root, expected.companion);

    assert(existsSync(main_path), `missing exact-version main VSIX: ${expected.main}`);
    assert(existsSync(companion_path), `missing exact-version companion VSIX: ${expected.companion}`);

    const main_entries = archive_entries(main_path);
    const companion_entries = archive_entries(companion_path);
    validate_main_entries(main_entries);
    validate_companion_entries(companion_entries);

    validate_archived_manifest(
        JSON.parse(archive_text(main_path, 'extension/package.json')),
        main_manifest,
        'main VSIX',
    );
    validate_archived_manifest(
        JSON.parse(archive_text(companion_path, 'extension/package.json')),
        companion_manifest,
        'companion VSIX',
    );
    validate_externalized_sqlite(
        archive_text(companion_path, 'extension/dist/extension.js'),
        'companion VSIX bundle',
    );

    return {
        version: expected.version,
        main: basename(main_path),
        companion: expected.companion,
    };
}

const invoked_path = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invoked_path === import.meta.url) {
    const checked = await check_vsix_packages();
    process.stdout.write(
        `inspected ${checked.main} and ${checked.companion}: exact versions and identities match; `
        + 'main excludes companion files; companion excludes source/tests and externalizes node:sqlite\n',
    );
}
