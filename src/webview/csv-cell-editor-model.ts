/**
 * Pure keyboard semantics for the CSV cell editor (Phase E). Extracted from the
 * old `CellEditor` so the intent table is unit-tested without React or Glide's
 * overlay runtime; the thin `csv-cell-editor.tsx` wrapper maps each intent onto
 * preventDefault / stopPropagation / Glide's onFinishedEditing.
 */

/** Minimal structural view of a keyboard event (assignable from React's). */
export interface EditorKeyEvent {
    key: string;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
}

/**
 * What a keypress means inside the editor:
 *  - `cancel`        Escape — discard, close the overlay.
 *  - `commit-right`  Tab — commit, move to the next column.
 *  - `commit-left`   Shift+Tab — commit, move to the previous column.
 *  - `commit-down`   Enter — commit, move to the next row.
 *  - `newline`       Shift/Alt+Enter — insert a newline, grow to multiline.
 *  - `save`          Cmd/Ctrl+S — let it bubble to the window save handler.
 *  - `default`       everything else — the input handles it normally.
 */
export type EditorKeyIntent =
    | 'cancel'
    | 'commit-right'
    | 'commit-left'
    | 'commit-down'
    | 'newline'
    | 'save'
    | 'default';

export function editor_key_intent(e: EditorKeyEvent): EditorKeyIntent {
    if (e.key === 'Escape') return 'cancel';
    if (e.key === 'Tab') return e.shiftKey ? 'commit-left' : 'commit-right';
    if (e.key === 'Enter' && (e.shiftKey || e.altKey)) return 'newline';
    if (e.key === 'Enter') return 'commit-down';
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) return 'save';
    return 'default';
}

/**
 * Insert a newline at the caret (or over the current selection), returning the
 * new text and the caret position just past the inserted newline. Mirrors the
 * old editor's Shift/Alt+Enter handling so the wrapper can stay declarative.
 */
export function insert_newline(
    value: string,
    start: number,
    end: number,
): { value: string; cursor: number } {
    return {
        value: value.slice(0, start) + '\n' + value.slice(end),
        cursor: start + 1,
    };
}
