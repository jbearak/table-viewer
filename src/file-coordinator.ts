import type { ExcelHeaderPlanningInput } from './data-source/excel-header-source';
import {
    canonical_file_key,
    type FileRefreshWatcher,
    type FileRefreshWatcherEventKind,
    type FileRefreshWatcherFactory,
} from './file-refresh-watcher';
import { compare_authority } from './authority-order';
import {
    create_resource_identity,
    is_provider_state_key,
    type ResourceIdentity,
    type ResourceUriLike,
} from './resource-identity';
import type { ExcelHeaderOverride } from './data-source/interface';
import { normalize_host_state, plan_excel_override_state } from './excel-header-plan';
import type {
    AuthorityFileStateStore,
    AuthorityTransactionFinalizeResult,
    AuthorityTransactionKind,
    DurableFileAuthority,
    FileStateLease,
    FileStateSnapshot,
} from './state';
import type { PerFileState } from './types';
import {
    reconcile_finalization,
    type FinalizationReconciliation,
} from './finalization-reconciliation';
import { deep_clone_and_freeze } from './immutable';
import {
    cleanup_authority,
    discard_authority,
    finalize_authority,
    read_authority,
    release_authority_fallback,
    stage_authority,
} from './state-authority';

export interface FileAuthoritySnapshot extends DurableFileAuthority {
    readonly fileKey: string;
}

export interface AuthorityOperationToken<
    Kind extends AuthorityTransactionKind = AuthorityTransactionKind,
> {
    readonly ordinal: number;
    readonly kind: Kind;
    readonly basis: FileAuthoritySnapshot;
    readonly id: string;
}

export type AuthorityOperationStart<
    Kind extends AuthorityTransactionKind = AuthorityTransactionKind,
> =
    | { readonly type: 'started'; readonly token: AuthorityOperationToken<Kind> }
    | { readonly type: 'rejected'; readonly basis: FileAuthoritySnapshot };

export interface AuthorityCommitTurn {
    readonly operationOrdinal: number;
}

export type AuthorityCommitTurnResult =
    | { readonly type: 'granted'; readonly turn: AuthorityCommitTurn }
    | { readonly type: 'rejected' };

export interface AuthorityCommitReceiptBase {
    readonly operationKind: AuthorityTransactionKind;
    readonly operationOrdinal: number;
    readonly previousBasis: FileAuthoritySnapshot;
    readonly resultingBasis: FileAuthoritySnapshot;
    readonly stateSnapshot: Readonly<FileStateSnapshot>;
}

export interface PhysicalAuthorityCommitReceipt extends AuthorityCommitReceiptBase {
    readonly operationKind: 'physical';
    readonly digest: string;
}

export interface ProjectionAuthorityCommitReceipt extends AuthorityCommitReceiptBase {
    readonly operationKind: 'projection';
}

export type AuthorityCommitReceipt =
    | PhysicalAuthorityCommitReceipt
    | ProjectionAuthorityCommitReceipt;

export type AuthorityCommitReceiptFor<Kind extends AuthorityTransactionKind> =
    Kind extends 'physical'
        ? PhysicalAuthorityCommitReceipt
        : ProjectionAuthorityCommitReceipt;

export type SuccessfulAuthorityFinalization =
    | Extract<AuthorityTransactionFinalizeResult, { type: 'finalized' }>
    | Extract<FinalizationReconciliation, { type: 'committed' }>;

export interface ExcelHeaderOperationReceipt extends ProjectionAuthorityCommitReceipt {
    readonly requestId: string;
    readonly sheetIndex: number;
    readonly sheetName: string;
    readonly override: ExcelHeaderOverride;
    readonly originToken: symbol;
}

export type ExcelHeaderCommitResult =
    | { readonly type: 'committed'; readonly receipt: ExcelHeaderOperationReceipt }
    | { readonly type: 'indeterminate'; readonly error: string }
    | { readonly type: 'rejected'; readonly error: string };

export interface CommitExcelHeaderCommand {
    readonly requestId: string;
    readonly sheetIndex: number;
    readonly sheetName: string;
    readonly override: ExcelHeaderOverride;
    readonly originToken: symbol;
    readonly expectedPhysicalRevision: number;
    readonly expectedPhysicalDigest?: string;
    readonly planningInput: ExcelHeaderPlanningInput;
    readonly stateStore: AuthorityFileStateStore;
}

export type ExcelHeaderSubscriber = (receipt: ExcelHeaderOperationReceipt) => void | Promise<void>;

export type FileRefreshReason =
    | 'watcherChange'
    | 'watcherCreate'
    | 'watcherDelete'
    | 'postSave'
    | 'projectionRecovery';

export interface FileRefreshEvent {
    readonly refreshRevision: number;
    readonly episode: number;
    readonly reason: FileRefreshReason;
    readonly priority: 'normal' | 'high';
}

export type FileRefreshSubscriberResult =
    | { readonly type: 'completed' }
    | { readonly type: 'superseded' }
    | { readonly type: 'disposed' }
    | { readonly type: 'failed'; readonly error: unknown };

export type FileRefreshSubscriber = (
    event: FileRefreshEvent,
) => void | FileRefreshSubscriberResult | Promise<void | FileRefreshSubscriberResult>;

export type FileRefreshRequestResult =
    | { readonly type: 'completed'; readonly event: FileRefreshEvent }
    | { readonly type: 'disposed' };

export interface FileRefreshSubscription {
    /** Hold watcher dispatch across the final checked-write boundary. A following
     * postSave request absorbs the held batch; cancel releases it normally. */
    reserve_post_save(): { cancel(): void };
    request(reason: 'postSave'): Promise<FileRefreshRequestResult>;
    dispose(): void;
}

interface RefreshRequestState {
    dispose(): void;
}

interface RefreshSubscriberState {
    readonly listener: FileRefreshSubscriber;
    readonly requests: Set<RefreshRequestState>;
    disposed: boolean;
    postSaveReservations: number;
}

interface PendingRefreshBatch {
    revision: number;
    reason: Exclude<FileRefreshReason, 'postSave' | 'projectionRecovery'>;
}

interface OperationState {
    valid: boolean;
    requested: boolean;
    turnPromise?: Promise<AuthorityCommitTurnResult>;
    readonly digest?: string;
}

interface TurnInternal extends AuthorityCommitTurn {
    readonly token: AuthorityOperationToken;
    phase: 'granted' | 'finalizing';
}

interface TurnRequest {
    readonly token: AuthorityOperationToken;
    readonly promise: Promise<AuthorityCommitTurnResult>;
    readonly resolve: (result: AuthorityCommitTurnResult) => void;
}

interface FileCoordinatorEntry {
    readonly fileKey: string;
    readonly statePath: string;
    readonly identity: ResourceIdentity;
    stateTail: Promise<void>;
    initialization: 'idle' | 'initializing' | 'ready';
    readonly aliases: Set<string>;
    readonly registrations: Map<string, Promise<void>>;
    stateLease?: FileStateLease;
    stateStore?: AuthorityFileStateStore;
    attachments: number;
    operations: number;
    nextOrdinal: number;
    authority: DurableFileAuthority;
    readonly states: Map<AuthorityOperationToken, OperationState>;
    readonly requests: Map<AuthorityOperationToken, TurnRequest>;
    activeTurn?: TurnInternal;
    readonly subscribers: Set<ExcelHeaderSubscriber>;
    readonly refreshSubscribers: Set<RefreshSubscriberState>;
    refreshWatcher?: FileRefreshWatcher;
    refreshWatcherListener?: { dispose(): void };
    refreshRevision: number;
    refreshEpisode: number;
    refreshRequests: number;
    refreshReservations: number;
    pendingRefresh?: PendingRefreshBatch;
    pendingRefreshFlushes: number;
    readonly warnedKeys: Set<string>;
}

const entries = new Map<string, FileCoordinatorEntry>();

export { canonical_file_key } from './file-refresh-watcher';

function snapshot(entry: FileCoordinatorEntry): FileAuthoritySnapshot {
    return Object.freeze({ fileKey: entry.fileKey, ...structuredClone(entry.authority) });
}

function dispose_best_effort(disposable: { dispose(): void } | undefined): void {
    try {
        disposable?.dispose();
    } catch (error) {
        console.error('Failed to dispose a file refresh resource', error);
    }
}

function cleanup(entry: FileCoordinatorEntry): void {
    if (
        entry.attachments === 0
        && entry.operations === 0
        && entry.subscribers.size === 0
        && entry.refreshSubscribers.size === 0
        && entry.refreshRequests === 0
        && entry.refreshReservations === 0
        && entry.pendingRefreshFlushes === 0
        && entries.get(entry.fileKey) === entry
    ) {
        dispose_best_effort(entry.refreshWatcherListener);
        entry.refreshWatcherListener = undefined;
        dispose_best_effort(entry.refreshWatcher);
        entry.refreshWatcher = undefined;
        entries.delete(entry.fileKey);
        if (entry.stateStore) release_authority_fallback(entry.stateStore, entry.statePath);
        void entry.stateLease?.release().catch((error) => {
            console.error('Failed to release file state lease', error);
        });
        entry.stateLease = undefined;
    }
}

function watcher_reason(
    kind: FileRefreshWatcherEventKind,
): Exclude<FileRefreshReason, 'postSave' | 'projectionRecovery'> {
    if (kind === 'create') return 'watcherCreate';
    if (kind === 'delete') return 'watcherDelete';
    return 'watcherChange';
}

function invoke_refresh_subscribers(
    entry: FileCoordinatorEntry,
    event: FileRefreshEvent,
    requester?: RefreshSubscriberState,
): Promise<void> | undefined {
    let requester_completion: Promise<void> | undefined;
    for (const subscriber of [...entry.refreshSubscribers]) {
        const delivered = deep_clone_and_freeze(event);
        let completion: Promise<void>;
        try {
            completion = Promise.resolve(subscriber.listener(delivered)).then(() => undefined);
        } catch (error) {
            console.error('Failed to refresh a file view', error);
            completion = Promise.resolve();
        }
        const safe_completion = completion.catch((error) => {
            console.error('Failed to refresh a file view', error);
        });
        if (subscriber === requester) requester_completion = safe_completion;
        else void safe_completion;
    }
    return requester_completion;
}

function dispatch_refresh(
    entry: FileCoordinatorEntry,
    revision: number,
    reason: FileRefreshReason,
    priority: 'normal' | 'high',
    requester?: RefreshSubscriberState,
): { event: FileRefreshEvent; completion?: Promise<void> } {
    const event = deep_clone_and_freeze({
        refreshRevision: revision,
        episode: ++entry.refreshEpisode,
        reason,
        priority,
    });
    return {
        event,
        completion: invoke_refresh_subscribers(entry, event, requester),
    };
}

function dispatch_projection_recovery(entry: FileCoordinatorEntry): void {
    const revision = ++entry.refreshRevision;
    entry.pendingRefresh = undefined;
    dispatch_refresh(entry, revision, 'projectionRecovery', 'high');
}

function schedule_pending_refresh(
    entry: FileCoordinatorEntry,
    batch: PendingRefreshBatch,
): void {
    entry.pendingRefreshFlushes += 1;
    queueMicrotask(() => {
        try {
            if (
                entry.pendingRefresh !== batch
                || entry.refreshReservations > 0
            ) return;
            entry.pendingRefresh = undefined;
            dispatch_refresh(entry, batch.revision, batch.reason, 'normal');
        } finally {
            entry.pendingRefreshFlushes -= 1;
            cleanup(entry);
        }
    });
}

function queue_watcher_refresh(
    entry: FileCoordinatorEntry,
    kind: FileRefreshWatcherEventKind,
): void {
    const revision = ++entry.refreshRevision;
    const next_reason = watcher_reason(kind);
    const pending = entry.pendingRefresh;
    if (pending) {
        pending.revision = revision;
        if (next_reason !== 'watcherChange' || pending.reason === 'watcherChange') {
            pending.reason = next_reason;
        }
        return;
    }

    const batch: PendingRefreshBatch = { revision, reason: next_reason };
    entry.pendingRefresh = batch;
    schedule_pending_refresh(entry, batch);
}

function ensure_refresh_watcher(
    entry: FileCoordinatorEntry,
    factory: FileRefreshWatcherFactory,
): void {
    if (entry.refreshWatcher) return;
    const watcher = factory.create(entry.identity);
    try {
        entry.refreshWatcherListener = watcher.on_event((kind) => {
            queue_watcher_refresh(entry, kind);
        });
        entry.refreshWatcher = watcher;
    } catch (error) {
        dispose_best_effort(watcher);
        throw error;
    }
}

function entry_for(
    resource: ResourceUriLike | string,
    platform: NodeJS.Platform,
): FileCoordinatorEntry {
    const identity = create_resource_identity(resource, platform);
    let entry = entries.get(identity.key);
    if (!entry) {
        entry = {
            fileKey: identity.key,
            statePath: identity.stateKey,
            identity,
            stateTail: Promise.resolve(),
            initialization: 'idle',
            aliases: new Set(),
            registrations: new Map(),
            attachments: 0,
            operations: 0,
            nextOrdinal: 1,
            authority: {
                commitSequence: 0,
                authorityRevision: 0,
                physicalRevision: 0,
                projectionRevision: 0,
            },
            states: new Map(),
            requests: new Map(),
            subscribers: new Set(),
            refreshSubscribers: new Set(),
            refreshRevision: 0,
            refreshEpisode: 0,
            refreshRequests: 0,
            refreshReservations: 0,
            pendingRefreshFlushes: 0,
            warnedKeys: new Set(),
        };
        entries.set(identity.key, entry);
    }
    return entry;
}

function canonical_state_key(entry: FileCoordinatorEntry, candidate: string): string {
    if (is_provider_state_key(candidate)) return candidate;
    return canonical_file_key(candidate, entry.identity.platform);
}

function register_store(
    entry: FileCoordinatorEntry,
    identity: ResourceIdentity,
    store: AuthorityFileStateStore | undefined,
): Promise<void> {
    if (!store) {
        entry.initialization = 'ready';
        return Promise.resolve();
    }
    if (entry.aliases.has(identity.registrationKey)) return Promise.resolve();
    const pending = entry.registrations.get(identity.registrationKey);
    if (pending) return pending;

    const had_ready_baseline = entry.initialization === 'ready' || entry.aliases.size > 0;
    if (!had_ready_baseline) entry.initialization = 'initializing';
    entry.operations += 1;
    entry.stateStore ??= store;
    const work = entry.stateTail.then(async () => {
        const legacy_provider_path = identity.kind === 'provider'
            ? canonical_file_key(identity.uri.fsPath, identity.platform)
            : undefined;
        const provider_copy_id = legacy_provider_path
            ? `provider-migration:${JSON.stringify([legacy_provider_path, entry.statePath])}`
            : undefined;
        if (!entry.stateLease) {
            entry.stateLease = store.lease_entry
                ? await store.lease_entry(
                    entry.statePath,
                    (candidate) => canonical_state_key(entry, candidate),
                    legacy_provider_path,
                    provider_copy_id,
                )
                : undefined;
        }
        if (!entry.stateLease && entry.identity.kind === 'file') {
            await store.canonicalize_path?.(
                entry.statePath,
                (candidate) => canonical_state_key(entry, candidate),
            );
        } else if (entry.stateLease && identity.registrationKey !== entry.identity.registrationKey) {
            await store.canonicalize_path?.(
                entry.statePath,
                (candidate) => canonical_state_key(entry, candidate),
            );
        }
        if (
            legacy_provider_path
            && legacy_provider_path !== entry.statePath
            && provider_copy_id
        ) {
            const migration = store.copy_entry_if_absent
                ? await store.copy_entry_if_absent(
                    legacy_provider_path,
                    entry.statePath,
                    provider_copy_id,
                )
                : { type: 'unsupported' as const };
            if (migration.type === 'unsupported') {
                throw new Error(
                    'Provider state migration requires an atomic complete-entry copy.',
                );
            }
        }
        if (
            identity.kind === 'file'
            && identity.uri.fsPath !== entry.statePath
        ) {
            const [stable, alias] = await Promise.all([
                store.read(entry.statePath),
                store.read(identity.uri.fsPath),
            ]);
            if (Object.keys(stable.state).length === 0 && Object.keys(alias.state).length > 0) {
                await store.compare_and_set(
                    entry.statePath,
                    stable.revision,
                    alias.state as PerFileState,
                );
            }
        }
        const observed = await read_authority(store, entry.statePath);
        const installed = install_authority(entry, observed);
        if (installed.type === 'invalid') {
            throw new Error('The persisted file authority diverged during initialization.');
        }
        entry.aliases.add(identity.registrationKey);
        entry.initialization = 'ready';
        void cleanup_authority(store, entry.statePath).catch(() => {});
    });
    const exposed = work.then(
        () => {
            entry.registrations.delete(identity.registrationKey);
            entry.operations -= 1;
            cleanup(entry);
        },
        (error: unknown) => {
            entry.initialization = entry.aliases.size > 0 || had_ready_baseline
                ? 'ready'
                : 'idle';
            entry.registrations.delete(identity.registrationKey);
            entry.operations -= 1;
            cleanup(entry);
            throw error;
        },
    );
    entry.registrations.set(identity.registrationKey, exposed);
    entry.stateTail = exposed.catch(() => {});
    return exposed;
}

function activate_turn(entry: FileCoordinatorEntry): void {
    if (entry.activeTurn) return;
    const request = [...entry.requests.values()]
        .filter(({ token }) => entry.states.get(token)?.valid)
        .sort((a, b) => a.token.ordinal - b.token.ordinal)[0];
    if (!request) return;
    entry.requests.delete(request.token);
    const turn: TurnInternal = {
        operationOrdinal: request.token.ordinal,
        token: request.token,
        phase: 'granted',
    };
    entry.activeTurn = turn;
    request.resolve({ type: 'granted', turn });
}

function finish(entry: FileCoordinatorEntry, token: AuthorityOperationToken): void {
    const state = entry.states.get(token);
    if (!state) return;
    const request = entry.requests.get(token);
    if (request) {
        entry.requests.delete(token);
        request.resolve({ type: 'rejected' });
    }
    entry.states.delete(token);
    entry.operations -= 1;
    activate_turn(entry);
    cleanup(entry);
}

function reject_operation(
    entry: FileCoordinatorEntry,
    token: AuthorityOperationToken,
    state: OperationState,
): void {
    state.valid = false;
    const request = entry.requests.get(token);
    if (request) {
        entry.requests.delete(token);
        request.resolve({ type: 'rejected' });
    }
}

function invalidate(
    entry: FileCoordinatorEntry,
    physical_change: boolean,
    digest: string,
): void {
    for (const [token, state] of entry.states) {
        if (!state.valid || entry.activeTurn?.token === token) continue;
        if (
            (token.kind === 'physical' && state.digest !== digest)
            || (token.kind === 'projection' && physical_change)
        ) reject_operation(entry, token, state);
    }
    activate_turn(entry);
}

type AuthorityInstallResult =
    | { type: 'installed'; previous: FileAuthoritySnapshot; current: FileAuthoritySnapshot }
    | { type: 'unchanged'; current: FileAuthoritySnapshot }
    | { type: 'stale'; current: FileAuthoritySnapshot }
    | { type: 'invalid'; current: FileAuthoritySnapshot };

function invalidate_after_authority_install(
    entry: FileCoordinatorEntry,
    finishing: AuthorityOperationToken | undefined,
    previous: FileAuthoritySnapshot,
    observed: DurableFileAuthority,
): void {
    const physical_change = previous.physicalRevision !== observed.physicalRevision
        || previous.physicalDigest !== observed.physicalDigest;
    const projection_change = previous.projectionRevision !== observed.projectionRevision;
    for (const [token, state] of entry.states) {
        if (!state.valid || token === finishing) continue;
        if (
            (
                physical_change
                && (
                    token.kind === 'projection'
                    || state.digest !== observed.physicalDigest
                )
            )
            || (
                projection_change
                && token.kind === 'projection'
                && (finishing === undefined || token.ordinal < finishing.ordinal)
            )
        ) reject_operation(entry, token, state);
    }
    activate_turn(entry);
}

function exact_finalizing_projection_token(
    entry: FileCoordinatorEntry,
    candidate: DurableFileAuthority,
): AuthorityOperationToken | undefined {
    const turn = entry.activeTurn;
    if (turn?.phase !== 'finalizing' || turn.token.kind !== 'projection') return undefined;
    const current = entry.authority;
    if (
        candidate.commitSequence !== current.commitSequence + 1
        || candidate.authorityRevision !== current.authorityRevision + 1
        || candidate.projectionRevision !== current.projectionRevision + 1
        || candidate.physicalRevision !== current.physicalRevision
        || candidate.physicalDigest !== current.physicalDigest
    ) return undefined;
    return turn.token;
}

function install_authority(
    entry: FileCoordinatorEntry,
    candidate: DurableFileAuthority,
    finishing?: AuthorityOperationToken,
): AuthorityInstallResult {
    const previous = snapshot(entry);
    const relation = compare_authority(candidate, entry.authority);
    if (relation === 'equal') return { type: 'unchanged', current: previous };
    if (relation === 'dominated') return { type: 'stale', current: previous };
    if (relation === 'divergent') return { type: 'invalid', current: previous };
    const effective_finishing = finishing
        ?? exact_finalizing_projection_token(entry, candidate);
    entry.authority = structuredClone(candidate);
    invalidate_after_authority_install(entry, effective_finishing, previous, candidate);
    return { type: 'installed', previous, current: snapshot(entry) };
}

export interface FileCoordinatorAttachment {
    readonly statePath: string;
    authority(): FileAuthoritySnapshot;
    state_ready(): Promise<void>;
    begin_physical(expectedAuthorityRevision: number, digest: string): AuthorityOperationStart<'physical'>;
    operation_is_current(token: AuthorityOperationToken): boolean;
    state_write_is_current(authorityRevision: number): boolean;
    request_commit_turn(token: AuthorityOperationToken): Promise<AuthorityCommitTurnResult>;
    start_finalization(turn: AuthorityCommitTurn): void;
    finalize_authority_commit<Kind extends AuthorityTransactionKind>(
        token: AuthorityOperationToken<Kind>,
        turn: AuthorityCommitTurn,
        finalized: SuccessfulAuthorityFinalization,
        finalizationBasis: FileAuthoritySnapshot,
    ): AuthorityCommitReceiptFor<Kind>;
    observe_advanced_authority(
        token: AuthorityOperationToken,
        turn: AuthorityCommitTurn,
        authority: DurableFileAuthority,
    ): FileAuthoritySnapshot;
    release_commit_turn(turn: AuthorityCommitTurn): void;
    cancel(token: AuthorityOperationToken): void;
    commit_excel_header(command: CommitExcelHeaderCommand): Promise<ExcelHeaderCommitResult>;
    subscribe_excel_headers(listener: ExcelHeaderSubscriber): { dispose(): void };
    subscribe_refresh(
        listener: FileRefreshSubscriber,
        factory: FileRefreshWatcherFactory,
    ): FileRefreshSubscription;
    mark_warning_seen(key: string): boolean;
    dispose(): void;
}

export function acquire_file_coordinator(
    resource: ResourceUriLike | string,
    state_store?: AuthorityFileStateStore,
    platform: NodeJS.Platform = process.platform,
): FileCoordinatorAttachment {
    const identity = create_resource_identity(resource, platform);
    const entry = entry_for(identity.uri, platform);
    entry.attachments += 1;
    void register_store(entry, identity, state_store).catch(() => {});
    let disposed = false;

    const attachment: FileCoordinatorAttachment = {
        statePath: entry.statePath,
        authority: () => snapshot(entry),
        state_ready: () => register_store(entry, identity, state_store),

        begin_physical(expectedAuthorityRevision, digest) {
            const basis = snapshot(entry);
            if (state_store && entry.initialization !== 'ready') {
                return { type: 'rejected', basis };
            }
            if (
                basis.authorityRevision !== expectedAuthorityRevision
                && basis.physicalDigest !== digest
            ) return { type: 'rejected', basis };
            invalidate(entry, basis.physicalDigest !== digest, digest);
            const token = Object.freeze({
                ordinal: entry.nextOrdinal++,
                kind: 'physical' as const,
                basis,
                id: `physical:${entry.fileKey}:${Date.now()}:${Math.random()}`,
            });
            entry.states.set(token, { valid: true, requested: false, digest });
            entry.operations += 1;
            return { type: 'started', token };
        },

        operation_is_current(token) {
            return entry.states.get(token)?.valid === true;
        },

        state_write_is_current(authorityRevision) {
            return entry.authority.authorityRevision === authorityRevision
                && entry.activeTurn?.phase !== 'finalizing';
        },

        request_commit_turn(token) {
            const state = entry.states.get(token);
            if (!state?.valid) return Promise.resolve({ type: 'rejected' });
            if (state.turnPromise) return state.turnPromise;
            state.requested = true;
            let resolve_request!: (result: AuthorityCommitTurnResult) => void;
            const promise = new Promise<AuthorityCommitTurnResult>((resolve) => {
                resolve_request = resolve;
            });
            state.turnPromise = promise;
            entry.requests.set(token, { token, promise, resolve: resolve_request });
            activate_turn(entry);
            return promise;
        },

        start_finalization(turn) {
            if (entry.activeTurn !== turn || entry.activeTurn.phase !== 'granted') {
                throw new Error('The authority commit turn cannot begin finalization.');
            }
            entry.activeTurn.phase = 'finalizing';
        },

        finalize_authority_commit(token, turn, finalized, finalizationBasis) {
            if (entry.activeTurn !== turn || entry.activeTurn.token !== token) {
                throw new Error('The authority commit turn is no longer active.');
            }
            const operation = entry.states.get(token);
            if (!operation) {
                throw new Error('The authority operation is no longer active.');
            }
            if (token.kind === 'physical' && operation.digest === undefined) {
                throw new Error('The physical authority operation has no digest.');
            }
            const installed = install_authority(entry, finalized.authority, token);
            entry.activeTurn = undefined;
            finish(entry, token);
            if (installed.type !== 'installed' && installed.type !== 'unchanged') {
                throw new Error('The finalized authority was not a monotonic advance.');
            }
            const base = {
                operationKind: token.kind,
                operationOrdinal: token.ordinal,
                previousBasis: installed.type === 'installed'
                    ? installed.previous
                    : finalizationBasis,
                resultingBasis: installed.current,
                stateSnapshot: finalized.snapshot,
            };
            const receipt = token.kind === 'physical'
                ? {
                    ...base,
                    operationKind: 'physical' as const,
                    digest: operation.digest as string,
                }
                : {
                    ...base,
                    operationKind: 'projection' as const,
                };
            return deep_clone_and_freeze(receipt) as AuthorityCommitReceiptFor<typeof token.kind>;
        },

        observe_advanced_authority(token, turn, authority) {
            if (entry.activeTurn !== turn || entry.activeTurn.token !== token) {
                throw new Error('The authority commit turn is no longer active.');
            }
            const installed = install_authority(entry, authority, token);
            entry.activeTurn = undefined;
            finish(entry, token);
            if (installed.type === 'invalid') {
                throw new Error('The observed authority was not a monotonic advance.');
            }
            return installed.current;
        },

        release_commit_turn(turn) {
            if (entry.activeTurn !== turn) return;
            const state = entry.states.get(entry.activeTurn.token);
            if (state) {
                state.requested = false;
                state.turnPromise = undefined;
            }
            entry.activeTurn = undefined;
            activate_turn(entry);
        },

        cancel(token) {
            if (
                entry.activeTurn?.token === token
                && entry.activeTurn.phase === 'finalizing'
            ) return;
            if (entry.activeTurn?.token === token) entry.activeTurn = undefined;
            finish(entry, token);
        },

        async commit_excel_header(command) {
            if (disposed) {
                return { type: 'rejected', error: 'The worksheet view is no longer available.' };
            }
            entry.operations += 1;
            let token: AuthorityOperationToken<'projection'> | undefined;
            let receipt: ExcelHeaderOperationReceipt | undefined;
            let recovery_required = false;
            const indeterminate = (error: string): ExcelHeaderCommitResult => {
                recovery_required = true;
                return { type: 'indeterminate', error };
            };
            try {
                await register_store(entry, identity, state_store);
                const basis = snapshot(entry);
                const physical_basis_is_current = () => {
                    const current = snapshot(entry);
                    return current.physicalRevision === command.expectedPhysicalRevision
                        && current.physicalDigest === command.expectedPhysicalDigest;
                };
                if (!physical_basis_is_current()) {
                    return { type: 'rejected', error: 'The worksheet changed before the header request arrived.' };
                }
                for (const [older, state] of entry.states) {
                    if (
                        older.kind === 'projection'
                        && state.valid
                        && !state.requested
                        && entry.activeTurn?.token !== older
                    ) reject_operation(entry, older, state);
                }
                token = Object.freeze({
                    ordinal: entry.nextOrdinal++,
                    kind: 'projection' as const,
                    basis,
                    id: `projection:${entry.fileKey}:${command.requestId}:${Math.random()}`,
                });
                entry.states.set(token, { valid: true, requested: false });
                const planning_is_current = () => (
                    token !== undefined
                    && attachment.operation_is_current(token)
                    && physical_basis_is_current()
                );
                const names = command.planningInput.sheets.map((sheet) => sheet.name);
                let conflicts = 0;
                const retry_or_reject = (): ExcelHeaderCommitResult | undefined => {
                    if (conflicts >= 3) {
                        return {
                            type: 'rejected',
                            error: 'The worksheet kept changing before the header setting could be saved.',
                        };
                    }
                    conflicts += 1;
                    return undefined;
                };
                const reject_authority_mismatch = async (
                    observed: DurableFileAuthority,
                    turn?: AuthorityCommitTurn,
                ): Promise<ExcelHeaderCommitResult> => {
                    const current = attachment.authority();
                    const relation = compare_authority(observed, current);
                    if (relation === 'dominates') {
                        let granted = turn;
                        if (!granted) {
                            const requested = await attachment.request_commit_turn(token!);
                            if (requested.type === 'granted') granted = requested.turn;
                        }
                        if (granted) {
                            if (compare_authority(attachment.authority(), current) === 'equal') {
                                attachment.observe_advanced_authority(token!, granted, observed);
                            } else {
                                attachment.release_commit_turn(granted);
                            }
                        }
                    } else if (turn) {
                        attachment.release_commit_turn(turn);
                    }
                    const installed = attachment.authority();
                    if (
                        observed.projectionRevision > basis.projectionRevision
                        || installed.projectionRevision > basis.projectionRevision
                    ) recovery_required = true;
                    return {
                        type: 'rejected',
                        error: relation === 'dominates'
                            ? 'The durable workbook advanced during header finalization.'
                            : 'The durable workbook authority could not be reconciled safely.',
                    };
                };

                for (;;) {
                    if (!planning_is_current()) {
                        return { type: 'rejected', error: 'The worksheet changed before the header setting could be saved.' };
                    }
                    const state_snapshot = await command.stateStore.read(entry.statePath);
                    if (!planning_is_current()) {
                        return { type: 'rejected', error: 'The worksheet changed before the header setting could be saved.' };
                    }
                    const plan = plan_excel_override_state(
                        normalize_host_state(state_snapshot.state, names),
                        command.planningInput,
                        command.sheetIndex,
                        command.sheetName,
                        command.override,
                    );
                    if (!plan) {
                        return { type: 'rejected', error: 'The selected worksheet no longer matches this request.' };
                    }
                    if (!planning_is_current()) {
                        return { type: 'rejected', error: 'The worksheet changed before the header setting could be saved.' };
                    }
                    const stage_basis = attachment.authority();
                    const stage = await stage_authority(
                        command.stateStore,
                        entry.statePath,
                        {
                            id: token.id,
                            kind: 'projection',
                            ordinal: token.ordinal,
                            expectedStateRevision: state_snapshot.revision,
                            expectedCommitSequence: stage_basis.commitSequence,
                            nextState: plan.state,
                        },
                    );
                    if (!planning_is_current()) {
                        return { type: 'rejected', error: 'The worksheet changed before the header setting could be saved.' };
                    }
                    if (stage.type === 'conflict') {
                        const relation = compare_authority(stage.authority, attachment.authority());
                        if (relation !== 'equal') {
                            return await reject_authority_mismatch(stage.authority);
                        }
                        const rejected = retry_or_reject();
                        if (rejected) return rejected;
                        continue;
                    }
                    const requested = await attachment.request_commit_turn(token);
                    if (requested.type === 'rejected' || !planning_is_current()) {
                        if (requested.type === 'granted') attachment.release_commit_turn(requested.turn);
                        return { type: 'rejected', error: 'The worksheet changed before the header setting could be saved.' };
                    }
                    const finalizationBasis = attachment.authority();
                    const descriptor = {
                        transactionId: token.id,
                        kind: 'projection' as const,
                        basis: finalizationBasis,
                        expectedStateRevision: state_snapshot.revision,
                        previousState: state_snapshot.state,
                        nextState: plan.state,
                    };
                    if (!planning_is_current()) {
                        attachment.release_commit_turn(requested.turn);
                        return { type: 'rejected', error: 'The worksheet changed before the header setting could be saved.' };
                    }
                    attachment.start_finalization(requested.turn);
                    let finalized: Awaited<ReturnType<typeof finalize_authority>>;
                    try {
                        finalized = await finalize_authority(
                            command.stateStore,
                            entry.statePath,
                            token.id,
                        );
                    } catch (error) {
                        let reconciled: FinalizationReconciliation;
                        try {
                            reconciled = await reconcile_finalization(
                                command.stateStore,
                                entry.statePath,
                                descriptor,
                            );
                        } catch {
                            attachment.release_commit_turn(requested.turn);
                            void discard_authority(command.stateStore, entry.statePath, token.id);
                            return indeterminate(
                                'The header setting may have been saved, but its final authority could not be inspected.',
                            );
                        }
                        if (reconciled.type === 'committed') {
                            finalized = {
                                type: 'finalized',
                                snapshot: reconciled.snapshot,
                                authority: reconciled.authority,
                            };
                        } else if (reconciled.type === 'advanced') {
                            attachment.observe_advanced_authority(
                                token,
                                requested.turn,
                                reconciled.authority,
                            );
                            return indeterminate(
                                'The header setting may have been saved before the durable workbook advanced.',
                            );
                        } else {
                            attachment.release_commit_turn(requested.turn);
                            void discard_authority(command.stateStore, entry.statePath, token.id);
                            throw error;
                        }
                    }
                    if (finalized.type === 'conflict') {
                        const relation = compare_authority(
                            finalized.authority,
                            finalizationBasis,
                        );
                        if (relation !== 'equal') {
                            return await reject_authority_mismatch(
                                finalized.authority,
                                requested.turn,
                            );
                        }
                        attachment.release_commit_turn(requested.turn);
                        const newer = [...entry.states.entries()].some(([candidate, candidate_state]) => (
                            candidate.kind === 'projection'
                            && candidate.ordinal > token!.ordinal
                            && candidate_state.valid
                        ));
                        if (newer) {
                            const state = entry.states.get(token);
                            if (state) state.valid = false;
                            return { type: 'rejected', error: 'A newer header setting superseded this request.' };
                        }
                        const rejected = retry_or_reject();
                        if (rejected) return rejected;
                        continue;
                    }
                    let inspected;
                    try {
                        inspected = await command.stateStore.inspect_authority_transaction(
                            entry.statePath,
                            token.id,
                        );
                    } catch {
                        attachment.observe_advanced_authority(
                            token,
                            requested.turn,
                            finalized.authority,
                        );
                        return indeterminate(
                            'The header setting was saved, but the latest workbook authority could not be confirmed.',
                        );
                    }
                    const inspected_relation = compare_authority(
                        inspected.authority,
                        finalized.authority,
                    );
                    if (inspected_relation !== 'equal') {
                        attachment.observe_advanced_authority(
                            token,
                            requested.turn,
                            finalized.authority,
                        );
                        return indeterminate(
                            'The header setting was saved, but the latest workbook authority could not be confirmed.',
                        );
                    }
                    if (!physical_basis_is_current()) {
                        attachment.observe_advanced_authority(
                            token,
                            requested.turn,
                            finalized.authority,
                        );
                        return indeterminate(
                            'The header setting was saved against an older physical workbook basis.',
                        );
                    }
                    const current_after_confirmation = attachment.authority();
                    if (
                        compare_authority(
                            current_after_confirmation,
                            finalized.authority,
                        ) === 'dominates'
                    ) {
                        attachment.observe_advanced_authority(
                            token,
                            requested.turn,
                            current_after_confirmation,
                        );
                        return indeterminate(
                            'The header setting was saved before the durable workbook advanced.',
                        );
                    }
                    const authorityReceipt = attachment.finalize_authority_commit(
                        token,
                        requested.turn,
                        finalized,
                        finalizationBasis,
                    );
                    receipt = Object.freeze({
                        ...authorityReceipt,
                        requestId: command.requestId,
                        sheetIndex: command.sheetIndex,
                        sheetName: command.sheetName,
                        override: command.override,
                        originToken: command.originToken,
                    });
                    return { type: 'committed', receipt };
                }
            } catch (error) {
                if (token && entry.activeTurn?.token === token) {
                    attachment.release_commit_turn(entry.activeTurn);
                }
                throw error;
            } finally {
                if (token) {
                    if (entry.states.has(token)) finish(entry, token);
                } else {
                    entry.operations -= 1;
                    cleanup(entry);
                }
                if (token) void discard_authority(command.stateStore, entry.statePath, token.id);
                if (receipt) {
                    for (const subscriber of [...entry.subscribers]) {
                        try {
                            void Promise.resolve(subscriber(receipt)).catch((error) => {
                                console.error('Failed to refresh an Excel header view', error);
                            });
                        } catch (error) {
                            console.error('Failed to refresh an Excel header view', error);
                        }
                    }
                } else if (recovery_required) {
                    dispatch_projection_recovery(entry);
                }
            }
        },

        subscribe_excel_headers(listener) {
            entry.subscribers.add(listener);
            return {
                dispose() {
                    entry.subscribers.delete(listener);
                    cleanup(entry);
                },
            };
        },

        subscribe_refresh(listener, factory) {
            ensure_refresh_watcher(entry, factory);
            const subscriber: RefreshSubscriberState = {
                listener,
                requests: new Set(),
                disposed: false,
                postSaveReservations: 0,
            };
            entry.refreshSubscribers.add(subscriber);

            const release_reservation = (flush: boolean): void => {
                if (subscriber.postSaveReservations === 0) return;
                subscriber.postSaveReservations -= 1;
                entry.refreshReservations -= 1;
                if (flush && entry.refreshReservations === 0 && entry.pendingRefresh) {
                    schedule_pending_refresh(entry, entry.pendingRefresh);
                }
                cleanup(entry);
            };

            return {
                reserve_post_save() {
                    if (subscriber.disposed || !entry.refreshSubscribers.has(subscriber)) {
                        return { cancel() {} };
                    }
                    subscriber.postSaveReservations += 1;
                    entry.refreshReservations += 1;
                    let active = true;
                    return {
                        cancel() {
                            if (!active) return;
                            active = false;
                            release_reservation(true);
                        },
                    };
                },
                request(reason) {
                    if (subscriber.disposed || !entry.refreshSubscribers.has(subscriber)) {
                        return Promise.resolve({ type: 'disposed' });
                    }
                    // Consume this subscriber's checked-write reservation without
                    // flushing its watcher batch: postSave absorbs that revision.
                    release_reservation(false);
                    let resolve_request!: (result: FileRefreshRequestResult) => void;
                    let reject_request!: (error: unknown) => void;
                    const result = new Promise<FileRefreshRequestResult>((resolve, reject) => {
                        resolve_request = resolve;
                        reject_request = reject;
                    });
                    let active = true;
                    const release_request = (): boolean => {
                        if (!active) return false;
                        active = false;
                        subscriber.requests.delete(request_state);
                        entry.refreshRequests -= 1;
                        cleanup(entry);
                        return true;
                    };
                    const request_state: RefreshRequestState = {
                        dispose() {
                            if (release_request()) resolve_request({ type: 'disposed' });
                        },
                    };
                    subscriber.requests.add(request_state);
                    entry.refreshRequests += 1;
                    try {
                        const revision = ++entry.refreshRevision;
                        entry.pendingRefresh = undefined;
                        const dispatched = dispatch_refresh(
                            entry,
                            revision,
                            reason,
                            'high',
                            subscriber,
                        );
                        void Promise.resolve(dispatched.completion).then(
                            () => {
                                if (release_request()) {
                                    resolve_request({
                                        type: 'completed',
                                        event: dispatched.event,
                                    });
                                }
                            },
                            (error: unknown) => {
                                if (release_request()) reject_request(error);
                            },
                        );
                    } catch (error) {
                        if (release_request()) reject_request(error);
                    }
                    return result;
                },
                dispose() {
                    if (subscriber.disposed) return;
                    subscriber.disposed = true;
                    entry.refreshSubscribers.delete(subscriber);
                    while (subscriber.postSaveReservations > 0) {
                        release_reservation(true);
                    }
                    for (const request of [...subscriber.requests]) request.dispose();
                    cleanup(entry);
                },
            };
        },

        mark_warning_seen(key) {
            if (entry.warnedKeys.has(key)) return false;
            entry.warnedKeys.add(key);
            return true;
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            entry.attachments = Math.max(0, entry.attachments - 1);
            cleanup(entry);
        },
    };
    return attachment;
}

export function file_coordinator_registry_size(): number {
    return entries.size;
}
