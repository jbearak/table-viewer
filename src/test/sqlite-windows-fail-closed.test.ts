import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteFileStateError } from '../sqlite-file-state-errors';
import { open_sqlite_file_state_store } from '../sqlite-file-state-persistence';
import type { SqliteDesktopFileStateIdentity } from '../sqlite-file-state-schema';

let tempDirectory: string | undefined;

const identity: SqliteDesktopFileStateIdentity = {
    productKind: 'desktop',
    databaseId: 'windows-fail-closed-database',
    storageEnvironmentId: 'windows-fail-closed-environment',
};

afterEach(() => {
    if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
});

describe('SQLite Windows public open', () => {
    it.runIf(process.platform === 'win32')(
        'fails closed without creating database evidence when directory durability is unsupported',
        async () => {
            tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-sqlite-windows-fail-closed-'));
            const databasePath = path.join(tempDirectory, 'file-state.sqlite3');

            let caught: unknown;
            try {
                await open_sqlite_file_state_store(databasePath, {
                    identity,
                    migration: { appliedAtMs: 100, appVersion: '0.7.0' },
                    clientKind: 'sqlite-windows-fail-closed-test',
                    clientVersion: '0.7.0',
                    timeoutMs: 0,
                });
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(SqliteFileStateError);
            expect((caught as SqliteFileStateError).category).toBe('unsupported');
            expect((caught as SqliteFileStateError).metadata.operation).toBe('directory-durability');
            expect(fs.existsSync(databasePath)).toBe(false);
            expect(fs.readdirSync(tempDirectory).filter((name) =>
                name !== '.file-state.sqlite3.recovery-gate')).toEqual([]);

            const gateDirectory = path.join(tempDirectory, '.file-state.sqlite3.recovery-gate');
            if (fs.existsSync(gateDirectory)) {
                expect(fs.readdirSync(gateDirectory)).toEqual(['readers']);
                expect(fs.readdirSync(path.join(gateDirectory, 'readers'))).toEqual([]);
            }
        },
    );
});
