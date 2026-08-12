#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ATTEMPTS = 3;
const repo_dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron_installer = join(repo_dir, 'node_modules', 'electron', 'install.js');

function describe_failure(result) {
    if (result.error) return result.error.message;
    if (result.signal) return `signal ${result.signal}`;
    return `exit code ${result.status ?? 'unknown'}`;
}

/**
 * Run Electron's idempotent installer with bounded retries. Electron 43 defers
 * its binary download until first use, but the lazy path tries only once. A
 * transient fetch failure would otherwise fail CI or a local desktop setup even
 * though repeating the same verified install is safe.
 */
export function install_electron({
    attempts = DEFAULT_ATTEMPTS,
    run_installer = () => spawnSync(process.execPath, [electron_installer], {
        stdio: 'inherit',
        env: {
            ...process.env,
            // @electron/get does not honor HTTP(S)_PROXY unless explicitly
            // enabled. Keep an explicit caller choice, including an empty value.
            ELECTRON_GET_USE_PROXY: process.env.ELECTRON_GET_USE_PROXY ?? 'true',
        },
    }),
    log = console,
} = {}) {
    if (!Number.isInteger(attempts) || attempts < 1) {
        throw new TypeError('Electron install attempts must be a positive integer');
    }

    let last_failure = 'unknown failure';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        log.info(`Ensuring Electron binary (attempt ${attempt}/${attempts})...`);
        const result = run_installer();
        if (!result.error && result.status === 0) return;

        last_failure = describe_failure(result);
        if (attempt < attempts) {
            log.warn(`Electron install failed with ${last_failure}; retrying.`);
        }
    }

    throw new Error(
        `Electron install failed after ${attempts} attempts (last failure: ${last_failure})`,
    );
}

const invoked_path = process.argv[1]
    ? pathToFileURL(resolve(process.argv[1])).href
    : undefined;
if (invoked_path === import.meta.url) {
    try {
        install_electron();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
