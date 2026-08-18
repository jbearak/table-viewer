/**
 * What the desktop's native Edit menu needs to know about this window's history.
 *
 * The renderer owns the history, and a native menu cannot read it — so the menu's
 * labels and enablement are a projection posted across the boundary. Pure and
 * separate from App because two things about it are worth testing on their own:
 * what the projection says, and when it has changed enough to be worth posting.
 * A post per keystroke would rebuild the application menu on every keystroke.
 *
 * Deliberately narrow: two labels, two booleans and the text-editing flag. A
 * replay being in flight is not among them, because it changes neither item — the
 * renderer's own busy refusal is the throttle, and it is silent by design.
 */

import type { HistoryMenuProjection } from '../types';
import { peek_history, type HistoryStackState } from './history-stack-model';

/**
 * The projection for one history state.
 *
 * A `blocked` peek — undo has run back into a barrier — counts as unavailable.
 * The item greys out, which is the truthful answer: there is nothing further
 * back to reach. The reason is not on the menu, because a disabled item cannot be
 * clicked to hear it; the keystroke path still explains itself (see
 * `history_refusal_warning`).
 */
export function history_menu_projection(
    state: HistoryStackState,
    text_editing: boolean,
): HistoryMenuProjection {
    const undo = peek_history(state, 'undo');
    const redo = peek_history(state, 'redo');
    return Object.freeze({
        undoAvailable: undo.kind === 'available',
        redoAvailable: redo.kind === 'available',
        ...(undo.kind === 'available' ? { undoLabel: undo.entry.action.label } : {}),
        ...(redo.kind === 'available' ? { redoLabel: redo.entry.action.label } : {}),
        textEditing: text_editing,
    });
}

/** Whether two projections would build the same two menu items. */
export function history_menu_projections_equal(
    a: HistoryMenuProjection | undefined,
    b: HistoryMenuProjection,
): boolean {
    return a !== undefined
        && a.undoAvailable === b.undoAvailable
        && a.redoAvailable === b.redoAvailable
        && a.undoLabel === b.undoLabel
        && a.redoLabel === b.redoLabel
        && a.textEditing === b.textEditing;
}
