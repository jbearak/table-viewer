// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
    edit_command_target,
    history_hotkey_command,
    text_field_selection,
} from '../webview/edit-command';

describe('edit_command_target', () => {
    it('routes to the focused text field', () => {
        expect(edit_command_target(document.createElement('input'))).toBe('text');
        expect(edit_command_target(document.createElement('textarea'))).toBe('text');
    });

    it('routes contenteditable hosts to the text path', () => {
        const host = document.createElement('div');
        // jsdom does not implement isContentEditable from the attribute alone.
        Object.defineProperty(host, 'isContentEditable', { value: true });
        expect(edit_command_target(host)).toBe('text');
    });

    it('routes the canvas grid, other elements, and nothing focused to the grid', () => {
        expect(edit_command_target(document.createElement('canvas'))).toBe('grid');
        expect(edit_command_target(document.createElement('div'))).toBe('grid');
        expect(edit_command_target(null)).toBe('grid');
    });
});

describe('text_field_selection', () => {
    function input(value: string, start?: number, end?: number) {
        const field = document.createElement('input');
        field.value = value;
        if (start !== undefined && end !== undefined) {
            field.setSelectionRange(start, end);
        }
        return field;
    }

    it('returns the selected substring', () => {
        expect(text_field_selection(input('hello world', 6, 11))).toBe('world');
    });

    it('falls back to the whole value for a caret with no range', () => {
        expect(text_field_selection(input('hello', 2, 2))).toBe('hello');
    });
});

describe('history_hotkey_command', () => {
    function chord(overrides: Partial<Parameters<typeof history_hotkey_command>[0]>) {
        return history_hotkey_command({
            key: 'z',
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            ...overrides,
        });
    }

    it('reads the macOS chords', () => {
        expect(chord({ metaKey: true })).toBe('undo');
        expect(chord({ metaKey: true, shiftKey: true })).toBe('redo');
    });

    it('reads the Windows and Linux chords', () => {
        expect(chord({ ctrlKey: true })).toBe('undo');
        expect(chord({ ctrlKey: true, key: 'y' })).toBe('redo');
        // Ctrl+Shift+Z too: a webview cannot tell which platform it is on, and a
        // user typing the other convention means redo either way.
        expect(chord({ ctrlKey: true, shiftKey: true })).toBe('redo');
    });

    it('ignores the same letters typed with no accelerator', () => {
        expect(chord({})).toBeUndefined();
        expect(chord({ key: 'y' })).toBeUndefined();
    });

    it('ignores chords that are not these chords', () => {
        // Alt makes a different chord, not a modified version of this one.
        expect(chord({ metaKey: true, altKey: true })).toBeUndefined();
        // Both modifiers is the undo chord on no platform.
        expect(chord({ metaKey: true, ctrlKey: true })).toBeUndefined();
        // Shift+Y is redo nowhere.
        expect(chord({ ctrlKey: true, key: 'y', shiftKey: true })).toBeUndefined();
        expect(chord({ metaKey: true, key: 'a' })).toBeUndefined();
    });

    it('reads a capital Z, which is what Shift actually delivers', () => {
        expect(chord({ metaKey: true, key: 'Z', shiftKey: true })).toBe('redo');
    });
});
