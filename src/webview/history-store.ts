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
    empty_history_stack,
    record_history_action,
    type HistoryAction,
    type HistoryBounds,
    type HistoryStackState,
    type RecordOutcome,
} from './history-stack-model';
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
    stage_record(action: HistoryAction, bounds?: HistoryBounds): StagedHistoryRecord;
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
