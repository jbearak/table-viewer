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
 * replay being in flight is not among them, because it changes neither item: a
 * press made meanwhile is held by the page and carried out when the replay has
 * landed (`history-press-model.ts`).
 */

import type { HistoryMenuProjection } from '../types';
import { peek_history, type HistoryStackState } from './history-stack-model';

/**
 * The projection for one history state.
 *
 * A `blocked` peek — undo has run back into a barrier — counts as unavailable,
 * so the item reads plain "Undo": there is nothing further back to reach. The
 * item stays enabled (`desktop/main/history-menu-model.ts`), and a press of it
 * says why (`history_refusal_warning`).
 *
 * `pending_view_label` names the person's sort or filter still in flight, which
 * Undo would cancel: it is what Undo does next, though it is not on the stack
 * yet. Redo is unchanged, because a Redo press waits for it.
 */
export function history_menu_projection(
    state: HistoryStackState,
    text_editing: boolean,
    pending_view_label?: string,
): HistoryMenuProjection {
    const undo = peek_history(state, 'undo');
    const redo = peek_history(state, 'redo');
    const undo_label = pending_view_label
        ?? (undo.kind === 'available' ? undo.entry.action.label : undefined);
    return Object.freeze({
        undoAvailable: undo_label !== undefined,
        redoAvailable: redo.kind === 'available',
        ...(undo_label !== undefined ? { undoLabel: undo_label } : {}),
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
