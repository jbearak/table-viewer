import { describe, expect, it } from 'vitest';
import {
    create_history_replay_lease_registry,
    type HistoryReplayLeaseRegistry,
} from '../history-replay-lease-model';
import {
    sanitized_commit_history_replay_request,
    HISTORY_REPLAY_LEASE_TTL_MS,
    HISTORY_REPLAY_TERMINAL_RETENTION_MS,
    type CommitHistoryReplayRequest,
} from '../history-replay-protocol';

const IDENTITY = { leaseId: 'lease-1', requestId: 'req-1', replayId: 'replay-1' };

/** A fake clock, advanced explicitly: nothing here waits on a real delay. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
    let value = start;
    return { now: () => value, advance: (ms) => { value += ms; } };
}

function commit(overrides: Record<string, unknown> = {}): CommitHistoryReplayRequest {
    const parsed = sanitized_commit_history_replay_request({
        ...IDENTITY,
        mutationId: 'mutation-1',
        cells: [{ ordinal: 0, entry: null }],
        highlights: [],
        ...overrides,
    });
    if (parsed === undefined) throw new Error('fixture is not a valid commit request');
    return parsed;
}

function registry(): HistoryReplayLeaseRegistry<string, string> {
    return create_history_replay_lease_registry<string, string>();
}

describe('issuing', () => {
    it('issues one lease and refuses a second while it is live', () => {
        const time = clock();
        const leases = registry();
        expect(leases.issue(IDENTITY, 'payload', time.now())).toBeDefined();
        expect(leases.issue(
            { ...IDENTITY, leaseId: 'lease-2' }, 'payload', time.now(),
        )).toBeUndefined();
    });

    it('issues again once the first expired unspent', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        time.advance(HISTORY_REPLAY_LEASE_TTL_MS);
        expect(leases.issue(
            { ...IDENTITY, leaseId: 'lease-2' }, 'payload', time.now(),
        )).toBeDefined();
    });

    it('carries the host payload through untouched', () => {
        const time = clock();
        const leases = create_history_replay_lease_registry<{ cells: number }, string>();
        const payload = { cells: 3 };
        expect(leases.issue(IDENTITY, payload, time.now())?.payload).toBe(payload);
    });
});

describe('exactly-once consumption', () => {
    it('the first matching commit takes the lease', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        const decision = leases.decide_commit(commit(), time.now());
        expect(decision.kind).toBe('accept');
        expect(leases.current(time.now())?.state).toBe('committing');
    });

    it('a duplicate of the same proposal joins rather than running again', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        const first = leases.decide_commit(commit(), time.now());
        const second = leases.decide_commit(commit(), time.now());
        expect(first.kind).toBe('accept');
        expect(second.kind).toBe('join');
        if (first.kind !== 'accept' || second.kind !== 'join') throw new Error('unreachable');
        expect(second.lease).toBe(first.lease);
    });

    it('a different proposal under the same lease is refused, never applied', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.decide_commit(commit(), time.now());
        const other = leases.decide_commit(
            commit({ cells: [{ ordinal: 0, entry: { value: 'x', base: 'y' } }] }),
            time.now(),
        );
        expect(other).toEqual({ kind: 'refuse', reason: 'proposal-mismatch' });
    });

    it('a different mutation id over identical writes is refused', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.decide_commit(commit(), time.now());
        expect(leases.decide_commit(
            commit({ mutationId: 'mutation-2' }), time.now(),
        )).toEqual({ kind: 'refuse', reason: 'proposal-mismatch' });
    });

    it('a mismatched correlation is malformed, not a mismatch', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        expect(leases.decide_commit(
            commit({ replayId: 'replay-2' }), time.now(),
        )).toEqual({ kind: 'refuse', reason: 'malformed' });
    });

    it('an unknown lease id is expired', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        expect(leases.decide_commit(
            commit({ leaseId: 'lease-9' }), time.now(),
        )).toEqual({ kind: 'refuse', reason: 'expired' });
    });
});

describe('expiry', () => {
    it('an unspent lease cannot commit past its TTL', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        time.advance(HISTORY_REPLAY_LEASE_TTL_MS);
        expect(leases.decide_commit(commit(), time.now()))
            .toEqual({ kind: 'refuse', reason: 'expired' });
    });

    it('a lease taken just inside its TTL still commits', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        time.advance(HISTORY_REPLAY_LEASE_TTL_MS - 1);
        expect(leases.decide_commit(commit(), time.now()).kind).toBe('accept');
    });

    it('a committing lease does not expire mid-operation', () => {
        // Expiring it would leave a mutation running with nothing to record its
        // answer against — and the answer is what a lost ack recovers.
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.decide_commit(commit(), time.now());
        time.advance(HISTORY_REPLAY_LEASE_TTL_MS * 10);
        expect(leases.current(time.now())?.state).toBe('committing');
        expect(leases.decide_commit(commit(), time.now()).kind).toBe('join');
    });
});

describe('settled replays', () => {
    it('a duplicate after completion replays the recorded answer', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.decide_commit(commit(), time.now());
        leases.settle(IDENTITY.leaseId, 'committed', time.now());

        const decision = leases.decide_commit(commit(), time.now());
        expect(decision.kind).toBe('replay');
        if (decision.kind !== 'replay') throw new Error('unreachable');
        expect(decision.settled.result).toBe('committed');
    });

    it('the answer outlives the lease TTL, which is the whole point', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.decide_commit(commit(), time.now());
        leases.settle(IDENTITY.leaseId, 'committed', time.now());
        time.advance(HISTORY_REPLAY_LEASE_TTL_MS * 5);
        expect(leases.decide_commit(commit(), time.now()).kind).toBe('replay');
    });

    it('a settled replay is forgotten past retention', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.decide_commit(commit(), time.now());
        leases.settle(IDENTITY.leaseId, 'committed', time.now());
        time.advance(HISTORY_REPLAY_TERMINAL_RETENTION_MS);
        leases.collect(time.now());
        expect(leases.decide_commit(commit(), time.now()))
            .toEqual({ kind: 'refuse', reason: 'expired' });
    });

    it('a different proposal against a settled replay is a mismatch', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.decide_commit(commit(), time.now());
        leases.settle(IDENTITY.leaseId, 'committed', time.now());
        expect(leases.decide_commit(
            commit({ mutationId: 'mutation-2' }), time.now(),
        )).toEqual({ kind: 'refuse', reason: 'proposal-mismatch' });
    });

    it('settling frees the slot for the next replay', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.decide_commit(commit(), time.now());
        leases.settle(IDENTITY.leaseId, 'refused', time.now());
        expect(leases.current(time.now())).toBeUndefined();
        expect(leases.issue(
            { ...IDENTITY, leaseId: 'lease-2' }, 'payload', time.now(),
        )).toBeDefined();
    });

    it('settling a lease that is not committing does nothing', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.settle(IDENTITY.leaseId, 'committed', time.now());
        expect(leases.current(time.now())?.state).toBe('issued');
    });
});

describe('abandonment and invalidation', () => {
    it('abandoning an unspent lease frees the slot', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.abandon(IDENTITY.leaseId);
        expect(leases.current(time.now())).toBeUndefined();
        expect(leases.decide_commit(commit(), time.now()))
            .toEqual({ kind: 'refuse', reason: 'expired' });
    });

    it('abandoning is idempotent and ignores a foreign id', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.abandon('lease-9');
        expect(leases.current(time.now())).toBeDefined();
        leases.abandon(IDENTITY.leaseId);
        leases.abandon(IDENTITY.leaseId);
        expect(leases.current(time.now())).toBeUndefined();
    });

    it('abandoning cannot cancel a commit already running', () => {
        // Abandonment races a commit the webview already sent; losing that race
        // must not stop the mutation, whose answer is still owed.
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.decide_commit(commit(), time.now());
        leases.abandon(IDENTITY.leaseId);
        expect(leases.current(time.now())?.state).toBe('committing');
    });

    it('invalidation drops an unspent lease but spares a committing one', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.invalidate();
        expect(leases.current(time.now())).toBeUndefined();

        leases.issue({ ...IDENTITY, leaseId: 'lease-2' }, 'payload', time.now());
        leases.decide_commit(commit({ leaseId: 'lease-2' }), time.now());
        leases.invalidate();
        expect(leases.current(time.now())?.state).toBe('committing');
    });

    it('clearing forgets settled answers too', () => {
        const time = clock();
        const leases = registry();
        leases.issue(IDENTITY, 'payload', time.now());
        leases.decide_commit(commit(), time.now());
        leases.settle(IDENTITY.leaseId, 'committed', time.now());
        leases.clear();
        expect(leases.decide_commit(commit(), time.now()))
            .toEqual({ kind: 'refuse', reason: 'expired' });
    });
});
