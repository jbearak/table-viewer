import { existsSync, mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { run_sqlite_api_probe } from './sqlite-api-probe.mjs';
// TypeScript from src/, imported exactly as desktop/main/main.ts does: this probe
// is bundled by desktop/build.mjs into dist/runtime-probes/, so the real v1
// initialization and validation code is what runs here rather than a transcription
// of it. A drift between production and the probe would be the one failure mode a
// runtime probe cannot afford.
import {
    assert_sqlite_directory_durability_supported,
    initialize_sqlite_database_no_clobber,
} from '../src/sqlite-open-recovery';
import {
    validate_sqlite_file_state_database,
} from '../src/sqlite-file-state-validation';
import {
    SqliteFileStateError,
} from '../src/sqlite-file-state-errors';
import {
    DESKTOP_STATE_IDENTITY,
    DESKTOP_STATE_DATABASE_NAME,
} from './main/desktop-state-database';

function invariant(condition, message) {
    if (!condition) throw new Error(`electron sqlite runtime probe failed: ${message}`);
}

function write_output(stream, text) {
    // Probe output is one short line. A synchronous descriptor write both flushes it
    // before app.exit() and fails immediately if a pipe has already closed.
    writeSync(stream.fd, text);
}

/**
 * Which v1 contract this platform is required to satisfy.
 *
 * Every platform is required to install today, Windows included: where no
 * directory-flush primitive exists the flush is skipped rather than refused. But
 * the refusal has not gone away — a *location* whose filesystem rejects a flush it
 * was asked to perform still fails closed — so the probe must still assert per
 * outcome rather than assuming installation succeeds unconditionally, and on that
 * path the observable guarantee is the refusal itself.
 *
 * Derived by *running* the production rule against a throwaway directory rather
 * than by re-testing `platform === 'win32'`. The second copy of a predicate is
 * the bug: it keeps answering confidently after the original has changed, and the
 * probe would then assert a stale contract — asserting an install where production
 * had started refusing, or a refusal where it had started installing, with nothing
 * to catch either. Calling the enforcer makes the two unable to disagree.
 *
 * `platform` and the injected `assert` are still parameters, so every branch stays
 * reachable from a unit test on any host.
 */
export function v1_contract_for_platform(
    platform = process.platform,
    assert = assert_sqlite_directory_durability_supported,
) {
    const probe_directory = mkdtempSync(join(tmpdir(), 'table-viewer-durability-contract-'));
    try {
        // Exactly production's default operations: passing anything else here
        // would be the injected-capability path production never takes, and would
        // report a contract no shipped build can honor.
        assert(probe_directory, undefined, platform);
        return 'installed';
    } catch (error) {
        if (error instanceof SqliteFileStateError && error.category === 'unsupported') {
            return 'fail-closed';
        }
        throw error;
    } finally {
        rmSync(probe_directory, { recursive: true, force: true });
    }
}

/**
 * Assert the Windows fail-closed policy positively, from the outcome of a real
 * initialization attempt.
 *
 * The category is checked through `SqliteFileStateError` rather than by matching
 * the message so a reworded message cannot turn this into a vacuous pass, and the
 * absence of the target file is checked because "refuses" only means anything if
 * the refusal happened before any state was written. Kept pure (outcome in, shape
 * out) so a test can drive every rejection path.
 */
export function assert_v1_refusal(error, database_created) {
    invariant(error !== undefined,
        'v1 initialization succeeded at a location whose directory flush was refused');
    invariant(error instanceof SqliteFileStateError,
        `v1 refusal is ${error?.constructor?.name ?? typeof error}, not SqliteFileStateError`);
    invariant(error.category === 'unsupported',
        `v1 refusal category is ${String(error.category)}, not unsupported`);
    invariant(error.metadata.operation === 'directory-durability',
        `v1 refusal operation is ${String(error.metadata.operation)}, not directory-durability`);
    invariant(!database_created,
        'v1 initialization refused durability but still left a database file behind');
    return {
        contract: 'fail-closed',
        installed: false,
        refusedCategory: error.category,
        refusedOperation: error.metadata.operation,
        databaseCreated: false,
    };
}

/**
 * Prove the packaged Electron runtime can hold a real v1 database, not merely
 * that it exposes the node:sqlite API.
 *
 * `run_sqlite_api_probe` answers "is the API there and does it behave"; this
 * answers "does *our* schema install and validate under this exact runtime",
 * which is the question a packaged build actually depends on. The durability
 * pragmas are re-asserted here on top of `validate_sqlite_file_state_database`
 * because they are the properties an embedded runtime is most likely to compile
 * differently, and a rollback-journal database opened with the wrong journal mode
 * or a weakened synchronous setting is silently non-durable rather than broken.
 */
async function probe_v1_database(platform = process.platform) {
    const contract = v1_contract_for_platform(platform);
    const probe_directory = mkdtempSync(join(tmpdir(), 'table-viewer-electron-v1-probe-'));
    try {
        const database_path = join(probe_directory, DESKTOP_STATE_DATABASE_NAME);
        if (contract === 'fail-closed') {
            let refusal;
            try {
                const refused = await initialize_sqlite_database_no_clobber(
                    database_path,
                    DESKTOP_STATE_IDENTITY,
                    { appliedAtMs: Date.now(), appVersion: 'electron-runtime-probe' },
                );
                // An unexpected success still owns a connection; release it before
                // reporting, so the temp-directory removal below cannot be blocked.
                await refused.database.close();
            } catch (error) {
                refusal = error;
            }
            return assert_v1_refusal(refusal, existsSync(database_path));
        }
        const result = await initialize_sqlite_database_no_clobber(
            database_path,
            DESKTOP_STATE_IDENTITY,
            { appliedAtMs: Date.now(), appVersion: 'electron-runtime-probe' },
        );
        try {
            invariant(result.installed, 'v1 initialization did not install a fresh database');
            const database = result.database.database;
            const metadata = validate_sqlite_file_state_database(database, {
                identity: DESKTOP_STATE_IDENTITY,
            });
            invariant(metadata.productKind === 'desktop',
                'validated database is not a desktop database');
            const pragma = (name) => database.prepare(`PRAGMA ${name}`).get()?.[name];
            // Rollback journal, not WAL: the whole coordination model depends on it.
            invariant(pragma('journal_mode') === 'delete',
                `journal_mode is ${String(pragma('journal_mode'))}, not delete`);
            invariant(pragma('synchronous') === 2,
                `synchronous is ${String(pragma('synchronous'))}, not FULL (2)`);
            invariant(pragma('secure_delete') === 1,
                `secure_delete is ${String(pragma('secure_delete'))}, not on`);
            return { contract, installed: true, entryCount: metadata.entryCount };
        } finally {
            await result.database.close();
        }
    } finally {
        // The throwaway database, its sidecars, and the recovery gate tokens beside
        // it all live under this directory, so one removal covers the lot.
        rmSync(probe_directory, { recursive: true, force: true });
    }
}

async function main() {
    let exit_code = 0;
    try {
        // Wait for Electron's platform lifecycle to initialize before requesting exit.
        // Calling app.exit() before readiness can leave Linux helper processes alive
        // under xvfb even though the synchronous SQLite probe has completed.
        await app.whenReady();
        const result = run_sqlite_api_probe('electron-main');
        if (result.electron !== '43.2.0') {
            throw new Error(`expected Electron 43.2.0, received ${result.electron}`);
        }
        const v1 = await probe_v1_database();
        write_output(process.stdout, `${JSON.stringify({ ...result, v1 })}\n`);
    } catch (error) {
        exit_code = 1;
        try {
            write_output(
                process.stderr,
                `${error instanceof Error ? error.message : String(error)}\n`,
            );
        } catch {
            // A closed diagnostic pipe must not keep the Electron process alive.
        }
    } finally {
        app.exit(exit_code);
    }
}

void main();
