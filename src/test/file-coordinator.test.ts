import { describe, expect, it, vi } from 'vitest';
import {
    acquire_file_coordinator,
    canonical_file_key,
    file_coordinator_registry_size,
    type AuthorityOperationToken,
    type ExcelHeaderOperationReceipt,
    type FileRefreshEvent,
    type PhysicalAuthorityCommitReceipt,
    type SuccessfulAuthorityFinalization,
} from '../file-coordinator';
import type {
    FileRefreshWatchIdentity,
    FileRefreshWatcher,
    FileRefreshWatcherEventKind,
    FileRefreshWatcherFactory,
} from '../file-refresh-watcher';
import type { FinalizationReconciliation } from '../finalization-reconciliation';
import type { ExcelHeaderPlanningInput } from '../data-source/excel-header-source';
import type { AuthorityFileStateStore, FileStateStore } from '../state';
import type { StoredPerFileState } from '../types';
import {
    finalize_authority,
    stage_authority,
    with_in_memory_authority_transactions,
} from '../state-authority';

function mapped_state_store(initial: Record<string, StoredPerFileState> = {}) {
    const values = new Map<string, { state: StoredPerFileState; revision: number }>();
    let next_revision = 1;
    for (const [key, state] of Object.entries(initial)) {
        values.set(key, { state: structuredClone(state), revision: next_revision++ });
    }
    const store: FileStateStore = {
        async read(path) {
            const value = values.get(path);
            return value
                ? { state: structuredClone(value.state), revision: value.revision }
                : { state: {}, revision: 0 };
        },
        async compare_and_set(path, expected, state, validate) {
            const current = values.get(path);
            const revision = current?.revision ?? 0;
            const validation = validate?.();
            if (
                revision !== expected
                || (validation !== undefined && validation !== true)
            ) {
                return {
                    type: 'conflict',
                    snapshot: current
                        ? { state: structuredClone(current.state), revision }
                        : { state: {}, revision: 0 },
                };
            }
            const committed = { state: structuredClone(state), revision: next_revision++ };
            values.set(path, committed);
            return {
                type: 'committed',
                snapshot: { state: structuredClone(state), revision: committed.revision },
            };
        },
        async canonicalize_path(canonical, canonical_key) {
            const aliases = [...values.keys()].filter((key) => (
                key !== canonical && canonical_key(key) === canonical
            ));
            if (!values.has(canonical) && aliases.length > 0) {
                const winner = aliases.reduce((left, right) => (
                    values.get(left)!.revision > values.get(right)!.revision
                        ? left
                        : right
                ));
                values.set(canonical, {
                    state: structuredClone(values.get(winner)!.state),
                    revision: next_revision++,
                });
            }
            for (const alias of aliases) values.delete(alias);
        },
        async touch() {},
    };
    return {
        store: with_in_memory_authority_transactions(store),
        value: (path: string) => values.get(path)?.state,
    };
}

const planning_input: ExcelHeaderPlanningInput = Object.freeze({
    hasFormatting: false,
    sheets: Object.freeze([Object.freeze({
        name: 'People',
        rowCount: 3,
        columnCount: 2,
        merges: Object.freeze([]),
        hasFormatting: false,
        columnNames: Object.freeze(['Name', 'Age']),
        detected: true,
    })]),
});

function begin_physical(
    coordinator: ReturnType<typeof acquire_file_coordinator>,
    digest: string,
): AuthorityOperationToken<'physical'> {
    const result = coordinator.begin_physical(
        coordinator.authority().authorityRevision,
        digest,
    );
    if (result.type !== 'started') throw new Error('operation rejected');
    return result.token;
}

async function establish(
    coordinator: ReturnType<typeof acquire_file_coordinator>,
    digest = 'digest-a',
    store: AuthorityFileStateStore = mapped_state_store().store,
) {
    const operation = begin_physical(coordinator, digest);
    const state = await store.read(coordinator.statePath);
    const staged = await stage_authority(store, coordinator.statePath, {
        id: operation.id,
        kind: 'physical',
        ordinal: operation.ordinal,
        expectedStateRevision: state.revision,
        expectedCommitSequence: coordinator.authority().commitSequence,
        physicalDigest: digest,
    });
    if (staged.type !== 'staged') throw new Error('stage rejected');
    const requested = await coordinator.request_commit_turn(operation);
    if (requested.type !== 'granted') throw new Error('turn rejected');
    const finalized = await finalize_authority(store, coordinator.statePath, operation.id);
    if (finalized.type !== 'finalized') throw new Error('finalize rejected');
    return coordinator.finalize_authority_commit(
        operation,
        requested.turn,
        finalized,
    ).resultingBasis;
}

function header_command(
    store: AuthorityFileStateStore,
    requestId: string,
    override: 'on' | 'off',
) {
    return {
        requestId,
        sheetIndex: 0,
        sheetName: 'People',
        override,
        originToken: Symbol(requestId),
        expectedPhysicalRevision: 1,
        planningInput: planning_input,
        stateStore: store,
    } as const;
}

class TestRefreshWatcher implements FileRefreshWatcher {
    readonly listeners = new Set<(kind: FileRefreshWatcherEventKind) => void>();
    disposeCalls = 0;

    on_event(listener: (kind: FileRefreshWatcherEventKind) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    emit(kind: FileRefreshWatcherEventKind): void {
        for (const listener of [...this.listeners]) listener(kind);
    }

    dispose(): void {
        this.disposeCalls += 1;
        this.listeners.clear();
    }
}

class TestRefreshWatcherFactory implements FileRefreshWatcherFactory {
    readonly identities: FileRefreshWatchIdentity[] = [];
    readonly watchers: TestRefreshWatcher[] = [];

    create(identity: FileRefreshWatchIdentity): FileRefreshWatcher {
        this.identities.push(identity);
        const watcher = new TestRefreshWatcher();
        this.watchers.push(watcher);
        return watcher;
    }
}

async function flush_refresh(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('file coordinator reservations', () => {
    it('keeps physical and projection revisions independent and reuses a digest', async () => {
        const path = `/tmp/coordinator-revisions-${Math.random()}.xlsx`;
        const state = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, state.store);

        expect(await establish(coordinator, 'a', state.store)).toMatchObject({
            physicalRevision: 1,
            projectionRevision: 0,
            authorityRevision: 1,
        });
        expect(await establish(coordinator, 'a', state.store)).toMatchObject({
            physicalRevision: 1,
            projectionRevision: 0,
            authorityRevision: 1,
        });
        await coordinator.commit_excel_header(header_command(state.store, 'h', 'off'));
        expect(coordinator.authority()).toMatchObject({
            physicalRevision: 1,
            projectionRevision: 1,
            authorityRevision: 2,
        });
        expect(await establish(coordinator, 'b', state.store)).toMatchObject({
            physicalRevision: 2,
            projectionRevision: 1,
            authorityRevision: 3,
        });
        coordinator.dispose();
    });

    it('returns ordered physical and projection receipts from exact finalizations', async () => {
        const path = `/tmp/coordinator-receipts-${Math.random()}.xlsx`;
        const state = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, state.store);
        const physical = begin_physical(coordinator, 'digest-receipt');
        const before = await state.store.read(coordinator.statePath);
        await stage_authority(state.store, coordinator.statePath, {
            id: physical.id,
            kind: 'physical',
            ordinal: physical.ordinal,
            expectedStateRevision: before.revision,
            expectedCommitSequence: 0,
            nextState: { activeSheetIndex: 1 },
            physicalDigest: 'digest-receipt',
        });
        const physical_turn = await coordinator.request_commit_turn(physical);
        if (physical_turn.type !== 'granted') throw new Error('turn rejected');
        const physical_finalized = await finalize_authority(
            state.store,
            coordinator.statePath,
            physical.id,
        );
        if (physical_finalized.type !== 'finalized') throw new Error('finalize rejected');
        const physical_receipt: PhysicalAuthorityCommitReceipt =
            coordinator.finalize_authority_commit(
                physical,
                physical_turn.turn,
                physical_finalized,
            );

        const projection = await coordinator.commit_excel_header(
            header_command(state.store, 'receipt-projection', 'off'),
        );
        if (projection.type !== 'committed') throw new Error('projection rejected');

        expect(physical_receipt).toMatchObject({
            operationKind: 'physical',
            operationOrdinal: 1,
            digest: 'digest-receipt',
            previousBasis: { authorityRevision: 0 },
            resultingBasis: {
                authorityRevision: 1,
                physicalRevision: 1,
                projectionRevision: 0,
            },
            stateSnapshot: physical_finalized.snapshot,
        });
        expect(projection.receipt).toMatchObject({
            operationKind: 'projection',
            operationOrdinal: 2,
            previousBasis: { authorityRevision: 1 },
            resultingBasis: {
                authorityRevision: 2,
                physicalRevision: 1,
                projectionRevision: 1,
            },
        });
        expect(projection.receipt.stateSnapshot).toEqual(
            await state.store.read(coordinator.statePath),
        );
        expect(Object.isFrozen(physical_receipt.stateSnapshot.state)).toBe(true);
        coordinator.dispose();
    });

    it('observes advanced authority without producing a commit receipt', async () => {
        const path = `/tmp/advanced-${Math.random()}.xlsx`;
        const coordinator = acquire_file_coordinator(path);
        const operation = begin_physical(coordinator, 'advanced-digest');
        const turn = await coordinator.request_commit_turn(operation);
        if (turn.type !== 'granted') throw new Error('turn rejected');
        coordinator.start_finalization(turn.turn);
        const invalidated = begin_physical(coordinator, 'queued-digest');

        const observed = coordinator.observe_advanced_authority(
            operation,
            turn.turn,
            {
                commitSequence: 4,
                authorityRevision: 3,
                physicalRevision: 2,
                projectionRevision: 1,
                physicalDigest: 'other-digest',
            },
        );

        expect(observed).toMatchObject({
            authorityRevision: 3,
            physicalRevision: 2,
            projectionRevision: 1,
        });
        expect(observed).not.toHaveProperty('operationKind');
        expect(observed).not.toHaveProperty('stateSnapshot');
        type Advanced = Extract<FinalizationReconciliation, { type: 'advanced' }>;
        type AdvancedCanFinalize = Advanced extends SuccessfulAuthorityFinalization
            ? true
            : false;
        const advanced_can_finalize: AdvancedCanFinalize = false;
        expect(advanced_can_finalize).toBe(false);
        expect(coordinator.operation_is_current(invalidated)).toBe(false);
        coordinator.cancel(invalidated);
        coordinator.dispose();
        expect(file_coordinator_registry_size()).toBe(0);
    });

    it('rejects a queued projection when observed reconciliation advances physical authority', async () => {
        const path = `/tmp/observed-physical-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        const active = begin_physical(coordinator, 'candidate-digest');
        const active_turn = await coordinator.request_commit_turn(active);
        if (active_turn.type !== 'granted') throw new Error('turn rejected');
        coordinator.start_finalization(active_turn.turn);

        let projection_stages = 0;
        let projection_staged!: () => void;
        const projection_ready = new Promise<void>((resolve) => {
            projection_staged = resolve;
        });
        const store: AuthorityFileStateStore = {
            ...base.store,
            async stage_authority_transaction(file_path, stage) {
                const result = await base.store.stage_authority_transaction(file_path, stage);
                if (stage.kind === 'projection') {
                    projection_stages += 1;
                    projection_staged();
                }
                return result;
            },
        };
        const queued = coordinator.commit_excel_header(
            header_command(store, 'stale-physical-plan', 'off'),
        );
        await projection_ready;

        const previous = coordinator.authority();
        coordinator.observe_advanced_authority(active, active_turn.turn, {
            commitSequence: previous.commitSequence + 1,
            authorityRevision: previous.authorityRevision + 1,
            physicalRevision: previous.physicalRevision + 1,
            projectionRevision: previous.projectionRevision,
            physicalDigest: 'external-digest',
        });

        await expect(queued).resolves.toMatchObject({ type: 'rejected' });
        expect(projection_stages).toBe(1);
        expect(base.value(coordinator.statePath) ?? {}).not.toHaveProperty(
            'excelFirstRowHeaders.People',
        );
        const cleanup = begin_physical(coordinator, 'cleanup-digest');
        const cleanup_turn = await coordinator.request_commit_turn(cleanup);
        expect(cleanup_turn.type).toBe('granted');
        if (cleanup_turn.type === 'granted') {
            coordinator.release_commit_turn(cleanup_turn.turn);
        }
        coordinator.cancel(cleanup);
        coordinator.dispose();
    });

    it('rejects an older queued projection after an observed projection-only advance', async () => {
        const path = `/tmp/observed-older-projection-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);

        let release_read!: () => void;
        const read_gate = new Promise<void>((resolve) => { release_read = resolve; });
        let read_started!: () => void;
        const read_ready = new Promise<void>((resolve) => { read_started = resolve; });
        let projection_staged!: () => void;
        const stage_ready = new Promise<void>((resolve) => { projection_staged = resolve; });
        let gate_once = true;
        const store: AuthorityFileStateStore = {
            ...base.store,
            async read(file_path) {
                if (gate_once) {
                    gate_once = false;
                    read_started();
                    await read_gate;
                }
                return base.store.read(file_path);
            },
            async stage_authority_transaction(file_path, stage) {
                const result = await base.store.stage_authority_transaction(file_path, stage);
                if (stage.kind === 'projection') projection_staged();
                return result;
            },
        };
        const older = coordinator.commit_excel_header(
            header_command(store, 'older-projection', 'off'),
        );
        await read_ready;

        const active = begin_physical(coordinator, 'digest-a');
        const active_turn = await coordinator.request_commit_turn(active);
        if (active_turn.type !== 'granted') throw new Error('turn rejected');
        coordinator.start_finalization(active_turn.turn);
        release_read();
        await stage_ready;

        const external_state = await base.store.read(coordinator.statePath);
        const external_authority = await base.store.read_authority(coordinator.statePath);
        const external_id = `external-older:${Math.random()}`;
        const external_stage = await stage_authority(base.store, coordinator.statePath, {
            id: external_id,
            kind: 'projection',
            ordinal: active.ordinal,
            expectedStateRevision: external_state.revision,
            expectedCommitSequence: external_authority.commitSequence,
        });
        if (external_stage.type !== 'staged') throw new Error('external stage rejected');
        const external = await finalize_authority(
            base.store,
            coordinator.statePath,
            external_id,
        );
        if (external.type !== 'finalized') throw new Error('external finalize rejected');

        coordinator.observe_advanced_authority(active, active_turn.turn, external.authority);

        await expect(older).resolves.toMatchObject({ type: 'rejected' });
        const cleanup = begin_physical(coordinator, 'digest-a');
        const cleanup_turn = await coordinator.request_commit_turn(cleanup);
        expect(cleanup_turn.type).toBe('granted');
        if (cleanup_turn.type === 'granted') {
            coordinator.release_commit_turn(cleanup_turn.turn);
        }
        coordinator.cancel(cleanup);
        coordinator.dispose();
    });

    it('preserves newer queued projection order after an observed projection-only advance', async () => {
        const path = `/tmp/observed-projection-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        const active = begin_physical(coordinator, 'digest-a');
        const active_turn = await coordinator.request_commit_turn(active);
        if (active_turn.type !== 'granted') throw new Error('turn rejected');
        coordinator.start_finalization(active_turn.turn);

        let projection_staged!: () => void;
        const projection_ready = new Promise<void>((resolve) => {
            projection_staged = resolve;
        });
        const store: AuthorityFileStateStore = {
            ...base.store,
            async stage_authority_transaction(file_path, stage) {
                const result = await base.store.stage_authority_transaction(file_path, stage);
                if (stage.kind === 'projection' && stage.id.includes('newer-projection')) {
                    projection_staged();
                }
                return result;
            },
        };
        const queued = coordinator.commit_excel_header(
            header_command(store, 'newer-projection', 'off'),
        );
        await projection_ready;

        const external_state = await base.store.read(coordinator.statePath);
        const external_authority = await base.store.read_authority(coordinator.statePath);
        const external_id = `external:${Math.random()}`;
        const external_stage = await stage_authority(
            base.store,
            coordinator.statePath,
            {
                id: external_id,
                kind: 'projection',
                ordinal: active.ordinal,
                expectedStateRevision: external_state.revision,
                expectedCommitSequence: external_authority.commitSequence,
            },
        );
        if (external_stage.type !== 'staged') throw new Error('external stage rejected');
        const external = await finalize_authority(
            base.store,
            coordinator.statePath,
            external_id,
        );
        if (external.type !== 'finalized') throw new Error('external finalize rejected');

        coordinator.observe_advanced_authority(
            active,
            active_turn.turn,
            external.authority,
        );

        await expect(queued).resolves.toMatchObject({ type: 'committed' });
        expect(coordinator.authority()).toMatchObject({
            physicalRevision: 1,
            projectionRevision: 2,
            authorityRevision: 3,
        });
        expect(base.value(coordinator.statePath)).toMatchObject({
            excelFirstRowHeaders: { People: 'off' },
        });
        coordinator.dispose();
    });

    it('retains one shared entry through the final active reservation', async () => {
        const path = `/tmp/coordinator-lifetime-${Math.random()}.xlsx`;
        const first = acquire_file_coordinator(path);
        const second = acquire_file_coordinator(path);
        const reservation = begin_physical(first, 'a');
        first.dispose();
        second.dispose();
        expect(file_coordinator_registry_size()).toBe(1);
        first.cancel(reservation);
        expect(file_coordinator_registry_size()).toBe(0);
    });

    it('does not poison queued reservations after a rejection', async () => {
        const path = `/tmp/coordinator-rejection-${Math.random()}.xlsx`;
        const coordinator = acquire_file_coordinator(path);
        await establish(coordinator, 'current');
        const rejected = coordinator.begin_physical(0, 'stale');
        expect(rejected.type).toBe('rejected');
        const next = begin_physical(coordinator, 'next');
        coordinator.cancel(next);
        coordinator.dispose();
    });

    it('keeps synchronous inspection and operation start reentrant-safe', () => {
        const coordinator = acquire_file_coordinator(`/tmp/sync-${Math.random()}.xlsx`);
        const before = coordinator.authority();
        const first = coordinator.begin_physical(before.authorityRevision, 'a');
        expect(first.type).toBe('started');
        expect(coordinator.authority()).toEqual(before);
        const second = coordinator.begin_physical(before.authorityRevision, 'b');
        expect(second.type).toBe('started');
        if (first.type === 'started') coordinator.cancel(first.token);
        if (second.type === 'started') coordinator.cancel(second.token);
        coordinator.dispose();
    });

    it('resolves an invalidated requested waiter', async () => {
        const coordinator = acquire_file_coordinator(`/tmp/stale-turn-${Math.random()}.xlsx`);
        const first = begin_physical(coordinator, 'a');
        const active = await coordinator.request_commit_turn(first);
        if (active.type !== 'granted') throw new Error('turn rejected');
        const second = begin_physical(coordinator, 'b');
        const requested = coordinator.request_commit_turn(second);
        coordinator.cancel(second);
        await expect(requested).resolves.toEqual({ type: 'rejected' });
        coordinator.release_commit_turn(active.turn);
        coordinator.cancel(first);
        coordinator.dispose();
    });

    it('rejects delayed older header planning when a newer token supersedes it', async () => {
        const path = `/tmp/coordinator-order-${Math.random()}.xlsx`;
        const state = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, state.store);
        await establish(coordinator, 'digest-a', state.store);
        const receipts: ExcelHeaderOperationReceipt[] = [];
        const subscription = coordinator.subscribe_excel_headers((receipt) => {
            receipts.push(receipt);
        });

        const [first, second] = await Promise.all([
            coordinator.commit_excel_header(header_command(state.store, 'first', 'off')),
            coordinator.commit_excel_header(header_command(state.store, 'second', 'on')),
        ]);

        expect(first.type).toBe('rejected');
        expect(second.type).toBe('committed');
        expect(receipts.map((receipt) => [
            receipt.operationOrdinal,
            receipt.resultingBasis.projectionRevision,
        ])).toEqual([[3, 1]]);
        expect(state.value(coordinator.statePath)).toMatchObject({
            excelFirstRowHeaders: { People: 'on' },
        });
        subscription.dispose();
        coordinator.dispose();
    });

    it('terminates conflicted A when newer queued B exists', async () => {
        const path = `/tmp/projection-conflict-newer-${Math.random()}.xlsx`;
        const state = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, state.store);
        await establish(coordinator, 'digest-a', state.store);
        let release_a!: () => void;
        const a_gate = new Promise<void>((resolve) => { release_a = resolve; });
        let mark_a_started!: () => void;
        const a_started = new Promise<void>((resolve) => { mark_a_started = resolve; });
        const store: AuthorityFileStateStore = {
            ...state.store,
            async finalize_authority_transaction(file_path, id) {
                if (id.includes(':A:')) {
                    mark_a_started();
                    await a_gate;
                    return {
                        type: 'conflict',
                        snapshot: await state.store.read(file_path),
                        authority: await state.store.read_authority(file_path),
                    };
                }
                return state.store.finalize_authority_transaction(file_path, id);
            },
        };
        const a = coordinator.commit_excel_header(
            header_command(store, 'A', 'off'),
        );
        await a_started;
        const b = coordinator.commit_excel_header(
            header_command(store, 'B', 'on'),
        );
        release_a();
        await expect(a).resolves.toMatchObject({ type: 'rejected' });
        await expect(b).resolves.toMatchObject({ type: 'committed' });
        expect(state.value(coordinator.statePath)).toMatchObject({
            excelFirstRowHeaders: { People: 'on' },
        });
        coordinator.dispose();
    });

    it('releases authority before fire-and-converge subscribers run', async () => {
        const path = `/tmp/coordinator-subscriber-${Math.random()}.xlsx`;
        const state = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, state.store);
        await establish(coordinator, 'digest-a', state.store);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const nested = vi.fn();
        const subscription = coordinator.subscribe_excel_headers(async () => {
            const reservation = begin_physical(coordinator, 'digest-a');
            nested();
            coordinator.cancel(reservation);
            await gate;
        });

        await expect(coordinator.commit_excel_header(
            header_command(state.store, 'notify', 'off'),
        )).resolves.toMatchObject({ type: 'committed' });
        await Promise.resolve();
        expect(nested).toHaveBeenCalledOnce();
        release();
        subscription.dispose();
        coordinator.dispose();
    });

    it('does not let an unrequested older operation block a requested newer one', async () => {
        const coordinator = acquire_file_coordinator(`/tmp/requested-only-${Math.random()}.xlsx`);
        const older = begin_physical(coordinator, 'a');
        const newer = begin_physical(coordinator, 'b');
        const requested = await coordinator.request_commit_turn(newer);
        expect(requested.type).toBe('granted');
        if (requested.type === 'granted') coordinator.release_commit_turn(requested.turn);
        coordinator.cancel(older);
        coordinator.cancel(newer);
        coordinator.dispose();
    });

    it('releases a requested turn after finalization failure', async () => {
        const path = `/tmp/finalize-failure-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        const store: AuthorityFileStateStore = {
            ...base.store,
            async finalize_authority_transaction() {
                throw new Error('finalize failed');
            },
            async inspect_authority_transaction(file_path) {
                return {
                    snapshot: await base.store.read(file_path),
                    authority: await base.store.read_authority(file_path),
                    stagePresent: true,
                };
            },
        };
        await expect(coordinator.commit_excel_header(
            header_command(store, 'failure', 'off'),
        )).rejects.toThrow('finalize failed');

        const next = begin_physical(coordinator, 'digest-b');
        const requested = await coordinator.request_commit_turn(next);
        expect(requested.type).toBe('granted');
        if (requested.type === 'granted') coordinator.release_commit_turn(requested.turn);
        coordinator.cancel(next);
        coordinator.dispose();
    });

    it('reconciles a projection that commits and then reports an error', async () => {
        const path = `/tmp/ambiguous-projection-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        const store: AuthorityFileStateStore = {
            ...base.store,
            async finalize_authority_transaction(file_path, id) {
                await base.store.finalize_authority_transaction(file_path, id);
                throw new Error('ambiguous finalize');
            },
        };
        const notified = vi.fn();
        const subscription = coordinator.subscribe_excel_headers(notified);
        await expect(coordinator.commit_excel_header(
            header_command(store, 'ambiguous', 'off'),
        )).resolves.toMatchObject({ type: 'committed' });
        expect(notified).toHaveBeenCalledOnce();
        expect(coordinator.authority()).toMatchObject({
            projectionRevision: 1,
            authorityRevision: 2,
        });
        expect(base.value(coordinator.statePath)).toMatchObject({
            excelFirstRowHeaders: { People: 'off' },
        });
        subscription.dispose();
        coordinator.dispose();
    });

    it('discards a projection stage after observing an advanced reconciliation', async () => {
        const path = `/tmp/advanced-projection-stage-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        let local_id = '';
        const store: AuthorityFileStateStore = {
            ...base.store,
            async finalize_authority_transaction(file_path, id) {
                local_id = id;
                const state = await base.store.read(file_path);
                const authority = await base.store.read_authority(file_path);
                const external_id = `external-advance:${Math.random()}`;
                const staged = await stage_authority(base.store, file_path, {
                    id: external_id,
                    kind: 'projection',
                    ordinal: 999,
                    expectedStateRevision: state.revision,
                    expectedCommitSequence: authority.commitSequence,
                });
                if (staged.type !== 'staged') throw new Error('external stage rejected');
                const external = await finalize_authority(
                    base.store,
                    file_path,
                    external_id,
                );
                if (external.type !== 'finalized') {
                    throw new Error('external finalize rejected');
                }
                throw new Error('ambiguous advanced finalize');
            },
        };

        await expect(coordinator.commit_excel_header(
            header_command(store, 'advanced-stage', 'off'),
        )).resolves.toMatchObject({
            type: 'rejected',
            error: 'The durable workbook advanced during header finalization.',
        });
        expect(local_id).not.toBe('');
        await vi.waitFor(async () => {
            const inspection = await base.store.inspect_authority_transaction(
                coordinator.statePath,
                local_id,
            );
            expect(inspection.stagePresent).toBe(false);
        });
        coordinator.dispose();
    });

    it('cannot cancel an active finalization and starts the next turn afterward', async () => {
        const path = `/tmp/active-finalize-${Math.random()}.xlsx`;
        const state = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, state.store);
        const first = begin_physical(coordinator, 'a');
        const snapshot = await state.store.read(coordinator.statePath);
        await stage_authority(state.store, coordinator.statePath, {
            id: first.id, kind: 'physical', ordinal: first.ordinal,
            expectedStateRevision: snapshot.revision,
            expectedCommitSequence: 0,
            physicalDigest: 'a',
        });
        const first_turn = await coordinator.request_commit_turn(first);
        if (first_turn.type !== 'granted') throw new Error('turn rejected');
        coordinator.start_finalization(first_turn.turn);
        coordinator.cancel(first);

        const second = begin_physical(coordinator, 'b');
        const second_wait = coordinator.request_commit_turn(second);
        const finalized = await finalize_authority(
            state.store,
            coordinator.statePath,
            first.id,
        );
        if (finalized.type !== 'finalized') throw new Error('finalize rejected');
        coordinator.finalize_authority_commit(
            first,
            first_turn.turn,
            finalized,
        );
        const second_turn = await second_wait;
        expect(second_turn.type).toBe('granted');
        if (second_turn.type === 'granted') coordinator.release_commit_turn(second_turn.turn);
        coordinator.cancel(second);
        expect(coordinator.authority().physicalDigest).toBe('a');
        coordinator.dispose();
    });

    it('keeps a submitted command alive after the origin attachment closes', async () => {
        const path = `/tmp/coordinator-origin-${Math.random()}.xlsx`;
        const state = mapped_state_store();
        const origin = acquire_file_coordinator(path, state.store);
        const secondary = acquire_file_coordinator(path, state.store);
        await establish(origin, 'digest-a', state.store);
        const notified = vi.fn();
        const subscription = secondary.subscribe_excel_headers(notified);
        const command = origin.commit_excel_header(
            header_command(state.store, 'survives', 'off'),
        );
        origin.dispose();
        await expect(command).resolves.toMatchObject({ type: 'committed' });
        expect(notified).toHaveBeenCalledOnce();
        subscription.dispose();
        secondary.dispose();
    });
});

describe('file coordinator refresh stream', () => {
    it('shares one watcher and stream across canonical aliases', async () => {
        const factory = new TestRefreshWatcherFactory();
        const first = acquire_file_coordinator('C:\\Data\\Book.xlsx', undefined, 'win32');
        const second = acquire_file_coordinator('c:\\data\\book.xlsx', undefined, 'win32');
        const first_events: FileRefreshEvent[] = [];
        const second_events: FileRefreshEvent[] = [];
        const one = first.subscribe_refresh((event) => { first_events.push(event); }, factory);
        const two = second.subscribe_refresh((event) => { second_events.push(event); }, factory);

        expect(factory.watchers).toHaveLength(1);
        expect(factory.identities[0]).toMatchObject({
            fileKey: 'c:\\data\\book.xlsx',
            filePath: 'C:\\Data\\Book.xlsx',
            directory: 'C:\\Data',
            basename: 'Book.xlsx',
        });
        factory.watchers[0].emit('change');
        await flush_refresh();
        expect(first_events).toEqual(second_events);
        expect(first_events).toMatchObject([{
            refreshRevision: 1,
            episode: 1,
            reason: 'watcherChange',
            priority: 'normal',
        }]);
        expect(first_events[0]).not.toBe(second_events[0]);
        expect(Object.isFrozen(first_events[0])).toBe(true);

        one.dispose();
        two.dispose();
        first.dispose();
        expect(factory.watchers[0].disposeCalls).toBe(0);
        second.dispose();
        expect(factory.watchers[0].disposeCalls).toBe(1);
    });

    it('keeps Darwin case-distinct watch entries', () => {
        const factory = new TestRefreshWatcherFactory();
        const upper = acquire_file_coordinator('/Volumes/Case/Book.xlsx', undefined, 'darwin');
        const lower = acquire_file_coordinator('/Volumes/Case/book.xlsx', undefined, 'darwin');
        const a = upper.subscribe_refresh(() => {}, factory);
        const b = lower.subscribe_refresh(() => {}, factory);
        expect(factory.watchers).toHaveLength(2);
        expect(factory.identities.map((identity) => identity.filePath)).toEqual([
            '/Volumes/Case/Book.xlsx',
            '/Volumes/Case/book.xlsx',
        ]);
        a.dispose();
        b.dispose();
        upper.dispose();
        lower.dispose();
        expect(factory.watchers.map((watcher) => watcher.disposeCalls)).toEqual([1, 1]);
    });

    it('retains the watcher through the last attachment, operation, and subscriber', () => {
        const factory = new TestRefreshWatcherFactory();
        const coordinator = acquire_file_coordinator(`/tmp/refresh-lifetime-${Math.random()}.csv`);
        const refresh = coordinator.subscribe_refresh(() => {}, factory);
        const excel = coordinator.subscribe_excel_headers(() => {});
        const operation = begin_physical(coordinator, 'digest');

        coordinator.dispose();
        refresh.dispose();
        expect(factory.watchers[0].disposeCalls).toBe(0);
        excel.dispose();
        expect(factory.watchers[0].disposeCalls).toBe(0);
        coordinator.cancel(operation);
        expect(factory.watchers[0].disposeCalls).toBe(1);
        expect(file_coordinator_registry_size()).toBe(0);
    });

    it('retains the entry and watcher through a pending flush', async () => {
        const factory = new TestRefreshWatcherFactory();
        const coordinator = acquire_file_coordinator(`/tmp/pending-refresh-${Math.random()}.csv`);
        const subscription = coordinator.subscribe_refresh(() => {}, factory);
        factory.watchers[0].emit('change');
        subscription.dispose();
        coordinator.dispose();

        expect(file_coordinator_registry_size()).toBe(1);
        expect(factory.watchers[0].disposeCalls).toBe(0);
        await flush_refresh();
        expect(file_coordinator_registry_size()).toBe(0);
        expect(factory.watchers[0].disposeCalls).toBe(1);
    });

    it('retains one shared entry through requesting-subscriber completion', async () => {
        const factory = new TestRefreshWatcherFactory();
        const file_path = `/tmp/request-lifetime-${Math.random()}.csv`;
        const first = acquire_file_coordinator(file_path);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const first_subscription = first.subscribe_refresh(() => gate, factory);
        const request = first_subscription.request('postSave');
        first_subscription.dispose();
        first.dispose();

        expect(file_coordinator_registry_size()).toBe(1);
        expect(factory.watchers[0].disposeCalls).toBe(0);
        const second = acquire_file_coordinator(file_path);
        const second_subscription = second.subscribe_refresh(() => {}, factory);
        expect(factory.watchers).toHaveLength(1);

        release();
        await expect(request).resolves.toMatchObject({ type: 'completed' });
        expect(factory.watchers[0].disposeCalls).toBe(0);
        second_subscription.dispose();
        second.dispose();
        expect(factory.watchers[0].disposeCalls).toBe(1);
        expect(file_coordinator_registry_size()).toBe(0);
    });

    it('coalesces watcher reasons while preserving revisions and episodes', async () => {
        const factory = new TestRefreshWatcherFactory();
        const coordinator = acquire_file_coordinator(`/tmp/coalesce-${Math.random()}.csv`);
        const events: FileRefreshEvent[] = [];
        const subscription = coordinator.subscribe_refresh((event) => { events.push(event); }, factory);
        const watcher = factory.watchers[0];

        watcher.emit('change');
        watcher.emit('create');
        watcher.emit('change');
        await flush_refresh();
        watcher.emit('delete');
        watcher.emit('create');
        await flush_refresh();

        expect(events).toMatchObject([
            { refreshRevision: 3, episode: 1, reason: 'watcherCreate', priority: 'normal' },
            { refreshRevision: 5, episode: 2, reason: 'watcherCreate', priority: 'normal' },
        ]);
        subscription.dispose();
        coordinator.dispose();
    });

    it('lets postSave absorb pending watcher work but not later signals', async () => {
        const factory = new TestRefreshWatcherFactory();
        const coordinator = acquire_file_coordinator(`/tmp/post-save-${Math.random()}.csv`);
        const events: FileRefreshEvent[] = [];
        const subscription = coordinator.subscribe_refresh((event) => { events.push(event); }, factory);
        const watcher = factory.watchers[0];

        watcher.emit('change');
        const requested = subscription.request('postSave');
        watcher.emit('delete');
        await expect(requested).resolves.toMatchObject({
            type: 'completed',
            event: { refreshRevision: 2, episode: 1, reason: 'postSave', priority: 'high' },
        });
        await flush_refresh();
        expect(events).toMatchObject([
            { refreshRevision: 2, episode: 1, reason: 'postSave', priority: 'high' },
            { refreshRevision: 3, episode: 2, reason: 'watcherDelete', priority: 'normal' },
        ]);

        subscription.dispose();
        coordinator.dispose();
    });

    it('forms a later watcher episode while subscriber work is still pending', async () => {
        const factory = new TestRefreshWatcherFactory();
        const coordinator = acquire_file_coordinator(`/tmp/in-flight-refresh-${Math.random()}.csv`);
        const events: FileRefreshEvent[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const subscription = coordinator.subscribe_refresh((event) => {
            events.push(event);
            if (event.reason === 'postSave') return gate;
        }, factory);

        const request = subscription.request('postSave');
        factory.watchers[0].emit('change');
        await flush_refresh();
        expect(events).toMatchObject([
            { refreshRevision: 1, episode: 1, reason: 'postSave' },
            { refreshRevision: 2, episode: 2, reason: 'watcherChange' },
        ]);
        release();
        await expect(request).resolves.toMatchObject({ type: 'completed' });
        subscription.dispose();
        coordinator.dispose();
    });

    it('starts every subscriber and isolates requesting completion from failures and hangs', async () => {
        const factory = new TestRefreshWatcherFactory();
        const coordinator = acquire_file_coordinator(`/tmp/isolation-${Math.random()}.csv`);
        const starts: string[] = [];
        let release_requester!: () => void;
        const requester_gate = new Promise<void>((resolve) => { release_requester = resolve; });
        const requester = coordinator.subscribe_refresh(() => {
            starts.push('requester');
            return requester_gate;
        }, factory);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const throwing = coordinator.subscribe_refresh(() => {
            starts.push('throwing');
            throw new Error('subscriber failed');
        }, factory);
        const hanging = coordinator.subscribe_refresh(() => {
            starts.push('hanging');
            return new Promise<void>(() => {});
        }, factory);

        let request_settled = false;
        const request = requester.request('postSave').then((result) => {
            request_settled = true;
            return result;
        });
        await Promise.resolve();
        expect(starts).toEqual(['requester', 'throwing', 'hanging']);
        expect(request_settled).toBe(false);
        release_requester();
        await expect(request).resolves.toMatchObject({ type: 'completed' });
        expect(error).toHaveBeenCalledOnce();

        requester.dispose();
        throwing.dispose();
        hanging.dispose();
        coordinator.dispose();
        error.mockRestore();
    });

    it('does not interact with authority turns and safely rejects disposed requests', async () => {
        const factory = new TestRefreshWatcherFactory();
        const coordinator = acquire_file_coordinator(`/tmp/no-turn-${Math.random()}.csv`);
        const operation = begin_physical(coordinator, 'digest');
        const before = coordinator.authority();
        const subscription = coordinator.subscribe_refresh(() => {}, factory);
        await expect(subscription.request('postSave')).resolves.toMatchObject({ type: 'completed' });
        expect(coordinator.operation_is_current(operation)).toBe(true);
        expect(coordinator.authority()).toEqual(before);

        subscription.dispose();
        await expect(subscription.request('postSave')).resolves.toEqual({ type: 'disposed' });
        coordinator.cancel(operation);
        coordinator.dispose();
        expect(factory.watchers[0].disposeCalls).toBe(1);
    });

    it('cleans up after a throwing watcher subscriber', async () => {
        const factory = new TestRefreshWatcherFactory();
        const coordinator = acquire_file_coordinator(`/tmp/throw-cleanup-${Math.random()}.csv`);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const subscription = coordinator.subscribe_refresh(() => {
            throw new Error('refresh failed');
        }, factory);
        factory.watchers[0].emit('create');
        await flush_refresh();
        subscription.dispose();
        coordinator.dispose();

        expect(error).toHaveBeenCalledOnce();
        expect(file_coordinator_registry_size()).toBe(0);
        expect(factory.watchers[0].disposeCalls).toBe(1);
        error.mockRestore();
    });
});

describe('file coordinator identity', () => {
    it('keeps canonical Windows state authoritative and retires aliases', async () => {
        const upper = 'C:\\Data\\Book.xlsx';
        const lower = 'c:\\data\\book.xlsx';
        const stable = canonical_file_key(upper, 'win32');
        const state = mapped_state_store({
            [upper]: { activeSheetIndex: 2 },
            [lower]: { activeSheetIndex: 7 },
        });
        const first = acquire_file_coordinator(upper, state.store, 'win32');
        const second = acquire_file_coordinator(lower, state.store, 'win32');
        await Promise.all([first.state_ready(), second.state_ready()]);

        expect(first.authority()).toEqual(second.authority());
        expect(first.statePath).toBe(stable);
        expect(second.statePath).toBe(stable);
        expect(state.value(stable)).toMatchObject({ activeSheetIndex: 7 });
        first.dispose();
        second.dispose();

        const reopened = acquire_file_coordinator(upper, state.store, 'win32');
        await reopened.state_ready();
        expect(reopened.statePath).toBe(stable);
        expect(state.value(reopened.statePath)).toMatchObject({ activeSheetIndex: 7 });
        reopened.dispose();
    });

    it('discovers an uppercase Windows legacy key on lowercase first reopen', async () => {
        const upper = 'C:\\Data\\Legacy.xlsx';
        const lower = 'c:\\data\\legacy.xlsx';
        const stable = canonical_file_key(lower, 'win32');
        const state = mapped_state_store({
            [upper]: { activeSheetIndex: 4 },
        });

        const coordinator = acquire_file_coordinator(lower, state.store, 'win32');
        await coordinator.state_ready();
        expect(coordinator.statePath).toBe(stable);
        expect(state.value(stable)).toMatchObject({ activeSheetIndex: 4 });
        expect(state.value(upper)).toBeUndefined();
        coordinator.dispose();
    });

    it('keeps case-distinct macOS paths separate under explicit policy', () => {
        const upper = canonical_file_key('/Volumes/Case/Book.xlsx', 'darwin');
        const lower = canonical_file_key('/Volumes/Case/book.xlsx', 'darwin');
        expect(upper).not.toBe(lower);
        const first = acquire_file_coordinator('/Volumes/Case/Book.xlsx', undefined, 'darwin');
        const second = acquire_file_coordinator('/Volumes/Case/book.xlsx', undefined, 'darwin');
        expect(first.authority().fileKey).not.toBe(second.authority().fileKey);
        first.dispose();
        second.dispose();
    });
});
