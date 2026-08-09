import * as path from 'node:path';
import {
    open_sqlite_file_state_store,
    type SqliteFileStatePersistenceOptions,
} from './sqlite-file-state-persistence';
import type { SqliteDirectVscodeFileStateIdentity } from './sqlite-file-state-schema';
import type { AuthorityFileStateStore } from './state';

export const VSCODE_STATE_DATABASE_NAME = 'file-state.sqlite3';
export const VSCODE_STATE_DATABASE_ID = 'tableViewer.vscode.fileState.direct.v1';
export const VSCODE_STATE_CLIENT_PROFILE_ID = 'vscode-global-storage';
export const VSCODE_STATE_STORAGE_ENVIRONMENT_ID = 'vscode-global-storage';
export const VSCODE_STATE_CLIENT_KIND = 'vscode';
export const VSCODE_STATE_BUSY_TIMEOUT_MS = 5_000;

export const VSCODE_STATE_FALLBACK_WARNING =
    'Table Viewer could not open its state database and is storing per-file state '
    + 'in this VS Code profile instead. Editing still works and nothing is lost, but '
    + 'this window cannot coordinate edits with other Table Viewer products. '
    + 'Existing database files were left unchanged.';

/**
 * The global-storage directory VS Code hands the extension is already scoped by
 * profile and by remote authority, so the one canonical database beneath each
 * such root needs only one deterministic identity — no random database id and no
 * identity sidecar. The identity is `direct-vscode`: this database is created
 * empty and never imports a Memento, so its schema forbids legacy import rows
 * outright rather than leaving them nullable.
 */
export const VSCODE_STATE_IDENTITY: SqliteDirectVscodeFileStateIdentity = Object.freeze({
    productKind: 'vscode',
    schemaKind: 'direct-vscode',
    databaseId: VSCODE_STATE_DATABASE_ID,
    clientProfileId: VSCODE_STATE_CLIENT_PROFILE_ID,
    storageEnvironmentId: VSCODE_STATE_STORAGE_ENVIRONMENT_ID,
});

type VscodeSqliteOptions = Pick<
    SqliteFileStatePersistenceOptions,
    'supportedProtocol' | 'timeoutMs' | 'now' | 'randomId' | 'hooks' | 'initialization'
>;

export interface VscodeStateDatabaseOptions {
    readonly storageDirectory: string;
    /** Durable degraded medium used when the SQLite open cannot succeed. */
    readonly openFallbackStore: () => VscodeStateFallback;
    readonly appVersion: string;
    readonly getMaxStoredFiles?: () => number;
    readonly warn: (message: string) => void | Promise<void>;
    readonly sqlite?: VscodeSqliteOptions;
    /** Test seam; production callers use the shared SQLite store opener. */
    readonly openStore?: typeof open_sqlite_file_state_store;
}

export interface VscodeStateFallback {
    readonly store: AuthorityFileStateStore;
    /** Settle any queued writes; the degraded medium has its own write queue. */
    close(): Promise<void>;
}

export interface OpenedVscodeStateDatabase {
    readonly mode: 'sqlite' | 'fallback';
    readonly databasePath: string;
    readonly store: AuthorityFileStateStore;
    close(): Promise<void>;
}

export function vscode_state_database_path(storageDirectory: string): string {
    if (!path.isAbsolute(storageDirectory)) {
        throw new TypeError('The VS Code state storage directory must be absolute.');
    }
    return path.join(path.resolve(storageDirectory), VSCODE_STATE_DATABASE_NAME);
}

/**
 * Open (creating on first run) the extension's canonical file-state database.
 *
 * An initial open or validation failure selects the caller's durable degraded
 * store and warns the user, without modifying, deleting, or setting aside the
 * failed basename set — a database this host could not read may still be readable
 * by a newer build, and silently discarding it is worse than degrading. Runtime
 * read/write failures after a successful open stay visible to callers, exactly as
 * they do on the desktop.
 *
 * Falling back rather than refusing matters on Windows in particular, where the
 * backend declines SQLite outright because Node exposes no proven directory-entry
 * flush (see assert_sqlite_directory_durability_supported). The desktop can refuse
 * to start there; an editor extension cannot, so it degrades to a durable medium
 * that simply does not participate in cross-product coordination.
 */
export async function open_vscode_state_database(
    options: VscodeStateDatabaseOptions,
): Promise<OpenedVscodeStateDatabase> {
    const databasePath = vscode_state_database_path(options.storageDirectory);
    const now = options.sqlite?.now ?? Date.now;
    const openStore = options.openStore ?? open_sqlite_file_state_store;
    let opened: Awaited<ReturnType<typeof open_sqlite_file_state_store>>;
    try {
        opened = await openStore(databasePath, {
            identity: VSCODE_STATE_IDENTITY,
            migration: {
                appliedAtMs: now(),
                appVersion: options.appVersion,
            },
            clientKind: VSCODE_STATE_CLIENT_KIND,
            clientVersion: options.appVersion,
            supportedProtocol: options.sqlite?.supportedProtocol,
            // Pending edits in this database are this host's own; there is no
            // separate process whose recovery evidence they must be matched to.
            requiresPendingEditRecovery: false,
            timeoutMs: options.sqlite?.timeoutMs ?? VSCODE_STATE_BUSY_TIMEOUT_MS,
            now: options.sqlite?.now,
            randomId: options.sqlite?.randomId,
            hooks: options.sqlite?.hooks,
            initialization: options.sqlite?.initialization,
        }, options.getMaxStoredFiles);
    } catch {
        const fallback = options.openFallbackStore();
        try {
            const warning = options.warn(VSCODE_STATE_FALLBACK_WARNING);
            void Promise.resolve(warning).catch(() => undefined);
        } catch {
            // Warning delivery is best-effort; the degraded store remains usable.
        }
        return {
            mode: 'fallback',
            databasePath,
            store: fallback.store,
            close: () => fallback.close(),
        };
    }

    let closePromise: Promise<void> | undefined;
    return {
        mode: 'sqlite',
        databasePath,
        store: opened.store,
        close() {
            closePromise ??= opened.close();
            return closePromise;
        },
    };
}
