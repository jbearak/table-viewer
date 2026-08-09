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
    readonly appVersion: string;
    readonly getMaxStoredFiles?: () => number;
    readonly sqlite?: VscodeSqliteOptions;
    /** Test seam; production callers use the shared SQLite store opener. */
    readonly openStore?: typeof open_sqlite_file_state_store;
}

export interface OpenedVscodeStateDatabase {
    readonly databasePath: string;
    readonly store: AuthorityFileStateStore;
    close(): Promise<void>;
}

/**
 * What the user is told, and what they can do about it.
 *
 * Names the database so it can be inspected or moved aside by hand, and keeps the
 * underlying cause verbatim rather than replacing it with a summary — the cause is
 * what distinguishes a database another window still holds from one that is
 * genuinely damaged, and those have different remedies.
 */
export function vscode_state_open_failure_message(
    databasePath: string,
    cause: unknown,
): string {
    const detail = cause instanceof Error && cause.message.length > 0
        ? cause.message
        : String(cause);
    return `Table Viewer could not open its state database at ${databasePath}: ${detail}. `
        + 'Close any other windows using it and reload. If the problem persists, move '
        + 'that file aside and reload to start with fresh state. Table Viewer will not '
        + 'modify or delete it for you.';
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
 * There is no second backend. An open or validation failure propagates so
 * activation fails visibly, carrying the path and the original cause; nothing on
 * disk is modified, deleted, or set aside, because a database this build cannot
 * read may still be readable by another and the user is the only one who should
 * decide to give up on it. Runtime read/write failures after a successful open
 * stay visible to callers, exactly as they do on the desktop.
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
    } catch (error) {
        // Rethrown with the path and the original cause attached, never swallowed
        // and never replaced: `cause` keeps the backend's own category and stage
        // available to anything that wants to classify the failure.
        throw new Error(vscode_state_open_failure_message(databasePath, error), { cause: error });
    }

    let closePromise: Promise<void> | undefined;
    return {
        databasePath,
        store: opened.store,
        close() {
            closePromise ??= opened.close();
            return closePromise;
        },
    };
}
