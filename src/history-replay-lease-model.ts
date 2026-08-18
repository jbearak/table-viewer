/**
 * The lease's lifecycle, as a pure state machine.
 *
 * A lease is what makes a commit correspond to a preparation. The host verified
 * the document, materialized every cell and checked every overlay against
 * durable state; the lease is the receipt, and spending it is what authorizes a
 * mutation the host would otherwise have to re-verify from scratch.
 *
 * Three properties are the whole reason this is a machine and not a `Map`:
 *
 *   - **Exactly once.** A `postMessage` can be delivered twice; a renderer that
 *     did not see an acknowledgement will resend. The first valid commit takes
 *     the lease SYNCHRONOUSLY — before any `await` — so a duplicate arriving
 *     while the host is mid-write finds a lease already spent and joins the
 *     operation already running instead of starting a second one.
 *   - **A settled replay stays answerable.** The answer outlives the lease.
 *     A lost acknowledgement is recovered by resending the identical commit and
 *     getting the recorded answer back, without touching the document again.
 *   - **A different proposal is not a duplicate.** Duplicate delivery and a
 *     second, different proposal under one lease look alike at the transport
 *     and must not be treated alike, so acceptance is keyed on the proposal's
 *     digest as well as its mutation id.
 *
 * No timers and no host APIs: `now` is passed in. Tests advance a number rather
 * than sleeping, which is also why nothing here reads a clock of its own.
 */

import {
    history_replay_proposal_digest,
    HISTORY_REPLAY_LEASE_TTL_MS,
    HISTORY_REPLAY_TERMINAL_RETENTION_MS,
    type CommitHistoryReplayRequest,
    type HistoryReplayCommitRefusalReason,
} from './history-replay-protocol';

/**
 * A lease that has been issued and not yet spent.
 *
 * `payload` is whatever the host needs to keep to finish the job — the prepared
 * cells, the adoption it verified, the source observation. The model neither
 * reads nor copies it: what the lease is BOUND to is the host's business, and
 * teaching this module about adoptions would make the state machine untestable
 * without one.
 */
export interface IssuedHistoryReplayLease<TPayload> {
    readonly state: 'issued';
    readonly leaseId: string;
    readonly requestId: string;
    readonly replayId: string;
    readonly payload: TPayload;
    readonly expiresAt: number;
}

/** A lease whose commit is running. */
export interface CommittingHistoryReplayLease<TPayload> {
    readonly state: 'committing';
    readonly leaseId: string;
    readonly requestId: string;
    readonly replayId: string;
    readonly payload: TPayload;
    readonly mutationId: string;
    readonly proposalDigest: string;
}

/**
 * A replay that has finished, one way or the other.
 *
 * Kept after the lease itself is gone, and for much longer: this is what a lost
 * acknowledgement is recovered from. `settledAt` starts the retention clock.
 */
export interface SettledHistoryReplay<TResult> {
    readonly state: 'settled';
    readonly leaseId: string;
    readonly requestId: string;
    readonly replayId: string;
    readonly mutationId: string;
    readonly proposalDigest: string;
    readonly result: TResult;
    readonly settledAt: number;
}

export type HistoryReplayLease<TPayload, TResult> =
    | IssuedHistoryReplayLease<TPayload>
    | CommittingHistoryReplayLease<TPayload>
    | SettledHistoryReplay<TResult>;

/**
 * What a commit request should cause.
 *
 *   - `accept`: this caller owns the mutation and must run it, then report the
 *     outcome through {@link settle_history_replay_lease}.
 *   - `join`: the same proposal is already running. Await that operation and
 *     answer with its result; do NOT run a second one.
 *   - `replay`: it already finished. Re-post the recorded answer.
 *   - `refuse`: it cannot proceed, with the reason to post.
 */
export type HistoryReplayCommitDecision<TPayload, TResult> =
    | {
        readonly kind: 'accept';
        readonly lease: CommittingHistoryReplayLease<TPayload>;
    }
    | {
        readonly kind: 'join';
        readonly lease: CommittingHistoryReplayLease<TPayload>;
    }
    | {
        readonly kind: 'replay';
        readonly settled: SettledHistoryReplay<TResult>;
    }
    | {
        readonly kind: 'refuse';
        readonly reason: HistoryReplayCommitRefusalReason;
    };

export interface HistoryReplayLeaseRegistry<TPayload, TResult> {
    /**
     * Issue a lease for a verified preparation.
     *
     * At most one lease is live at a time: a replay is a document-wide
     * operation, and two of them interleaving would each be planning against a
     * document the other is moving. Returns `undefined` when one is already
     * outstanding.
     */
    issue(
        identity: { readonly leaseId: string; readonly requestId: string; readonly replayId: string },
        payload: TPayload,
        now: number,
    ): IssuedHistoryReplayLease<TPayload> | undefined;
    /**
     * Decide what a commit request causes, taking the lease if it is this
     * caller's to take. Synchronous and total: the transition happens before the
     * caller's first `await`, which is what makes the taking exactly-once.
     */
    decide_commit(
        request: CommitHistoryReplayRequest,
        now: number,
    ): HistoryReplayCommitDecision<TPayload, TResult>;
    /** Record a running commit's outcome, making it replayable. */
    settle(leaseId: string, result: TResult, now: number): void;
    /** The live lease, if there is one and it has not expired. */
    current(now: number): IssuedHistoryReplayLease<TPayload> | CommittingHistoryReplayLease<TPayload> | undefined;
    /**
     * Drop an unspent lease. Idempotent, and deliberately silent about a lease
     * that is already committing: abandonment races a commit the caller has
     * already sent, and losing that race must not cancel the mutation.
     */
    abandon(leaseId: string): void;
    /**
     * Invalidate an unspent lease because the host state it was bound to moved.
     * A committing lease is left alone — its operation carries its own currency
     * checks and its answer must stay recoverable.
     */
    invalidate(): void;
    /** Expire an unspent lease past its TTL and forget settled replays past retention. */
    collect(now: number): void;
    /** Forget everything. For a renderer reload, whose history is gone anyway. */
    clear(): void;
}

export function create_history_replay_lease_registry<TPayload, TResult>(
): HistoryReplayLeaseRegistry<TPayload, TResult> {
    let live: IssuedHistoryReplayLease<TPayload> | CommittingHistoryReplayLease<TPayload> | undefined;
    const settled = new Map<string, SettledHistoryReplay<TResult>>();

    const expired = (lease: typeof live, now: number): boolean => (
        lease?.state === 'issued' && now >= lease.expiresAt
    );

    const collect = (now: number): void => {
        // Only an ISSUED lease expires. A committing one is mid-write: expiring
        // it would leave a mutation running with nothing to record its answer
        // against, and the answer is what a lost acknowledgement recovers.
        if (expired(live, now)) live = undefined;
        for (const [id, record] of settled) {
            if (now - record.settledAt >= HISTORY_REPLAY_TERMINAL_RETENTION_MS) {
                settled.delete(id);
            }
        }
    };

    return {
        issue: (identity, payload, now) => {
            collect(now);
            if (live !== undefined) return undefined;
            const lease: IssuedHistoryReplayLease<TPayload> = Object.freeze({
                state: 'issued' as const,
                leaseId: identity.leaseId,
                requestId: identity.requestId,
                replayId: identity.replayId,
                payload,
                expiresAt: now + HISTORY_REPLAY_LEASE_TTL_MS,
            });
            live = lease;
            return lease;
        },

        decide_commit: (request, now) => {
            collect(now);
            const digest = history_replay_proposal_digest(request);

            // Settled first, and BEFORE the identity checks below: this is the
            // lost-acknowledgement path, and by the time it is taken the lease
            // is long gone, so nothing else could recognize the request.
            const record = settled.get(request.leaseId);
            if (record !== undefined) {
                if (
                    record.requestId !== request.requestId
                    || record.replayId !== request.replayId
                ) return { kind: 'refuse', reason: 'malformed' };
                if (
                    record.mutationId !== request.mutationId
                    || record.proposalDigest !== digest
                ) return { kind: 'refuse', reason: 'proposal-mismatch' };
                return { kind: 'replay', settled: record };
            }

            if (live === undefined || live.leaseId !== request.leaseId) {
                // Nothing by that name: it expired unspent, was abandoned, or
                // was invalidated. All three are terminal for the webview, which
                // must start a fresh preparation rather than retry.
                return { kind: 'refuse', reason: 'expired' };
            }
            if (
                live.requestId !== request.requestId
                || live.replayId !== request.replayId
            ) return { kind: 'refuse', reason: 'malformed' };

            if (live.state === 'committing') {
                if (
                    live.mutationId !== request.mutationId
                    || live.proposalDigest !== digest
                ) return { kind: 'refuse', reason: 'proposal-mismatch' };
                return { kind: 'join', lease: live };
            }

            const committing: CommittingHistoryReplayLease<TPayload> = Object.freeze({
                state: 'committing' as const,
                leaseId: live.leaseId,
                requestId: live.requestId,
                replayId: live.replayId,
                payload: live.payload,
                mutationId: request.mutationId,
                proposalDigest: digest,
            });
            live = committing;
            return { kind: 'accept', lease: committing };
        },

        settle: (leaseId, result, now) => {
            if (live?.state !== 'committing' || live.leaseId !== leaseId) return;
            settled.set(leaseId, Object.freeze({
                state: 'settled' as const,
                leaseId,
                requestId: live.requestId,
                replayId: live.replayId,
                mutationId: live.mutationId,
                proposalDigest: live.proposalDigest,
                result,
                settledAt: now,
            }));
            live = undefined;
        },

        current: (now) => {
            collect(now);
            return live;
        },

        abandon: (leaseId) => {
            if (live?.state === 'issued' && live.leaseId === leaseId) live = undefined;
        },

        invalidate: () => {
            if (live?.state === 'issued') live = undefined;
        },

        collect,

        clear: () => {
            live = undefined;
            settled.clear();
        },
    };
}
