/**
 * When a press of Undo or Redo is carried out.
 *
 * A press that meets something this window itself started (a replay still out,
 * a sort still installing, a session being claimed or let go, a save) is not
 * refused and not dropped: it is held, and carried out when that has cleared.
 * Only if it has not cleared within the bound is the press answered with a
 * message. This module is the pure half of that rule: what a press waits for,
 * in which order the reasons are asked, and what may still be recorded while
 * a press waits. App owns the slots and the refs the facts are read from.
 */

import type { HistoryDirection } from './history-cell-state-model';

/** How long a press is held before it is answered with a message instead. */
export const HISTORY_PRESS_HOLD_MS = 5_000;

/** The same sentence about Undo or Redo is not said twice within this long. */
export const HISTORY_MESSAGE_REPEAT_MS = 2_000;

/**
 * One press. A small value handed down the attempt and kept by whichever slot
 * holds it, so a second hold, a retry, and a typing hold that is sent on are
 * all bounded from the same instant and numbered the same.
 */
export interface HistoryPress {
    readonly direction: HistoryDirection;
    /** When the key was pressed. The bound runs from here and is never restarted. */
    readonly started: number;
    /**
     * The press's number, given once. A gesture made before the press carries
     * a lower ticket, and is what may still be recorded while the press waits.
     */
    readonly epoch: number;
    /**
     * The count of snapshots this window had applied when the press was first
     * held for the editing session to finish going. A snapshot applied since
     * ends that wait, even if the session id has not changed.
     */
    readonly release_seq?: number;
}

/** Why a press is held, which is also what it says if the bound is reached. */
export type HistoryPressWait = 'applying' | 'updating' | 'refreshing' | 'finishing' | 'saving';

/** What the window is doing, read from its refs at one instant. */
export interface HistoryPressFacts {
    /**
     * This window said it no longer matches its file ("…Reopen the file…"):
     * its history describes a document the file is not.
     */
    readonly reopen_required: boolean;
    /** A header result needs a reload: the fence stays up with nothing to wait for. */
    readonly header_reload_required: boolean;
    /** A header change is queued, posted, or fenced. */
    readonly header_change_in_flight: boolean;
    /** A replay of any kind is out, or one is waiting to be tried again. */
    readonly replay_in_flight: boolean;
    /**
     * A gesture of this window has not been answered: a highlight, a row
     * height, a row admission, a column or width write, a full backlog.
     */
    readonly gesture_in_flight: boolean;
    /** A sort, filter, or hide of this window is still installing. */
    readonly view_request_in_flight: boolean;
    /** A gesture is waiting for the editing session, or still running in the grid. */
    readonly session_gesture_pending: boolean;
    /** A save of this window is in flight. */
    readonly save_in_flight: boolean;
}

export type HistoryPressGate =
    | { readonly kind: 'run' }
    | { readonly kind: 'hold'; readonly wait: HistoryPressWait }
    /** Not transient: only a reload clears it, so the press is told at once. */
    | { readonly kind: 'reload-required' }
    /** Not transient either: only a reopen of the file clears it. */
    | { readonly kind: 'reopen-required' };

/**
 * The first thing a press is asked, whatever is on top of the stack.
 *
 * The order is the order of the answers a person would want: a window that
 * must be reopened, or a fence that needs a reload, is said, because nothing
 * will clear it; a header change and a
 * replay come before the gestures, so the wait names the older work; a save is
 * last, so a press behind a save that is itself behind a sort waits for the
 * sort by name.
 */
export function history_press_gate(facts: HistoryPressFacts): HistoryPressGate {
    if (facts.reopen_required) return { kind: 'reopen-required' };
    if (facts.header_reload_required) return { kind: 'reload-required' };
    if (facts.header_change_in_flight) return { kind: 'hold', wait: 'applying' };
    if (facts.replay_in_flight) return { kind: 'hold', wait: 'applying' };
    if (facts.gesture_in_flight) return { kind: 'hold', wait: 'applying' };
    if (facts.view_request_in_flight) return { kind: 'hold', wait: 'updating' };
    if (facts.session_gesture_pending) return { kind: 'hold', wait: 'applying' };
    if (facts.save_in_flight) return { kind: 'hold', wait: 'saving' };
    return { kind: 'run' };
}

/** What a view step's replay is asked on top of the window gate. */
export interface ViewStepPressFacts {
    /** The editing session this window holds, if any. */
    readonly session_id: string | undefined;
    /** The session whose publication is fenced: one on its way out. */
    readonly fenced_session_id: string | undefined;
    /** How many snapshots this window has applied. */
    readonly applied_snapshot_seq: number;
    /** `HistoryPress.release_seq` of the press that asks. */
    readonly release_seq: number | undefined;
}

/**
 * Whether a view step has to wait for the editing session to finish going.
 *
 * Undoing the last unsaved edit releases the session, and until the host has
 * finished, its admission of a sort, filter, or hide answers "try again in a
 * moment". The wait ends when the session id changes or the next snapshot is
 * applied; after either the replay goes ahead and the host's answer decides.
 * The fence itself does not come down with a snapshot, so the second end is
 * remembered on the press.
 *
 * A window that never had a session has neither id, and does not wait.
 */
export function view_step_press_gate(facts: ViewStepPressFacts): HistoryPressGate {
    if (
        facts.session_id !== undefined
        && facts.fenced_session_id === facts.session_id
        && !(facts.release_seq !== undefined && facts.applied_snapshot_seq > facts.release_seq)
    ) return { kind: 'hold', wait: 'finishing' };
    return { kind: 'run' };
}

/** Whether a press made at `started` has waited out its bound by `now`. */
export function history_press_bound_reached(press: Pick<HistoryPress, 'started'>, now: number): boolean {
    return now - press.started >= HISTORY_PRESS_HOLD_MS;
}

/**
 * Whether work may be recorded although a press is waiting.
 *
 * While a press is held, or one is waiting to be tried again, nothing new is
 * recorded: a gesture made after the press must not get under it. Work that
 * was asked for before the press must still finish, and it says so with a
 * ticket, the press counter's value when it was made: lower than the press's
 * epoch means made before the press.
 *
 * With both slots taken the lower epoch governs, which is the retry's: a
 * gesture made after the retry's press and before the held one has a ticket
 * between the two, and the retry's press was made before it.
 *
 * `held_epoch` is absent for a typing hold, which reserves nothing (the keys
 * it waits for are on their way into an editor whose commit must be admitted).
 * `ticket` is absent where none is set, and 0 is a ticket: the press's own
 * fold of the open editor uses it.
 */
export function press_admits_ticket(input: {
    readonly held_epoch: number | undefined;
    readonly retry_epoch: number | undefined;
    readonly ticket: number | undefined;
}): boolean {
    const { held_epoch, retry_epoch, ticket } = input;
    if (held_epoch === undefined && retry_epoch === undefined) return true;
    if (ticket === undefined) return false;
    return ticket < Math.min(held_epoch ?? Infinity, retry_epoch ?? Infinity);
}

/**
 * Whether a message about Undo or Redo is said now, given the last one said.
 *
 * A key held down against something that does not clear would otherwise put
 * up one dialog per repeat. A deliberate second press, later, is told again.
 */
export function history_message_is_repeat(
    last: { readonly message: string; readonly at: number } | null,
    message: string,
    now: number,
): boolean {
    return last !== null && last.message === message && now - last.at < HISTORY_MESSAGE_REPEAT_MS;
}
