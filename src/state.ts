import type { ExtensionContext } from 'vscode';
import type { PerFileState, StoredPerFileState } from './types';

const STATE_KEY = 'tableViewer.fileState';
export const DEFAULT_MAX_STORED_FILES = 10_000;

type StoredStateMap = Record<string, StoredPerFileState>;

export type FileStateTransactionDecision =
    | { type: 'abort' }
    | { type: 'accept' }
    | { type: 'commit'; state: PerFileState };

export interface FileStateStore {
    get(file_path: string): StoredPerFileState;
    set(file_path: string, state: PerFileState): Promise<void>;
    /** Serialized read-modify-write used when several panels own disjoint fields. */
    update?(
        file_path: string,
        updater: (current: StoredPerFileState) => PerFileState,
    ): Promise<void>;
    /** Serialized asynchronous conditional update. An abort/accept decision does
     *  not write global state; commit writes exactly the returned state. */
    transaction?(
        file_path: string,
        decide: (
            current: StoredPerFileState,
        ) => Promise<FileStateTransactionDecision>,
    ): Promise<FileStateTransactionDecision['type']>;
}

function get_all_state(
    context: ExtensionContext
): StoredStateMap {
    const stored = context.globalState.get<unknown>(STATE_KEY, {});
    if (!stored || typeof stored !== 'object') return {};
    return stored as StoredStateMap;
}

function evict_excess(
    map: StoredStateMap,
    max: number
): void {
    const keys = Object.keys(map);
    const evict_count = keys.length - max;
    for (let i = 0; i < evict_count; i++) {
        delete map[keys[i]];
    }
}

export function create_file_state_store(
    context: ExtensionContext,
    get_max_stored?: () => number
): FileStateStore {
    const get_max = get_max_stored
        ?? (() => DEFAULT_MAX_STORED_FILES);
    let pending_write: Promise<void> = Promise.resolve();

    const enqueue = (operation: () => Promise<void>): Promise<void> => {
        pending_write = pending_write.catch(() => {}).then(operation);
        return pending_write;
    };

    const update = (
        file_path: string,
        updater: (current: StoredPerFileState) => PerFileState,
    ): Promise<void> => enqueue(async () => {
        const all = get_all_state(context);
        const next = updater(all[file_path] ?? {});
        delete all[file_path];
        all[file_path] = next;
        evict_excess(all, get_max());
        await context.globalState.update(STATE_KEY, all);
    });

    const transaction = async (
        file_path: string,
        decide: (
            current: StoredPerFileState,
        ) => Promise<FileStateTransactionDecision>,
    ): Promise<FileStateTransactionDecision['type']> => {
        let result: FileStateTransactionDecision['type'] = 'abort';
        await enqueue(async () => {
            const all = get_all_state(context);
            const decision = await decide(all[file_path] ?? {});
            result = decision.type;
            if (decision.type !== 'commit') return;
            delete all[file_path];
            all[file_path] = decision.state;
            evict_excess(all, get_max());
            await context.globalState.update(STATE_KEY, all);
        });
        return result;
    };

    return {
        get(file_path: string): StoredPerFileState {
            const all = get_all_state(context);
            const value = all[file_path];
            if (value !== undefined) {
                // Touch recency on every successful read. Re-read inside the
                // serialized operation so a queued write cannot be overwritten
                // by the snapshot returned synchronously to this caller.
                void enqueue(async () => {
                    const latest = get_all_state(context);
                    const current = latest[file_path];
                    if (current === undefined) return;
                    delete latest[file_path];
                    latest[file_path] = current;
                    await context.globalState.update(STATE_KEY, latest);
                }).catch(() => {});
            }
            return value ?? {};
        },

        async set(
            file_path: string,
            state: PerFileState
        ): Promise<void> {
            await update(file_path, () => state);
        },

        update,
        transaction,
    };
}
