// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, it, expect, afterEach, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
    if (root && container) {
        root.unmount();
        document.body.removeChild(container);
    }
    root = null;
    container = null;
});

async function render_editor(props: {
    value: string;
    on_confirm: (value: string, advance: 'down' | 'right' | 'none') => void;
    on_cancel: () => void;
}) {
    const { CellEditor } = await import('../webview/cell-editor');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(CellEditor, props));
    });
}

describe('CellEditor', () => {
    it('renders an input with the initial value', async () => {
        await render_editor({ value: 'hello', on_confirm: vi.fn(), on_cancel: vi.fn() });
        const input = container!.querySelector('input') as HTMLInputElement;
        expect(input).not.toBeNull();
        expect(input.value).toBe('hello');
    });

    it('renders a textarea for multi-line values', async () => {
        await render_editor({ value: 'line1\nline2', on_confirm: vi.fn(), on_cancel: vi.fn() });
        const textarea = container!.querySelector('textarea') as HTMLTextAreaElement;
        expect(textarea).not.toBeNull();
        expect(textarea.value).toBe('line1\nline2');
    });

    it('calls on_confirm with the value and "down" on Enter for single-line', async () => {
        const on_confirm = vi.fn();
        await render_editor({ value: 'test', on_confirm, on_cancel: vi.fn() });
        const input = container!.querySelector('input') as HTMLInputElement;
        await act(async () => {
            input.value = 'changed';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(on_confirm).toHaveBeenCalledWith('changed', 'down');
    });

    it('calls on_cancel on Escape', async () => {
        const on_cancel = vi.fn();
        await render_editor({ value: 'test', on_confirm: vi.fn(), on_cancel });
        const input = container!.querySelector('input') as HTMLInputElement;
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(on_cancel).toHaveBeenCalled();
    });


    it('Shift+Enter inserts a newline and switches to textarea', async () => {
        const on_confirm = vi.fn();
        await render_editor({ value: 'hello', on_confirm, on_cancel: vi.fn() });

        // Starts as an input (single-line)
        expect(container!.querySelector('input')).not.toBeNull();
        expect(container!.querySelector('textarea')).toBeNull();

        const input = container!.querySelector('input') as HTMLInputElement;
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
        });

        // Should now be a textarea with a newline appended
        const textarea = container!.querySelector('textarea') as HTMLTextAreaElement;
        expect(textarea).not.toBeNull();
        expect(textarea.value).toBe('hello\n');

        // Should NOT have confirmed the edit
        expect(on_confirm).not.toHaveBeenCalled();
    });

    it('Alt+Enter inserts a newline and switches to textarea', async () => {
        const on_confirm = vi.fn();
        await render_editor({ value: 'world', on_confirm, on_cancel: vi.fn() });

        const input = container!.querySelector('input') as HTMLInputElement;
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }));
        });

        const textarea = container!.querySelector('textarea') as HTMLTextAreaElement;
        expect(textarea).not.toBeNull();
        expect(textarea.value).toBe('world\n');
        expect(on_confirm).not.toHaveBeenCalled();
    });

    it('focuses the textarea after Shift+Enter switches from input to textarea', async () => {
        await render_editor({ value: 'hello', on_confirm: vi.fn(), on_cancel: vi.fn() });

        const input = container!.querySelector('input') as HTMLInputElement;
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
        });

        const textarea = container!.querySelector('textarea') as HTMLTextAreaElement;
        expect(textarea).not.toBeNull();
        expect(document.activeElement).toBe(textarea);
    });

    it('places cursor at end (no selection) after Shift+Enter switches to textarea', async () => {
        await render_editor({ value: 'hello', on_confirm: vi.fn(), on_cancel: vi.fn() });

        const input = container!.querySelector('input') as HTMLInputElement;
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
        });

        const textarea = container!.querySelector('textarea') as HTMLTextAreaElement;
        // Cursor should be at the end, not selecting all text
        expect(textarea.selectionStart).toBe(textarea.value.length);
        expect(textarea.selectionEnd).toBe(textarea.value.length);
    });

    it('Enter in multiline textarea confirms the edit', async () => {
        const on_confirm = vi.fn();
        await render_editor({ value: 'line1\nline2', on_confirm, on_cancel: vi.fn() });
        const textarea = container!.querySelector('textarea') as HTMLTextAreaElement;
        await act(async () => {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(on_confirm).toHaveBeenCalledWith('line1\nline2', 'down');
    });

    it('calls on_confirm with value and "right" on Tab', async () => {
        const on_confirm = vi.fn();
        await render_editor({ value: 'test', on_confirm, on_cancel: vi.fn() });
        const input = container!.querySelector('input') as HTMLInputElement;
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        });
        expect(on_confirm).toHaveBeenCalledWith('test', 'right');
    });
});
