/**
 * The workbook's undo/redo history, held where the workbook is.
 *
 * One store per open document, beside the edit-session registry in App, because
 * the history is workbook-wide by decision: a gesture on any sheet joins one
 * chronological list, and undoing an edit made on another sheet switches to it.
 * Per-sheet stores could not express that, and React state could not either —
 * capture needs the current state synchronously, in the middle of assembling a
 * gesture, without a re-render between reading it and recording into it.
 *
 * Deliberately ignorant of edit sessions, saves and edit mode. History outlives
 * an edit session (undo may re-enter edit mode, and must never be what releases
 * one), a save is not a boundary, and the only thing that empties it is a
 * different document taking this one's place.
 *
 * Staging mirrors {@link EditSessionStore.stage_writes}, and for the same
 * reason: recording an action and applying its edits are one transaction, so
 * neither may publish until both have swapped. A subscriber that saw the history
 * grow before the cells moved — or the reverse — would render a menu enabled for
 * an action whose edits are not there yet.
 */

import {
    commit_history_move,
    empty_history_stack,
    record_history_action,
    rekey_saved_appended_row_history,
    rekey_committed_tail_removal_history,
    type CommitOutcome,
    type HistoryAction,
    type HistoryActionSource,
    type HistoryBounds,
    type HistoryEntry,
    type HistoryStackState,
    type RecordOutcome,
    type SavedHistoryRowAssignment,
    type SavedTailRemovalCommit,
} from './history-stack-model';
import type { HistoryDirection } from './history-cell-state-model';
import { stage_mutation, type StagedMutation } from './staged-mutation';

/**
 * A recording held back from the store's subscribers — a {@link StagedMutation}
 * that also says what recording WOULD do.
 *
 * `outcome` is available before the commit, so a caller can see whether the
 * action was refused, empty, or recorded while it is still deciding whether to
 * go through with the transaction it belongs to.
 */
export interface StagedHistoryRecord extends StagedMutation {
    readonly outcome: RecordOutcome;
}

/**
 * A replayed entry's move, held back from the store's subscribers.
 *
 * Staged for the same reason a recording is, and more urgently: a replay moves
 * cells across possibly several worksheet stores AND moves the entry between the
 * undo and redo stacks, and those are one transaction. A subscriber that saw the
 * entry change stacks before the cells moved would offer to redo a change that
 * is not applied yet.
 */
export interface StagedHistoryMove extends StagedMutation {
    /**
     * What the move WOULD do — moved, already-committed, or dropped — available
     * before the commit, so a caller can see which case it has while it is still
     * deciding whether to go through with the transaction.
     */
    readonly outcome: CommitOutcome;
}

export interface HistoryStore {
    /** Copy-on-write, so it is a valid `useSyncExternalStore` getSnapshot. */
    snapshot(): HistoryStackState;
    subscribe(listener: () => void): () => void;
    /**
     * Record an action, without publishing it.
     *
     * The action should be a plain `{label, changes}` rather than one built by
     * `history_action`: recording takes ownership and abandons the rebuild as
     * soon as the hard bound is passed, so handing it a pre-owned action makes a
     * gesture too large to keep get fully copied before being refused.
     */
    /**
     * Stage a recording. Accepts a streamed source so an unbounded gesture — a
     * workbook-wide discard — is only materialized as far as the bounds allow.
     */
    stage_record(
        action: HistoryAction | HistoryActionSource,
        bounds?: HistoryBounds,
    ): StagedHistoryRecord;
    /**
     * Record that a replayed entry has landed, without publishing it.
     *
     * `entry` is the one `peek_history` handed out. ONE REPLAY AT A TIME remains
     * the caller's obligation — see `commit_history_move`: the stack tolerates a
     * commit that is late, duplicated or out of order and says which it was, but
     * two replays of the same entry in flight together are indistinguishable
     * from one whose commit is merely slow.
     */
    stage_move(
        direction: HistoryDirection,
        entry: HistoryEntry,
        bounds?: HistoryBounds,
    ): StagedHistoryMove;
    /** Advance temporary appended-row identities after the host's save receipt. */
    rekey_saved_rows(rows: readonly SavedHistoryRowAssignment[]): void;
    /** Turn tail removals written by Save into host-admitted row restorations. */
    rekey_saved_removals(rows: readonly SavedTailRemovalCommit[]): void;
    /**
     * Empty the history. For a different document replacing this one, where any
     * surviving action would be another file's edits waiting to be replayed
     * through a worksheet identity that happens to match.
     */
    clear(): void;
}

export function create_history_store(initial?: HistoryStackState): HistoryStore {
    let state = initial ?? empty_history_stack();
    const listeners = new Set<() => void>();

    const notify = (): void => {
        // Copy first: a listener may unsubscribe during the walk.
        for (const listener of [...listeners]) listener();
    };

    return {
        snapshot: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        stage_record: (action, bounds) => {
            // The state recorded against, so a history that moved for any reason
            // invalidates the staging rather than silently rebasing this action
            // onto a stack it never saw — which would drop whatever landed in
            // between, or resurrect a redo stack that recording should clear.
            const staged_from = state;
            const outcome = record_history_action(staged_from, action, bounds);
            const staged = stage_mutation(
                () => state === staged_from,
                () => {
                    // An empty action leaves the state object identical, so this
                    // is also what makes a no-op gesture publish nothing.
                    if (outcome.state === state) return false;
                    state = outcome.state;
                    return true;
                },
                notify,
            );
            return { outcome, ...staged };
        },
        stage_move: (direction, entry, bounds) => {
            const staged_from = state;
            const outcome = commit_history_move(staged_from, direction, entry, bounds);
            const staged = stage_mutation(
                () => state === staged_from,
                () => {
                    // `already-committed` returns the state unchanged, so this is
                    // also what makes a duplicate commit publish nothing.
                    if (outcome.state === state) return false;
                    state = outcome.state;
                    return true;
                },
                notify,
            );
            return { outcome, ...staged };
        },

        rekey_saved_rows: (rows) => {
            const next = rekey_saved_appended_row_history(state, rows);
            if (next === state) return;
            state = next;
            notify();
        },

        rekey_saved_removals: (rows) => {
            const next = rekey_committed_tail_removal_history(state, rows);
            if (next === state) return;
            state = next;
            notify();
        },

        clear: () => {
            if (state.undoStack.length === 0
                && state.redoStack.length === 0
                && state.barrier === undefined) {
                return;
            }
            // A fresh stack rather than `clear_history`, which preserves the
            // epoch so an in-flight replay can tell it was cut off. Nothing can
            // be in flight against a document that no longer exists.
            state = empty_history_stack();
            notify();
        },
    };
}
