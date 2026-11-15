// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GridCellKind, type GridCell } from '../webview/glide-data-grid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsvCellEditor } from '../webview/csv-cell-editor';
import type { EditorKeyEvent } from '../webview/csv-cell-editor-model';

const key = (name: string, mods: Partial<EditorKeyEvent> = {}): EditorKeyEvent => ({
    key: name,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...mods,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const value = (text: string): GridCell => ({
    kind: GridCellKind.Text,
    data: text,
    displayData: text,
    allowOverlay: true,
});

async function render_editor(
    text: string,
    on_change = vi.fn(),
    on_finished = vi.fn(),
    on_navigation = vi.fn(),
    initial_value?: string,
    grid_value: GridCell = value(text),
    held_keys?: readonly EditorKeyEvent[],
) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        const props = {
            value: grid_value,
            onChange: on_change,
            onFinishedEditing: on_finished,
            onCommitNavigation: on_navigation,
            initialValue: initial_value,
            heldKeys: held_keys,
        };
        root!.render(React.createElement(CsvCellEditor, props));
    });
    return { on_change, on_finished, on_navigation };
}

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
});

describe('CsvCellEditor', () => {
    it('opens as if the keys typed before it opened had been typed into it', async () => {
        const on_change = vi.fn();
        await render_editor('a', on_change, vi.fn(), vi.fn(), 'a', value('a'), [
            key('b'), key('ArrowLeft'), key('c'),
        ]);

        const input = container!.querySelector('input')!;
        expect(input.value).toBe('acb');
        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(2);
        // Glide commits its own copy of the value when the person clicks away.
        expect(on_change).toHaveBeenCalledWith(expect.objectContaining({ data: 'acb' }));
    });

    it('opens on a character typed on any layout, with the held ones after it', async () => {
        const on_change = vi.fn();
        await render_editor('a', on_change, vi.fn(), vi.fn(), 'ж', value('a'), [key('é'), key('𝔸')]);

        const input = container!.querySelector('input')!;
        expect(input.value).toBe('жé𝔸');
        expect(input.selectionStart).toBe('жé𝔸'.length);
        expect(on_change).toHaveBeenCalledWith(expect.objectContaining({ data: 'жé𝔸' }));
    });

    it('applies held keys to a value it opens with selected', async () => {
        const on_change = vi.fn();
        await render_editor('London', on_change, vi.fn(), vi.fn(), undefined, value('London'), [
            key('ArrowLeft'), key('X'),
        ]);

        const input = container!.querySelector('input')!;
        expect(input.value).toBe('XLondon');
        expect(input.selectionStart).toBe(1);
        expect(on_change).toHaveBeenCalledWith(expect.objectContaining({ data: 'XLondon' }));
    });

    it('places the caret after the seed character when typing opens the editor', async () => {
        await render_editor('a', vi.fn(), vi.fn(), vi.fn(), 'a');

        const input = container!.querySelector('input')!;
        expect(input.selectionStart).toBe(1);
        expect(input.selectionEnd).toBe(1);
    });

    it('uses the type-to-edit seed instead of stale rich Markdown', async () => {
        const rich: GridCell = {
            kind: GridCellKind.Custom,
            data: {
                kind: 'rich-text',
                lines: [[{ text: 'old' }]],
                font_size_px: 13,
                edit_value: '**old**',
            },
            copyData: 'old',
            allowOverlay: true,
        };
        await render_editor('unused', vi.fn(), vi.fn(), vi.fn(), 'z', rich);

        const input = container!.querySelector('input')!;
        expect(input.value).toBe('z');
        expect(input.selectionStart).toBe(1);
        expect(input.selectionEnd).toBe(1);
    });

    it('selects the existing value when opening without typed input', async () => {
        await render_editor('Alice');

        const input = container!.querySelector('input')!;
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(5);
    });

    it('reports forward Tab navigation and leaves movement to GridShell', async () => {
        const { on_finished, on_navigation } = await render_editor('Alice');
        const input = container!.querySelector('input')!;
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            }));
        });
        expect(on_navigation).toHaveBeenCalledWith('next');
        expect(on_finished).toHaveBeenCalledWith(
            expect.objectContaining({ data: 'Alice' }),
            [0, 0],
        );
    });

    it('keeps Shift+Enter in the editor as a newline', async () => {
        const { on_change, on_finished } = await render_editor('Alice');
        const input = container!.querySelector('input')!;
        input.setSelectionRange(5, 5);
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            }));
        });

        const textarea = container!.querySelector('textarea')!;
        expect(textarea.value).toBe('Alice\n');
        expect(document.activeElement).toBe(textarea);
        expect(on_change).toHaveBeenCalledWith(
            expect.objectContaining({ data: 'Alice\n' }),
        );
        expect(on_finished).not.toHaveBeenCalled();
    });

    // A textarea turns CRLF and a bare CR into LF; an untouched value still
    // commits as the cell's own text, or the edit would be a phantom change.
    it.each(['first\r\nsecond', 'first\rsecond'])(
        'commits unchanged %j as the text it opened with',
        async (text) => {
            const { on_change, on_finished } = await render_editor(text);
            const textarea = container!.querySelector('textarea')!;
            expect(textarea.value).toBe('first\nsecond');
            expect(on_change).not.toHaveBeenCalled();
            await act(async () => {
                textarea.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter',
                    bubbles: true,
                    cancelable: true,
                }));
            });
            expect(on_finished).toHaveBeenCalledWith(expect.objectContaining({ data: text }), [0, 0]);
        },
    );

    describe('with keys the browser moves the caret for', () => {
        // jsdom has no Selection.modify. This one acts on the focused input,
        // as Chromium's does, for the two moves these tests use.
        const modify = vi.fn((alter: string, direction: string, granularity: string) => {
            const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement;
            const start = el.selectionStart!;
            const end = el.selectionEnd!;
            if (alter !== 'extend' || (direction !== 'left' && direction !== 'backward')) return;
            const to = granularity === 'word'
                ? el.value.slice(0, start).replace(/\S+\s*$/u, '').length
                : start - 1;
            el.setSelectionRange(to, end, 'backward');
        });
        beforeEach(() => {
            modify.mockClear();
            Object.defineProperty(Selection.prototype, 'modify', { value: modify, configurable: true });
        });
        afterEach(() => {
            delete (Selection.prototype as { modify?: unknown }).modify;
        });

        it('lets the browser move them in the input, in turn with the text typed around them', async () => {
            const on_change = vi.fn();
            await render_editor('a', on_change, vi.fn(), vi.fn(), 'a', value('a'), [
                key('b'), key('c'), key('ArrowLeft', { shiftKey: true }), key('X'),
            ]);

            expect(modify).toHaveBeenCalledWith('extend', 'left', 'character');
            const input = container!.querySelector('input')!;
            expect(input.value).toBe('abX');
            expect(input.selectionStart).toBe(3);
            expect(on_change).toHaveBeenCalledWith(expect.objectContaining({ data: 'abX' }));
        });

        it('deletes what the browser selects for a word delete', async () => {
            // Ctrl+Backspace outside macOS, which jsdom stands in for.
            await render_editor('x', vi.fn(), vi.fn(), vi.fn(), 'o', value('x'), [
                ...'ne two'.split('').map((c) => key(c)), key('Backspace', { ctrlKey: true }),
            ]);

            expect(modify).toHaveBeenCalledWith('extend', 'backward', 'word');
            expect(container!.querySelector('input')!.value).toBe('one ');
        });

        it('switches to lines for a held line break, and moves the caret in them after it', async () => {
            const on_change = vi.fn();
            await render_editor('a', on_change, vi.fn(), vi.fn(), 'a', value('a'), [
                key('Enter', { shiftKey: true }), key('b'), key('c'), key('ArrowLeft', { shiftKey: true }), key('X'),
            ]);

            expect(container!.querySelector('input')).toBeNull();
            const textarea = container!.querySelector('textarea')!;
            expect(textarea.value).toBe('a\nbX');
            expect(document.activeElement).toBe(textarea);
            expect(textarea.selectionStart).toBe(4);
            expect(on_change).toHaveBeenLastCalledWith(expect.objectContaining({ data: 'a\nbX' }));
        });
    });
});
