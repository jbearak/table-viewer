// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditingHandle, GridShellProps } from '../webview/grid-shell';

const grid_mock = vi.hoisted(() => ({
    props: null as null | Record<string, unknown>,
    update_cells: vi.fn(),
    scroll_to: vi.fn(),
    loader_enabled: [] as boolean[],
    ensure_rows: vi.fn(),
}));

vi.mock('@glideapps/glide-data-grid', () => {
    const React = require('react') as typeof import('react');
    return {
        CompactSelection: { empty: () => ({}) },
        DataEditor: React.forwardRef((props: unknown, ref: React.ForwardedRef<unknown>) => {
            grid_mock.props = props as Record<string, unknown>;
            React.useImperativeHandle(ref, () => ({
                updateCells: grid_mock.update_cells,
                scrollTo: grid_mock.scroll_to,
            }));
            return React.createElement('div', { className: 'data-editor-stub' });
        }),
        GridCellKind: { Text: 'text' },
    };
});

vi.mock('../webview/use-row-loader', () => ({
    use_row_loader: (
        _sheet: number,
        _rows: number,
        _generation: number,
        enabled: boolean,
    ) => {
        grid_mock.loader_enabled.push(enabled);
        return {
            ensure_rows: grid_mock.ensure_rows,
            get_row: () => [
                { raw: 'source-a', formatted: 'source-a', bold: false, italic: false },
                { raw: 'hidden-b', formatted: 'hidden-b', bold: false, italic: false },
                { raw: 'source-c', formatted: 'source-c', bold: false, italic: false },
            ],
            sample_loaded_rows: () => [],
            version: 0,
        };
    },
}));

vi.mock('../webview/vscode-theme', () => ({
    use_vscode_theme: () => ({}),
}));

vi.mock('../webview/merge-overlay', () => ({
    MergeOverlay: React.forwardRef((_props: unknown, ref: React.ForwardedRef<unknown>) => {
        React.useImperativeHandle(ref, () => ({ repaint: vi.fn() }));
        return React.createElement('div', { className: 'merge-overlay-stub' });
    }),
}));

vi.mock('../webview/row-resize-overlay', () => ({
    RowResizeOverlay: React.forwardRef((_props: unknown, ref: React.ForwardedRef<unknown>) => {
        React.useImperativeHandle(ref, () => ({ set_target: vi.fn() }));
        return React.createElement('div', { className: 'row-resize-overlay-stub' });
    }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

function props(overrides: Partial<GridShellProps> = {}): GridShellProps {
    return {
        sheet_meta: {
            name: 'Sheet1',
            rowCount: 1,
            columnCount: 3,
            columnNames: ['A name', 'B name', 'C name'],
            merges: [],
            hasFormatting: false,
        },
        sheet_index: 0,
        generation: 1,
        show_formatting: false,
        column_projection: {
            visible_to_source: [0, 2],
            source_to_visible: [0, undefined, 1],
        },
        column_widths: { 0: 100, 1: 150, 2: 200 },
        on_column_resize: vi.fn(),
        row_heights: {},
        on_row_resize: vi.fn(),
        merges: [],
        ...overrides,
    };
}

async function render_grid(initial: GridShellProps) {
    vi.resetModules();
    vi.stubGlobal('acquireVsCodeApi', () => ({
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn(),
    }));
    const { GridShell } = await import('../webview/grid-shell');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(GridShell, initial));
    });
    return GridShell;
}

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
    grid_mock.props = null;
    grid_mock.update_cells.mockReset();
    grid_mock.scroll_to.mockReset();
    grid_mock.ensure_rows.mockReset();
    grid_mock.loader_enabled = [];
    vi.unstubAllGlobals();
});

describe('GridShell column projection', () => {
    it('builds displayed columns and reads/resizes canonical source columns', async () => {
        const on_column_resize = vi.fn();
        await render_grid(props({ on_column_resize }));

        const columns = grid_mock.props!.columns as Array<{
            id: string;
            title: string;
            width: number;
        }>;
        expect(columns).toEqual([
            { id: '0', title: 'A name', width: 100 },
            { id: '2', title: 'C name', width: 200 },
        ]);

        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { data: string };
        expect(get_cell_content([1, 0]).data).toBe('source-c');

        const on_column_resize_grid = grid_mock.props!.onColumnResize as
            (column: unknown, size: number, display_column: number) => void;
        on_column_resize_grid({}, 222, 1);
        expect(on_column_resize).toHaveBeenCalledWith(2, 222);
    });

    it('clears display selection when projection changes without remounting editing state', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const GridShell = await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            editing_ref,
            initial_edits: { '0:2': { value: 'dirty', base: 'source-c' } },
        }));
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => {
            on_selection_change({
                columns: {},
                rows: {},
                current: {
                    cell: [1, 0],
                    range: { x: 1, y: 0, width: 1, height: 1 },
                    rangeStack: [],
                },
            });
        });

        await act(async () => {
            root!.render(React.createElement(GridShell, props({
                edit_mode: true,
                csv_editable: true,
                editing_ref,
                initial_edits: { '0:2': { value: 'dirty', base: 'source-c' } },
                column_projection: {
                    visible_to_source: [2],
                    source_to_visible: [undefined, undefined, 0],
                },
            })));
        });

        const selection = grid_mock.props!.gridSelection as { current?: unknown };
        expect(selection.current).toBeUndefined();
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);
    });

    it('commits a live overlay to the source-keyed dirty map before hiding its column', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const on_editing_change = vi.fn();
        const GridShell = await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            editing_ref,
            on_editing_change,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => {
            on_selection_change({
                columns: {},
                rows: {},
                current: {
                    cell: [1, 0],
                    range: { x: 1, y: 0, width: 1, height: 1 },
                    rangeStack: [],
                },
            });
        });
        const clip = document.createElement('div');
        clip.className = 'gdg-clip-region';
        const input = document.createElement('input');
        input.value = 'typed but not closed';
        clip.appendChild(input);
        document.body.appendChild(clip);

        await act(async () => editing_ref.current?.commit_live_edit());
        const latest_status = on_editing_change.mock.calls.at(-1)![0];
        expect(latest_status.edits).toEqual({
            '0:2': { value: 'typed but not closed', base: 'source-c' },
        });
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);

        await act(async () => {
            root!.render(React.createElement(GridShell, props({
                edit_mode: true,
                csv_editable: true,
                editing_ref,
                on_editing_change,
                column_projection: {
                    visible_to_source: [],
                    source_to_visible: [undefined, undefined, undefined],
                },
            })));
        });
        expect(container!.querySelector('[role="status"]')).not.toBeNull();
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);

        await act(async () => {
            root!.render(React.createElement(GridShell, props({
                edit_mode: true,
                csv_editable: true,
                editing_ref,
                on_editing_change,
            })));
        });
        expect(container!.querySelector('.data-editor-stub')).not.toBeNull();
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);
    });

    it('restores the last visible location after Hide all and recovery', async () => {
        const GridShell = await render_grid(props({ row_count: 200 }));
        const on_visible_region_changed = grid_mock.props!.onVisibleRegionChanged as
            (range: { x: number; y: number; width: number; height: number }) => void;
        await act(async () => on_visible_region_changed({
            x: 1,
            y: 75,
            width: 1,
            height: 10,
        }));

        await act(async () => {
            root!.render(React.createElement(GridShell, props({
                row_count: 200,
                column_projection: {
                    visible_to_source: [],
                    source_to_visible: [undefined, undefined, undefined],
                },
            })));
        });
        expect(container!.querySelector('[role="status"]')).not.toBeNull();

        await act(async () => {
            root!.render(React.createElement(GridShell, props({ row_count: 200 })));
        });
        expect(grid_mock.scroll_to).toHaveBeenCalledWith(1, 75);
    });

    it('renders a recoverable all-hidden status without grid overlays or row requests', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const GridShell = await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            editing_ref,
            initial_edits: { '0:2': { value: 'dirty', base: 'source-c' } },
            column_projection: {
                visible_to_source: [],
                source_to_visible: [undefined, undefined, undefined],
            },
        }));

        expect(container!.querySelector('[role="status"]')?.textContent)
            .toContain('All columns are hidden');
        expect(container!.querySelector('.data-editor-stub')).toBeNull();
        expect(container!.querySelector('.merge-overlay-stub')).toBeNull();
        expect(container!.querySelector('.row-resize-overlay-stub')).toBeNull();
        expect(grid_mock.loader_enabled.at(-1)).toBe(false);
        expect(grid_mock.ensure_rows).not.toHaveBeenCalled();
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);

        await act(async () => {
            root!.render(React.createElement(GridShell, props({
                edit_mode: true,
                csv_editable: true,
                editing_ref,
                initial_edits: { '0:2': { value: 'dirty', base: 'source-c' } },
            })));
        });
        expect(container!.querySelector('.data-editor-stub')).not.toBeNull();
        expect(grid_mock.loader_enabled.at(-1)).toBe(true);
        expect(grid_mock.ensure_rows).toHaveBeenCalledWith(0, 40);
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);
    });
});
