// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditingHandle } from '../webview/grid-shell';

const grid_mock = vi.hoisted(() => ({
    props: null as null | {
        onCellEdited?: (cell: [number, number], value: { kind: string; data: string }) => void;
    },
}));

vi.mock('@glideapps/glide-data-grid', () => {
    const React = require('react') as typeof import('react');
    return {
        CompactSelection: { empty: () => ({}) },
        DataEditor: React.forwardRef((props: unknown, ref: React.ForwardedRef<unknown>) => {
            grid_mock.props = props as typeof grid_mock.props;
            React.useImperativeHandle(ref, () => ({
                updateCells: vi.fn(),
                scrollTo: vi.fn(),
            }));
            return React.createElement('div', { className: 'data-editor-stub' });
        }),
        GridCellKind: { Text: 'text' },
    };
});

vi.mock('../webview/use-row-loader', () => ({
    use_row_loader: () => ({
        ensure_rows: vi.fn(),
        get_row: (row: number) => [
            { raw: row === 0 ? 'base' : '', formatted: row === 0 ? 'base' : '', bold: false, italic: false },
            { raw: row === 0 ? 'middle' : '', formatted: row === 0 ? 'middle' : '', bold: false, italic: false },
            { raw: row === 0 ? 'source-two' : '', formatted: row === 0 ? 'source-two' : '', bold: false, italic: false },
        ],
        sample_loaded_rows: () => [],
        version: 0,
    }),
}));

vi.mock('../webview/vscode-theme', () => ({
    use_vscode_theme: () => ({}),
}));

vi.mock('../webview/merge-overlay', () => ({
    MergeOverlay: React.forwardRef((_props: unknown, ref: React.ForwardedRef<unknown>) => {
        React.useImperativeHandle(ref, () => ({ repaint: vi.fn() }));
        return null;
    }),
}));

vi.mock('../webview/row-resize-overlay', () => ({
    RowResizeOverlay: React.forwardRef((_props: unknown, ref: React.ForwardedRef<unknown>) => {
        React.useImperativeHandle(ref, () => ({ set_target: vi.fn() }));
        return null;
    }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render_grid(
    column_projection = {
        visible_to_source: [0],
        source_to_visible: [0, undefined, undefined],
        hidden_count: 2,
    },
) {
    vi.resetModules();
    const post_message = vi.fn();
    const editing_ref = React.createRef<EditingHandle | null>();

    vi.stubGlobal('acquireVsCodeApi', () => ({
        postMessage: post_message,
        getState: vi.fn(),
        setState: vi.fn(),
    }));

    const { GridShell } = await import('../webview/grid-shell');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
        root!.render(React.createElement(GridShell, {
            sheet_meta: {
                name: 'Sheet1',
                rowCount: 1,
                columnCount: 3,
                merges: [],
                hasFormatting: false,
            },
            sheet_index: 0,
            generation: 1,
            show_formatting: false,
            column_projection,
            column_widths: {},
            on_column_resize: vi.fn(),
            row_heights: {},
            on_row_resize: vi.fn(),
            merges: [],
            edit_mode: true,
            csv_editable: true,
            editing_ref,
        }));
    });

    return { post_message, editing_ref };
}

async function edit_cell(value: string) {
    await act(async () => {
        grid_mock.props!.onCellEdited!([0, 0], { kind: 'text', data: value });
    });
}

async function save_result(success: boolean) {
    await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'saveResult', success } }));
    });
}

function save_messages(post_message: ReturnType<typeof vi.fn>) {
    return post_message.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg && typeof msg === 'object' && 'type' in msg && msg.type === 'saveCsv');
}

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
    grid_mock.props = null;
    vi.unstubAllGlobals();
});

describe('GridShell CSV save', () => {
    it('saves a projected display edit under its source-column key', async () => {
        const { post_message, editing_ref } = await render_grid({
            visible_to_source: [2],
            source_to_visible: [undefined, undefined, 0],
            hidden_count: 2,
        });

        await edit_cell('projected');
        post_message.mockClear();

        expect(editing_ref.current!.request_save()).toBe(true);
        expect(save_messages(post_message)).toEqual([{
            type: 'saveCsv',
            edits: { '0:2': 'projected' },
        }]);
    });

    it('blocks overlapping saves and preserves edits newer than the in-flight save', async () => {
        const { post_message, editing_ref } = await render_grid();

        await edit_cell('first');
        post_message.mockClear();

        expect(editing_ref.current!.request_save()).toBe(true);
        expect(save_messages(post_message)).toEqual([{ type: 'saveCsv', edits: { '0:0': 'first' } }]);

        await edit_cell('second');
        expect(editing_ref.current!.request_save()).toBe(false);
        expect(save_messages(post_message)).toEqual([{ type: 'saveCsv', edits: { '0:0': 'first' } }]);

        await save_result(true);
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);

        post_message.mockClear();
        expect(editing_ref.current!.request_save()).toBe(true);
        expect(save_messages(post_message)).toEqual([{ type: 'saveCsv', edits: { '0:0': 'second' } }]);
    });

    it('does not clear dirty edits on a duplicate success after a failed save', async () => {
        const { post_message, editing_ref } = await render_grid();

        await edit_cell('first');
        post_message.mockClear();

        expect(editing_ref.current!.request_save()).toBe(true);
        expect(save_messages(post_message)).toEqual([{ type: 'saveCsv', edits: { '0:0': 'first' } }]);

        await save_result(false);
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);

        await save_result(true);

        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);
    });

    it('preserves a revert to the pre-save value while the save is in flight', async () => {
        const { post_message, editing_ref } = await render_grid();

        await edit_cell('first');
        post_message.mockClear();

        expect(editing_ref.current!.request_save()).toBe(true);
        expect(save_messages(post_message)).toEqual([{ type: 'saveCsv', edits: { '0:0': 'first' } }]);

        await edit_cell('base');
        await save_result(true);

        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);

        post_message.mockClear();
        expect(editing_ref.current!.request_save()).toBe(true);
        expect(save_messages(post_message)).toEqual([{ type: 'saveCsv', edits: { '0:0': 'base' } }]);
    });
});
