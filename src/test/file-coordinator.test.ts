import { describe, expect, it, vi } from 'vitest';
import {
    acquire_file_coordinator,
    canonical_file_key,
    file_coordinator_registry_size,
    type AuthorityOperationToken,
    type ExcelHeaderOperationReceipt,
} from '../file-coordinator';
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
): AuthorityOperationToken {
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
    return coordinator.install_finalized_authority(
        operation,
        requested.turn,
        finalized.authority,
    );
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
        coordinator.install_finalized_authority(
            first,
            first_turn.turn,
            finalized.authority,
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
