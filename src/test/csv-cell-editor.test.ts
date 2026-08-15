// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GridCellKind, type GridCell } from '../webview/glide-data-grid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CsvCellEditor } from '../webview/csv-cell-editor';

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
) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(CsvCellEditor, {
            value: value(text),
            onChange: on_change,
            onFinishedEditing: on_finished,
            onCommitNavigation: on_navigation,
        }));
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
});
