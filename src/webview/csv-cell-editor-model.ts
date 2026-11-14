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

export type EditorCommitNavigation = 'next' | 'previous' | 'below';

/**
 * What a keypress means inside the editor:
 *  - `cancel`               Escape — discard, close the overlay.
 *  - `commit-tab-forward`   Tab — commit, traverse forward.
 *  - `commit-tab-backward`  Shift+Tab — commit, traverse backward.
 *  - `commit-down`          Enter — commit, move to the next row.
 *  - `newline`              Shift/Alt+Enter — insert a newline, grow multiline.
 *  - `save`                 Cmd/Ctrl+S — bubble to the window save handler.
 *  - `default`              everything else — the input handles it normally.
 */
export type EditorKeyIntent =
    | 'cancel'
    | 'commit-tab-forward'
    | 'commit-tab-backward'
    | 'commit-down'
    | 'newline'
    | 'save'
    | 'default';

export function editor_key_intent(e: EditorKeyEvent): EditorKeyIntent {
    if (e.key === 'Escape') return 'cancel';
    if (e.key === 'Tab') {
        return e.shiftKey ? 'commit-tab-backward' : 'commit-tab-forward';
    }
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

/**
 * What a key typed while an editor is waiting to open does to the text it will
 * open with:
 *  - `text`     the editor would change its text to `text`.
 *  - `commit`   the editor would commit and move; it opens and commits at once.
 *  - `pass`     a shortcut, or Escape, which the grid handles as usual.
 *  - `hold`     a key the editor keeps to itself, such as an arrow moving the
 *               caret; the grid must not act on it either.
 *
 * `text` is undefined when the editor will open on the cell's own value, all of
 * it selected, as it does after Enter, Space, or a double click; the first key
 * typed then replaces that value. Glide maps Space and Shift+Space to grid
 * actions, so they reach a waiting editor only through here.
 */
export type HeldEditorKey =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'commit'; readonly navigation: EditorCommitNavigation }
    | { readonly kind: 'pass' }
    | { readonly kind: 'hold' };

export function held_editor_key(
    text: string | undefined,
    e: EditorKeyEvent,
): HeldEditorKey {
    if (e.metaKey || e.ctrlKey) return { kind: 'pass' };
    switch (editor_key_intent(e)) {
        case 'cancel':
        case 'save':
            return { kind: 'pass' };
        case 'commit-tab-forward':
            return { kind: 'commit', navigation: 'next' };
        case 'commit-tab-backward':
            return { kind: 'commit', navigation: 'previous' };
        case 'commit-down':
            return { kind: 'commit', navigation: 'below' };
        case 'newline':
            return { kind: 'text', text: (text ?? '') + '\n' };
        case 'default':
            break;
    }
    // The caret sits at the end of typed text, so Delete removes nothing there.
    // Either key removes a selected value.
    if (e.key === 'Backspace') return { kind: 'text', text: Array.from(text ?? '').slice(0, -1).join('') };
    if (e.key === 'Delete') return text === undefined ? { kind: 'text', text: '' } : { kind: 'hold' };
    // 'Dead' and 'Process' belong to a character still being composed.
    if (e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified') return { kind: 'pass' };
    const code = e.key.codePointAt(0) ?? 0;
    if (Array.from(e.key).length === 1 && code >= 0x20 && code !== 0x7f) {
        return { kind: 'text', text: (text ?? '') + e.key };
    }
    return { kind: 'hold' };
}
