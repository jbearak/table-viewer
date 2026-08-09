import * as path from 'node:path';
import {
    open_sqlite_file_state_store,
    type SqliteFileStatePersistenceOptions,
} from './sqlite-file-state-persistence';
import {
    type SqliteDirectVscodeFileStateIdentity,
} from './sqlite-file-state-schema';
import {
    create_cosmetic_file_state_store,
    open_in_memory_cosmetic_file_state_store,
} from './cosmetic-file-state-store';
import type { FileStateStore } from './state';

export const VSCODE_COSMETIC_STATE_DATABASE_NAME = 'file-state.sqlite3';
export const VSCODE_COSMETIC_STATE_DATABASE_ID = 'tableViewer.vscode.fileState.direct.v1';
export const VSCODE_COSMETIC_STATE_CLIENT_PROFILE_ID = 'vscode-global-storage';
export const VSCODE_COSMETIC_STATE_STORAGE_ENVIRONMENT_ID = 'vscode-global-storage';
export const VSCODE_COSMETIC_STATE_CLIENT_KIND = 'vscode-cosmetic';
export const VSCODE_COSMETIC_STATE_BUSY_TIMEOUT_MS = 5_000;

export const VSCODE_COSMETIC_STATE_FALLBACK_WARNING =
    'Table Viewer could not open its SQLite settings database. '
    + 'This window will use temporary layout state. Existing database files were left unchanged.';

/**
 * The global-storage directory is already scoped by VS Code profile and remote
 * authority. One deterministic identity is therefore sufficient for the one
 * canonical database beneath each such root, without a second identity sidecar.
 */
export const VSCODE_COSMETIC_STATE_IDENTITY: SqliteDirectVscodeFileStateIdentity = Object.freeze({
    productKind: 'vscode',
    schemaKind: 'direct-vscode',
    databaseId: VSCODE_COSMETIC_STATE_DATABASE_ID,
    clientProfileId: VSCODE_COSMETIC_STATE_CLIENT_PROFILE_ID,
    storageEnvironmentId: VSCODE_COSMETIC_STATE_STORAGE_ENVIRONMENT_ID,
});

type CosmeticSqliteOptions = Pick<
    SqliteFileStatePersistenceOptions,
    'supportedProtocol' | 'timeoutMs' | 'now' | 'randomId' | 'hooks' | 'initialization'
>;

export interface VscodeCosmeticStateDatabaseOptions {
    readonly storageDirectory: string;
    readonly appVersion: string;
    readonly getMaxStoredFiles?: () => number;
    readonly warn: (message: string) => void | Promise<void>;
    readonly sqlite?: CosmeticSqliteOptions;
    /** Test seam; production callers use the shared SQLite store opener. */
    readonly openStore?: typeof open_sqlite_file_state_store;
}

export interface OpenedVscodeCosmeticStateDatabase {
    readonly mode: 'sqlite' | 'memory';
    readonly databasePath: string;
    readonly store: FileStateStore;
    close(): Promise<void>;
}

export function vscode_cosmetic_state_database_path(storageDirectory: string): string {
    if (!path.isAbsolute(storageDirectory)) {
        throw new TypeError('VS Code cosmetic state storage directory must be absolute.');
    }
    return path.join(path.resolve(storageDirectory), VSCODE_COSMETIC_STATE_DATABASE_NAME);
}

/**
 * Open the unwired direct VS Code cosmetic backend. Initial open/validation
 * failures select a fresh in-memory store without modifying or setting aside the
 * failed basename set. Runtime read/write failures remain visible to callers.
 */
export async function open_vscode_cosmetic_state_database(
    options: VscodeCosmeticStateDatabaseOptions,
): Promise<OpenedVscodeCosmeticStateDatabase> {
    const databasePath = vscode_cosmetic_state_database_path(options.storageDirectory);
    const now = options.sqlite?.now ?? Date.now;
    const openStore = options.openStore ?? open_sqlite_file_state_store;
    let opened: Awaited<ReturnType<typeof open_sqlite_file_state_store>>;
    try {
        opened = await openStore(databasePath, {
            identity: VSCODE_COSMETIC_STATE_IDENTITY,
            migration: {
                appliedAtMs: now(),
                appVersion: options.appVersion,
            },
            clientKind: VSCODE_COSMETIC_STATE_CLIENT_KIND,
            clientVersion: options.appVersion,
            supportedProtocol: options.sqlite?.supportedProtocol,
            requiresPendingEditRecovery: false,
            timeoutMs: options.sqlite?.timeoutMs ?? VSCODE_COSMETIC_STATE_BUSY_TIMEOUT_MS,
            now: options.sqlite?.now,
            randomId: options.sqlite?.randomId,
            hooks: options.sqlite?.hooks,
            initialization: {
                ...options.sqlite?.initialization,
                // This database contains only disposable cosmetic state and never
                // participates in pending-edit recovery. Windows may therefore use it
                // when Node cannot prove directory-entry durability; all other failures
                // still escape to the fresh in-memory fallback below.
                directoryDurabilityPolicy: 'best-effort',
            },
        }, options.getMaxStoredFiles);
    } catch {
        const fallback = open_in_memory_cosmetic_file_state_store(options.getMaxStoredFiles);
        try {
            const warning = options.warn(VSCODE_COSMETIC_STATE_FALLBACK_WARNING);
            void Promise.resolve(warning).catch(() => undefined);
        } catch {
            // Warning delivery is best-effort; the cosmetic fallback remains usable.
        }
        return {
            mode: 'memory',
            databasePath,
            store: fallback.store,
            close: () => fallback.close(),
        };
    }

    let closePromise: Promise<void> | undefined;
    return {
        mode: 'sqlite',
        databasePath,
        store: create_cosmetic_file_state_store(opened.store),
        close() {
            closePromise ??= opened.close();
            return closePromise;
        },
    };
}
