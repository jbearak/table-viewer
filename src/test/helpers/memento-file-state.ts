import type { ExtensionContext } from 'vscode';
import {
    create_authority_store,
    create_keyed_file_state_persistence,
    type AuthorityFileStateStore,
    type FileStatePersistenceMedium,
    type KeyedFileStatePersistence,
} from '../../state';

/**
 * A Memento-shaped persistence medium, for tests only.
 *
 * Production has exactly one backend — the SQLite database opened in
 * `src/vscode-state-database.ts` — so this no longer lives in `src/state.ts`.
 * It survives here because a single-JSON-blob medium is the cheapest way to
 * exercise the store and keyed-persistence layers directly: the whole persisted
 * envelope is one inspectable value, and a write can be made to fail on demand.
 * Nothing about the medium is VS Code-specific beyond the shape of the object the
 * existing tests already build.
 */
const TEST_STATE_KEY = 'tableViewer.fileState';

export function memento_medium(context: ExtensionContext): FileStatePersistenceMedium {
    const memento = context.globalState;
    return {
        runtime_key: memento as object,
        read: () => memento.get<unknown>(TEST_STATE_KEY, {}),
        write: async (envelope) => {
            await memento.update(TEST_STATE_KEY, envelope);
        },
    };
}

export function create_memento_keyed_file_state_persistence(
    context: ExtensionContext,
): KeyedFileStatePersistence {
    return create_keyed_file_state_persistence(memento_medium(context));
}

export function create_memento_file_state_store(
    context: ExtensionContext,
    get_max_stored?: () => number,
): AuthorityFileStateStore {
    return create_authority_store(memento_medium(context), get_max_stored);
}
