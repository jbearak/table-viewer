// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { edit_command_target, text_field_selection } from '../webview/edit-command';

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
