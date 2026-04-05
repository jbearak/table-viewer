import type { ExtensionContext } from 'vscode';
import type { PerFileState, StoredPerFileState } from './types';

const STATE_KEY = 'tableViewer.fileState';
export const DEFAULT_MAX_STORED_FILES = 10_000;

type StoredStateMap = Record<string, StoredPerFileState>;

export interface FileStateStore {
    get(file_path: string): StoredPerFileState;
    set(file_path: string, state: PerFileState): Promise<void>;
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

    return {
        get(file_path: string): StoredPerFileState {
            const all = get_all_state(context);
            return all[file_path] ?? {};
        },

        async set(
            file_path: string,
            state: PerFileState
        ): Promise<void> {
            pending_write = pending_write
                .catch(() => {})
                .then(async () => {
                    const all = get_all_state(context);
                    delete all[file_path];
                    all[file_path] = state;
                    evict_excess(all, get_max());
                    await context.globalState.update(
                        STATE_KEY,
                        all
                    );
                });
            await pending_write;
        },
    };
}
