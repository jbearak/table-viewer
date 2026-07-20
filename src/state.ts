import type { ExtensionContext } from 'vscode';
import { compare_authority } from './authority-order';
import type { PerFileState, StoredPerFileState } from './types';

const STATE_KEY = 'tableViewer.fileState';
const STATE_FORMAT = 'tableViewer.fileState.v1';
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

export interface FileStateLease {
    release(): Promise<void>;
}

export type FileStateCopyResult =
    | {
        readonly type: 'copied';
        readonly source: FileStateSnapshot;
        readonly destination: FileStateSnapshot;
    }
    | {
        readonly type: 'sourceAbsent';
        readonly source: FileStateSnapshot;
        readonly destination: FileStateSnapshot;
    }
    | {
        readonly type: 'destinationExists';
        readonly destination: FileStateSnapshot;
    }
    | { readonly type: 'unsupported' };

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
    lease_entry?(
        canonical_path: string,
        canonical_key: (file_path: string) => string,
        copy_from_if_absent?: string,
        copy_id?: string,
    ): Promise<FileStateLease>;
    /** Atomically clone the complete persisted entry when destination is absent.
     * The source remains untouched because legacy fsPath ownership is ambiguous. */
    copy_entry_if_absent?(
        source_path: string,
        destination_path: string,
        copy_id: string,
    ): Promise<FileStateCopyResult>;
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
    copyProvenance?: {
        id: string;
        sourcePath: string;
        sourceRevision: number;
    };
}

interface PersistedStateEnvelope {
    format: typeof STATE_FORMAT;
    nextRevision: number;
    absenceRevision: number;
    entries: Record<string, PersistedEntry>;
}

interface StateRuntime {
    pending: Promise<unknown>;
    readonly leases: Map<string, number>;
}

type LegacyStoredStateMap = Record<string, StoredPerFileState>;
const runtime_by_memento = new WeakMap<object, StateRuntime>();

function runtime_for(memento: object): StateRuntime {
    let runtime = runtime_by_memento.get(memento);
    if (!runtime) {
        runtime = { pending: Promise.resolve(), leases: new Map() };
        runtime_by_memento.set(memento, runtime);
    }
    return runtime;
}

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

function stages_are_live(entry: PersistedEntry, now: number): boolean {
    return Object.values(entry.stages ?? {}).some((stage) => now - stage.createdAt <= STALE_STAGE_MS);
}

function trim_entries(
    all: PersistedStateEnvelope,
    runtime: StateRuntime,
    max: number,
    additionally_protected: ReadonlySet<string> = new Set(),
    now = Date.now(),
): boolean {
    let changed = false;
    for (const entry of Object.values(all.entries)) {
        if (!entry.stages) continue;
        for (const [id, stage] of Object.entries(entry.stages)) {
            if (now - stage.createdAt > STALE_STAGE_MS) {
                delete entry.stages[id];
                delete entry.copyProvenance;
                changed = true;
            }
        }
        if (Object.keys(entry.stages).length === 0) delete entry.stages;
    }
    const ordinary = Object.keys(all.entries).filter((key) => (
        !additionally_protected.has(key)
        && (runtime.leases.get(key) ?? 0) === 0
        && !stages_are_live(all.entries[key], now)
    ));
    const excess = ordinary.length - Math.max(1, max);
    if (excess > 0) {
        for (let index = 0; index < excess; index += 1) delete all.entries[ordinary[index]];
        all.absenceRevision = allocate_revision(all);
        changed = true;
    }
    return changed;
}

function states_equal(left: StoredPerFileState, right: StoredPerFileState): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalize_entries(
    all: PersistedStateEnvelope,
    canonical_path: string,
    canonical_key: (file_path: string) => string,
): boolean {
    const aliases = Object.keys(all.entries).filter((key) => (
        key !== canonical_path && canonical_key(key) === canonical_path
    ));
    if (aliases.length === 0) return false;
    const keyed = [canonical_path, ...aliases]
        .map((key) => ({ key, entry: all.entries[key] }))
        .filter((candidate): candidate is { key: string; entry: PersistedEntry } => !!candidate.entry);
    const winner = keyed.reduce((left, right) => {
        const relation = compare_authority(
            authority_for(left.entry),
            authority_for(right.entry),
        );
        if (relation === 'dominates') return left;
        if (relation === 'dominated') return right;
        if (relation === 'divergent') {
            throw new Error('Cannot canonicalize divergent durable file authority.');
        }
        if (right.entry.revision !== left.entry.revision) {
            return right.entry.revision > left.entry.revision ? right : left;
        }
        if (right.key === canonical_path) return right;
        return left;
    });
    all.entries[canonical_path] = structuredClone(winner.entry);
    for (const alias of aliases) delete all.entries[alias];
    all.absenceRevision = allocate_revision(all);
    return true;
}

function copy_persisted_entry_if_absent(
    all: PersistedStateEnvelope,
    source_path: string,
    destination_path: string,
    copy_id: string,
): { result: FileStateCopyResult; changed: boolean } {
    const destination = all.entries[destination_path];
    if (destination) {
        if (
            destination.copyProvenance?.id === copy_id
            && destination.copyProvenance.sourcePath === source_path
        ) {
            return {
                result: {
                    type: 'copied',
                    source: {
                        state: structuredClone(destination.state),
                        revision: destination.copyProvenance.sourceRevision,
                    },
                    destination: snapshot_for(all, destination_path),
                },
                changed: false,
            };
        }
        return {
            result: {
                type: 'destinationExists',
                destination: snapshot_for(all, destination_path),
            },
            changed: false,
        };
    }
    const source = all.entries[source_path];
    if (!source) {
        return {
            result: {
                type: 'sourceAbsent',
                source: snapshot_for(all, source_path),
                destination: snapshot_for(all, destination_path),
            },
            changed: false,
        };
    }
    const copied = structuredClone(source);
    copied.revision = allocate_revision(all);
    for (const stage of Object.values(copied.stages ?? {})) {
        if (stage.expectedStateRevision === source.revision) {
            stage.expectedStateRevision = copied.revision;
        }
    }
    copied.copyProvenance = {
        id: copy_id,
        sourcePath: source_path,
        sourceRevision: source.revision,
    };
    all.entries[destination_path] = copied;
    return {
        result: {
            type: 'copied',
            source: snapshot_for(all, source_path),
            destination: snapshot_for(all, destination_path),
        },
        changed: true,
    };
}

export function create_file_state_store(
    context: ExtensionContext,
    get_max_stored?: () => number,
): AuthorityFileStateStore {
    const get_max = get_max_stored ?? (() => DEFAULT_MAX_STORED_FILES);
    const memento = context.globalState as object;
    const runtime = runtime_for(memento);
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = runtime.pending.catch(() => {}).then(operation);
        runtime.pending = result;
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
                trim_entries(all, runtime, get_max());
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
                delete entry.copyProvenance;
                trim_entries(all, runtime, get_max());
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
                        next_authority.physicalDigest = stage.physicalDigest;
                    }
                }
                const next_state = stage.nextState ?? entry.state;
                const state_changed = !states_equal(entry.state, next_state);
                entry.state = structuredClone(next_state);
                if (state_changed) entry.revision = allocate_revision(all);
                entry.authority = next_authority;
                delete entry.copyProvenance;
                delete entry.stages![stage_id];
                if (Object.keys(entry.stages!).length === 0) delete entry.stages;
                delete all.entries[file_path];
                all.entries[file_path] = entry;
                trim_entries(all, runtime, get_max());
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
                delete entry.copyProvenance;
                delete entry.stages[stage_id];
                if (Object.keys(entry.stages).length === 0) delete entry.stages;
                trim_entries(all, runtime, get_max());
                await context.globalState.update(STATE_KEY, all);
            });
        },

        cleanup_authority_transactions(_file_path, now = Date.now()) {
            return enqueue(async () => {
                const all = get_all_state(context);
                if (!trim_entries(all, runtime, get_max(), new Set(), now)) return;
                await context.globalState.update(STATE_KEY, all);
            });
        },

        canonicalize_path(canonical_path, canonical_key) {
            return enqueue(async () => {
                const all = get_all_state(context);
                const changed = canonicalize_entries(all, canonical_path, canonical_key);
                const trimmed = trim_entries(
                    all,
                    runtime,
                    get_max(),
                    new Set([canonical_path]),
                );
                if (!changed && !trimmed) return;
                await context.globalState.update(STATE_KEY, all);
            });
        },

        lease_entry(canonical_path, canonical_key, copy_from_if_absent, copy_id) {
            return enqueue(async () => {
                const all = get_all_state(context);
                let changed = canonicalize_entries(all, canonical_path, canonical_key);
                if (copy_from_if_absent) {
                    const copied = copy_persisted_entry_if_absent(
                        all,
                        copy_from_if_absent,
                        canonical_path,
                        copy_id ?? `lease:${copy_from_if_absent}:${canonical_path}`,
                    );
                    changed = copied.changed || changed;
                }
                const protected_paths = new Set([canonical_path]);
                if (copy_from_if_absent) protected_paths.add(copy_from_if_absent);
                const trimmed = trim_entries(
                    all,
                    runtime,
                    get_max(),
                    protected_paths,
                );
                if (changed || trimmed) await context.globalState.update(STATE_KEY, all);
                runtime.leases.set(canonical_path, (runtime.leases.get(canonical_path) ?? 0) + 1);
                let released = false;
                let release_promise: Promise<void> | undefined;
                return {
                    release(): Promise<void> {
                        if (release_promise) return release_promise;
                        release_promise = enqueue(async () => {
                            if (released) return;
                            released = true;
                            const count = runtime.leases.get(canonical_path) ?? 0;
                            if (count <= 1) runtime.leases.delete(canonical_path);
                            else runtime.leases.set(canonical_path, count - 1);
                            const current = get_all_state(context);
                            if (!trim_entries(current, runtime, get_max())) return;
                            await context.globalState.update(STATE_KEY, current);
                        });
                        return release_promise;
                    },
                };
            });
        },

        copy_entry_if_absent(source_path, destination_path, copy_id) {
            return enqueue(async () => {
                const all = get_all_state(context);
                const copied = copy_persisted_entry_if_absent(
                    all,
                    source_path,
                    destination_path,
                    copy_id,
                );
                const trimmed = trim_entries(
                    all,
                    runtime,
                    get_max(),
                    new Set([source_path, destination_path]),
                );
                if (copied.changed || trimmed) {
                    await context.globalState.update(STATE_KEY, all);
                }
                return copied.result;
            });
        },

        touch(file_path) {
            return enqueue(async () => {
                const all = get_all_state(context);
                const current = all.entries[file_path];
                let changed = false;
                if (current) {
                    delete all.entries[file_path];
                    all.entries[file_path] = current;
                    changed = true;
                }
                changed = trim_entries(all, runtime, get_max()) || changed;
                if (changed) await context.globalState.update(STATE_KEY, all);
            });
        },
    };
}
