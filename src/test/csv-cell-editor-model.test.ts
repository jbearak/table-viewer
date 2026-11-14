import { describe, it, expect } from 'vitest';
import {
    editor_key_intent,
    held_editor_key,
    insert_newline,
    type EditorKeyEvent,
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

describe('held_editor_key', () => {
    it('adds a printable key to the text, Space and Shift+Space included', () => {
        expect(held_editor_key('New', ev(' '))).toEqual({ kind: 'text', text: 'New ' });
        expect(held_editor_key('NEW', ev(' ', { shiftKey: true }))).toEqual({ kind: 'text', text: 'NEW ' });
        expect(held_editor_key('caf', ev('é', { altKey: true }))).toEqual({ kind: 'text', text: 'café' });
    });

    it('replaces a value the editor would open with selected', () => {
        expect(held_editor_key(undefined, ev('a'))).toEqual({ kind: 'text', text: 'a' });
        expect(held_editor_key(undefined, ev('Backspace'))).toEqual({ kind: 'text', text: '' });
        expect(held_editor_key(undefined, ev('Delete'))).toEqual({ kind: 'text', text: '' });
    });

    it('removes the last character on Backspace, and nothing on Delete after the caret', () => {
        expect(held_editor_key('Nwe', ev('Backspace'))).toEqual({ kind: 'text', text: 'Nw' });
        expect(held_editor_key('a😀', ev('Backspace'))).toEqual({ kind: 'text', text: 'a' });
        expect(held_editor_key('Nwe', ev('Delete'))).toEqual({ kind: 'hold' });
    });

    it('adds a newline on Shift+Enter or Alt+Enter', () => {
        expect(held_editor_key('a', ev('Enter', { shiftKey: true }))).toEqual({ kind: 'text', text: 'a\n' });
        expect(held_editor_key('a', ev('Enter', { altKey: true }))).toEqual({ kind: 'text', text: 'a\n' });
    });

    it('commits on Enter, Tab, and Shift+Tab', () => {
        expect(held_editor_key('a', ev('Enter'))).toEqual({ kind: 'commit', navigation: 'below' });
        expect(held_editor_key('a', ev('Tab'))).toEqual({ kind: 'commit', navigation: 'next' });
        expect(held_editor_key('a', ev('Tab', { shiftKey: true }))).toEqual({ kind: 'commit', navigation: 'previous' });
    });

    it('leaves Escape, shortcuts, and composition to the grid', () => {
        expect(held_editor_key('a', ev('Escape'))).toEqual({ kind: 'pass' });
        expect(held_editor_key('a', ev('s', { metaKey: true }))).toEqual({ kind: 'pass' });
        expect(held_editor_key('a', ev('z', { ctrlKey: true }))).toEqual({ kind: 'pass' });
        expect(held_editor_key('a', ev('Dead', { altKey: true }))).toEqual({ kind: 'pass' });
    });

    it('holds keys the editor keeps to itself', () => {
        for (const key of ['ArrowLeft', 'ArrowDown', 'Home', 'PageDown', 'F2', 'Shift', '\t']) {
            expect(held_editor_key('a', ev(key))).toEqual({ kind: 'hold' });
        }
    });
});
