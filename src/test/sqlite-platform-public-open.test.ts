import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { open_sqlite_file_state_store } from '../sqlite-file-state-persistence';
import {
    SQLITE_FILE_STATE_FORMAT,
    SQLITE_FILE_STATE_USER_VERSION,
    type SqliteDesktopFileStateIdentity,
} from '../sqlite-file-state-schema';
import { inspect_sqlite_recovery_gate } from '../sqlite-open-recovery';

let tempDirectory: string | undefined;

const identity: SqliteDesktopFileStateIdentity = {
    productKind: 'desktop',
    databaseId: 'platform-public-open-database',
    storageEnvironmentId: 'platform-public-open-environment',
};

afterEach(() => {
    if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
});

/**
 * The public open, on whatever platform this is running on.
 *
 * This file used to assert the opposite on Windows: that the open refused with
 * `unsupported`/`directory-durability` and created nothing. It no longer does, and
 * that reversal is why the test still exists. Where a host has no directory-flush
 * primitive to call at all — NTFS — the flush is skipped rather than refused,
 * matching SQLite's own Windows VFS, so every platform must now install a
 * complete, valid v1 database through the same public entry point.
 *
 * Deliberately no longer restricted to win32. The contract is platform-independent,
 * so running it everywhere means a regression that re-introduced a platform refusal
 * fails on a developer machine rather than only in the Windows job — and the
 * Windows job can no longer pass by skipping the only vitest step it runs.
 */
describe('SQLite public open', () => {
    it('installs a complete v1 database on this platform', async () => {
        tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-sqlite-public-open-'));
        const databasePath = path.join(tempDirectory, 'file-state.sqlite3');

        const opened = await open_sqlite_file_state_store(databasePath, {
            identity,
            migration: { appliedAtMs: 100, appVersion: '0.7.0' },
            clientKind: 'sqlite-platform-public-open-test',
            clientVersion: '0.7.0',
            timeoutMs: 0,
        });

        try {
            // A usable store, not merely a file that appeared.
            const initial = await opened.store.read('/a.csv');
            const committed = await opened.store.compare_and_set('/a.csv', initial.revision, {
                activeSheetIndex: 3,
            });
            expect(committed.type).toBe('committed');
        } finally {
            await opened.close();
        }

        expect(fs.existsSync(databasePath)).toBe(true);
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
            expect(database.prepare('PRAGMA user_version').get()?.user_version)
                .toBe(SQLITE_FILE_STATE_USER_VERSION);
            expect(database.prepare('SELECT format FROM state_meta').get()?.format)
                .toBe(SQLITE_FILE_STATE_FORMAT);
        } finally {
            database.close();
        }

        // Reopened through the same public entry point rather than validated by
        // spot-checking tables here. The open runs production's whole validator, so
        // this is what catches a database that installs but would be rejected on the
        // *next* launch — and it proves the committed state survived the close.
        const reopened = await open_sqlite_file_state_store(databasePath, {
            identity,
            migration: { appliedAtMs: 200, appVersion: '0.7.0' },
            clientKind: 'sqlite-platform-public-open-test',
            clientVersion: '0.7.0',
            timeoutMs: 0,
        });
        try {
            expect((await reopened.store.read('/a.csv')).state)
                .toMatchObject({ activeSheetIndex: 3 });
        } finally {
            await reopened.close();
        }

        // Coordination state is released on close on every platform. A skipped
        // directory flush must not become a skipped *removal*: a stranded reader
        // token or exclusive intent makes the next open wait on a process that is
        // already gone.
        const gate = inspect_sqlite_recovery_gate(databasePath);
        expect(gate.readerTokenIds).toEqual([]);
        expect(gate.exclusiveIntentTokenId).toBeUndefined();
        expect(gate.exclusiveIntentMalformed).toBe(false);
        expect(gate.malformedReaderTokenNames).toEqual([]);

        // Nothing beside the database but its own gate directory: no quarantine
        // copy, no leftover candidate, and no journal surviving a clean close.
        expect(fs.readdirSync(tempDirectory).sort())
            .toEqual(['.file-state.sqlite3.recovery-gate', 'file-state.sqlite3']);
    });
});
