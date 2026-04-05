import type { ExtensionContext } from 'vscode';
import type { PerFileState } from './types';

const STATE_KEY = 'tableViewer.fileState';
const MAX_STORED_FILES = 10_000;

type StoredStateMap = Record<string, PerFileState>;

export interface FileStateStore {
    get(file_path: string): PerFileState;
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
    context: ExtensionContext
): FileStateStore {
    let pending_write: Promise<void> = Promise.resolve();

    return {
        get(file_path: string): PerFileState {
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
                    evict_excess(all, MAX_STORED_FILES);
                    await context.globalState.update(
                        STATE_KEY,
                        all
                    );
                });
            await pending_write;
        },
    };
}
