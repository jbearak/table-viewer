/**
 * The desktop Edit menu's Undo and Redo items, as pure data.
 *
 * The menu is the only place a desktop user can *see* what undo would do, so it
 * has to say it: a label of "Undo Paste" rather than a bare "Undo", greyed out
 * when there is nothing to walk back. That means main.ts holds a copy of state
 * the renderer owns, refreshed by a `historyMenuStateChanged` post, and every
 * question about what the menu should read is answered here rather than inside a
 * click handler.
 *
 * Pure and Electron-free, because the interesting part is the rules and not the
 * MenuItem — in particular the two ways an item can be enabled. A viewer window
 * whose history has something in it enables the item and forwards the intent to
 * the renderer. A window with no history model at all — welcome, preferences,
 * the state inspector, or a viewer with an empty stack whose focus is in a text
 * field — leaves it enabled for the *native* text undo, which is a different
 * stack with its own contents that nothing here can see. Disabling the item in
 * that case would take text undo away from the CSV cell editor.
 */

import { is_plain_record } from '../../src/plain-record';
import type { HistoryMenuProjection } from '../../src/types';

/**
 * What one viewer's renderer last said about its history.
 *
 * The wire type itself, not a copy of it. The renderer builds this payload and
 * the main process reads it, so a second declaration here would be two contracts
 * for one message — and the first thing to drift would be whether a label is
 * absent or present-and-undefined, which is exactly the distinction the menu
 * turns into "Undo" versus "Undo Paste".
 *
 * The field worth knowing before reading the rest of this file is `textEditing`:
 * focus is in a text field, so the chord means the browser's text undo. The items
 * must then be enabled regardless of the workbook stack, and labelled plainly —
 * naming a workbook gesture on an item that will undo a keystroke inside a cell
 * editor is worse than saying nothing.
 */
export type HistoryMenuState = HistoryMenuProjection;

/** How one menu item should read and behave. */
export interface HistoryMenuItem {
    readonly label: string;
    readonly enabled: boolean;
}

/**
 * The item for one direction.
 *
 * A replay already in flight does not enter into it. Both items keep the label
 * and enablement they had: the renderer refuses a second replay silently, and an
 * item that greyed out for the few hundred milliseconds one takes would flicker
 * under a held-down chord.
 *
 * `state` is undefined for a window that has never reported — a non-viewer
 * window, or a viewer whose renderer has not posted yet. Enabled with a plain
 * label, because that is the native-text-undo case: the routing fallback in
 * main.ts calls `webContents.undo()`, and only the page knows whether its own
 * undo stack has anything in it.
 */
export function history_menu_item(
    direction: 'undo' | 'redo',
    state: HistoryMenuState | undefined,
): HistoryMenuItem {
    const plain = direction === 'undo' ? 'Undo' : 'Redo';
    if (state === undefined || state.textEditing) {
        return { label: plain, enabled: true };
    }
    const available = direction === 'undo' ? state.undoAvailable : state.redoAvailable;
    const label = direction === 'undo' ? state.undoLabel : state.redoLabel;
    if (!available) return { label: plain, enabled: false };
    return {
        label: label === undefined || label === '' ? plain : `${plain} ${label}`,
        enabled: true,
    };
}

/**
 * Decode a `historyMenuStateChanged` payload, or answer undefined.
 *
 * Sanitized rather than trusted, like every other message crossing the renderer
 * boundary: the payload reaches a native menu, and a label is built from workbook
 * data. `is_plain_record` is the shared guard the other wire decoders use: a
 * hand-rolled `typeof value === 'object'` would admit an array or a class
 * instance, and would need a cast from `unknown` to read a field off it.
 *
 * Both labels are capped here as well as at the source — the renderer's stack
 * truncates them, and a menu is not the place to discover it did not.
 */
export function sanitized_history_menu_state(
    value: unknown,
): HistoryMenuState | undefined {
    if (!is_plain_record(value)) return undefined;
    const { undoAvailable, redoAvailable, textEditing } = value;
    if (
        typeof undoAvailable !== 'boolean'
        || typeof redoAvailable !== 'boolean'
        || typeof textEditing !== 'boolean'
    ) return undefined;
    const label = (raw: unknown): string | undefined => (
        typeof raw === 'string' ? raw.slice(0, MAX_MENU_LABEL_LENGTH) : undefined
    );
    return Object.freeze({
        undoAvailable,
        redoAvailable,
        undoLabel: label(value.undoLabel),
        redoLabel: label(value.redoLabel),
        textEditing,
    });
}

/** Matches the renderer's own `MAX_BARRIER_LABEL_LENGTH`. A menu item this long
 *  is already unreadable; the cap is about what the main process retains. */
const MAX_MENU_LABEL_LENGTH = 200;
