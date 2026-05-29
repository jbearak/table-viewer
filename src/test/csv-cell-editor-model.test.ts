import { describe, it, expect } from 'vitest';
import {
    editor_key_intent,
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

    it('Tab commits and moves right', () => {
        expect(editor_key_intent(ev('Tab'))).toBe('commit-right');
    });

    it('Shift+Tab commits and moves left', () => {
        expect(editor_key_intent(ev('Tab', { shiftKey: true }))).toBe('commit-left');
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
