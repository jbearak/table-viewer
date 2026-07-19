import type {
    FileStateCompareAndSetResult,
    FileStateSnapshot,
    FileStateStore,
} from '../../state';
import type { PerFileState, StoredPerFileState } from '../../types';

export function versioned_state_store(initial: StoredPerFileState = {}) {
    const states = new Map<string, StoredPerFileState>();
    const revisions = new Map<string, number>();

    const snapshot = (file_path: string): FileStateSnapshot => ({
        state: structuredClone(states.get(file_path) ?? initial),
        revision: revisions.get(file_path) ?? 0,
    });

    const store: FileStateStore = {
        async read(file_path) {
            return snapshot(file_path);
        },
        async compare_and_set(
            file_path,
            expected_revision,
            state,
        ): Promise<FileStateCompareAndSetResult> {
            const current = snapshot(file_path);
            if (current.revision !== expected_revision) {
                return { type: 'conflict', snapshot: current };
            }
            const revision = expected_revision + 1;
            states.set(file_path, structuredClone(state));
            revisions.set(file_path, revision);
            return {
                type: 'committed',
                snapshot: { state: structuredClone(state), revision },
            };
        },
        async touch() {},
    };

    return {
        store,
        get_state(file_path: string): PerFileState {
            return structuredClone(states.get(file_path) ?? initial) as PerFileState;
        },
        revision(file_path: string): number {
            return revisions.get(file_path) ?? 0;
        },
    };
}
