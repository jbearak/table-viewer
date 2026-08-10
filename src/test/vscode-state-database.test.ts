import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    open_vscode_state_database,
    vscode_state_database_path,
    vscode_state_open_failure_message,
    VSCODE_STATE_CLIENT_KIND,
    VSCODE_STATE_DATABASE_ID,
    VSCODE_STATE_DATABASE_NAME,
    VSCODE_STATE_IDENTITY,
    type OpenedVscodeStateDatabase,
} from '../vscode-state-database';
import {
    is_direct_vscode_file_state_identity,
    SQLITE_DIRECT_VSCODE_FILE_STATE_FORMAT,
    SQLITE_DIRECT_VSCODE_FILE_STATE_MIGRATION_NAME,
    SQLITE_DIRECT_VSCODE_FILE_STATE_USER_VERSION,
} from '../sqlite-file-state-schema';
import { open_sqlite_file_state_store } from '../sqlite-file-state-persistence';
import { sheet_edits } from './pending-edits-helper';

let storageDirectory: string;
let opened: OpenedVscodeStateDatabase[];

async function open(overrides: {
    readonly openStore?: typeof open_sqlite_file_state_store;
    readonly storageDirectory?: string;
    readonly getMaxStoredFiles?: () => number;
} = {}) {
    const database = await open_vscode_state_database({
        storageDirectory: overrides.storageDirectory ?? storageDirectory,
        appVersion: '0.7.0',
        getMaxStoredFiles: overrides.getMaxStoredFiles,
        ...(overrides.openStore ? { openStore: overrides.openStore } : {}),
    });
    opened.push(database);
    return { database };
}

function read_meta(databasePath: string): Record<string, unknown> {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        return {
            ...(database.prepare('SELECT * FROM state_meta').get() as Record<string, unknown>),
            userVersion: database.prepare('PRAGMA user_version').get()?.user_version,
            migrations: database.prepare('SELECT version, name FROM schema_migrations').all(),
            legacyImports: database.prepare('SELECT count(*) AS n FROM legacy_imports').get()?.n,
            legacySources: database.prepare('SELECT count(*) AS n FROM legacy_sources').get()?.n,
            legacyClaims: database.prepare('SELECT count(*) AS n FROM legacy_entry_claims').get()?.n,
        };
    } finally {
        database.close();
    }
}

beforeEach(async () => {
    storageDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tv-vscode-state-'));
    opened = [];
});

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(opened.map((database) => database.close()));
    await fs.promises.rm(storageDirectory, { recursive: true, force: true });
});

describe('VS Code state database identity', () => {
    it('is a legacy-free direct VS Code identity', () => {
        expect(is_direct_vscode_file_state_identity(VSCODE_STATE_IDENTITY)).toBe(true);
        expect(VSCODE_STATE_IDENTITY).not.toHaveProperty('legacy');
        expect(Object.isFrozen(VSCODE_STATE_IDENTITY)).toBe(true);
    });

    it('places one canonical database directly under the given storage directory', () => {
        expect(vscode_state_database_path('/profile/state'))
            .toBe(path.join('/profile/state', VSCODE_STATE_DATABASE_NAME));
    });

    it('refuses a relative storage directory rather than resolving against the cwd', () => {
        expect(() => vscode_state_database_path('relative/state')).toThrow(TypeError);
    });
});

describe('VS Code state database open', () => {
    it('creates an empty direct-schema database and reports the SQLite mode', async () => {
        const { database } = await open();

        expect(database.databasePath).toBe(vscode_state_database_path(storageDirectory));

        const meta = read_meta(database.databasePath);
        expect(meta).toMatchObject({
            format: SQLITE_DIRECT_VSCODE_FILE_STATE_FORMAT,
            database_id: VSCODE_STATE_DATABASE_ID,
            product_kind: 'vscode',
            authority_mode: 'sqlite',
            userVersion: SQLITE_DIRECT_VSCODE_FILE_STATE_USER_VERSION,
            legacyImports: 0,
            legacySources: 0,
            legacyClaims: 0,
        });
        expect(meta.migrations).toEqual([{
            version: SQLITE_DIRECT_VSCODE_FILE_STATE_USER_VERSION,
            name: SQLITE_DIRECT_VSCODE_FILE_STATE_MIGRATION_NAME,
        }]);
        for (const column of [
            'legacy_capsule_id',
            'legacy_source_format',
            'legacy_source_digest',
            'legacy_import_claim_id',
        ]) {
            expect(meta[column]).toBeNull();
        }
    });

    it('keeps the full authority surface, pending edits included', async () => {
        const { database } = await open();
        const initial = await database.store.read('/a.csv');

        const committed = await database.store.compare_and_set('/a.csv', initial.revision, {
            pendingEdits: sheet_edits({ '1:2': 'draft' }),
            activeSheetIndex: 0,
        });

        expect(committed.type).toBe('committed');
        expect((await database.store.read('/a.csv')).state)
            .toMatchObject({ pendingEdits: sheet_edits({ '1:2': 'draft' }) });
        expect(typeof database.store.read_authority).toBe('function');
    });

    it('reopens the same database and finds the state a previous session committed', async () => {
        const first = await open();
        const initial = await first.database.store.read('/a.csv');
        await first.database.store.compare_and_set('/a.csv', initial.revision, {
            activeSheetIndex: 4,
        });
        await first.database.close();

        const second = await open();

        expect((await second.database.store.read('/a.csv')).state)
            .toMatchObject({ activeSheetIndex: 4 });
    });

    it('passes the deterministic identity, client kind, and busy timeout to the opener', async () => {
        const openStore = vi.fn(open_sqlite_file_state_store);

        await open({ openStore });

        expect(openStore).toHaveBeenCalledTimes(1);
        const [databasePath, options] = openStore.mock.calls[0];
        expect(databasePath).toBe(vscode_state_database_path(storageDirectory));
        expect(options).toMatchObject({
            identity: VSCODE_STATE_IDENTITY,
            clientKind: VSCODE_STATE_CLIENT_KIND,
            clientVersion: '0.7.0',
            requiresPendingEditRecovery: false,
            timeoutMs: 5_000,
        });
        expect(options.migration.appVersion).toBe('0.7.0');
    });

    it('forwards the caller-supplied retention limit to the opened store', async () => {
        const openStore = vi.fn(open_sqlite_file_state_store);
        const getMaxStoredFiles = () => 7;

        await open({ openStore, getMaxStoredFiles });

        expect(openStore.mock.calls[0][2]).toBe(getMaxStoredFiles);
    });

    it('closes the underlying store exactly once however many times close is called', async () => {
        const close = vi.fn(async () => undefined);
        const openStore = vi.fn(async () => ({
            store: {} as never,
            persistence: {} as never,
            close,
        }));

        const { database } = await open({ openStore });
        await Promise.all([database.close(), database.close()]);
        await database.close();

        expect(close).toHaveBeenCalledTimes(1);
    });
});

describe('VS Code state database open failure', () => {
    it('rejects with the database path and the underlying cause', async () => {
        const cause = new Error('open refused');
        const openStore = vi.fn(async () => { throw cause; });

        const failure = await open({ openStore }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        const error = failure as Error;
        expect(error.message).toContain(vscode_state_database_path(storageDirectory));
        expect(error.message).toContain('open refused');
        // The cause is attached, not summarized away: whatever classified the
        // backend failure stays reachable for anything that wants to inspect it.
        expect(error.cause).toBe(cause);
    });

    it('tells the user what to do without promising to do it for them', async () => {
        const message = vscode_state_open_failure_message('/profile/state/file-state.sqlite3', new Error('database is locked'));

        expect(message).toContain('/profile/state/file-state.sqlite3');
        expect(message).toContain('database is locked');
        expect(message).toMatch(/Close any other windows/);
        expect(message).toMatch(/move\s+that file aside/);
        expect(message).toMatch(/will not\s+modify or delete it/);
    });

    it('reports a non-Error rejection without losing it', async () => {
        const openStore = vi.fn(async () => { throw 'refused as a string'; });

        const failure = await open({ openStore }).catch((error: unknown) => error) as Error;

        expect(failure.message).toContain('refused as a string');
        expect(failure.cause).toBe('refused as a string');
    });

    it('leaves an unreadable database exactly where the user left it', async () => {
        const databasePath = vscode_state_database_path(storageDirectory);
        // A file that is not a Table Viewer database at all: the open must fail and
        // the bytes must still be exactly where the user left them afterwards.
        await fs.promises.writeFile(databasePath, 'not a database');

        const failure = await open().catch((error: unknown) => error) as Error;

        expect(failure.message).toContain(databasePath);
        expect(await fs.promises.readFile(databasePath, 'utf8')).toBe('not a database');
        // Only the coordination gate directory may appear beside it; no quarantine
        // copy, renamed member, or replacement database.
        expect((await fs.promises.readdir(storageDirectory)).filter(
            (entry) => !entry.endsWith('.recovery-gate'),
        )).toEqual([VSCODE_STATE_DATABASE_NAME]);
    });

    it('surfaces a runtime failure after a successful open', async () => {
        const { database } = await open();
        await database.close();

        // Post-open read/write failures belong to the caller, exactly as on desktop.
        await expect(database.store.read('/a.csv')).rejects.toThrow();
    });
});
