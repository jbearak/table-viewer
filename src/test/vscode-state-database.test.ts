import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    open_vscode_state_database,
    vscode_state_database_path,
    VSCODE_STATE_CLIENT_KIND,
    VSCODE_STATE_DATABASE_ID,
    VSCODE_STATE_DATABASE_NAME,
    VSCODE_STATE_FALLBACK_WARNING,
    VSCODE_STATE_IDENTITY,
    type OpenedVscodeStateDatabase,
} from '../vscode-state-database';
import { create_authority_store, type FileStatePersistenceMedium } from '../state';
import {
    is_direct_vscode_file_state_identity,
    SQLITE_DIRECT_VSCODE_FILE_STATE_FORMAT,
    SQLITE_DIRECT_VSCODE_FILE_STATE_MIGRATION_NAME,
    SQLITE_DIRECT_VSCODE_FILE_STATE_USER_VERSION,
} from '../sqlite-file-state-schema';
import { open_sqlite_file_state_store } from '../sqlite-file-state-persistence';

let storageDirectory: string;
let opened: OpenedVscodeStateDatabase[];

/** The durable degraded medium a host supplies; an object standing in for Memento. */
function fallback_fixture() {
    let envelope: unknown = {};
    const medium: FileStatePersistenceMedium = {
        runtime_key: {},
        read: () => envelope,
        write: async (next) => { envelope = next; },
    };
    let closed = 0;
    return {
        openCount: 0,
        closeCount: () => closed,
        inspect: () => envelope,
        open() {
            this.openCount += 1;
            return {
                store: create_authority_store(medium),
                close: async () => { closed += 1; },
            };
        },
    };
}

async function open(overrides: {
    readonly warn?: (message: string) => void | Promise<void>;
    readonly openStore?: typeof open_sqlite_file_state_store;
    readonly storageDirectory?: string;
    readonly openFallbackStore?: () => { store: any; close(): Promise<void> };
    readonly getMaxStoredFiles?: () => number;
} = {}, fallback = fallback_fixture()) {
    const warnings: string[] = [];
    const database = await open_vscode_state_database({
        storageDirectory: overrides.storageDirectory ?? storageDirectory,
        appVersion: '0.7.0',
        getMaxStoredFiles: overrides.getMaxStoredFiles,
        openFallbackStore: overrides.openFallbackStore ?? (() => fallback.open()),
        warn: overrides.warn ?? ((message) => { warnings.push(message); }),
        ...(overrides.openStore ? { openStore: overrides.openStore } : {}),
    });
    opened.push(database);
    return { database, warnings, fallback };
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
        const { database, warnings, fallback } = await open();

        expect(database.mode).toBe('sqlite');
        expect(database.databasePath).toBe(vscode_state_database_path(storageDirectory));
        expect(warnings).toEqual([]);
        expect(fallback.openCount).toBe(0);

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
            pendingEdits: { '1:2': 'draft' },
            activeSheetIndex: 0,
        });

        expect(committed.type).toBe('committed');
        expect((await database.store.read('/a.csv')).state)
            .toMatchObject({ pendingEdits: { '1:2': 'draft' } });
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

        expect(second.database.mode).toBe('sqlite');
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

describe('VS Code state database degraded fallback', () => {
    it('selects the durable fallback store and warns when the open fails', async () => {
        const openStore = vi.fn(async () => {
            throw new Error('open refused');
        });

        const { database, warnings, fallback } = await open({ openStore });

        expect(database.mode).toBe('fallback');
        expect(database.databasePath).toBe(vscode_state_database_path(storageDirectory));
        expect(warnings).toEqual([VSCODE_STATE_FALLBACK_WARNING]);
        expect(fallback.openCount).toBe(1);
    });

    it('leaves the failed basename set untouched rather than deleting or setting it aside', async () => {
        const databasePath = vscode_state_database_path(storageDirectory);
        // A file that is not a Table Viewer database at all: the open must fail and
        // the bytes must still be exactly where the user left them afterwards.
        await fs.promises.writeFile(databasePath, 'not a database');

        const { database, warnings } = await open();

        expect(database.mode).toBe('fallback');
        expect(warnings).toEqual([VSCODE_STATE_FALLBACK_WARNING]);
        expect(await fs.promises.readFile(databasePath, 'utf8')).toBe('not a database');
        // Only the coordination gate directory may appear beside it; no quarantine
        // copy, renamed member, or replacement database.
        expect((await fs.promises.readdir(storageDirectory)).filter(
            (entry) => !entry.endsWith('.recovery-gate'),
        )).toEqual([VSCODE_STATE_DATABASE_NAME]);
    });

    it('still reads and writes state through the fallback store', async () => {
        const openStore = vi.fn(async () => { throw new Error('open refused'); });

        const { database, fallback } = await open({ openStore });
        const initial = await database.store.read('/a.csv');
        await database.store.compare_and_set('/a.csv', initial.revision, { activeSheetIndex: 2 });

        expect((await database.store.read('/a.csv')).state)
            .toMatchObject({ activeSheetIndex: 2 });
        expect(fallback.inspect()).toMatchObject({ entries: expect.any(Object) });
    });

    it('closes the fallback store so its queued writes settle', async () => {
        const openStore = vi.fn(async () => { throw new Error('open refused'); });

        const { database, fallback } = await open({ openStore });
        await database.close();

        expect(fallback.closeCount()).toBe(1);
    });

    it('keeps the fallback usable when warning delivery throws', async () => {
        const openStore = vi.fn(async () => { throw new Error('open refused'); });

        const { database } = await open({
            openStore,
            warn: () => { throw new Error('no UI available'); },
        });

        expect(database.mode).toBe('fallback');
        const initial = await database.store.read('/a.csv');
        expect((await database.store.compare_and_set('/a.csv', initial.revision, {})).type)
            .toBe('committed');
    });

    it('keeps the fallback usable when an async warning rejects', async () => {
        const openStore = vi.fn(async () => { throw new Error('open refused'); });

        const { database } = await open({
            openStore,
            warn: async () => { throw new Error('dialog dismissed'); },
        });

        expect(database.mode).toBe('fallback');
        expect(await database.store.read('/a.csv')).toMatchObject({ revision: expect.any(Number) });
    });

    it('surfaces a runtime failure after a successful open instead of degrading', async () => {
        const { database } = await open();
        await database.close();

        // Post-open read/write failures belong to the caller, exactly as on desktop.
        await expect(database.store.read('/a.csv')).rejects.toThrow();
    });
});
