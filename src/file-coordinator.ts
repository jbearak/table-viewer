import type { ExcelHeaderPlanningInput } from './data-source/excel-header-source';
import {
    canonical_file_key,
    file_refresh_watch_identity,
    type FileRefreshWatchIdentity,
    type FileRefreshWatcher,
    type FileRefreshWatcherEventKind,
    type FileRefreshWatcherFactory,
} from './file-refresh-watcher';
import type { ExcelHeaderOverride } from './data-source/interface';
import { normalize_host_state, plan_excel_override_state } from './excel-header-plan';
import type {
    AuthorityFileStateStore,
    AuthorityTransactionFinalizeResult,
    AuthorityTransactionKind,
    DurableFileAuthority,
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
    | { readonly type: 'rejected'; readonly error: string };

export interface CommitExcelHeaderCommand {
    readonly requestId: string;
    readonly sheetIndex: number;
    readonly sheetName: string;
    readonly override: ExcelHeaderOverride;
    readonly originToken: symbol;
    readonly expectedPhysicalRevision: number;
    readonly planningInput: ExcelHeaderPlanningInput;
    readonly stateStore: AuthorityFileStateStore;
}

export type ExcelHeaderSubscriber = (receipt: ExcelHeaderOperationReceipt) => void | Promise<void>;

export type FileRefreshReason =
    | 'watcherChange'
    | 'watcherCreate'
    | 'watcherDelete'
    | 'postSave';

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

interface RefreshSubscriberState {
    readonly listener: FileRefreshSubscriber;
    disposed: boolean;
    postSaveReservations: number;
}

interface PendingRefreshBatch {
    revision: number;
    reason: Exclude<FileRefreshReason, 'postSave'>;
}

interface OperationState {
    valid: boolean;
    requested: boolean;
    readonly digest?: string;
}

interface TurnInternal extends AuthorityCommitTurn {
    readonly token: AuthorityOperationToken;
    phase: 'granted' | 'finalizing';
}

interface TurnRequest {
    readonly token: AuthorityOperationToken;
    readonly resolve: (result: AuthorityCommitTurnResult) => void;
}

interface FileCoordinatorEntry {
    readonly fileKey: string;
    readonly statePath: string;
    readonly platform: NodeJS.Platform;
    readonly watchIdentity: FileRefreshWatchIdentity;
    stateReady: Promise<void>;
    readonly aliases: Set<string>;
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
        entry.refreshWatcherListener?.dispose();
        entry.refreshWatcherListener = undefined;
        entry.refreshWatcher?.dispose();
        entry.refreshWatcher = undefined;
        entries.delete(entry.fileKey);
        release_authority_fallback(entry.statePath);
    }
}

function watcher_reason(kind: FileRefreshWatcherEventKind): Exclude<FileRefreshReason, 'postSave'> {
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
    const watcher = factory.create(entry.watchIdentity);
    try {
        entry.refreshWatcherListener = watcher.on_event((kind) => {
            queue_watcher_refresh(entry, kind);
        });
        entry.refreshWatcher = watcher;
    } catch (error) {
        watcher.dispose();
        throw error;
    }
}

function entry_for(file_path: string, platform: NodeJS.Platform): FileCoordinatorEntry {
    const fileKey = canonical_file_key(file_path, platform);
    let entry = entries.get(fileKey);
    if (!entry) {
        entry = {
            fileKey,
            statePath: fileKey,
            platform,
            watchIdentity: file_refresh_watch_identity(file_path, platform),
            stateReady: Promise.resolve(),
            aliases: new Set(),
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
        entries.set(fileKey, entry);
    }
    return entry;
}

function register_store(
    entry: FileCoordinatorEntry,
    raw_path: string,
    store: AuthorityFileStateStore | undefined,
): void {
    if (!store || entry.aliases.has(raw_path)) return;
    entry.aliases.add(raw_path);
    entry.operations += 1;
    const work = entry.stateReady.catch(() => {}).then(async () => {
        await store.canonicalize_path?.(
            entry.statePath,
            (candidate) => canonical_file_key(candidate, entry.platform),
        );
        if (raw_path !== entry.statePath) {
            const [stable, alias] = await Promise.all([
                store.read(entry.statePath),
                store.read(raw_path),
            ]);
            if (Object.keys(stable.state).length === 0 && Object.keys(alias.state).length > 0) {
                await store.compare_and_set(entry.statePath, stable.revision, alias.state as PerFileState);
            }
        }
        entry.authority = await read_authority(store, entry.statePath);
        void cleanup_authority(store, entry.statePath).catch(() => {});
    });
    entry.stateReady = work.finally(() => {
        entry.operations -= 1;
        cleanup(entry);
    });
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

function invalidate(entry: FileCoordinatorEntry, physical_change: boolean): void {
    for (const [token, state] of entry.states) {
        if (!state.valid || entry.activeTurn?.token === token) continue;
        if (token.kind === 'physical' || (token.kind === 'projection' && physical_change)) {
            reject_operation(entry, token, state);
        }
    }
    activate_turn(entry);
}

function invalidate_after_observed_advance(
    entry: FileCoordinatorEntry,
    finishing: AuthorityOperationToken,
    previous: FileAuthoritySnapshot,
    observed: DurableFileAuthority,
): void {
    const physical_change = previous.physicalRevision !== observed.physicalRevision
        || previous.physicalDigest !== observed.physicalDigest;
    const projection_change = previous.projectionRevision !== observed.projectionRevision;
    for (const [token, state] of entry.states) {
        if (!state.valid || token === finishing) continue;
        if (
            physical_change
            || (
                projection_change
                && token.kind === 'projection'
                && token.ordinal < finishing.ordinal
            )
        ) {
            reject_operation(entry, token, state);
        }
    }
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
    file_path: string,
    state_store?: AuthorityFileStateStore,
    platform: NodeJS.Platform = process.platform,
): FileCoordinatorAttachment {
    const entry = entry_for(file_path, platform);
    entry.attachments += 1;
    register_store(entry, file_path, state_store);
    let disposed = false;

    const attachment: FileCoordinatorAttachment = {
        statePath: entry.statePath,
        authority: () => snapshot(entry),
        state_ready: () => entry.stateReady,

        begin_physical(expectedAuthorityRevision, digest) {
            const basis = snapshot(entry);
            if (
                basis.authorityRevision !== expectedAuthorityRevision
                && basis.physicalDigest !== digest
            ) return { type: 'rejected', basis };
            invalidate(entry, basis.physicalDigest !== digest);
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
            state.requested = true;
            return new Promise<AuthorityCommitTurnResult>((resolve) => {
                entry.requests.set(token, { token, resolve });
                activate_turn(entry);
            });
        },

        start_finalization(turn) {
            if (entry.activeTurn !== turn || entry.activeTurn.phase !== 'granted') {
                throw new Error('The authority commit turn cannot begin finalization.');
            }
            entry.activeTurn.phase = 'finalizing';
        },

        finalize_authority_commit(token, turn, finalized) {
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
            const previousBasis = snapshot(entry);
            entry.authority = structuredClone(finalized.authority);
            entry.activeTurn = undefined;
            finish(entry, token);
            const base = {
                operationKind: token.kind,
                operationOrdinal: token.ordinal,
                previousBasis,
                resultingBasis: snapshot(entry),
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
            const previous = snapshot(entry);
            entry.authority = structuredClone(authority);
            invalidate_after_observed_advance(entry, token, previous, authority);
            entry.activeTurn = undefined;
            finish(entry, token);
            return snapshot(entry);
        },

        release_commit_turn(turn) {
            if (entry.activeTurn !== turn) return;
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
            await entry.stateReady;
            const basis = snapshot(entry);
            if (basis.physicalRevision !== command.expectedPhysicalRevision) {
                return { type: 'rejected', error: 'The worksheet changed before the header request arrived.' };
            }
            for (const [older, state] of entry.states) {
                if (
                    older.kind === 'projection'
                    && state.valid
                    && !state.requested
                    && entry.activeTurn?.token !== older
                ) {
                    state.valid = false;
                    const waiting = entry.requests.get(older);
                    if (waiting) {
                        entry.requests.delete(older);
                        waiting.resolve({ type: 'rejected' });
                    }
                }
            }
            const token = Object.freeze({
                ordinal: entry.nextOrdinal++,
                kind: 'projection' as const,
                basis,
                id: `projection:${entry.fileKey}:${command.requestId}:${Math.random()}`,
            });
            entry.states.set(token, { valid: true, requested: false });
            entry.operations += 1;
            let receipt: ExcelHeaderOperationReceipt | undefined;
            try {
                const names = command.planningInput.sheets.map((sheet) => sheet.name);
                for (;;) {
                    if (!attachment.operation_is_current(token)) {
                        return { type: 'rejected', error: 'The worksheet changed before the header setting could be saved.' };
                    }
                    const state_snapshot = await command.stateStore.read(entry.statePath);
                    const plan = plan_excel_override_state(
                        normalize_host_state(state_snapshot.state, names),
                        command.planningInput,
                        command.sheetIndex,
                        command.sheetName,
                        command.override,
                    );
                    if (!plan) return { type: 'rejected', error: 'The selected worksheet no longer matches this request.' };
                    const stage = await stage_authority(
                        command.stateStore,
                        entry.statePath,
                        {
                            id: token.id,
                            kind: 'projection',
                            ordinal: token.ordinal,
                            expectedStateRevision: state_snapshot.revision,
                            expectedCommitSequence: attachment.authority().commitSequence,
                            nextState: plan.state,
                        },
                    );
                    if (stage.type === 'conflict') continue;
                    const requested = await attachment.request_commit_turn(token);
                    if (requested.type === 'rejected') {
                        void discard_authority(command.stateStore, entry.statePath, token.id);
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
                    attachment.start_finalization(requested.turn);
                    let finalized: Awaited<ReturnType<typeof finalize_authority>>;
                    try {
                        finalized = await finalize_authority(
                            command.stateStore,
                            entry.statePath,
                            token.id,
                        );
                    } catch (error) {
                        const reconciled = await reconcile_finalization(
                            command.stateStore,
                            entry.statePath,
                            descriptor,
                        );
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
                            return {
                                type: 'rejected',
                                error: 'The durable workbook advanced during header finalization.',
                            };
                        } else {
                            attachment.release_commit_turn(requested.turn);
                            void discard_authority(command.stateStore, entry.statePath, token.id);
                            throw error;
                        }
                    }
                    if (finalized.type === 'conflict') {
                        attachment.release_commit_turn(requested.turn);
                        const state = entry.states.get(token);
                        if (state) state.requested = false;
                        const newer = [...entry.states.entries()].some(([candidate, candidate_state]) => (
                            candidate.kind === 'projection'
                            && candidate.ordinal > token.ordinal
                            && candidate_state.valid
                        ));
                        if (newer) {
                            if (state) state.valid = false;
                            void discard_authority(command.stateStore, entry.statePath, token.id);
                            return { type: 'rejected', error: 'A newer header setting superseded this request.' };
                        }
                        continue;
                    }
                    const authorityReceipt = attachment.finalize_authority_commit(
                        token,
                        requested.turn,
                        finalized,
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
                if (entry.activeTurn?.token === token) {
                    attachment.release_commit_turn(entry.activeTurn);
                }
                throw error;
            } finally {
                if (entry.states.has(token)) finish(entry, token);
                void discard_authority(command.stateStore, entry.statePath, token.id);
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
                async request(reason) {
                    if (subscriber.disposed || !entry.refreshSubscribers.has(subscriber)) {
                        return { type: 'disposed' };
                    }
                    // Consume this subscriber's checked-write reservation without
                    // flushing its watcher batch: postSave absorbs that revision.
                    release_reservation(false);
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
                        await dispatched.completion;
                        return { type: 'completed', event: dispatched.event };
                    } finally {
                        entry.refreshRequests -= 1;
                        cleanup(entry);
                    }
                },
                dispose() {
                    if (subscriber.disposed) return;
                    subscriber.disposed = true;
                    entry.refreshSubscribers.delete(subscriber);
                    while (subscriber.postSaveReservations > 0) {
                        release_reservation(true);
                    }
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
