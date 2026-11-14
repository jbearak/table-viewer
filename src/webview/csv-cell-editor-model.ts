/**
 * Pure keyboard semantics for the CSV cell editor (Phase E). Extracted from the
 * old `CellEditor` so the intent table is unit-tested without React or Glide's
 * overlay runtime; the thin `csv-cell-editor.tsx` wrapper maps each intent onto
 * preventDefault / stopPropagation / Glide's onFinishedEditing.
 */

import { has_line_break } from './line-breaks';

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

/** An editor's text, and the selection in it as UTF-16 offsets. */
export interface EditorText {
    readonly text: string;
    readonly start: number;
    readonly end: number;
}

/** Each grapheme boundary in `text`, from 0 to its length, as the caret steps. */
function caret_stops(text: string): number[] {
    const stops = [0];
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        for (const { index, segment } of segmenter.segment(text)) stops.push(index + segment.length);
    } else {
        let at = 0;
        for (const point of text) stops.push(at += point.length);
    }
    return stops;
}

function replace_selection(state: EditorText, insert: string, caret_after: number): EditorText {
    const text = state.text.slice(0, state.start) + insert + state.text.slice(state.end);
    return { text, start: caret_after, end: caret_after };
}

function caret(state: EditorText, at: number): EditorText {
    return { text: state.text, start: at, end: at };
}

/**
 * What an open editor's input does with a key it handles itself, those
 * `editor_key_intent` calls `default` or `newline`, measured in the desktop
 * app's editor:
 *  - a printable key, Backspace, Delete, and Shift/Alt+Enter edit the text;
 *  - Left and Right move the caret one character, or to the start or end of
 *    a selection;
 *  - in a single line, Up and Home move it to the start, Down and End to the
 *    end. On Windows, Up and Down leave it where it is.
 *
 * Keys it cannot place exactly change nothing: Home, End, Up and Down in text
 * with line breaks, where the caret moves by wrapped line, and Shift, Alt,
 * Cmd or Ctrl with a caret key, which select or move by word or line.
 */
export function apply_editor_key(
    state: EditorText,
    e: EditorKeyEvent,
    windows = false,
): EditorText {
    if (e.metaKey || e.ctrlKey) return state;
    const intent = editor_key_intent(e);
    if (intent === 'newline') {
        const { value, cursor } = insert_newline(state.text, state.start, state.end);
        return { text: value, start: cursor, end: cursor };
    }
    if (intent !== 'default') return state;
    const selected = state.start !== state.end;
    if (e.key === 'Backspace') {
        if (selected) return replace_selection(state, '', state.start);
        const before = Array.from(state.text.slice(0, state.start)).slice(0, -1).join('');
        return replace_selection({ ...state, start: before.length }, '', before.length);
    }
    if (e.key === 'Delete') {
        if (selected) return replace_selection(state, '', state.start);
        const next = caret_stops(state.text).find((stop) => stop > state.end);
        return next === undefined ? state : replace_selection({ ...state, end: next }, '', state.start);
    }
    const code = e.key.codePointAt(0) ?? 0;
    if (Array.from(e.key).length === 1 && code >= 0x20 && code !== 0x7f) {
        return replace_selection(state, e.key, state.start + e.key.length);
    }
    if (e.shiftKey || e.altKey) return state;
    const multiline = has_line_break(state.text);
    switch (e.key) {
        case 'ArrowLeft': {
            if (selected) return caret(state, state.start);
            const stops = caret_stops(state.text);
            return caret(state, stops.filter((stop) => stop < state.start).pop() ?? 0);
        }
        case 'ArrowRight': {
            if (selected) return caret(state, state.end);
            const stops = caret_stops(state.text);
            return caret(state, stops.find((stop) => stop > state.end) ?? state.text.length);
        }
        case 'ArrowUp':
            return multiline || windows ? state : caret(state, 0);
        case 'Home':
            return multiline ? state : caret(state, 0);
        case 'ArrowDown':
            return multiline || windows ? state : caret(state, state.text.length);
        case 'End':
            return multiline ? state : caret(state, state.text.length);
        default:
            return state;
    }
}

/**
 * The text and selection an editor opens with when keys were typed for it
 * before it could open: `initial` with the caret at its end, or all of it
 * selected, then each key applied as the open editor would apply it.
 */
export function replay_editor_keys(
    initial: string,
    all_selected: boolean,
    keys: readonly EditorKeyEvent[],
    windows = false,
): EditorText {
    let state: EditorText = {
        text: initial,
        start: all_selected ? 0 : initial.length,
        end: initial.length,
    };
    for (const key of keys) state = apply_editor_key(state, key, windows);
    return state;
}

/**
 * One editor held while the session it needs is acquired:
 *  - `initial`  what it opens with, as the grid would open it: a typed
 *               character, or undefined for the cell's own value, all of it
 *               selected, as after Enter, Space, or a double click.
 *  - `keys`     what was typed into it before it opened. The editor applies
 *               them as it opens (see `replay_editor_keys`).
 *  - `commit`   an Enter or Tab typed after them; it commits as soon as it
 *               opens.
 */
export interface HeldEdit {
    readonly initial: string | undefined;
    readonly keys: readonly EditorKeyEvent[];
    readonly commit?: EditorCommitNavigation;
}

/**
 * Typing held for the session: the edit the first key opened, and each edit
 * begun after a held commit, which opens at the cell that commit moves to.
 * `dropping` is set by a key after a commit that only the grid acts on, such
 * as an arrow moving the selection. Neither it nor any key after it is
 * replayed, so none can land in a cell the person did not mean.
 */
export interface HeldTyping {
    /** Never empty. */
    readonly edits: readonly HeldEdit[];
    readonly dropping?: boolean;
}

export function hold_typing(initial: string | undefined): HeldTyping {
    return { edits: [{ initial, keys: [] }] };
}

const MODIFIER_KEYS = new Set([
    'Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'Fn', 'FnLock', 'NumLock', 'ScrollLock',
]);

/**
 * Whether `key` is one character a key types, as on the grid it starts an
 * edit: é, ж, or ü on a layout that has them, as well as ASCII. Mirrors the
 * rule in the Glide fork's DataEditor onKeyDown.
 */
function is_typed_character(key: string): boolean {
    const code = key.codePointAt(0) ?? 0;
    return Array.from(key).length === 1 && code >= 0x20 && code !== 0x7f;
}

function key_of(e: EditorKeyEvent): EditorKeyEvent {
    return { key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey };
}

function with_last(typing: HeldTyping, edit: HeldEdit): HeldTyping {
    return { ...typing, edits: [...typing.edits.slice(0, -1), edit] };
}

/**
 * A key typed while edits are held. Returns the typing with it held, or
 * undefined for a key the grid handles as usual: Escape, a Cmd or Ctrl
 * shortcut, or a key belonging to a character still being composed.
 *
 * While the last edit is open the key goes to it: Enter, Tab, or Shift+Tab
 * commit it, and any other key is kept for the editor to apply. After a
 * commit, a key does what it would do on the grid once the editor had
 * closed: a key that types a character starts an edit with it, Space or
 * Enter starts one on the cell's own value, and any other key sets `dropping`.
 */
export function hold_key(typing: HeldTyping, e: EditorKeyEvent): HeldTyping | undefined {
    if (e.metaKey || e.ctrlKey) return undefined;
    const intent = editor_key_intent(e);
    if (intent === 'cancel' || intent === 'save') return undefined;
    // 'Dead' and 'Process' belong to a character still being composed.
    if (e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified') return undefined;
    if (typing.dropping) return typing;
    const last = typing.edits[typing.edits.length - 1]!;
    if (last.commit === undefined) {
        if (intent === 'commit-down') return with_last(typing, { ...last, commit: 'below' });
        if (intent === 'commit-tab-forward') return with_last(typing, { ...last, commit: 'next' });
        if (intent === 'commit-tab-backward') return with_last(typing, { ...last, commit: 'previous' });
        return with_last(typing, { ...last, keys: [...last.keys, key_of(e)] });
    }
    // A modifier pressed on its own, as before a capital letter, does nothing.
    if (MODIFIER_KEYS.has(e.key)) return typing;
    // The grid opens an editor on the cell's value for Space and Enter, and
    // one with the character for any other printable key, on any layout.
    const plain = !e.shiftKey && !e.altKey;
    let initial: string | undefined | null = null;
    if (plain && (e.key === ' ' || e.key === 'Enter')) initial = undefined;
    else if (!e.altKey && e.key !== ' ' && is_typed_character(e.key)) initial = e.key;
    if (initial === null) return { ...typing, dropping: true };
    return { ...typing, edits: [...typing.edits, { initial, keys: [] }] };
}
