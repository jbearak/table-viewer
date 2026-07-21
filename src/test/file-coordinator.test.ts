import { describe, expect, it, vi } from 'vitest';
import * as vscode_mock from './mocks/vscode';
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
    read_authority,
    release_authority_fallback,
    stage_authority,
    with_in_memory_authority_transactions,
} from '../state-authority';

function mapped_state_store(initial: Record<string, StoredPerFileState> = {}) {
    const values = new Map<string, { state: StoredPerFileState; revision: number }>();
    const copies = new Map<string, {
        id: string;
        source: string;
        sourceSnapshot: { state: StoredPerFileState; revision: number };
        destinationSnapshot: { state: StoredPerFileState; revision: number };
    }>();
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
            copies.delete(path);
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
        async copy_entry_if_absent(source, destination, copy_id) {
            const current = values.get(destination);
            if (current) {
                const prior = copies.get(destination);
                if (prior?.id === copy_id && prior.source === source) {
                    return {
                        type: 'copied',
                        source: structuredClone(prior.sourceSnapshot),
                        destination: structuredClone(prior.destinationSnapshot),
                    };
                }
                return {
                    type: 'destinationExists',
                    destination: {
                        state: structuredClone(current.state),
                        revision: current.revision,
                    },
                };
            }
            const source_value = values.get(source);
            if (!source_value) {
                const absent = { state: {}, revision: 0 };
                return {
                    type: 'sourceAbsent',
                    source: absent,
                    destination: structuredClone(absent),
                };
            }
            const source_snapshot = {
                state: structuredClone(source_value.state),
                revision: source_value.revision,
            };
            const destination_snapshot = {
                state: structuredClone(source_value.state),
                revision: next_revision++,
            };
            values.set(destination, structuredClone(destination_snapshot));
            copies.set(destination, {
                id: copy_id,
                source,
                sourceSnapshot: source_snapshot,
                destinationSnapshot: destination_snapshot,
            });
            return {
                type: 'copied',
                source: structuredClone(source_snapshot),
                destination: structuredClone(destination_snapshot),
            };
        },
        async touch() {},
    };
    return {
        backing: store,
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
    await coordinator.state_ready();
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
    const finalization_basis = coordinator.authority();
    const finalized = await finalize_authority(store, coordinator.statePath, operation.id);
    if (finalized.type !== 'finalized') throw new Error('finalize rejected');
    return coordinator.finalize_authority_commit(
        operation,
        requested.turn,
        finalized,
        finalization_basis,
    ).resultingBasis;
}

function header_command(
    store: AuthorityFileStateStore,
    requestId: string,
    override: 'on' | 'off',
    expected_digest = 'digest-a',
) {
    return {
        requestId,
        sheetIndex: 0,
        sheetName: 'People',
        override,
        originToken: Symbol(requestId),
        expectedPhysicalRevision: 1,
        expectedPhysicalDigest: expected_digest,
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
        await coordinator.commit_excel_header(header_command(state.store, 'h', 'off', 'a'));
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
        await coordinator.state_ready();
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
        const physical_finalization_basis = coordinator.authority();
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
                physical_finalization_basis,
            );

        const projection = await coordinator.commit_excel_header(
            header_command(state.store, 'receipt-projection', 'off', 'digest-receipt'),
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

    it('returns indeterminate when finalization and reconciliation inspection both fail', async () => {
        const path = `/tmp/finalize-reconcile-failure-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        let projection_id = '';
        const store: AuthorityFileStateStore = {
            ...base.store,
            async finalize_authority_transaction(file_path, id) {
                if (!id.startsWith('projection:')) {
                    return base.store.finalize_authority_transaction(file_path, id);
                }
                projection_id = id;
                const result = await base.store.finalize_authority_transaction(file_path, id);
                if (result.type !== 'finalized') return result;
                throw new Error('ambiguous finalize');
            },
            async inspect_authority_transaction(file_path, id) {
                if (id === projection_id) throw new Error('inspection unavailable');
                return base.store.inspect_authority_transaction(file_path, id);
            },
        };
        const notified = vi.fn();
        const subscription = coordinator.subscribe_excel_headers(notified);
        const factory = new TestRefreshWatcherFactory();
        const recovery_events: FileRefreshEvent[] = [];
        const refresh = coordinator.subscribe_refresh((event) => {
            recovery_events.push(event);
        }, factory);

        await expect(coordinator.commit_excel_header(
            header_command(store, 'double-failure', 'off'),
        )).resolves.toMatchObject({ type: 'indeterminate' });
        expect(notified).not.toHaveBeenCalled();
        expect(recovery_events).toMatchObject([{
            reason: 'projectionRecovery',
            priority: 'high',
        }]);

        const next = begin_physical(coordinator, 'digest-b');
        const requested = await coordinator.request_commit_turn(next);
        expect(requested.type).toBe('granted');
        if (requested.type === 'granted') coordinator.release_commit_turn(requested.turn);
        coordinator.cancel(next);
        refresh.dispose();
        subscription.dispose();
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

    it('recovers every subscriber when an ambiguous projection is followed by a later advance', async () => {
        const path = `/tmp/advanced-projection-stage-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        const store: AuthorityFileStateStore = {
            ...base.store,
            async finalize_authority_transaction(file_path, id) {
                const local = await base.store.finalize_authority_transaction(file_path, id);
                if (local.type !== 'finalized' || !id.startsWith('projection:')) return local;
                const external_id = `external-advance:${Math.random()}`;
                const staged = await stage_authority(base.store, file_path, {
                    id: external_id,
                    kind: 'physical',
                    ordinal: 999,
                    expectedStateRevision: local.snapshot.revision,
                    expectedCommitSequence: local.authority.commitSequence,
                    physicalDigest: local.authority.physicalDigest,
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
        const receipt_subscriber = vi.fn();
        const receipt_subscription = coordinator.subscribe_excel_headers(receipt_subscriber);
        const factory = new TestRefreshWatcherFactory();
        const first_events: FileRefreshEvent[] = [];
        const second_events: FileRefreshEvent[] = [];
        const first_refresh = coordinator.subscribe_refresh((event) => {
            first_events.push(event);
        }, factory);
        const second_refresh = coordinator.subscribe_refresh((event) => {
            second_events.push(event);
        }, factory);

        await expect(coordinator.commit_excel_header(
            header_command(store, 'advanced-stage', 'off'),
        )).resolves.toMatchObject({ type: 'indeterminate' });

        expect(base.value(coordinator.statePath)).toMatchObject({
            excelFirstRowHeaders: { People: 'off' },
        });
        const durable = await base.store.read_authority(coordinator.statePath);
        expect(durable).toMatchObject({
            commitSequence: 3,
            authorityRevision: 2,
            physicalRevision: 1,
            projectionRevision: 1,
            physicalDigest: 'digest-a',
        });
        expect(coordinator.authority()).toMatchObject(durable);
        expect(receipt_subscriber).not.toHaveBeenCalled();
        expect(first_events).toMatchObject([{
            reason: 'projectionRecovery',
            priority: 'high',
        }]);
        expect(second_events).toMatchObject([{
            reason: 'projectionRecovery',
            priority: 'high',
        }]);

        const next = begin_physical(coordinator, 'digest-b');
        const requested = await coordinator.request_commit_turn(next);
        expect(requested.type).toBe('granted');
        if (requested.type === 'granted') coordinator.release_commit_turn(requested.turn);
        coordinator.cancel(next);
        first_refresh.dispose();
        second_refresh.dispose();
        receipt_subscription.dispose();
        coordinator.dispose();
    });

    it('cannot cancel an active finalization and invalidates stale queued physical work', async () => {
        const path = `/tmp/active-finalize-${Math.random()}.xlsx`;
        const state = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, state.store);
        await coordinator.state_ready();
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
        const first_finalization_basis = coordinator.authority();
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
            first_finalization_basis,
        );
        const second_turn = await second_wait;
        expect(second_turn.type).toBe('rejected');
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

describe('file coordinator Task 10 invariants', () => {
    it('retries fail-once initialization on the same attachment', async () => {
        const path = `/tmp/init-retry-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        let reads = 0;
        const store: AuthorityFileStateStore = {
            ...base.store,
            async read_authority(file_path) {
                reads += 1;
                if (reads === 1) throw new Error('temporary initialization failure');
                return base.store.read_authority(file_path);
            },
        };
        const coordinator = acquire_file_coordinator(path, store);

        await coordinator.state_ready().catch((error: unknown) => {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe('temporary initialization failure');
            expect(coordinator.begin_physical(0, 'digest').type).toBe('rejected');
            return coordinator.state_ready();
        });
        expect(reads).toBe(2);
        const started = coordinator.begin_physical(0, 'digest');
        expect(started.type).toBe('started');
        if (started.type === 'started') coordinator.cancel(started.token);
        coordinator.dispose();
    });

    it('preserves a ready baseline when later alias registration fails', async () => {
        const base = mapped_state_store();
        let fail_alias = false;
        const store: AuthorityFileStateStore = {
            ...base.store,
            async lease_entry() {
                return { release: async () => {} };
            },
            async canonicalize_path(canonical, canonical_key) {
                if (fail_alias) throw new Error('alias registration failed');
                await base.store.canonicalize_path?.(canonical, canonical_key);
            },
        };
        const first = acquire_file_coordinator('C:\\Data\\Alias.xlsx', store, 'win32');
        await first.state_ready();
        fail_alias = true;
        const second = acquire_file_coordinator('c:\\data\\alias.xlsx', store, 'win32');
        await expect(second.state_ready()).rejects.toThrow('alias registration failed');

        const operation = first.begin_physical(first.authority().authorityRevision, 'digest');
        expect(operation.type).toBe('started');
        if (operation.type === 'started') first.cancel(operation.token);
        await expect(first.state_ready()).resolves.toBeUndefined();

        fail_alias = false;
        await expect(second.state_ready()).resolves.toBeUndefined();
        first.dispose();
        second.dispose();
    });

    it('scopes fallback authority by backing store and path', async () => {
        const make_store = (): FileStateStore => {
            let snapshot = { state: {} as StoredPerFileState, revision: 0 };
            return {
                async read() { return structuredClone(snapshot); },
                async compare_and_set(_path, expected, state) {
                    if (snapshot.revision !== expected) {
                        return { type: 'conflict', snapshot: structuredClone(snapshot) };
                    }
                    snapshot = { state: structuredClone(state), revision: expected + 1 };
                    return { type: 'committed', snapshot: structuredClone(snapshot) };
                },
                async copy_entry_if_absent() {
                    return {
                        type: 'copied',
                        source: structuredClone(snapshot),
                        destination: structuredClone(snapshot),
                    };
                },
                async touch() {},
            };
        };
        const first_backing = make_store();
        const second_backing = make_store();
        const first = with_in_memory_authority_transactions(first_backing);
        const second = with_in_memory_authority_transactions(second_backing);
        const path = '/same.xlsx';
        await stage_authority(first, path, {
            id: 'first', kind: 'physical', ordinal: 1,
            expectedStateRevision: 0, expectedCommitSequence: 0,
            physicalDigest: 'first',
        });
        const finalized = await finalize_authority(first, path, 'first');
        expect(finalized.type).toBe('finalized');
        expect((await read_authority(first, path)).commitSequence).toBe(1);
        expect((await read_authority(second, path)).commitSequence).toBe(0);
        await first.copy_entry_if_absent?.(path, '/provider-key', 'scoped-copy');
        expect((await read_authority(first, '/provider-key')).commitSequence).toBe(1);
        expect((await read_authority(first, path)).commitSequence).toBe(1);

        release_authority_fallback(first, path);
        expect((await read_authority(first, path)).commitSequence).toBe(0);
        expect((await read_authority(second, path)).commitSequence).toBe(0);
        release_authority_fallback(first, '/provider-key');
    });

    it('does not advance the fallback state revision for an unchanged staged state', async () => {
        const path = '/unchanged.xlsx';
        const base = mapped_state_store({ [path]: { activeSheetIndex: 4 } });
        const compare_and_set = vi.fn(base.backing.compare_and_set.bind(base.backing));
        base.backing.compare_and_set = compare_and_set;
        const initial = await base.store.read(path);

        await expect(stage_authority(base.store, path, {
            id: 'unchanged-projection', kind: 'projection', ordinal: 1,
            expectedStateRevision: initial.revision, expectedCommitSequence: 0,
            nextState: { activeSheetIndex: 4 },
        })).resolves.toEqual({ type: 'staged' });

        await expect(finalize_authority(base.store, path, 'unchanged-projection'))
            .resolves.toMatchObject({
                type: 'finalized',
                snapshot: initial,
                authority: {
                    commitSequence: 1,
                    authorityRevision: 1,
                    projectionRevision: 1,
                },
            });
        expect(compare_and_set).not.toHaveBeenCalled();
        await expect(base.store.read(path)).resolves.toEqual(initial);
    });

    it('preserves fallback authority and recovery stages through delegated provider copying', async () => {
        const legacy = '/legacy-provider.xlsx';
        const provider = '/provider-key';
        const base = mapped_state_store({ [legacy]: { activeSheetIndex: 4 } });
        const copy_entry_if_absent = vi.fn(
            (source: string, destination: string, copy_id: string) => (
                base.backing.copy_entry_if_absent!(source, destination, copy_id)
            ),
        );
        const backing: FileStateStore = { ...base.backing, copy_entry_if_absent };
        const store = with_in_memory_authority_transactions(backing);
        const initial = await store.read(legacy);
        await expect(stage_authority(store, legacy, {
            id: 'committed-physical', kind: 'physical', ordinal: 1,
            expectedStateRevision: initial.revision, expectedCommitSequence: 0,
            physicalDigest: 'legacy-digest',
        })).resolves.toEqual({ type: 'staged' });
        await expect(finalize_authority(store, legacy, 'committed-physical'))
            .resolves.toMatchObject({ type: 'finalized' });
        await expect(stage_authority(store, legacy, {
            id: 'recovery-stage', kind: 'projection', ordinal: 2,
            expectedStateRevision: initial.revision, expectedCommitSequence: 1,
            nextState: { activeSheetIndex: 8 },
        })).resolves.toEqual({ type: 'staged' });
        expect(await read_authority(store, provider)).toMatchObject({ commitSequence: 0 });

        await expect(store.copy_entry_if_absent!(legacy, provider, 'complete-copy'))
            .resolves.toMatchObject({ type: 'copied' });

        expect(copy_entry_if_absent).toHaveBeenCalledWith(
            legacy,
            provider,
            'complete-copy',
        );
        expect(base.value(provider)).toEqual({ activeSheetIndex: 4 });
        expect(await read_authority(store, provider)).toMatchObject({
            commitSequence: 1,
            physicalDigest: 'legacy-digest',
        });
        expect((await store.inspect_authority_transaction(provider, 'recovery-stage')).stagePresent)
            .toBe(true);
        await expect(finalize_authority(store, provider, 'recovery-stage'))
            .resolves.toMatchObject({
                type: 'finalized',
                authority: { commitSequence: 2, projectionRevision: 1 },
                snapshot: { state: { activeSheetIndex: 8 } },
            });
        release_authority_fallback(store, legacy);
        release_authority_fallback(store, provider);
    });

    it('migrates materialized authority when the backing source state is absent', async () => {
        const legacy = '/metadata-only-authority.xlsx';
        const provider = '/metadata-only-authority-provider';
        const base = mapped_state_store();
        const store = base.store;
        await stage_authority(store, legacy, {
            id: 'authority-only', kind: 'physical', ordinal: 1,
            expectedStateRevision: 0, expectedCommitSequence: 0,
            physicalDigest: 'metadata-digest',
        });
        await finalize_authority(store, legacy, 'authority-only');
        expect((await store.read(legacy)).revision).toBe(0);

        await expect(store.copy_entry_if_absent!(legacy, provider, 'metadata-authority-copy'))
            .resolves.toMatchObject({ type: 'sourceAbsent' });

        expect((await store.read(provider)).revision).toBe(0);
        expect(await read_authority(store, provider)).toMatchObject({
            commitSequence: 1,
            physicalRevision: 1,
            physicalDigest: 'metadata-digest',
        });
        release_authority_fallback(store, legacy);
        release_authority_fallback(store, provider);
    });

    it('migrates and finalizes a metadata-only recovery stage', async () => {
        const legacy = '/metadata-only-stage.xlsx';
        const provider = '/metadata-only-stage-provider';
        const base = mapped_state_store();
        const store = base.store;
        await stage_authority(store, legacy, {
            id: 'metadata-stage', kind: 'projection', ordinal: 1,
            expectedStateRevision: 0, expectedCommitSequence: 0,
            nextState: { activeSheetIndex: 7 },
        });

        await expect(store.copy_entry_if_absent!(legacy, provider, 'metadata-stage-copy'))
            .resolves.toMatchObject({ type: 'sourceAbsent' });
        expect((await store.inspect_authority_transaction(provider, 'metadata-stage')).stagePresent)
            .toBe(true);
        await expect(finalize_authority(store, provider, 'metadata-stage'))
            .resolves.toMatchObject({
                type: 'finalized',
                authority: { commitSequence: 1, projectionRevision: 1 },
                snapshot: { state: { activeSheetIndex: 7 } },
            });
        release_authority_fallback(store, legacy);
        release_authority_fallback(store, provider);
    });

    it('does not let a read-only fallback placeholder claim provider ownership', async () => {
        const legacy = '/placeholder-source.xlsx';
        const provider = '/placeholder-provider';
        const base = mapped_state_store();
        const store = base.store;
        await read_authority(store, legacy);

        await expect(store.copy_entry_if_absent!(legacy, provider, 'absent-copy'))
            .resolves.toMatchObject({ type: 'sourceAbsent' });
        await base.backing.compare_and_set(legacy, 0, { activeSheetIndex: 5 });
        await expect(store.copy_entry_if_absent!(legacy, provider, 'real-copy'))
            .resolves.toMatchObject({ type: 'copied' });

        expect(base.value(provider)).toEqual({ activeSheetIndex: 5 });
        release_authority_fallback(store, legacy);
        release_authority_fallback(store, provider);
    });

    it('recovers a delegated copy that commits before throwing by replaying its copy id', async () => {
        const legacy = '/ambiguous-copy-source.xlsx';
        const provider = '/ambiguous-copy-provider';
        const base = mapped_state_store({ [legacy]: { activeSheetIndex: 2 } });
        const delegate = base.backing.copy_entry_if_absent!;
        let throw_after_first_copy = true;
        const copy_entry_if_absent = vi.fn(async (
            source: string,
            destination: string,
            copy_id: string,
        ) => {
            const result = await delegate(source, destination, copy_id);
            if (throw_after_first_copy) {
                throw_after_first_copy = false;
                throw new Error('copy committed before transport failed');
            }
            return result;
        });
        const backing: FileStateStore = { ...base.backing, copy_entry_if_absent };
        const store = with_in_memory_authority_transactions(backing);
        const initial = await store.read(legacy);
        await stage_authority(store, legacy, {
            id: 'ambiguous-authority', kind: 'physical', ordinal: 1,
            expectedStateRevision: initial.revision, expectedCommitSequence: 0,
            physicalDigest: 'ambiguous-digest',
        });
        await finalize_authority(store, legacy, 'ambiguous-authority');
        await stage_authority(store, legacy, {
            id: 'ambiguous-stage', kind: 'projection', ordinal: 2,
            expectedStateRevision: initial.revision, expectedCommitSequence: 1,
            nextState: { activeSheetIndex: 6 },
        });

        await expect(store.copy_entry_if_absent!(legacy, provider, 'stable-copy-id'))
            .resolves.toMatchObject({ type: 'copied' });

        expect(copy_entry_if_absent).toHaveBeenCalledTimes(2);
        expect(copy_entry_if_absent).toHaveBeenNthCalledWith(
            1, legacy, provider, 'stable-copy-id',
        );
        expect(copy_entry_if_absent).toHaveBeenNthCalledWith(
            2, legacy, provider, 'stable-copy-id',
        );
        expect(await read_authority(store, provider)).toMatchObject({
            commitSequence: 1,
            physicalDigest: 'ambiguous-digest',
        });
        await expect(finalize_authority(store, provider, 'ambiguous-stage'))
            .resolves.toMatchObject({ type: 'finalized' });
        release_authority_fallback(store, legacy);
        release_authority_fallback(store, provider);
    });

    it('invalidates fallback copy replay provenance after destination CAS', async () => {
        const legacy = '/copy-replay-cas-source.xlsx';
        const provider = '/copy-replay-cas-provider';
        const base = mapped_state_store({ [legacy]: { activeSheetIndex: 2 } });
        const store = base.store;
        const source_snapshot = await store.read(legacy);
        await stage_authority(store, legacy, {
            id: 'copy-replay-authority', kind: 'physical', ordinal: 1,
            expectedStateRevision: source_snapshot.revision,
            expectedCommitSequence: 0,
            physicalDigest: 'copy-replay-digest',
        });
        await finalize_authority(store, legacy, 'copy-replay-authority');
        const copied = await store.copy_entry_if_absent!(legacy, provider, 'copy-replay-id');
        if (copied.type !== 'copied') throw new Error('copy rejected');

        const committed = await store.compare_and_set(
            provider,
            copied.destination.revision,
            { activeSheetIndex: 8 },
        );
        if (committed.type !== 'committed') throw new Error('destination CAS rejected');
        await expect(store.copy_entry_if_absent!(legacy, provider, 'copy-replay-id'))
            .resolves.toMatchObject({
                type: 'destinationExists',
                destination: committed.snapshot,
            });
        release_authority_fallback(store, legacy);
        release_authority_fallback(store, provider);
    });

    it('leaves absent state untouched when no atomic copy primitive is available', async () => {
        const legacy = '/unsupported-copy-source.xlsx';
        const provider = '/unsupported-copy-provider';
        const base = mapped_state_store();
        const atomic_copy = base.backing.copy_entry_if_absent!;
        const backing: FileStateStore = {
            read: base.backing.read,
            compare_and_set: base.backing.compare_and_set,
            canonicalize_path: base.backing.canonicalize_path,
            touch: base.backing.touch,
        };
        const store = with_in_memory_authority_transactions(backing);

        await expect(store.copy_entry_if_absent!(legacy, provider, 'unsupported-copy'))
            .resolves.toEqual({ type: 'unsupported' });
        expect(await store.read(provider)).toEqual({ state: {}, revision: 0 });

        await backing.compare_and_set(legacy, 0, { activeSheetIndex: 9 });
        backing.copy_entry_if_absent = atomic_copy;
        await expect(store.copy_entry_if_absent!(legacy, provider, 'later-atomic-copy'))
            .resolves.toMatchObject({ type: 'copied' });
        expect(base.value(provider)).toEqual({ activeSheetIndex: 9 });
        release_authority_fallback(store, legacy);
        release_authority_fallback(store, provider);
    });

    it('pins source fallback metadata through an in-flight delegated provider copy', async () => {
        const legacy = '/legacy-in-flight-provider.xlsx';
        const provider = '/in-flight-provider-key';
        const base = mapped_state_store({ [legacy]: { activeSheetIndex: 4 } });
        let announce_copy!: () => void;
        const copy_started = new Promise<void>((resolve) => { announce_copy = resolve; });
        let release_copy!: () => void;
        const copy_gate = new Promise<void>((resolve) => { release_copy = resolve; });
        const copy_entry_if_absent = vi.fn(async (
            source: string,
            destination: string,
            copy_id: string,
        ) => {
            announce_copy();
            await copy_gate;
            return base.backing.copy_entry_if_absent!(source, destination, copy_id);
        });
        const backing: FileStateStore = { ...base.backing, copy_entry_if_absent };
        const store = with_in_memory_authority_transactions(backing);
        const initial = await store.read(legacy);
        await stage_authority(store, legacy, {
            id: 'committed-physical', kind: 'physical', ordinal: 1,
            expectedStateRevision: initial.revision, expectedCommitSequence: 0,
            physicalDigest: 'legacy-digest',
        });
        await finalize_authority(store, legacy, 'committed-physical');
        await stage_authority(store, legacy, {
            id: 'recovery-stage', kind: 'projection', ordinal: 2,
            expectedStateRevision: initial.revision, expectedCommitSequence: 1,
            nextState: { activeSheetIndex: 8 },
        });

        const copying = store.copy_entry_if_absent!(legacy, provider, 'in-flight-copy');
        await copy_started;
        release_authority_fallback(store, legacy);
        release_copy();
        await expect(copying).resolves.toMatchObject({ type: 'copied' });

        expect(base.value(provider)).toEqual({ activeSheetIndex: 4 });
        expect(await read_authority(store, provider)).toMatchObject({
            commitSequence: 1,
            physicalDigest: 'legacy-digest',
        });
        expect((await store.inspect_authority_transaction(provider, 'recovery-stage')).stagePresent)
            .toBe(true);
        release_authority_fallback(store, provider);
    });

    it('does not attach source fallback metadata when delegated provider state copying no-ops', async () => {
        const legacy = '/legacy-state-only-provider.xlsx';
        const provider = '/state-only-provider-key';
        const base = mapped_state_store({
            [legacy]: { activeSheetIndex: 4 },
            [provider]: { activeSheetIndex: 9 },
        });
        const copy_entry_if_absent = vi.fn(
            (source: string, destination: string, copy_id: string) => (
                base.backing.copy_entry_if_absent!(source, destination, copy_id)
            ),
        );
        const backing: FileStateStore = { ...base.backing, copy_entry_if_absent };
        const store = with_in_memory_authority_transactions(backing);
        const legacy_state = await store.read(legacy);
        await stage_authority(store, legacy, {
            id: 'legacy-physical', kind: 'physical', ordinal: 1,
            expectedStateRevision: legacy_state.revision, expectedCommitSequence: 0,
            physicalDigest: 'legacy-digest',
        });
        await finalize_authority(store, legacy, 'legacy-physical');
        await stage_authority(store, legacy, {
            id: 'legacy-recovery', kind: 'projection', ordinal: 2,
            expectedStateRevision: legacy_state.revision, expectedCommitSequence: 1,
            nextState: { activeSheetIndex: 5 },
        });

        await expect(store.copy_entry_if_absent!(legacy, provider, 'unrelated-copy'))
            .resolves.toMatchObject({ type: 'destinationExists' });

        expect(copy_entry_if_absent).toHaveBeenCalledWith(
            legacy,
            provider,
            'unrelated-copy',
        );
        expect(base.value(provider)).toEqual({ activeSheetIndex: 9 });
        expect(await read_authority(store, provider)).toMatchObject({
            commitSequence: 0,
            authorityRevision: 0,
            physicalRevision: 0,
            projectionRevision: 0,
        });
        expect((await store.inspect_authority_transaction(provider, 'legacy-recovery')).stagePresent)
            .toBe(false);
        release_authority_fallback(store, legacy);
        release_authority_fallback(store, provider);
    });

    it('preserves an existing provider state, authority, and stage when delegated copying no-ops', async () => {
        const legacy = '/legacy-existing-provider.xlsx';
        const provider = '/existing-provider-key';
        const base = mapped_state_store({
            [legacy]: { activeSheetIndex: 4 },
            [provider]: { activeSheetIndex: 9 },
        });
        const copy_entry_if_absent = vi.fn(
            (source: string, destination: string, copy_id: string) => (
                base.backing.copy_entry_if_absent!(source, destination, copy_id)
            ),
        );
        const backing: FileStateStore = { ...base.backing, copy_entry_if_absent };
        const store = with_in_memory_authority_transactions(backing);
        const legacy_state = await store.read(legacy);
        const provider_state = await store.read(provider);
        await stage_authority(store, legacy, {
            id: 'legacy-physical', kind: 'physical', ordinal: 1,
            expectedStateRevision: legacy_state.revision, expectedCommitSequence: 0,
            physicalDigest: 'legacy-digest',
        });
        await finalize_authority(store, legacy, 'legacy-physical');
        await stage_authority(store, legacy, {
            id: 'legacy-recovery', kind: 'projection', ordinal: 2,
            expectedStateRevision: legacy_state.revision, expectedCommitSequence: 1,
            nextState: { activeSheetIndex: 5 },
        });
        await stage_authority(store, provider, {
            id: 'provider-physical', kind: 'physical', ordinal: 3,
            expectedStateRevision: provider_state.revision, expectedCommitSequence: 0,
            physicalDigest: 'provider-digest',
        });
        await finalize_authority(store, provider, 'provider-physical');
        await stage_authority(store, provider, {
            id: 'provider-recovery', kind: 'projection', ordinal: 4,
            expectedStateRevision: provider_state.revision, expectedCommitSequence: 1,
            nextState: { activeSheetIndex: 10 },
        });

        await expect(store.copy_entry_if_absent!(legacy, provider, 'protected-copy'))
            .resolves.toMatchObject({ type: 'destinationExists' });

        expect(copy_entry_if_absent).not.toHaveBeenCalled();
        expect(base.value(provider)).toEqual({ activeSheetIndex: 9 });
        expect(await read_authority(store, provider)).toMatchObject({
            commitSequence: 1,
            physicalDigest: 'provider-digest',
        });
        expect((await store.inspect_authority_transaction(provider, 'provider-recovery')).stagePresent)
            .toBe(true);
        expect((await store.inspect_authority_transaction(provider, 'legacy-recovery')).stagePresent)
            .toBe(false);
        release_authority_fallback(store, legacy);
        release_authority_fallback(store, provider);
    });

    it('holds one atomic state-entry lease for the shared coordinator lifetime', async () => {
        const path = `/tmp/coordinator-lease-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const lease_entry = vi.fn(async () => ({ release: vi.fn(async () => {}) }));
        const store: AuthorityFileStateStore = { ...base.store, lease_entry };
        const first = acquire_file_coordinator(path, store);
        const second = acquire_file_coordinator(path, store);
        await Promise.all([first.state_ready(), second.state_ready()]);
        expect(lease_entry).toHaveBeenCalledOnce();
        const lease = await lease_entry.mock.results[0].value;

        first.dispose();
        expect(lease.release).not.toHaveBeenCalled();
        second.dispose();
        await vi.waitFor(() => expect(lease.release).toHaveBeenCalledOnce());
    });

    it('returns one promise for duplicate queued commit-turn requests', async () => {
        const coordinator = acquire_file_coordinator(`/tmp/duplicate-turn-${Math.random()}.xlsx`);
        const first = begin_physical(coordinator, 'first');
        const first_turn = await coordinator.request_commit_turn(first);
        if (first_turn.type !== 'granted') throw new Error('turn rejected');
        const second = begin_physical(coordinator, 'second');
        const left = coordinator.request_commit_turn(second);
        const right = coordinator.request_commit_turn(second);
        expect(left).toBe(right);

        coordinator.release_commit_turn(first_turn.turn);
        await expect(left).resolves.toMatchObject({ type: 'granted' });
        coordinator.cancel(first);
        coordinator.cancel(second);
        coordinator.dispose();
    });

    it('invalidates projection planning when a local physical finalization advances', async () => {
        const path = `/tmp/local-finalize-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        const physical = begin_physical(coordinator, 'digest-b');
        const current = await base.store.read(coordinator.statePath);
        await stage_authority(base.store, coordinator.statePath, {
            id: physical.id,
            kind: 'physical',
            ordinal: physical.ordinal,
            expectedStateRevision: current.revision,
            expectedCommitSequence: coordinator.authority().commitSequence,
            physicalDigest: 'digest-b',
        });
        const turn = await coordinator.request_commit_turn(physical);
        if (turn.type !== 'granted') throw new Error('turn rejected');
        const physical_finalization_basis = coordinator.authority();
        coordinator.start_finalization(turn.turn);

        let projection_staged!: () => void;
        const staged = new Promise<void>((resolve) => { projection_staged = resolve; });
        const projection_store: AuthorityFileStateStore = {
            ...base.store,
            async stage_authority_transaction(file_path, stage) {
                const result = await base.store.stage_authority_transaction(file_path, stage);
                if (stage.kind === 'projection') projection_staged();
                return result;
            },
        };
        const projection = coordinator.commit_excel_header(
            header_command(projection_store, 'local-finalize', 'off'),
        );
        await staged;
        const finalized = await finalize_authority(base.store, coordinator.statePath, physical.id);
        if (finalized.type !== 'finalized') throw new Error('finalize rejected');
        coordinator.finalize_authority_commit(
            physical,
            turn.turn,
            finalized,
            physical_finalization_basis,
        );

        await expect(projection).resolves.toMatchObject({ type: 'rejected' });
        expect(coordinator.authority().physicalDigest).toBe('digest-b');
        coordinator.dispose();
    });

    it('bounds state-only projection staging conflicts without hot-looping', async () => {
        const path = `/tmp/bounded-projection-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        let attempts = 0;
        const store: AuthorityFileStateStore = {
            ...base.store,
            async stage_authority_transaction(file_path, stage) {
                if (stage.kind !== 'projection') {
                    return base.store.stage_authority_transaction(file_path, stage);
                }
                attempts += 1;
                return {
                    type: 'conflict',
                    snapshot: await base.store.read(file_path),
                    authority: coordinator.authority(),
                };
            },
        };

        await expect(coordinator.commit_excel_header(
            header_command(store, 'bounded', 'off'),
        )).resolves.toMatchObject({
            type: 'rejected',
            error: 'The worksheet kept changing before the header setting could be saved.',
        });
        expect(attempts).toBe(4);
        coordinator.dispose();
    });

    it('broadcasts shared recovery when staging observes a newer projection authority', async () => {
        const path = `/tmp/stage-projection-recovery-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        let advanced = false;
        const store: AuthorityFileStateStore = {
            ...base.store,
            async stage_authority_transaction(file_path, stage) {
                if (stage.kind !== 'projection' || advanced) {
                    return base.store.stage_authority_transaction(file_path, stage);
                }
                advanced = true;
                const current = await base.store.read(file_path);
                await base.store.stage_authority_transaction(file_path, {
                    id: 'external-stage-projection',
                    kind: 'projection',
                    ordinal: 999,
                    expectedStateRevision: current.revision,
                    expectedCommitSequence: coordinator.authority().commitSequence,
                });
                await base.store.finalize_authority_transaction(
                    file_path,
                    'external-stage-projection',
                );
                return {
                    type: 'conflict',
                    snapshot: await base.store.read(file_path),
                    authority: await base.store.read_authority(file_path),
                };
            },
        };
        const receipt_subscriber = vi.fn();
        const receipts = coordinator.subscribe_excel_headers(receipt_subscriber);
        const factory = new TestRefreshWatcherFactory();
        const first_events: FileRefreshEvent[] = [];
        const second_events: FileRefreshEvent[] = [];
        const first = coordinator.subscribe_refresh((event) => { first_events.push(event); }, factory);
        const second = coordinator.subscribe_refresh((event) => { second_events.push(event); }, factory);

        await expect(coordinator.commit_excel_header(
            header_command(store, 'external-stage-conflict', 'off'),
        )).resolves.toMatchObject({ type: 'rejected' });

        expect(receipt_subscriber).not.toHaveBeenCalled();
        expect(coordinator.authority()).toMatchObject({ projectionRevision: 1 });
        expect(first_events).toMatchObject([{ reason: 'projectionRecovery', priority: 'high' }]);
        expect(second_events).toMatchObject([{ reason: 'projectionRecovery', priority: 'high' }]);
        first.dispose();
        second.dispose();
        receipts.dispose();
        coordinator.dispose();
    });

    it('broadcasts shared recovery when finalization conflicts with a newer projection', async () => {
        const path = `/tmp/finalize-projection-recovery-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        const store: AuthorityFileStateStore = {
            ...base.store,
            async finalize_authority_transaction(file_path, id) {
                if (!id.startsWith('projection:')) {
                    return base.store.finalize_authority_transaction(file_path, id);
                }
                const current = await base.store.read(file_path);
                const authority = await base.store.read_authority(file_path);
                await base.store.stage_authority_transaction(file_path, {
                    id: 'external-finalize-projection',
                    kind: 'projection',
                    ordinal: 999,
                    expectedStateRevision: current.revision,
                    expectedCommitSequence: authority.commitSequence,
                });
                await base.store.finalize_authority_transaction(
                    file_path,
                    'external-finalize-projection',
                );
                return base.store.finalize_authority_transaction(file_path, id);
            },
        };
        const receipt_subscriber = vi.fn();
        const receipts = coordinator.subscribe_excel_headers(receipt_subscriber);
        const factory = new TestRefreshWatcherFactory();
        const first_events: FileRefreshEvent[] = [];
        const second_events: FileRefreshEvent[] = [];
        const first = coordinator.subscribe_refresh((event) => { first_events.push(event); }, factory);
        const second = coordinator.subscribe_refresh((event) => { second_events.push(event); }, factory);

        await expect(coordinator.commit_excel_header(
            header_command(store, 'external-finalize-conflict', 'off'),
        )).resolves.toMatchObject({ type: 'rejected' });

        expect(receipt_subscriber).not.toHaveBeenCalled();
        expect(first_events).toMatchObject([{ reason: 'projectionRecovery', priority: 'high' }]);
        expect(second_events).toMatchObject([{ reason: 'projectionRecovery', priority: 'high' }]);
        expect(coordinator.authority()).toMatchObject({ projectionRevision: 1 });
        first.dispose();
        second.dispose();
        receipts.dispose();
        coordinator.dispose();
    });

    it('settles an indeterminate header finalize without broadcasting a stale receipt', async () => {
        const path = `/tmp/inspect-failure-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        await establish(coordinator, 'digest-a', base.store);
        let projection_id = '';
        const store: AuthorityFileStateStore = {
            ...base.store,
            async finalize_authority_transaction(file_path, id) {
                const local = await base.store.finalize_authority_transaction(file_path, id);
                if (local.type === 'finalized' && id.startsWith('projection:')) {
                    projection_id = id;
                    const current = await base.store.read(file_path);
                    await base.store.stage_authority_transaction(file_path, {
                        id: 'external-sequence',
                        kind: 'physical',
                        ordinal: 999,
                        expectedStateRevision: current.revision,
                        expectedCommitSequence: local.authority.commitSequence,
                        physicalDigest: 'digest-a',
                    });
                    await base.store.finalize_authority_transaction(
                        file_path,
                        'external-sequence',
                    );
                }
                return local;
            },
            async inspect_authority_transaction(file_path, id) {
                if (id === projection_id) throw new Error('transient inspect failure');
                return base.store.inspect_authority_transaction(file_path, id);
            },
        };
        const subscriber = vi.fn();
        const subscription = coordinator.subscribe_excel_headers(subscriber);
        const result = await coordinator.commit_excel_header(
            header_command(store, 'inspect-failure', 'off'),
        );
        expect(result).toMatchObject({ type: 'indeterminate' });
        expect(subscriber).not.toHaveBeenCalled();
        const lower_bound = coordinator.authority();
        const durable = await base.store.read_authority(coordinator.statePath);
        expect(durable.commitSequence).toBe(lower_bound.commitSequence + 1);

        const recovery = begin_physical(coordinator, 'digest-a');
        const state = await base.store.read(coordinator.statePath);
        const stage = await stage_authority(base.store, coordinator.statePath, {
            id: recovery.id,
            kind: 'physical',
            ordinal: recovery.ordinal,
            expectedStateRevision: state.revision,
            expectedCommitSequence: lower_bound.commitSequence,
            physicalDigest: 'digest-a',
        });
        expect(stage.type).toBe('conflict');
        if (stage.type === 'conflict') {
            const turn = await coordinator.request_commit_turn(recovery);
            if (turn.type !== 'granted') throw new Error('turn rejected');
            coordinator.observe_advanced_authority(recovery, turn.turn, stage.authority);
        }
        expect(coordinator.authority().commitSequence).toBe(durable.commitSequence);
        subscription.dispose();
        coordinator.dispose();
    });

    it('keeps indeterminate recovery when alias registration already installed later authority', async () => {
        const upper = 'C:\\Data\\Observed-Indeterminate.xlsx';
        const lower = 'c:\\data\\observed-indeterminate.xlsx';
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(upper, base.store, 'win32');
        await establish(coordinator, 'digest-a', base.store);
        let projection_id = '';
        let alias: ReturnType<typeof acquire_file_coordinator> | undefined;
        const store: AuthorityFileStateStore = {
            ...base.store,
            async finalize_authority_transaction(file_path, id) {
                const local = await base.store.finalize_authority_transaction(file_path, id);
                if (local.type === 'finalized' && id.startsWith('projection:')) {
                    projection_id = id;
                    const external_id = 'alias-observed-sequence';
                    await base.store.stage_authority_transaction(file_path, {
                        id: external_id,
                        kind: 'physical',
                        ordinal: 999,
                        expectedStateRevision: local.snapshot.revision,
                        expectedCommitSequence: local.authority.commitSequence,
                        physicalDigest: local.authority.physicalDigest,
                    });
                    await base.store.finalize_authority_transaction(file_path, external_id);
                }
                return local;
            },
            async inspect_authority_transaction(file_path, id) {
                if (id === projection_id) {
                    alias = acquire_file_coordinator(lower, base.store, 'win32');
                    await alias.state_ready();
                    throw new Error('inspection unavailable after alias registration');
                }
                return base.store.inspect_authority_transaction(file_path, id);
            },
        };
        const receipt_subscriber = vi.fn();
        const receipt_subscription = coordinator.subscribe_excel_headers(receipt_subscriber);
        const factory = new TestRefreshWatcherFactory();
        const recovery_events: FileRefreshEvent[] = [];
        const refresh_subscription = coordinator.subscribe_refresh((event) => {
            recovery_events.push(event);
        }, factory);

        await expect(coordinator.commit_excel_header(
            header_command(store, 'alias-observed', 'off'),
        )).resolves.toMatchObject({ type: 'indeterminate' });

        const durable = await base.store.read_authority(coordinator.statePath);
        expect(durable.commitSequence).toBe(3);
        expect(coordinator.authority()).toMatchObject(durable);
        expect(base.value(coordinator.statePath)).toMatchObject({
            excelFirstRowHeaders: { People: 'off' },
        });
        expect(receipt_subscriber).not.toHaveBeenCalled();
        expect(recovery_events).toMatchObject([{
            reason: 'projectionRecovery',
            priority: 'high',
        }]);
        const next = begin_physical(coordinator, 'digest-b');
        const requested = await coordinator.request_commit_turn(next);
        expect(requested.type).toBe('granted');
        if (requested.type === 'granted') coordinator.release_commit_turn(requested.turn);
        coordinator.cancel(next);
        refresh_subscription.dispose();
        receipt_subscription.dispose();
        alias?.dispose();
        coordinator.dispose();
    });

    it('preserves newer projection planning when an alias installs the active finalizer', async () => {
        const upper = 'C:\\Data\\Alias-Finalizing-Projection.xlsx';
        const lower = 'c:\\data\\alias-finalizing-projection.xlsx';
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(upper, base.store, 'win32');
        await establish(coordinator, 'digest-a', base.store);
        let release_a!: () => void;
        const a_gate = new Promise<void>((resolve) => { release_a = resolve; });
        let mark_a_finalizing!: () => void;
        const a_finalizing = new Promise<void>((resolve) => { mark_a_finalizing = resolve; });
        let alias: ReturnType<typeof acquire_file_coordinator> | undefined;
        const a_store: AuthorityFileStateStore = {
            ...base.store,
            async finalize_authority_transaction(file_path, id) {
                if (id.includes(':A:')) {
                    mark_a_finalizing();
                    await a_gate;
                }
                return base.store.finalize_authority_transaction(file_path, id);
            },
            async inspect_authority_transaction(file_path, id) {
                const inspected = await base.store.inspect_authority_transaction(file_path, id);
                if (id.includes(':A:')) {
                    alias = acquire_file_coordinator(lower, base.store, 'win32');
                    await alias.state_ready();
                }
                return inspected;
            },
        };
        let release_b_read!: () => void;
        const b_read_gate = new Promise<void>((resolve) => { release_b_read = resolve; });
        let mark_b_reading!: () => void;
        const b_reading = new Promise<void>((resolve) => { mark_b_reading = resolve; });
        let first_b_read = true;
        const b_store: AuthorityFileStateStore = {
            ...base.store,
            async read(file_path) {
                if (first_b_read) {
                    first_b_read = false;
                    mark_b_reading();
                    await b_read_gate;
                }
                return base.store.read(file_path);
            },
        };
        const receipts: ExcelHeaderOperationReceipt[] = [];
        const subscription = coordinator.subscribe_excel_headers((receipt) => {
            receipts.push(receipt);
        });

        const a = coordinator.commit_excel_header(header_command(a_store, 'A', 'off'));
        await a_finalizing;
        const b = coordinator.commit_excel_header(header_command(b_store, 'B', 'on'));
        await b_reading;
        release_a();
        await expect(a).resolves.toMatchObject({ type: 'committed' });
        release_b_read();
        await expect(b).resolves.toMatchObject({ type: 'committed' });

        expect(receipts.map((receipt) => [
            receipt.requestId,
            receipt.resultingBasis.projectionRevision,
        ])).toEqual([
            ['A', 1],
            ['B', 2],
        ]);
        expect(base.value(coordinator.statePath)).toMatchObject({
            excelFirstRowHeaders: { People: 'on' },
        });
        subscription.dispose();
        alias?.dispose();
        coordinator.dispose();
    });

    it('preserves the immediate basis for exact same-digest physical finalization', async () => {
        const upper = 'C:\\Data\\Exact-Physical.xlsx';
        const lower = 'c:\\data\\exact-physical.xlsx';
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(upper, base.store, 'win32');
        await establish(coordinator, 'digest-a', base.store);
        const earlier = begin_physical(coordinator, 'digest-b');
        const later = begin_physical(coordinator, 'digest-b');

        const later_state = await base.store.read(coordinator.statePath);
        await stage_authority(base.store, coordinator.statePath, {
            id: later.id,
            kind: 'physical',
            ordinal: later.ordinal,
            expectedStateRevision: later_state.revision,
            expectedCommitSequence: coordinator.authority().commitSequence,
            physicalDigest: 'digest-b',
        });
        const later_turn = await coordinator.request_commit_turn(later);
        if (later_turn.type !== 'granted') throw new Error('turn rejected');
        const later_basis = coordinator.authority();
        coordinator.start_finalization(later_turn.turn);
        const later_finalized = await finalize_authority(
            base.store,
            coordinator.statePath,
            later.id,
        );
        if (later_finalized.type !== 'finalized') throw new Error('finalize rejected');
        coordinator.finalize_authority_commit(
            later,
            later_turn.turn,
            later_finalized,
            later_basis,
        );

        const earlier_state = await base.store.read(coordinator.statePath);
        await stage_authority(base.store, coordinator.statePath, {
            id: earlier.id,
            kind: 'physical',
            ordinal: earlier.ordinal,
            expectedStateRevision: earlier_state.revision,
            expectedCommitSequence: coordinator.authority().commitSequence,
            physicalDigest: 'digest-b',
        });
        const earlier_turn = await coordinator.request_commit_turn(earlier);
        if (earlier_turn.type !== 'granted') throw new Error('turn rejected');
        const earlier_basis = coordinator.authority();
        coordinator.start_finalization(earlier_turn.turn);
        const earlier_finalized = await finalize_authority(
            base.store,
            coordinator.statePath,
            earlier.id,
        );
        if (earlier_finalized.type !== 'finalized') throw new Error('finalize rejected');

        const alias = acquire_file_coordinator(lower, base.store, 'win32');
        await alias.state_ready();
        const receipt = coordinator.finalize_authority_commit(
            earlier,
            earlier_turn.turn,
            earlier_finalized,
            earlier_basis,
        );

        expect(earlier.basis).toMatchObject({
            commitSequence: 1,
            physicalRevision: 1,
            physicalDigest: 'digest-a',
        });
        expect(receipt).toMatchObject({
            operationKind: 'physical',
            digest: 'digest-b',
            previousBasis: {
                commitSequence: 2,
                authorityRevision: 2,
                physicalRevision: 2,
                physicalDigest: 'digest-b',
            },
            resultingBasis: {
                commitSequence: 3,
                authorityRevision: 2,
                physicalRevision: 2,
                physicalDigest: 'digest-b',
            },
        });
        alias.dispose();
        coordinator.dispose();
    });

    it('commits when alias registration installs the exact finalized authority before receipt', async () => {
        const upper = 'C:\\Data\\Exact-Finalized.xlsx';
        const lower = 'c:\\data\\exact-finalized.xlsx';
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(upper, base.store, 'win32');
        await establish(coordinator, 'digest-a', base.store);
        let alias: ReturnType<typeof acquire_file_coordinator> | undefined;
        const store: AuthorityFileStateStore = {
            ...base.store,
            async inspect_authority_transaction(file_path, id) {
                const inspected = await base.store.inspect_authority_transaction(file_path, id);
                if (id.startsWith('projection:')) {
                    alias = acquire_file_coordinator(lower, base.store, 'win32');
                    await alias.state_ready();
                }
                return inspected;
            },
        };
        const receipt_subscriber = vi.fn();
        const subscription = coordinator.subscribe_excel_headers(receipt_subscriber);

        await expect(coordinator.commit_excel_header(
            header_command(store, 'exact-alias-finalize', 'off'),
        )).resolves.toMatchObject({
            type: 'committed',
            receipt: {
                previousBasis: {
                    commitSequence: 1,
                    authorityRevision: 1,
                    projectionRevision: 0,
                },
                resultingBasis: { projectionRevision: 1, commitSequence: 2 },
            },
        });

        expect(receipt_subscriber).toHaveBeenCalledOnce();
        expect(coordinator.authority()).toMatchObject({
            commitSequence: 2,
            projectionRevision: 1,
        });
        subscription.dispose();
        alias?.dispose();
        coordinator.dispose();
    });

    it('recovers when authority advances after exact finalization inspection', async () => {
        const upper = 'C:\\Data\\Post-Confirmation-Advance.xlsx';
        const lower = 'c:\\data\\post-confirmation-advance.xlsx';
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(upper, base.store, 'win32');
        await establish(coordinator, 'digest-a', base.store);
        let alias: ReturnType<typeof acquire_file_coordinator> | undefined;
        const store: AuthorityFileStateStore = {
            ...base.store,
            async inspect_authority_transaction(file_path, id) {
                const inspected = await base.store.inspect_authority_transaction(file_path, id);
                if (id.startsWith('projection:')) {
                    const current = await base.store.read(file_path);
                    await base.store.stage_authority_transaction(file_path, {
                        id: 'post-confirmation-sequence',
                        kind: 'physical',
                        ordinal: 999,
                        expectedStateRevision: current.revision,
                        expectedCommitSequence: inspected.authority.commitSequence,
                        physicalDigest: inspected.authority.physicalDigest,
                    });
                    await base.store.finalize_authority_transaction(
                        file_path,
                        'post-confirmation-sequence',
                    );
                    alias = acquire_file_coordinator(lower, base.store, 'win32');
                    await alias.state_ready();
                }
                return inspected;
            },
        };
        const receipt_subscriber = vi.fn();
        const receipts = coordinator.subscribe_excel_headers(receipt_subscriber);
        const factory = new TestRefreshWatcherFactory();
        const first_events: FileRefreshEvent[] = [];
        const second_events: FileRefreshEvent[] = [];
        const first = coordinator.subscribe_refresh((event) => { first_events.push(event); }, factory);
        const second = coordinator.subscribe_refresh((event) => { second_events.push(event); }, factory);

        await expect(coordinator.commit_excel_header(
            header_command(store, 'post-confirmation-advance', 'off'),
        )).resolves.toMatchObject({ type: 'indeterminate' });

        expect(receipt_subscriber).not.toHaveBeenCalled();
        expect(first_events).toMatchObject([{ reason: 'projectionRecovery', priority: 'high' }]);
        expect(second_events).toMatchObject([{ reason: 'projectionRecovery', priority: 'high' }]);
        expect(coordinator.authority()).toMatchObject({
            commitSequence: 3,
            projectionRevision: 1,
        });
        first.dispose();
        second.dispose();
        receipts.dispose();
        alias?.dispose();
        coordinator.dispose();
    });

    it('settles equal or dominated observations without installing divergent authority', async () => {
        const path = `/tmp/invalid-authority-${Math.random()}.xlsx`;
        const base = mapped_state_store();
        const coordinator = acquire_file_coordinator(path, base.store);
        const established = await establish(coordinator, 'digest-a', base.store);

        const equal = begin_physical(coordinator, 'digest-a');
        const equal_turn = await coordinator.request_commit_turn(equal);
        if (equal_turn.type !== 'granted') throw new Error('turn rejected');
        expect(coordinator.observe_advanced_authority(
            equal,
            equal_turn.turn,
            established,
        )).toMatchObject(established);

        const dominated = begin_physical(coordinator, 'digest-a');
        const dominated_turn = await coordinator.request_commit_turn(dominated);
        if (dominated_turn.type !== 'granted') throw new Error('turn rejected');
        expect(coordinator.observe_advanced_authority(
            dominated,
            dominated_turn.turn,
            {
                commitSequence: 0,
                authorityRevision: 0,
                physicalRevision: 0,
                projectionRevision: 0,
            },
        )).toMatchObject(established);
        expect(coordinator.authority()).toMatchObject(established);

        const divergent = begin_physical(coordinator, 'digest-a');
        const divergent_turn = await coordinator.request_commit_turn(divergent);
        if (divergent_turn.type !== 'granted') throw new Error('turn rejected');
        expect(() => coordinator.observe_advanced_authority(
            divergent,
            divergent_turn.turn,
            {
                ...established,
                commitSequence: established.commitSequence + 1,
                authorityRevision: 0,
            },
        )).toThrow('not a monotonic advance');
        expect(coordinator.authority()).toMatchObject(established);
        coordinator.dispose();
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

    it('disposes a never-settling refresh request without retaining shared resources', async () => {
        const factory = new TestRefreshWatcherFactory();
        const file_path = `/tmp/request-lifetime-${Math.random()}.csv`;
        const base = mapped_state_store();
        const releases: Array<ReturnType<typeof vi.fn>> = [];
        const lease_entry = vi.fn(async () => {
            const release = vi.fn(async () => {});
            releases.push(release);
            return { release };
        });
        const store: AuthorityFileStateStore = { ...base.store, lease_entry };
        const first = acquire_file_coordinator(file_path, store);
        await first.state_ready();
        let release_listener!: () => void;
        const listener_gate = new Promise<void>((resolve) => { release_listener = resolve; });
        let mark_listener_started!: () => void;
        const listener_started = new Promise<void>((resolve) => { mark_listener_started = resolve; });
        const first_subscription = first.subscribe_refresh(() => {
            mark_listener_started();
            return listener_gate;
        }, factory);
        const request = first_subscription.request('postSave');
        await listener_started;

        first_subscription.dispose();
        first.dispose();

        await expect(request).resolves.toEqual({ type: 'disposed' });
        expect(file_coordinator_registry_size()).toBe(0);
        expect(factory.watchers[0].disposeCalls).toBe(1);
        expect(releases[0]).toHaveBeenCalledOnce();

        const second = acquire_file_coordinator(file_path, store);
        await second.state_ready();
        const second_subscription = second.subscribe_refresh(() => {}, factory);
        expect(factory.watchers).toHaveLength(2);
        expect(factory.watchers[1].disposeCalls).toBe(0);
        expect(file_coordinator_registry_size()).toBe(1);

        release_listener();
        await Promise.resolve();
        await Promise.resolve();
        await expect(request).resolves.toEqual({ type: 'disposed' });
        expect(factory.watchers[0].disposeCalls).toBe(1);
        expect(factory.watchers[1].disposeCalls).toBe(0);
        expect(releases[0]).toHaveBeenCalledOnce();
        expect(file_coordinator_registry_size()).toBe(1);

        second_subscription.dispose();
        second.dispose();
        expect(factory.watchers[1].disposeCalls).toBe(1);
        expect(releases[1]).toHaveBeenCalledOnce();
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

    it('holds an own-write watcher batch for postSave and releases it on cancel', async () => {
        const factory = new TestRefreshWatcherFactory();
        const coordinator = acquire_file_coordinator(`/tmp/reserved-post-save-${Math.random()}.csv`);
        const events: FileRefreshEvent[] = [];
        const subscription = coordinator.subscribe_refresh((event) => { events.push(event); }, factory);

        const absorbed = subscription.reserve_post_save();
        factory.watchers[0].emit('change');
        await flush_refresh();
        expect(events).toEqual([]);
        await expect(subscription.request('postSave')).resolves.toMatchObject({
            event: { refreshRevision: 2, episode: 1, reason: 'postSave' },
        });
        absorbed.cancel(); // already consumed by request
        expect(events).toMatchObject([{
            refreshRevision: 2,
            episode: 1,
            reason: 'postSave',
            priority: 'high',
        }]);

        const released = subscription.reserve_post_save();
        factory.watchers[0].emit('delete');
        await flush_refresh();
        expect(events).toHaveLength(1);
        released.cancel();
        await flush_refresh();
        expect(events[1]).toMatchObject({
            refreshRevision: 3,
            episode: 2,
            reason: 'watcherDelete',
            priority: 'normal',
        });

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

    it('completes coordinator cleanup when watcher disposal throws', () => {
        const watcher: FileRefreshWatcher = {
            on_event() {
                return { dispose() { throw new Error('listener dispose failed'); } };
            },
            dispose() { throw new Error('watcher dispose failed'); },
        };
        const factory: FileRefreshWatcherFactory = { create: () => watcher };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const coordinator = acquire_file_coordinator(`/tmp/dispose-errors-${Math.random()}.csv`);
        const subscription = coordinator.subscribe_refresh(() => {}, factory);
        subscription.dispose();
        coordinator.dispose();

        expect(file_coordinator_registry_size()).toBe(0);
        expect(error).toHaveBeenCalledTimes(2);
        error.mockRestore();
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

    it('rejects provider readiness when complete-entry migration is unsupported', async () => {
        const resource = vscode_mock.Uri.from({
            scheme: 'memfs', authority: 'unsupported', path: '/book.xlsx',
            query: '', fragment: '', fsPath: '/legacy/unsupported-book.xlsx',
        });
        const legacy = canonical_file_key(resource.fsPath);
        const base = mapped_state_store({ [legacy]: { activeSheetIndex: 7 } });
        const backing: FileStateStore = {
            read: base.backing.read,
            compare_and_set: base.backing.compare_and_set,
            canonicalize_path: base.backing.canonicalize_path,
            touch: base.backing.touch,
        };
        const store = with_in_memory_authority_transactions(backing);
        const coordinator = acquire_file_coordinator(resource, store);

        await expect(coordinator.state_ready()).rejects.toThrow(
            'Provider state migration requires an atomic complete-entry copy.',
        );

        expect(base.value(coordinator.statePath)).toBeUndefined();
        expect(base.value(legacy)).toEqual({ activeSheetIndex: 7 });
        coordinator.dispose();
    });

    it('upgrades a provider key from the legacy canonical fsPath without deleting it', async () => {
        const resource = vscode_mock.Uri.from({
            scheme: 'memfs', authority: 'workspace', path: '/book.xlsx',
            query: '', fragment: '', fsPath: '/legacy/provider-book.xlsx',
        });
        const legacy = canonical_file_key(resource.fsPath);
        const base = mapped_state_store({ [legacy]: { activeSheetIndex: 6 } });
        const copy_entry_if_absent = vi.fn(
            (source: string, destination: string, copy_id: string) => (
                base.backing.copy_entry_if_absent!(source, destination, copy_id)
            ),
        );
        const store: AuthorityFileStateStore = { ...base.store, copy_entry_if_absent };
        const coordinator = acquire_file_coordinator(resource, store);
        await coordinator.state_ready();

        expect(copy_entry_if_absent).toHaveBeenCalledWith(
            legacy,
            coordinator.statePath,
            `provider-migration:${JSON.stringify([legacy, coordinator.statePath])}`,
        );
        expect(base.value(coordinator.statePath)).toEqual({ activeSheetIndex: 6 });
        expect(base.value(legacy)).toEqual({ activeSheetIndex: 6 });
        coordinator.dispose();
    });

    it('isolates provider coordinators, state, and watcher streams sharing one fsPath', async () => {
        const first_uri = vscode_mock.Uri.from({
            scheme: 'memfs', authority: 'workspace-a', path: '/book.xlsx',
            query: 'branch=main', fragment: 'one', fsPath: '/same/book.xlsx',
        });
        const second_uri = vscode_mock.Uri.from({
            scheme: 'memfs', authority: 'workspace-b', path: '/book.xlsx',
            query: 'branch=main', fragment: 'two', fsPath: '/same/book.xlsx',
        });
        const state = mapped_state_store();
        const first = acquire_file_coordinator(first_uri, state.store);
        const second = acquire_file_coordinator(second_uri, state.store);
        await Promise.all([first.state_ready(), second.state_ready()]);
        expect(first.statePath).not.toBe(second.statePath);
        expect(first.authority().fileKey).not.toBe(second.authority().fileKey);

        const first_basis = await state.store.read(first.statePath);
        const second_basis = await state.store.read(second.statePath);
        await state.store.compare_and_set(first.statePath, first_basis.revision, {
            activeSheetIndex: 1,
        });
        await state.store.compare_and_set(second.statePath, second_basis.revision, {
            activeSheetIndex: 2,
        });
        expect(state.value(first.statePath)).toEqual({ activeSheetIndex: 1 });
        expect(state.value(second.statePath)).toEqual({ activeSheetIndex: 2 });

        const factory = new TestRefreshWatcherFactory();
        const first_listener = vi.fn();
        const second_listener = vi.fn();
        const first_subscription = first.subscribe_refresh(first_listener, factory);
        const second_subscription = second.subscribe_refresh(second_listener, factory);
        expect(factory.watchers).toHaveLength(2);
        factory.watchers[0].emit('change');
        await flush_refresh();
        expect(first_listener).toHaveBeenCalledOnce();
        expect(second_listener).not.toHaveBeenCalled();

        first_subscription.dispose();
        second_subscription.dispose();
        first.dispose();
        second.dispose();
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
