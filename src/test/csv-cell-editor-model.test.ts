import { describe, it, expect } from 'vitest';
import {
    apply_held_keys,
    browser_caret_key,
    editor_key_intent,
    hold_key,
    hold_typing,
    insert_newline,
    replay_editor_keys,
    type EditorKeyEvent,
    type EditorText,
    type HeldKeysTarget,
    type HeldTyping,
    type SelectionMove,
} from '../webview/csv-cell-editor-model';

const ev = (key: string, mods: Partial<EditorKeyEvent> = {}): EditorKeyEvent => ({
    key,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...mods,
});

describe('editor_key_intent', () => {
    it('Escape cancels', () => {
        expect(editor_key_intent(ev('Escape'))).toBe('cancel');
    });

    it('Tab commits for forward traversal', () => {
        expect(editor_key_intent(ev('Tab'))).toBe('commit-tab-forward');
    });

    it('Shift+Tab commits for backward traversal', () => {
        expect(editor_key_intent(ev('Tab', { shiftKey: true }))).toBe('commit-tab-backward');
    });

    it('Enter commits and moves down', () => {
        expect(editor_key_intent(ev('Enter'))).toBe('commit-down');
    });

    it('Shift+Enter inserts a newline', () => {
        expect(editor_key_intent(ev('Enter', { shiftKey: true }))).toBe('newline');
    });

    it('Alt+Enter inserts a newline', () => {
        expect(editor_key_intent(ev('Enter', { altKey: true }))).toBe('newline');
    });

    it('Cmd+S and Ctrl+S propagate to the window save handler', () => {
        expect(editor_key_intent(ev('s', { metaKey: true }))).toBe('save');
        expect(editor_key_intent(ev('s', { ctrlKey: true }))).toBe('save');
    });

    it('any other key is default (handled by the input)', () => {
        expect(editor_key_intent(ev('a'))).toBe('default');
        expect(editor_key_intent(ev('ArrowDown'))).toBe('default');
        // A bare 's' without a modifier is just text.
        expect(editor_key_intent(ev('s'))).toBe('default');
    });
});

describe('insert_newline', () => {
    it('inserts a newline at the caret and advances the cursor past it', () => {
        const out = insert_newline('hello', 2, 2);
        expect(out.value).toBe('he\nllo');
        expect(out.cursor).toBe(3);
    });

    it('replaces a selection with a newline', () => {
        const out = insert_newline('hello', 1, 4);
        expect(out.value).toBe('h\no');
        expect(out.cursor).toBe(2);
    });

    it('appends at the end when caret is at the end', () => {
        const out = insert_newline('hi', 2, 2);
        expect(out.value).toBe('hi\n');
        expect(out.cursor).toBe(3);
    });
});

/** Keys from a compact spec: one character each, or a `{Name}` key. */
function keys(spec: string): EditorKeyEvent[] {
    return Array.from(spec.matchAll(/\{([^}]+)\}|([\s\S])/gu), ([, named, char]) => ev(named ?? char!));
}
const typed = (initial: string, spec: string) => replay_editor_keys(initial, false, keys(spec));
const on_value = (value: string, spec: string) => replay_editor_keys(value, true, keys(spec));

describe('replay_editor_keys', () => {
    it('opens on the text with the caret at its end, or on the value all selected', () => {
        expect(typed('ab', '')).toEqual({ text: 'ab', start: 2, end: 2 });
        expect(on_value('London', '')).toEqual({ text: 'London', start: 0, end: 6 });
    });

    it('adds a printable key at the caret, Space and Shift+Space included', () => {
        expect(typed('New', ' ').text).toBe('New ');
        expect(replay_editor_keys('NEW', false, [ev(' ', { shiftKey: true })]).text).toBe('NEW ');
        expect(replay_editor_keys('caf', false, [ev('é', { altKey: true })]).text).toBe('café');
    });

    it('replaces a value the editor would open with selected', () => {
        expect(on_value('Paris', 'a').text).toBe('a');
        expect(on_value('Paris', '{Backspace}').text).toBe('');
        expect(on_value('Paris', '{Delete}').text).toBe('');
    });

    it('removes the character before the caret on Backspace, and the one after it on Delete', () => {
        expect(typed('Nwe', '{Backspace}').text).toBe('Nw');
        expect(typed('a😀', '{Backspace}').text).toBe('a');
        expect(typed('Nwe', '{Delete}').text).toBe('Nwe');
        expect(typed('abcd', '{ArrowLeft}{ArrowLeft}{Backspace}')).toEqual({ text: 'acd', start: 1, end: 1 });
        expect(typed('abcd', '{ArrowLeft}{ArrowLeft}{Delete}')).toEqual({ text: 'abd', start: 2, end: 2 });
    });

    it('adds a newline at the caret on Shift+Enter or Alt+Enter', () => {
        expect(replay_editor_keys('a', false, [ev('Enter', { shiftKey: true })]).text).toBe('a\n');
        expect(replay_editor_keys('ab', false, [ev('ArrowLeft'), ev('Enter', { altKey: true })]).text).toBe('a\nb');
    });

    // As measured in the desktop app's open editor (macOS): with the caret
    // after "ab" of "abcd", Left, Right, Up, Down, Home, and End then "X" gave
    // aXbcd, abcXd, Xabcd, abcdX, Xabcd, abcdX; on a selected "London",
    // XLondon, LondonX, XLondon, LondonX, XLondon, LondonX.
    it('moves the caret on Left, Right, Up, Down, Home, and End as the open editor does', () => {
        const after = (spec: string) => typed('ab', `cd{ArrowLeft}{ArrowLeft}${spec}X`).text;
        expect(typed('a', 'b{ArrowLeft}c').text).toBe('acb');
        expect(after('{ArrowLeft}')).toBe('aXbcd');
        expect(after('{ArrowRight}')).toBe('abcXd');
        expect(after('{ArrowUp}')).toBe('Xabcd');
        expect(after('{ArrowDown}')).toBe('abcdX');
        expect(after('{Home}')).toBe('Xabcd');
        expect(after('{End}')).toBe('abcdX');
        for (const [key, text] of [
            ['ArrowLeft', 'XLondon'], ['ArrowRight', 'LondonX'], ['ArrowUp', 'XLondon'],
            ['ArrowDown', 'LondonX'], ['Home', 'XLondon'], ['End', 'LondonX'],
        ]) expect(on_value('London', `{${key}}X`).text).toBe(text);
    });

    it('stops the caret at either end of the text', () => {
        expect(typed('ab', '{ArrowLeft}{ArrowLeft}{ArrowLeft}X').text).toBe('Xab');
        expect(typed('ab', '{ArrowRight}X').text).toBe('abX');
        expect(typed('', '{ArrowLeft}{Home}{End}{ArrowUp}X').text).toBe('X');
    });

    it('steps over a whole character, not half of one', () => {
        expect(typed('a👍🏽', '{ArrowLeft}X').text).toBe('aX👍🏽');
        expect(typed('a👍🏽', '{ArrowLeft}{ArrowLeft}{ArrowRight}X').text).toBe('aX👍🏽');
        expect(typed('a👍🏽', '{ArrowLeft}{ArrowRight}X').text).toBe('a👍🏽X');
        expect(typed('a👍🏽b', '{ArrowLeft}{ArrowLeft}{Delete}').text).toBe('ab');
    });

    it('leaves the caret where it is for keys it cannot place exactly', () => {
        // Up and Down do not move the caret in a single line on Windows.
        expect(replay_editor_keys('ab', false, [ev('ArrowUp'), ev('X')], true).text).toBe('abX');
        expect(replay_editor_keys('ab', false, [ev('Home'), ev('X')], true).text).toBe('Xab');
        // With line breaks the caret moves by wrapped line.
        expect(replay_editor_keys('a\nb', false, keys('{Home}{ArrowUp}{End}{ArrowDown}X')).text).toBe('a\nbX');
        // Shift and Alt select and move by word.
        expect(replay_editor_keys('ab', false, [ev('ArrowLeft', { shiftKey: true }), ev('X')]).text).toBe('abX');
        expect(replay_editor_keys('ab', false, [ev('ArrowLeft', { altKey: true }), ev('X')]).text).toBe('abX');
        // Page Up keeps a selected value selected, as it does in the editor.
        expect(on_value('London', '{PageUp}{F2}X').text).toBe('X');
    });
});

describe('hold_key', () => {
    const hold = (initial: string | undefined, spec: string): HeldTyping | undefined => {
        let typing: HeldTyping | undefined = hold_typing(initial);
        for (const key of keys(spec)) typing = typing && hold_key(typing, key);
        return typing;
    };

    it('keeps every key the editor takes for it, arrows included', () => {
        expect(hold('a', 'b{ArrowLeft} {Backspace}{Home}{F2}')).toEqual({
            edits: [{ initial: 'a', keys: keys('b{ArrowLeft} {Backspace}{Home}{F2}') }],
        });
    });

    it('holds a copy of the key, not the grid event it came in', () => {
        const event = { ...ev('b'), cancel: () => undefined };
        expect(hold_key(hold_typing('a'), event)!.edits[0]!.keys[0]).toEqual(ev('b'));
    });

    it('commits on Enter, Tab, and Shift+Tab', () => {
        expect(hold('a', '{Enter}')!.edits[0]!.commit).toBe('below');
        expect(hold('a', '{Tab}')!.edits[0]!.commit).toBe('next');
        expect(hold_key(hold_typing('a'), ev('Tab', { shiftKey: true }))!.edits[0]!.commit).toBe('previous');
    });

    it('starts the next edit after a commit, as the grid would once the editor had closed', () => {
        expect(hold('a', 'bc{Enter}def{Tab}G')).toEqual({
            edits: [
                { initial: 'a', keys: keys('bc'), commit: 'below' },
                { initial: 'd', keys: keys('ef'), commit: 'next' },
                { initial: 'G', keys: [] },
            ],
        });
        // Shift on its own, as before a capital letter, changes nothing.
        expect(hold_key(hold('a', '{Enter}')!, ev('Shift', { shiftKey: true }))).toEqual(hold('a', '{Enter}'));
        expect(hold('a', '{Enter}{CapsLock}D')!.edits[1]).toEqual({ initial: 'D', keys: [] });
        // Space and Enter open the editor on the cell's own value.
        expect(hold('a', '{Enter} x')!.edits[1]).toEqual({ initial: undefined, keys: keys('x') });
        expect(hold('a', '{Enter}{Enter}x')!.edits[1]).toEqual({ initial: undefined, keys: keys('x') });
    });

    it('starts the next edit after a commit with a character typed on any layout', () => {
        expect(hold('a', '{Enter}жé{Tab}')!.edits[1]).toEqual({ initial: 'ж', keys: keys('é'), commit: 'next' });
        expect(hold_key(hold('a', '{Enter}')!, ev('Ü', { shiftKey: true }))!.edits[1]).toEqual({ initial: 'Ü', keys: [] });
        // One character outside the Basic Multilingual Plane is still one key.
        expect(hold('a', '{Enter}𝔸')!.edits[1]).toEqual({ initial: '𝔸', keys: [] });
    });

    it('replays nothing after a commit once a key only the grid acts on is typed', () => {
        for (const key of ['ArrowDown', 'Tab', 'Backspace', 'Delete', 'Home', 'F2']) {
            const typing = hold('a', `{Enter}{${key}}bc`);
            expect(typing).toEqual({ edits: [{ initial: 'a', keys: [], commit: 'below' }], dropping: true });
        }
        expect(hold_key(hold('a', '{Enter}')!, ev(' ', { shiftKey: true }))!.dropping).toBe(true);
        expect(hold_key(hold('a', '{Enter}')!, ev('b', { altKey: true }))!.dropping).toBe(true);
        // Option+Shift+A on macOS types Å, and is a shortcut on the grid.
        expect(hold_key(hold('a', '{Enter}')!, ev('Å', { altKey: true, shiftKey: true }))!.dropping).toBe(true);
        expect(hold('a', '{Enter}bc{ArrowLeft}d')!.dropping).toBeUndefined();
    });

    it('leaves shortcuts and composition to the grid', () => {
        for (const typing of [hold_typing('a'), hold('a', '{Enter}')!, hold('a', '{Enter}{ArrowUp}')!]) {
            expect(hold_key(typing, ev('s', { metaKey: true }))).toBeUndefined();
            expect(hold_key(typing, ev('c', { metaKey: true }))).toBeUndefined();
            expect(hold_key(typing, ev('v', { ctrlKey: true }))).toBeUndefined();
            expect(hold_key(typing, ev('z', { ctrlKey: true }))).toBeUndefined();
            expect(hold_key(typing, ev('Dead', { altKey: true }))).toBeUndefined();
        }
    });
});

describe('hold_key, for Escape and Cmd or Ctrl with a caret key', () => {
    const hold = (initial: string | undefined, events: readonly EditorKeyEvent[]): HeldTyping | undefined => {
        let typing: HeldTyping | undefined = hold_typing(initial);
        for (const key of events) typing = typing && hold_key(typing, key);
        return typing;
    };

    it('cancels the open edit on Escape, so it never opens, as the open editor does', () => {
        expect(hold('a', keys('b{Escape}'))).toEqual({ edits: [] });
        expect(hold(undefined, keys('{Escape}'))).toEqual({ edits: [] });
        // Nothing is left for the grid to open; it takes the keys after this.
        expect(hold_key({ edits: [] }, ev('x'))).toBeUndefined();
    });

    it('cancels only the edit after a commit, which still commits', () => {
        expect(hold('a', keys('b{Enter}cd{Escape}e'))).toEqual({
            edits: [
                { initial: 'a', keys: keys('b'), commit: 'below' },
                { initial: 'e', keys: [] },
            ],
        });
    });

    it('drops an Escape typed after a commit, with every key after it, as a key only the grid acts on', () => {
        expect(hold('a', keys('{Tab}{Escape}x'))).toEqual({
            edits: [{ initial: 'a', keys: [], commit: 'next' }],
            dropping: true,
        });
        const dropping = hold('a', keys('{Tab}{ArrowUp}'))!;
        expect(hold_key(dropping, ev('Escape'))).toBe(dropping);
    });

    it('keeps Cmd or Ctrl with a caret key for the editor, which keeps it from the grid', () => {
        const chords = [
            ev('ArrowLeft', { metaKey: true }), ev('ArrowDown', { metaKey: true, shiftKey: true }),
            ev('Home', { ctrlKey: true }), ev('End', { ctrlKey: true }),
            ev('ArrowRight', { ctrlKey: true }), ev('Backspace', { metaKey: true }),
        ];
        expect(hold('a', chords)).toEqual({ edits: [{ initial: 'a', keys: chords }] });
        // After a commit the grid would move the selection for one.
        expect(hold('a', [ev('Enter'), ev('ArrowLeft', { metaKey: true }), ev('x')])!.dropping).toBe(true);
    });
});

describe('browser_caret_key', () => {
    const on = (platform: 'mac' | 'windows' | 'linux', key: string, mods: Partial<EditorKeyEvent> = {}, multiline = false) =>
        browser_caret_key(ev(key, mods), platform, multiline);

    // Measured in the desktop app's open editor on macOS, in an input and in a
    // textarea, single and multi-line: each key moved the caret or selection
    // exactly as `Selection.modify` with these arguments did.
    it('moves as the open editor on macOS does', () => {
        expect(on('mac', 'ArrowLeft', { shiftKey: true })).toEqual({ moves: [['extend', 'left', 'character']] });
        expect(on('mac', 'ArrowRight', { altKey: true })).toEqual({ moves: [['move', 'right', 'word']] });
        expect(on('mac', 'ArrowLeft', { altKey: true, shiftKey: true })).toEqual({ moves: [['extend', 'left', 'word']] });
        expect(on('mac', 'ArrowLeft', { metaKey: true })).toEqual({ moves: [['move', 'left', 'lineboundary']] });
        expect(on('mac', 'ArrowRight', { ctrlKey: true, shiftKey: true }))
            .toEqual({ moves: [['extend', 'right', 'lineboundary']] });
        expect(on('mac', 'ArrowUp', { metaKey: true })).toEqual({ moves: [['move', 'backward', 'documentboundary']] });
        expect(on('mac', 'ArrowDown', { metaKey: true, shiftKey: true }))
            .toEqual({ moves: [['extend', 'forward', 'documentboundary']] });
        expect(on('mac', 'ArrowUp', { shiftKey: true })).toEqual({ moves: [['extend', 'backward', 'line']] });
        expect(on('mac', 'ArrowUp', { altKey: true }))
            .toEqual({ moves: [['move', 'backward', 'character'], ['move', 'backward', 'paragraphboundary']] });
        expect(on('mac', 'ArrowDown', { altKey: true, shiftKey: true })).toEqual({ moves: [['extend', 'forward', 'paragraph']] });
        expect(on('mac', 'Home', { shiftKey: true })).toEqual({ moves: [['extend', 'backward', 'documentboundary']] });
        expect(on('mac', 'Backspace', { altKey: true })).toEqual({ moves: [['extend', 'backward', 'word']], delete: true });
        expect(on('mac', 'Delete', { altKey: true })).toEqual({ moves: [['extend', 'forward', 'word']], delete: true });
        expect(on('mac', 'Backspace', { metaKey: true }))
            .toEqual({ moves: [['extend', 'backward', 'lineboundary']], delete: true });
    });

    it('moves by line in text with line breaks, and to its ends on Home and End only if it fits', () => {
        expect(on('mac', 'ArrowUp', {}, true)).toEqual({ moves: [['move', 'backward', 'line']] });
        expect(on('mac', 'ArrowDown', {}, true)).toEqual({ moves: [['move', 'forward', 'line']] });
        expect(on('mac', 'Home', {}, true)).toEqual({ moves: [['move', 'backward', 'lineboundary']], fits_only: true });
        expect(on('mac', 'End', {}, true)).toEqual({ moves: [['move', 'forward', 'lineboundary']], fits_only: true });
        expect(on('windows', 'Home', {}, true)).toEqual({ moves: [['move', 'backward', 'lineboundary']] });
    });

    it('leaves the keys it places exactly itself to apply_editor_key', () => {
        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete', 'x', 'Enter']) {
            expect(on('mac', key)).toBeUndefined();
            expect(on('windows', key)).toBeUndefined();
        }
        expect(on('mac', 'Backspace', { shiftKey: true })).toBeUndefined();
        expect(on('linux', 'Backspace', { altKey: true })).toBeUndefined();
    });

    it('does nothing for a chord the open editor ignores', () => {
        expect(on('mac', 'ArrowUp', { ctrlKey: true })).toEqual({ moves: [] });
        expect(on('mac', 'Home', { metaKey: true })).toEqual({ moves: [] });
        expect(on('mac', 'End', { metaKey: true })).toEqual({ moves: [] });
        expect(on('mac', 'Delete', { metaKey: true })).toEqual({ moves: [] });
        expect(on('windows', 'ArrowLeft', { altKey: true })).toEqual({ moves: [] });
        expect(on('windows', 'ArrowLeft', { metaKey: true })).toEqual({ moves: [] });
    });

    // Not measured: Chromium's key bindings outside macOS.
    it('moves by word with Ctrl, and to the ends of the text with Ctrl+Home and Ctrl+End, elsewhere', () => {
        expect(on('windows', 'ArrowLeft', { ctrlKey: true })).toEqual({ moves: [['move', 'left', 'word']] });
        expect(on('linux', 'ArrowRight', { ctrlKey: true, shiftKey: true })).toEqual({ moves: [['extend', 'right', 'word']] });
        expect(on('windows', 'Home', { ctrlKey: true })).toEqual({ moves: [['move', 'backward', 'documentboundary']] });
        expect(on('windows', 'End', { ctrlKey: true, shiftKey: true }))
            .toEqual({ moves: [['extend', 'forward', 'documentboundary']] });
        expect(on('windows', 'End', { shiftKey: true })).toEqual({ moves: [['extend', 'forward', 'lineboundary']] });
        expect(on('windows', 'Backspace', { ctrlKey: true })).toEqual({ moves: [['extend', 'backward', 'word']], delete: true });
    });
});

describe('apply_held_keys', () => {
    /** Text with a browser that selects one character to the left per move. */
    function target(text: string, at: number, options: { line_breaks?: boolean; overflows?: boolean } = {}) {
        let state: EditorText = { text, start: at, end: at };
        const moves: SelectionMove[] = [];
        const t: HeldKeysTarget & { moves: SelectionMove[]; state: () => EditorText } = {
            read: () => state,
            write: (next) => { state = next; },
            select: (list) => {
                for (const move of list) {
                    moves.push(move);
                    state = { ...state, start: Math.max(0, state.start - 1) };
                }
            },
            overflows: () => options.overflows ?? false,
            holds_line_breaks: options.line_breaks ?? true,
            moves,
            state: () => state,
        };
        return t;
    }

    it('lets the browser place the keys it moves for, in turn with the text typed around them', () => {
        const t = target('ab', 2);
        expect(apply_held_keys(t, [ev('c'), ev('ArrowLeft', { shiftKey: true }), ev('X')], 'mac')).toBe(3);
        expect(t.moves).toEqual([['extend', 'left', 'character']]);
        expect(t.state()).toEqual({ text: 'abX', start: 3, end: 3 });
    });

    it('deletes what a word or line delete selects, or only the selection there already was', () => {
        const t = target('one', 3);
        apply_held_keys(t, [ev('Backspace', { altKey: true })], 'mac');
        expect(t.state()).toEqual({ text: 'on', start: 2, end: 2 });

        const selected = target('one', 3);
        selected.write({ text: 'one', start: 1, end: 3 });
        apply_held_keys(selected, [ev('Backspace', { altKey: true })], 'mac');
        expect(selected.moves).toEqual([]);
        expect(selected.state()).toEqual({ text: 'o', start: 1, end: 1 });
    });

    it('leaves the caret for Home or End in text that overflows on macOS, where the editor scrolls instead', () => {
        const t = target('a\nb', 3, { overflows: true });
        apply_held_keys(t, [ev('Home'), ev('X')], 'mac');
        expect(t.moves).toEqual([]);
        expect(t.state().text).toBe('a\nbX');
        const fits = target('a\nb', 3);
        apply_held_keys(fits, [ev('Home')], 'mac');
        expect(fits.moves).toEqual([['move', 'backward', 'lineboundary']]);
    });

    it('stops at a line break a single-line input cannot hold', () => {
        const t = target('a', 1, { line_breaks: false });
        expect(apply_held_keys(t, [ev('b'), ev('Enter', { shiftKey: true }), ev('c')], 'mac')).toBe(1);
        expect(t.state().text).toBe('ab');
    });
});
