import type { ExtensionContext } from 'vscode';
import type { PerFileState, StoredPerFileState } from './types';

const STATE_KEY = 'tableViewer.fileState';
const STATE_FORMAT = 'tableViewer.fileState.v1';
export const DEFAULT_MAX_STORED_FILES = 10_000;

export interface FileStateSnapshot {
    state: StoredPerFileState;
    /** Semantic state revision. Legacy bare entries decode as revision zero. */
    revision: number;
}

export type FileStateCompareAndSetResult =
    | { type: 'committed'; snapshot: FileStateSnapshot }
    | { type: 'conflict'; snapshot: FileStateSnapshot };

export interface FileStateStore {
    /** Linearized read of state and its semantic revision. Does not touch LRU recency. */
    read(file_path: string): Promise<FileStateSnapshot>;
    /** Commit only when the semantic revision still matches `expected_revision`. */
    compare_and_set(
        file_path: string,
        expected_revision: number,
        state: PerFileState,
    ): Promise<FileStateCompareAndSetResult>;
    /** Move an existing entry to the newest LRU position without changing revision. */
    touch(file_path: string): Promise<void>;
}

interface PersistedEntry {
    revision: number;
    state: StoredPerFileState;
}

interface PersistedStateEnvelope {
    format: typeof STATE_FORMAT;
    /** Monotonic allocator shared by entry and absence generations. */
    nextRevision: number;
    /** Basis returned for every currently absent path. Bounded ABA protection. */
    absenceRevision: number;
    entries: Record<string, PersistedEntry>;
}

type LegacyStoredStateMap = Record<string, StoredPerFileState>;

// Production constructs one store, but sharing the queue by backing Memento also
// keeps additional in-process store instances from racing whole-envelope writes.
const pending_by_memento = new WeakMap<object, Promise<unknown>>();

function is_envelope(value: unknown): value is PersistedStateEnvelope {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && (value as { format?: unknown }).format === STATE_FORMAT
        && !!(value as { entries?: unknown }).entries
        && typeof (value as { entries?: unknown }).entries === 'object'
        && !Array.isArray((value as { entries?: unknown }).entries);
}

function get_all_state(context: ExtensionContext): PersistedStateEnvelope {
    const stored = context.globalState.get<unknown>(STATE_KEY, {});
    if (is_envelope(stored)) {
        const persisted = structuredClone(stored) as PersistedStateEnvelope & {
            tombstones?: Record<string, number>;
            absenceRevision?: number;
        };
        const legacy_absence = Math.max(
            0,
            ...Object.values(persisted.tombstones ?? {}),
        );
        const absenceRevision = Math.max(
            persisted.absenceRevision ?? 0,
            legacy_absence,
        );
        const nextRevision = Math.max(
            persisted.nextRevision ?? 1,
            absenceRevision + 1,
            ...Object.values(persisted.entries).map((entry) => entry.revision + 1),
        );
        return {
            format: STATE_FORMAT,
            nextRevision,
            absenceRevision,
            entries: persisted.entries,
        };
    }
    const entries: Record<string, PersistedEntry> = {};
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [file_path, state] of Object.entries(stored as LegacyStoredStateMap)) {
            entries[file_path] = { revision: 0, state };
        }
    }
    return {
        format: STATE_FORMAT,
        nextRevision: 1,
        absenceRevision: 0,
        entries,
    };
}

function snapshot_for(
    envelope: PersistedStateEnvelope,
    file_path: string,
): FileStateSnapshot {
    const entry = envelope.entries[file_path];
    return entry
        ? { state: structuredClone(entry.state), revision: entry.revision }
        : { state: {}, revision: envelope.absenceRevision };
}

function allocate_revision(envelope: PersistedStateEnvelope): number {
    const revision = envelope.nextRevision;
    envelope.nextRevision += 1;
    return revision;
}

function evict_excess(
    envelope: PersistedStateEnvelope,
    max: number,
): void {
    const keys = Object.keys(envelope.entries);
    const evict_count = keys.length - max;
    if (evict_count <= 0) return;
    for (let i = 0; i < evict_count; i++) delete envelope.entries[keys[i]];
    // One bounded generation invalidates every outstanding absent snapshot.
    // Harmless unrelated conflicts are preferable to retaining path tombstones.
    envelope.absenceRevision = allocate_revision(envelope);
}

export function create_file_state_store(
    context: ExtensionContext,
    get_max_stored?: () => number,
): FileStateStore {
    const get_max = get_max_stored ?? (() => DEFAULT_MAX_STORED_FILES);
    const memento = context.globalState as object;

    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const pending = pending_by_memento.get(memento) ?? Promise.resolve();
        const result = pending.catch(() => {}).then(operation);
        pending_by_memento.set(memento, result);
        return result;
    };

    return {
        read(file_path: string): Promise<FileStateSnapshot> {
            return enqueue(async () => snapshot_for(get_all_state(context), file_path));
        },

        compare_and_set(
            file_path: string,
            expected_revision: number,
            state: PerFileState,
        ): Promise<FileStateCompareAndSetResult> {
            const next_state = structuredClone(state);
            return enqueue(async () => {
                const all = get_all_state(context);
                const current = snapshot_for(all, file_path);
                if (current.revision !== expected_revision) {
                    return { type: 'conflict', snapshot: current };
                }
                const revision = allocate_revision(all);
                delete all.entries[file_path];
                all.entries[file_path] = { revision, state: next_state };
                evict_excess(all, get_max());
                await context.globalState.update(STATE_KEY, all);
                return {
                    type: 'committed',
                    snapshot: { state: structuredClone(next_state), revision },
                };
            });
        },

        touch(file_path: string): Promise<void> {
            return enqueue(async () => {
                const all = get_all_state(context);
                const current = all.entries[file_path];
                if (!current) return;
                delete all.entries[file_path];
                all.entries[file_path] = current;
                await context.globalState.update(STATE_KEY, all);
            });
        },
    };
}
