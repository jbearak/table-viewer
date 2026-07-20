import type { ExtensionContext } from 'vscode';
import type { PerFileState, StoredPerFileState } from './types';

const STATE_KEY = 'tableViewer.fileState';
const STATE_FORMAT = 'tableViewer.fileState.v1';
const MAX_STAGES_PER_ENTRY = 8;
const STALE_STAGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_STORED_FILES = 10_000;

export interface FileStateSnapshot {
    state: StoredPerFileState;
    revision: number;
}

export interface DurableFileAuthority {
commitSequence: number;
authorityRevision: number;
physicalRevision: number;
projectionRevision: number;
physicalDigest?: string;
}

export type AuthorityTransactionKind = 'physical' | 'projection';

export interface AuthorityTransactionStageInput {
id: string;
kind: AuthorityTransactionKind;
ordinal: number;
expectedStateRevision: number;
expectedCommitSequence: number;
nextState?: PerFileState;
physicalDigest?: string;
}

export type AuthorityTransactionStageResult =
    | { type: 'staged' }
    | { type: 'conflict'; snapshot: FileStateSnapshot; authority: DurableFileAuthority };

export interface AuthorityTransactionInspection {
    snapshot: FileStateSnapshot;
    authority: DurableFileAuthority;
    stagePresent: boolean;
}

export type AuthorityTransactionFinalizeResult =
    | { type: 'finalized'; snapshot: FileStateSnapshot; authority: DurableFileAuthority }
    | { type: 'conflict'; snapshot: FileStateSnapshot; authority: DurableFileAuthority };

export type FileStateCompareAndSetResult =
    | { type: 'committed'; snapshot: FileStateSnapshot }
    | { type: 'conflict'; snapshot: FileStateSnapshot };

export interface FileStateStore {
    read(file_path: string): Promise<FileStateSnapshot>;
    compare_and_set(
        file_path: string,
        expected_revision: number,
        state: PerFileState,
        validate?: () => boolean,
    ): Promise<FileStateCompareAndSetResult>;
    canonicalize_path?(
        canonical_path: string,
        canonical_key: (file_path: string) => string,
    ): Promise<void>;
    touch(file_path: string): Promise<void>;
}

export interface AuthorityFileStateStore extends FileStateStore {
    read_authority(file_path: string): Promise<DurableFileAuthority>;
    stage_authority_transaction(
        file_path: string,
        stage: AuthorityTransactionStageInput,
    ): Promise<AuthorityTransactionStageResult>;
    finalize_authority_transaction(
        file_path: string,
        stage_id: string,
    ): Promise<AuthorityTransactionFinalizeResult>;
    inspect_authority_transaction(
        file_path: string,
        stage_id: string,
    ): Promise<AuthorityTransactionInspection>;
    discard_authority_transaction(file_path: string, stage_id: string): Promise<void>;
    cleanup_authority_transactions(file_path: string, now?: number): Promise<void>;
}

interface PersistedAuthorityStage extends AuthorityTransactionStageInput {
    createdAt: number;
}

interface PersistedEntry {
    revision: number;
    state: StoredPerFileState;
    authority?: DurableFileAuthority;
    stages?: Record<string, PersistedAuthorityStage>;
}

interface PersistedStateEnvelope {
    format: typeof STATE_FORMAT;
    nextRevision: number;
    absenceRevision: number;
    entries: Record<string, PersistedEntry>;
}

type LegacyStoredStateMap = Record<string, StoredPerFileState>;
const pending_by_memento = new WeakMap<object, Promise<unknown>>();

function empty_authority(): DurableFileAuthority {
    return {
        commitSequence: 0,
        authorityRevision: 0,
        physicalRevision: 0,
        projectionRevision: 0,
    };
}

function authority_for(entry: PersistedEntry | undefined): DurableFileAuthority {
    return structuredClone(entry?.authority ?? empty_authority());
}

function is_envelope(value: unknown): value is PersistedStateEnvelope {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && (value as { format?: unknown }).format === STATE_FORMAT
        && !!(value as { entries?: unknown }).entries
        && typeof (value as { entries?: unknown }).entries === 'object';
}

function get_all_state(context: ExtensionContext): PersistedStateEnvelope {
    const stored = context.globalState.get<unknown>(STATE_KEY, {});
    if (is_envelope(stored)) {
        const persisted = structuredClone(stored) as PersistedStateEnvelope & {
            tombstones?: Record<string, number>;
            absenceRevision?: number;
        };
        const absenceRevision = Math.max(
            persisted.absenceRevision ?? 0,
            0,
            ...Object.values(persisted.tombstones ?? {}),
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
    return { format: STATE_FORMAT, nextRevision: 1, absenceRevision: 0, entries };
}

function snapshot_for(all: PersistedStateEnvelope, file_path: string): FileStateSnapshot {
    const entry = all.entries[file_path];
    return entry
        ? { state: structuredClone(entry.state), revision: entry.revision }
        : { state: {}, revision: all.absenceRevision };
}

function allocate_revision(all: PersistedStateEnvelope): number {
    return all.nextRevision++;
}

function ensure_entry(all: PersistedStateEnvelope, file_path: string): PersistedEntry {
    return all.entries[file_path] ??= {
        revision: all.absenceRevision,
        state: {},
        authority: empty_authority(),
    };
}

function evict_excess(all: PersistedStateEnvelope, max: number): void {
    const keys = Object.keys(all.entries);
    const count = keys.length - max;
    if (count <= 0) return;
    for (let index = 0; index < count; index++) delete all.entries[keys[index]];
    all.absenceRevision = allocate_revision(all);
}

function states_equal(left: StoredPerFileState, right: StoredPerFileState): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function create_file_state_store(
    context: ExtensionContext,
    get_max_stored?: () => number,
): AuthorityFileStateStore {
    const get_max = get_max_stored ?? (() => DEFAULT_MAX_STORED_FILES);
    const memento = context.globalState as object;
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const pending = pending_by_memento.get(memento) ?? Promise.resolve();
        const result = pending.catch(() => {}).then(operation);
        pending_by_memento.set(memento, result);
        return result;
    };

    return {
        read(file_path) {
            return enqueue(async () => snapshot_for(get_all_state(context), file_path));
        },

        compare_and_set(file_path, expected_revision, state, validate) {
            const next = structuredClone(state);
            return enqueue(async () => {
                const all = get_all_state(context);
                const current = snapshot_for(all, file_path);
                const valid = validate?.();
                if (
                    current.revision !== expected_revision
                    || (valid !== undefined && valid !== true)
                ) return { type: 'conflict', snapshot: current };
                const existing = all.entries[file_path];
                const entry: PersistedEntry = {
                    revision: allocate_revision(all),
                    state: next,
                    authority: authority_for(existing),
                    stages: structuredClone(existing?.stages),
                };
                delete all.entries[file_path];
                all.entries[file_path] = entry;
                evict_excess(all, get_max());
                await context.globalState.update(STATE_KEY, all);
                return {
                    type: 'committed',
                    snapshot: { state: structuredClone(next), revision: entry.revision },
                };
            });
        },

        read_authority(file_path) {
            return enqueue(async () => authority_for(get_all_state(context).entries[file_path]));
        },

        stage_authority_transaction(file_path, input) {
            const stage = structuredClone({ ...input, createdAt: Date.now() });
            return enqueue(async () => {
                const all = get_all_state(context);
                const current = snapshot_for(all, file_path);
                const entry = ensure_entry(all, file_path);
                const authority = authority_for(entry);
                if (
                    current.revision !== input.expectedStateRevision
                    || authority.commitSequence !== input.expectedCommitSequence
                ) return { type: 'conflict', snapshot: current, authority };
                const stages = entry.stages ??= {};
                stages[input.id] = stage;
                const ordered = Object.values(stages)
                    .sort((left, right) => left.createdAt - right.createdAt);
                while (ordered.length > MAX_STAGES_PER_ENTRY) {
                    delete stages[ordered.shift()!.id];
                }
                await context.globalState.update(STATE_KEY, all);
                return { type: 'staged' };
            });
        },

        finalize_authority_transaction(file_path, stage_id) {
            return enqueue(async () => {
                const all = get_all_state(context);
                const entry = all.entries[file_path];
                const current = snapshot_for(all, file_path);
                const authority = authority_for(entry);
                const stage = entry?.stages?.[stage_id];
                if (
                    !entry
                    || !stage
                    || current.revision !== stage.expectedStateRevision
                    || authority.commitSequence !== stage.expectedCommitSequence
                ) return { type: 'conflict', snapshot: current, authority };

                const next_authority: DurableFileAuthority = {
                    ...authority,
                    commitSequence: authority.commitSequence + 1,
                };
                if (stage.kind === 'projection') {
                    next_authority.projectionRevision += 1;
                    next_authority.authorityRevision += 1;
                } else if (authority.physicalDigest !== stage.physicalDigest) {
                    next_authority.physicalRevision += 1;
                    next_authority.authorityRevision += 1;
                    if (stage.physicalDigest === undefined) {
                        delete (next_authority as { physicalDigest?: string }).physicalDigest;
                    } else {
                        (next_authority as { physicalDigest?: string }).physicalDigest = stage.physicalDigest;
                    }
                }
                const next_state = stage.nextState ?? entry.state;
                const state_changed = !states_equal(entry.state, next_state);
                entry.state = structuredClone(next_state);
                if (state_changed) entry.revision = allocate_revision(all);
                entry.authority = next_authority;
                delete entry.stages![stage_id];
                if (Object.keys(entry.stages!).length === 0) delete entry.stages;
                delete all.entries[file_path];
                all.entries[file_path] = entry;
                evict_excess(all, get_max());
                await context.globalState.update(STATE_KEY, all);
                return {
                    type: 'finalized',
                    snapshot: { state: structuredClone(entry.state), revision: entry.revision },
                    authority: structuredClone(next_authority),
                };
            });
        },

        inspect_authority_transaction(file_path, stage_id) {
            return enqueue(async () => {
                const all = get_all_state(context);
                const entry = all.entries[file_path];
                return {
                    snapshot: snapshot_for(all, file_path),
                    authority: authority_for(entry),
                    stagePresent: !!entry?.stages?.[stage_id],
                };
            });
        },

        discard_authority_transaction(file_path, stage_id) {
            return enqueue(async () => {
                const all = get_all_state(context);
                const entry = all.entries[file_path];
                if (!entry?.stages?.[stage_id]) return;
                delete entry.stages[stage_id];
                if (Object.keys(entry.stages).length === 0) delete entry.stages;
                await context.globalState.update(STATE_KEY, all);
            });
        },

        cleanup_authority_transactions(file_path, now = Date.now()) {
            return enqueue(async () => {
                const all = get_all_state(context);
                const entry = all.entries[file_path];
                if (!entry?.stages) return;
                let changed = false;
                for (const [id, stage] of Object.entries(entry.stages)) {
                    if (now - stage.createdAt > STALE_STAGE_MS) {
                        delete entry.stages[id];
                        changed = true;
                    }
                }
                if (!changed) return;
                if (Object.keys(entry.stages).length === 0) delete entry.stages;
                await context.globalState.update(STATE_KEY, all);
            });
        },

        canonicalize_path(canonical_path, canonical_key) {
            return enqueue(async () => {
                const all = get_all_state(context);
                const aliases = Object.keys(all.entries).filter((key) => (
                    key !== canonical_path && canonical_key(key) === canonical_path
                ));
                if (aliases.length === 0) return;
                const candidates = [canonical_path, ...aliases]
                    .map((key) => all.entries[key])
                    .filter((entry): entry is PersistedEntry => !!entry);
                const durable = candidates.filter((entry) => (
                    authority_for(entry).commitSequence > 0
                ));
                const winner = (durable.length > 0 ? durable : candidates)
                    .reduce((left, right) => {
                        if (durable.length > 0) {
                            return authority_for(right).commitSequence
                                > authority_for(left).commitSequence ? right : left;
                        }
                        return right.revision > left.revision ? right : left;
                    });
                const canonical = structuredClone(winner);
                canonical.stages = undefined;
                all.entries[canonical_path] = canonical;
                for (const alias of aliases) delete all.entries[alias];
                all.absenceRevision = allocate_revision(all);
                await context.globalState.update(STATE_KEY, all);
            });
        },

        touch(file_path) {
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
