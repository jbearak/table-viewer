import * as fs from 'fs';
import * as path from 'path';
import {
    create_authority_store,
    type AuthorityFileStateStore,
    type FileStatePersistenceMedium,
} from './state';

/**
 * Stable on-disk file name for the desktop state blob. The name carries the
 * envelope format id so the layout is self-describing and versioned from day
 * one (see plan: `userData/state/tableViewer.fileState.v1.json`).
 */
export const JSON_STATE_FILE_NAME = 'tableViewer.fileState.v1.json';

/** Conventional location of the state blob under an app data directory. */
export function json_state_file_path(user_data_dir: string): string {
    return path.join(user_data_dir, 'state', JSON_STATE_FILE_NAME);
}

interface SharedFileMedium {
    readonly runtime_key: object;
    cache: unknown;
    loaded: boolean;
}

/**
 * One shared runtime per resolved blob path so multiple stores over the same
 * file serialize their operations and share leases, mirroring how VS Code
 * stores share a Memento. Single-writer per process (v1 constraint).
 */
const media_by_path = new Map<string, SharedFileMedium>();

let temp_counter = 0;

/**
 * Create an `AuthorityFileStateStore` persisting the `tableViewer.fileState.v1`
 * envelope as JSON at `state_file_path`. Semantics (CAS, authority stages,
 * leases, LRU, timestamps) are identical to the VS Code Memento backend; only
 * the persistence medium differs.
 *
 * Writes are atomic (temp file + rename). A missing or unreadable file is
 * treated as an empty store; the first durable write recreates it.
 */
export function create_json_file_state_store(
    state_file_path: string,
    get_max_stored?: () => number,
): AuthorityFileStateStore {
    const resolved = path.resolve(state_file_path);
    let shared = media_by_path.get(resolved);
    if (!shared) {
        shared = { runtime_key: {}, cache: undefined, loaded: false };
        media_by_path.set(resolved, shared);
    }
    const state = shared;
    const medium: FileStatePersistenceMedium = {
        runtime_key: state.runtime_key,
        read() {
            if (!state.loaded) {
                try {
                    state.cache = JSON.parse(fs.readFileSync(resolved, 'utf8'));
                } catch {
                    // Missing, unreadable, or corrupt blob: start empty. The
                    // next durable write atomically replaces the file.
                    state.cache = undefined;
                }
                state.loaded = true;
            }
            return state.cache ?? {};
        },
        async write(envelope) {
            const serialized = JSON.stringify(envelope);
            await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
            const temp = `${resolved}.${process.pid}.${temp_counter++}.tmp`;
            try {
                await fs.promises.writeFile(temp, serialized, 'utf8');
                await fs.promises.rename(temp, resolved);
            } catch (error) {
                await fs.promises.rm(temp, { force: true }).catch(() => {});
                throw error;
            }
            // Cache only after the rename succeeds so a failed write leaves
            // the visible state untouched (same guarantee as the Memento
            // backend). Parse the serialized form so the cache is exactly
            // what a re-read from disk would produce.
            state.cache = JSON.parse(serialized);
            state.loaded = true;
        },
    };
    return create_authority_store(medium, get_max_stored);
}
