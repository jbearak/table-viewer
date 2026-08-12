#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ATTEMPTS = 3;
const repo_dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron_builder_cli = join(
    repo_dir,
    'node_modules',
    'electron-builder',
    'out',
    'cli',
    'cli.js',
);
const electron_builder_arguments = [
    electron_builder_cli,
    '--config',
    'desktop/electron-builder.yml',
    '--publish',
    'never',
    '--win',
    '--x64',
    '--arm64',
];

function describe_failure(result) {
    if (result.error) return result.error.message;
    if (result.signal) return `signal ${result.signal}`;
    return `exit code ${result.status ?? 'unknown'}`;
}

/**
 * Package both Windows architectures with bounded retries. electron-builder
 * downloads architecture-specific Electron archives and installer tooling at
 * packaging time, independently of Electron's npm install script. A transient
 * failure in any one of those downloads should not discard the artifacts and
 * verified cache entries produced by the preceding attempt.
 */
export function package_desktop_windows({
    attempts = DEFAULT_ATTEMPTS,
    run_builder = () => spawnSync(process.execPath, electron_builder_arguments, {
        cwd: repo_dir,
        stdio: 'inherit',
    }),
    log = console,
} = {}) {
    if (!Number.isInteger(attempts) || attempts < 1) {
        throw new TypeError('Windows packaging attempts must be a positive integer');
    }

    let last_failure = 'unknown failure';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        log.info(`Packaging Windows desktop app (attempt ${attempt}/${attempts})...`);
        const result = run_builder();
        if (!result.error && result.status === 0) return;

        last_failure = describe_failure(result);
        if (attempt < attempts) {
            log.warn(`Windows packaging failed with ${last_failure}; retrying.`);
        }
    }

    throw new Error(
        `Windows packaging failed after ${attempts} attempts (last failure: ${last_failure})`,
    );
}

const invoked_path = process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href
    : undefined;
if (invoked_path === import.meta.url) {
    try {
        package_desktop_windows();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
