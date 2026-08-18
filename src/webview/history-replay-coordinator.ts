/**
 * One replay, from keypress to committed answer.
 *
 * The state machine between the history stack and the host's replay protocol.
 * Deliberately free of React and of the stores: the caller supplies readers over
 * the live overlay and highlight state, a poster, and a clock, and this module
 * decides what is sent, what is refused, and what a response means. That is what
 * makes it testable without a webview.
 *
 * ## One at a time, and why the reservation is not the lease
 *
 * `commit_history_move` tolerates a commit that is late, duplicated or out of
 * order and says which it was — but two replays of one entry in flight together
 * are indistinguishable from one whose commit is merely slow. So exactly one
 * replay may be outstanding, and this module is what guarantees it.
 *
 * The reservation is separate from the host's lease because it starts EARLIER:
 * it is taken when the user presses undo, before any message has been sent, and
 * a second keypress in that window must be refused too. The lease only exists
 * once the host has answered.
 *
 * ## What crosses, and what does not
 *
 * The request carries each cell's CURRENT overlay — what the cell holds right
 * now — not the side the action recorded. The host compares that against durable
 * state and echoes it back, and the planner then compare-and-swaps the recorded
 * transition against the echoed snapshot. Sending the recorded side instead
 * would be asking the host to confirm what the history already says, which
 * proves nothing about the document.
 *
 * ## Lost acknowledgements
 *
 * A commit that is sent and never answered is not known to have failed. The
 * identity of that commit — lease, mutation and proposal — is therefore retained
 * rather than discarded, so a retry is recognized as the SAME mutation and
 * answered from the host's terminal record instead of applied a second time.
 */

import {
    prepared_overlays_match_store,
    read_state_from_prepared_replay,
} from './history-replay-wire-model';
import {
    plan_history_replay,
    type ReplayPlan,
    type ReplayPlanResult,
} from './history-replay-model';
import {
    build_commit_request,
    build_prepare_request,
    commit_refusal_reason,
    prepare_refusal_reason,
    type ReplayRefusalReason,
    type ReplayRequestSources,
} from './history-replay-request-model';
import {
    action_requires_edit_session,
    peek_history,
    type HistoryEntry,
    type HistoryStackState,
} from './history-stack-model';
import type { HistoryDirection } from './history-cell-state-model';
import type {
    AbandonHistoryReplayRequest,
    CommitHistoryReplayRequest,
    HistoryReplayCommitRefused,
    HistoryReplayCommitted,
    HistoryReplayPrepared,
    HistoryReplayPrepareRefused,
    PrepareHistoryReplayRequest,
} from '../history-replay-protocol';

/**
 * A committed replay the coordinator has accepted, and what it moves.
 *
 * Returned by `on_committed` so the caller applies exactly the replay that was
 * accepted, with the entry and direction it was accepted for.
 */
export interface AcceptedReplay {
    readonly committed: HistoryReplayCommitted;
    readonly entry: HistoryEntry;
    readonly direction: HistoryDirection;
}

/** How a replay ended, for the caller to report or ignore. */
export type ReplayOutcome =
    | { readonly kind: 'committed'; readonly committed: HistoryReplayCommitted; readonly plan: ReplayPlan }
    | { readonly kind: 'refused'; readonly reason: ReplayRefusalReason };

export type { ReplayRefusalReason };

export interface ReplayCoordinatorHost extends ReplayRequestSources {
    /** The live history, read at the moment a replay starts. */
    readonly history: () => HistoryStackState;
    /**
     * Make sure an edit session is held, acquiring one if it is not, and answer
     * whether one is held now.
     *
     * Exists because a discard is undoable and a discard ENDS the session. Undo
     * of one therefore has to acquire a session before it can prepare: there is
     * otherwise no session for the host to authorize a write against, and no
     * store the restored overlays could be installed into.
     *
     * Called only for an action that writes CELLS — see
     * `action_requires_edit_session`. Highlights are durable workbook state, and
     * putting the user into edit mode to undo one would be entering content-editing
     * for a gesture that was never a content edit.
     *
     * Awaited before the prepare request is built, never alongside it. A grant
     * crosses a hydration boundary that replaces the stores wholesale, so a
     * request built beforehand would describe overlays that no longer exist — and
     * the history may itself have moved across the await, which is why the entry
     * is re-read afterwards rather than carried over.
     *
     * `false` is an ordinary refusal: the host would not grant one, or its cleanup
     * after the discard failed and editing is disabled for the file. Undo does not
     * retry, and never re-enters edit mode on a promise it cannot keep.
     */
    readonly ensure_session: () => Promise<boolean>;
    readonly post: (
        message:
            | { readonly type: 'prepareHistoryReplay'; readonly request: PrepareHistoryReplayRequest }
            | { readonly type: 'commitHistoryReplay'; readonly request: CommitHistoryReplayRequest }
            | { readonly type: 'abandonHistoryReplay'; readonly request: AbandonHistoryReplayRequest },
    ) => void;
    /** Correlation ids. Injected so tests are deterministic. */
    readonly next_id: (prefix: string) => string;
}

export interface HistoryReplayCoordinator {
    /**
     * Begin a replay in `direction`, or refuse.
     *
     * Resolves when the replay has settled one way or the other. A refusal is
     * final: the caller does not retry, because every refusal reason means the
     * state the replay was planned against is gone.
     */
    begin(direction: HistoryDirection): Promise<ReplayOutcome>;
    /** Whether a replay is outstanding, so the caller can refuse new gestures. */
    is_busy(): boolean;
    /** Deliver a host response. Unrecognized correlations are ignored. */
    on_prepared(prepared: HistoryReplayPrepared): void;
    on_prepare_refused(refusal: HistoryReplayPrepareRefused): void;
    /**
     * Accept a committed answer, returning what the caller must now apply.
     *
     * The accepted replay is RETURNED rather than left for the caller to read
     * back, because settling clears the reservation the entry lives in: an
     * accessor would have to be consulted before this call and never after, which
     * is a temporal coupling between React wiring and this state machine's
     * internals. Returning it makes acceptance and application one step, so the
     * caller cannot apply a document mutation this coordinator did not accept.
     *
     * `undefined` for an answer that does not match the running replay — a stale
     * correlation, or none running at all — and nothing should be applied then.
     */
    on_committed(committed: HistoryReplayCommitted): AcceptedReplay | undefined;
    on_commit_refused(refusal: HistoryReplayCommitRefused): void;
    /**
     * Abandon anything outstanding, because the document this history belongs to
     * is gone.
     *
     * A running replay is settled as refused rather than left pending: its caller
     * is awaiting an answer, and a promise that never resolves would hold the
     * reservation — and the user's undo — forever.
     */
    reset(): void;
}

/** What a started replay is waiting for. */
interface RunningReplay {
    readonly direction: HistoryDirection;
    readonly entry: HistoryEntry;
    readonly requestId: string;
    readonly replayId: string;
    readonly settle: (outcome: ReplayOutcome) => void;
    /**
     * How many highlights the prepare request carried.
     *
     * Retained rather than read back off the response: the prepared reply echoes
     * cells but not highlights, and the commit's highlight ordinals must name the
     * set the HOST verified. Counting the plan's own highlights instead would let
     * a plan and a preparation that disagree produce a commit addressing
     * highlights nothing was checked about.
     */
    readonly highlightCount: number;
    /** Set once the host has answered a prepare. */
    plan?: ReplayPlan;
    /**
     * Set once a commit has been sent, and retained if its answer is lost.
     *
     * The only record of a lease this replay keeps, and deliberately so: every
     * pre-commit path — a store that moved, a plan that refused, a planned write
     * with no ordinal — abandons the lease before returning, and the success path
     * sets this synchronously. There is therefore no reachable state in which a
     * lease is held but no commit was sent, and no second field is needed to
     * describe one.
     */
    commit?: CommitHistoryReplayRequest;
}

/**
 * A replay that has reserved the slot but has no entry yet, because it is waiting
 * on an edit session.
 *
 * Its own state rather than a half-filled {@link RunningReplay}: everything that
 * identifies a replay — the entry, the correlation ids, the highlight count — is
 * only knowable AFTER the session is granted, since the grant may move the
 * history. A running replay whose fields were still to be filled in would make
 * every response handler check whether they had been.
 *
 * The slot is held from the moment the user presses undo, which is what the
 * reservation has always been for: acquiring a session awaits a round trip, and a
 * second undo in that window must be refused rather than start a replay of its
 * own.
 */
interface AcquiringReplay {
    readonly kind: 'acquiring';
    readonly direction: HistoryDirection;
    readonly settle: (outcome: ReplayOutcome) => void;
}

/**
 * The one slot, in whichever phase holds it.
 *
 * One variable rather than two, because the two phases are halves of a single
 * fact — a replay is outstanding — and separate variables would make "both
 * populated" a representable state that nothing can produce, leaving every
 * busy check, settle path and reset to spell out the same exclusion by hand.
 */
type ActiveReplay = AcquiringReplay | (RunningReplay & { readonly kind: 'running' });

export function create_history_replay_coordinator(
    host: ReplayCoordinatorHost,
): HistoryReplayCoordinator {
    let active: ActiveReplay | undefined;

    /** The slot's occupant, but only once it is actually replaying. */
    const running_replay = (): (RunningReplay & { kind: 'running' }) | undefined =>
        active?.kind === 'running' ? active : undefined;

    const settle = (outcome: ReplayOutcome): void => {
        const replay = running_replay();
        if (replay === undefined) return;
        active = undefined;
        replay.settle(outcome);
    };

    const refuse = (reason: ReplayRefusalReason): void => {
        settle({ kind: 'refused', reason });
    };

    /** Release the reservation, if it is still the one that took the slot. */
    const release = (held: AcquiringReplay, outcome: ReplayOutcome): void => {
        if (active !== held) return;
        active = undefined;
        held.settle(outcome);
    };

    return {
        is_busy: () => active !== undefined,

        begin: (direction) => new Promise<ReplayOutcome>((resolve) => {
            if (active !== undefined) {
                resolve({ kind: 'refused', reason: 'busy' });
                return;
            }
            // Refuse an empty or blocked history BEFORE acquiring anything.
            // Acquiring a session installs fresh stores and puts the window into
            // edit mode, so doing it first would mean pressing undo with nothing
            // to undo silently started editing the file and then refused. The
            // authoritative read is still the one after the grant — a grant can
            // move the history — and this one only avoids a round trip that
            // could not have replayed anything.
            const before_acquiring = peek_history(host.history(), direction);
            if (before_acquiring.kind === 'blocked') {
                resolve({ kind: 'refused', reason: 'blocked' });
                return;
            }
            if (before_acquiring.kind === 'exhausted') {
                resolve({ kind: 'refused', reason: 'nothing-to-replay' });
                return;
            }
            // And acquire one only for a gesture that actually writes cells.
            // Highlights are durable workbook state, changeable outside edit mode
            // entirely, so undoing a highlight-only gesture must not put the user
            // into editing — while a MIXED gesture carries a cell write and still
            // must. Decided on this pre-grant read, which is sound for the purpose:
            // a grant can move the history, but only a cell-carrying entry asks for
            // one, and the post-grant read below is what the request is built from.
            const needs_session = action_requires_edit_session(before_acquiring.entry.action);
            const held: AcquiringReplay = { kind: 'acquiring', direction, settle: resolve };
            active = held;
            void (async () => {
                if (needs_session) {
                    let granted: boolean;
                    try {
                        granted = await host.ensure_session();
                    } catch {
                        granted = false;
                    }
                    if (!granted) {
                        // No session, so nothing to authorize a write against. An
                        // ordinary refusal, not an error: the host may simply
                        // refuse, and after a failed discard cleanup editing is
                        // disabled for the whole file.
                        release(held, { kind: 'refused', reason: 'unavailable' });
                        return;
                    }
                }
                if (active !== held) return;
                // Read AFTER any acquisition, never carried across it: a grant
                // replaces the stores wholesale, so the overlays a request must
                // describe are the post-install ones, and the epoch may have moved
                // — which is what would make an entry read earlier stale. Re-read
                // even when nothing was acquired, because this runs a turn later
                // and a recording can have landed in between.
                const peek = peek_history(host.history(), direction);
                if (peek.kind === 'blocked') {
                    release(held, { kind: 'refused', reason: 'blocked' });
                    return;
                }
                if (peek.kind === 'exhausted') {
                    release(held, { kind: 'refused', reason: 'nothing-to-replay' });
                    return;
                }
                const request = build_prepare_request(peek.entry, direction, host);
                if (request === undefined) {
                    // A cell the renderer cannot see right now. Refusing beats
                    // sending a request the host would have to answer
                    // `unavailable` for, and beats guessing an overlay the store
                    // does not hold.
                    release(held, { kind: 'refused', reason: 'unavailable' });
                    return;
                }
                // The one slot changes phase — from acquiring to running — in a
                // single assignment, so no window exists in which it is free.
                active = {
                    kind: 'running',
                    direction,
                    entry: peek.entry,
                    requestId: request.requestId,
                    replayId: request.replayId,
                    highlightCount: request.highlights.length,
                    settle: resolve,
                };
                host.post({ type: 'prepareHistoryReplay', request });
            })();
        }),

        on_prepared: (prepared) => {
            const replay = running_replay();
            if (
                replay === undefined
                || replay.requestId !== prepared.requestId
                || replay.replayId !== prepared.replayId
                || replay.plan !== undefined
            ) return;

            // The store may have moved during the round trip. Finding out here
            // costs a refusal; finding out after the commit costs a document
            // mutation the local history can no longer describe.
            if (!prepared_overlays_match_store(prepared, host.read_overlay)) {
                host.post({
                    type: 'abandonHistoryReplay',
                    request: { requestId: replay.requestId, replayId: replay.replayId, leaseId: prepared.leaseId },
                });
                refuse('conflict');
                return;
            }

            // Planned against the FROZEN snapshot the lease was issued against,
            // never the live store: planning against a state the host never
            // verified would authorize a write it never checked.
            const result: ReplayPlanResult = plan_history_replay(
                replay.entry.action,
                replay.direction,
                read_state_from_prepared_replay(prepared),
            );
            if (result.kind === 'refused') {
                host.post({
                    type: 'abandonHistoryReplay',
                    request: { requestId: replay.requestId, replayId: replay.replayId, leaseId: prepared.leaseId },
                });
                refuse(result.reason === 'unavailable' ? 'unavailable' : 'conflict');
                return;
            }

            const commit = build_commit_request(
                prepared,
                result,
                host.next_id('mutation'),
                replay.highlightCount,
            );
            if (commit === undefined) {
                // A planned write the preparation has no ordinal for. The host
                // would refuse it as a proposal mismatch; refusing here saves the
                // round trip and says the same thing.
                host.post({
                    type: 'abandonHistoryReplay',
                    request: { requestId: replay.requestId, replayId: replay.replayId, leaseId: prepared.leaseId },
                });
                refuse('conflict');
                return;
            }
            replay.plan = result;
            replay.commit = commit;
            host.post({ type: 'commitHistoryReplay', request: commit });
        },

        on_prepare_refused: (refusal) => {
            const replay = running_replay();
            if (
                replay === undefined
                || replay.requestId !== refusal.requestId
                || replay.replayId !== refusal.replayId
            ) return;
            refuse(prepare_refusal_reason(refusal.reason));
        },

        on_committed: (committed) => {
            const replay = running_replay();
            if (
                replay === undefined
                || replay.commit === undefined
                || replay.plan === undefined
                || replay.commit.leaseId !== committed.leaseId
                || replay.commit.mutationId !== committed.mutationId
            ) return undefined;
            // Read off the reservation BEFORE settling clears it, and handed back
            // rather than left for the caller to fetch.
            const accepted: AcceptedReplay = {
                committed,
                entry: replay.entry,
                direction: replay.direction,
            };
            settle({ kind: 'committed', committed, plan: replay.plan });
            return accepted;
        },

        on_commit_refused: (refusal) => {
            const replay = running_replay();
            if (
                replay === undefined
                || replay.commit === undefined
                || replay.commit.leaseId !== refusal.leaseId
                || replay.commit.mutationId !== refusal.mutationId
            ) return;
            refuse(commit_refusal_reason(refusal.reason));
        },

        reset: () => {
            const held = active;
            if (held !== undefined && held.kind === 'acquiring') {
                // Still waiting on a session for a document that has gone. Its
                // caller is awaiting an answer, so it is refused rather than left
                // for the acquisition to resolve into nothing — and the guard
                // there sees the cleared reservation and stops.
                release(held, { kind: 'refused', reason: 'document-changed' });
                return;
            }
            const replay = running_replay();
            if (replay === undefined) return;
            // Nothing to abandon, in either phase. Before a commit the replay
            // holds no lease — every pre-commit exit in `on_prepared` abandons
            // before returning — and after one, abandonment would race the commit
            // it names, and losing that race must not cancel a mutation already
            // running. The document's answer is simply no longer wanted.
            refuse('document-changed');
        },
    };
}
