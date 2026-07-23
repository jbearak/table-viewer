// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    EditingHandle,
    GridFocusHandle,
    GridShellProps,
} from '../webview/grid-shell';

// Array-backed CompactSelection stand-in with just enough surface for the
// selection models (add/remove/hasIndex/equals) used by drag sweeps.
const make_compact = vi.hoisted(() => {
    type Compact = {
        length: number;
        toArray: () => number[];
        hasIndex: (index: number) => boolean;
        first: () => number | undefined;
        last: () => number | undefined;
        add: (value: number | readonly [number, number]) => Compact;
        remove: (value: number) => Compact;
        equals: (other: { toArray?: () => number[] }) => boolean;
        [Symbol.iterator]: () => Iterator<number>;
    };
    const make = (values: number[]): Compact => {
        const sorted = [...new Set(values)].sort((a, b) => a - b);
        return {
            length: sorted.length,
            toArray: () => [...sorted],
            hasIndex: (index: number) => sorted.includes(index),
            first: () => sorted[0],
            last: () => sorted[sorted.length - 1],
            add: (value: number | readonly [number, number]) => {
                const added = typeof value === 'number'
                    ? [value]
                    : Array.from(
                        { length: value[1] - value[0] },
                        (_, offset) => value[0] + offset,
                    );
                return make([...sorted, ...added]);
            },
            remove: (value: number) => make(sorted.filter((index) => index !== value)),
            equals: (other) => {
                const other_values = other.toArray?.() ?? [];
                return other_values.length === sorted.length
                    && other_values.every((index, at) => index === sorted[at]);
            },
            *[Symbol.iterator]() { yield* sorted; },
        };
    };
    return make;
});

const grid_mock = vi.hoisted(() => ({
    props: null as null | Record<string, unknown>,
    row_resize_props: null as null | Record<string, unknown>,
    row_resize_set_target: vi.fn(),
    overlay_repaint: vi.fn(),
    update_cells: vi.fn(),
    scroll_to: vi.fn(),
    focus: vi.fn(),
    get_bounds: vi.fn((): { x: number; y: number; width: number; height: number } | undefined => ({
        x: 30, y: 10, width: 100, height: 36,
    })),
    loader_enabled: [] as boolean[],
    ensure_rows: vi.fn(),
    ensure_rows_loaded: vi.fn(async () => true),
    post_message: vi.fn(),
    get_row: vi.fn((_row?: number) => [
        { raw: 'source-a', formatted: 'source-a', bold: false, italic: false },
        { raw: 'hidden-b', formatted: 'hidden-b', bold: false, italic: false },
        { raw: 'source-c', formatted: 'source-c', bold: false, italic: false },
    ] as any),
}));

vi.mock('@glideapps/glide-data-grid', () => {
    const React = require('react') as typeof import('react');
    return {
        CompactSelection: {
            empty: () => make_compact([]),
            fromSingleSelection: (value: number | readonly [number, number]) =>
                typeof value === 'number'
                    ? make_compact([value])
                    : make_compact(Array.from(
                        { length: value[1] - value[0] },
                        (_, offset) => value[0] + offset,
                    )),
        },
        DataEditor: React.forwardRef((props: unknown, ref: React.ForwardedRef<unknown>) => {
            grid_mock.props = props as Record<string, unknown>;
            React.useImperativeHandle(ref, () => ({
                updateCells: grid_mock.update_cells,
                scrollTo: grid_mock.scroll_to,
                focus: grid_mock.focus,
                getBounds: grid_mock.get_bounds,
            }));
            return React.createElement('div', {
                className: 'data-editor-stub',
                tabIndex: 0,
            });
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
            ensure_rows_loaded: grid_mock.ensure_rows_loaded,
            get_row: grid_mock.get_row,
            get_source_row: (row: number) => row,
            sample_loaded_rows: () => [],
            version: 0,
        };
    },
}));

vi.mock('../webview/vscode-theme', () => ({
    use_vscode_theme: () => ({ theme: {}, highContrast: false }),
}));

vi.mock('../webview/merge-overlay', () => ({
    MergeOverlay: React.forwardRef((_props: unknown, ref: React.ForwardedRef<unknown>) => {
        React.useImperativeHandle(ref, () => ({ repaint: grid_mock.overlay_repaint }));
        return React.createElement('div', { className: 'merge-overlay-stub' });
    }),
}));

vi.mock('../webview/row-resize-overlay', () => ({
    RowResizeOverlay: React.forwardRef((props: unknown, ref: React.ForwardedRef<unknown>) => {
        grid_mock.row_resize_props = props as Record<string, unknown>;
        React.useImperativeHandle(ref, () => ({
            set_target: grid_mock.row_resize_set_target,
        }));
        return React.createElement('div', { className: 'row-resize-overlay-stub' });
    }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

function compact(values: number[]) {
    return make_compact(values);
}

function menu_button_labels(): string[] {
    return Array.from(document.querySelectorAll('button'))
        .map((button) => button.textContent ?? '');
}

function props(overrides: Partial<GridShellProps> = {}): GridShellProps {
    return {
        sheet_meta: {
            name: 'Sheet1',
            rowCount: 1,
            sourceRowCount: 1,
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
            hidden_count: 1,
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
        postMessage: grid_mock.post_message,
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
    grid_mock.row_resize_props = null;
    grid_mock.row_resize_set_target.mockReset();
    grid_mock.overlay_repaint.mockReset();
    grid_mock.update_cells.mockReset();
    grid_mock.scroll_to.mockReset();
    grid_mock.focus.mockReset();
    grid_mock.get_bounds.mockReset();
    grid_mock.get_bounds.mockImplementation(() => ({
        x: 30, y: 10, width: 100, height: 36,
    }));
    grid_mock.ensure_rows.mockReset();
    grid_mock.ensure_rows_loaded.mockReset();
    grid_mock.ensure_rows_loaded.mockImplementation(async () => true);
    grid_mock.post_message.mockReset();
    grid_mock.get_row.mockReset();
    grid_mock.get_row.mockImplementation(() => [
        { raw: 'source-a', formatted: 'source-a', bold: false, italic: false },
        { raw: 'hidden-b', formatted: 'hidden-b', bold: false, italic: false },
        { raw: 'source-c', formatted: 'source-c', bold: false, italic: false },
    ] as any);
    grid_mock.loader_enabled = [];
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'clipboard');
    vi.useRealTimers();
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

    it('exposes an imperative focus handle for the mounted Glide grid', async () => {
        const grid_focus_ref = React.createRef<GridFocusHandle | null>();
        await render_grid(props({ grid_focus_ref }));

        expect(grid_focus_ref.current?.focus()).toBe(true);
        expect(document.activeElement).toBe(
            container!.querySelector('.data-editor-stub'),
        );
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
                    hidden_count: 2,
                },
            })));
        });

        const selection = grid_mock.props!.gridSelection as { current?: unknown };
        expect(selection.current).toBeUndefined();
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);
    });

    it('retargets shortcuts when the previously focused source column is hidden', async () => {
        const on_transform_change = vi.fn();
        const GridShell = await render_grid(props({
            transform_sections: true,
            on_transform_change,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: {}, rows: {},
            current: {
                cell: [1, 0],
                range: { x: 1, y: 0, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        await act(async () => root!.render(React.createElement(GridShell, props({
            transform_sections: true,
            on_transform_change,
            column_projection: {
                visible_to_source: [0],
                source_to_visible: [0, undefined, undefined],
                hidden_count: 2,
            },
        }))));
        const on_key_down = grid_mock.props!.onKeyDown as (args: Record<string, unknown>) => void;
        on_key_down({
            key: 'A', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
            rawEvent: { code: 'KeyA', target: document.createElement('canvas') },
            cancel: vi.fn(), preventDefault: vi.fn(),
        });
        expect(on_transform_change).toHaveBeenCalledWith({
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        });
    });

    it('retargets shortcuts after programmatic vim and merge-aware navigation', async () => {
        const on_transform_change = vi.fn();
        await render_grid(props({
            row_count: 2,
            merges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
            transform_sections: true,
            on_transform_change,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        const on_key_down = grid_mock.props!.onKeyDown as
            (args: Record<string, unknown>) => void;
        const key_args = (key: string, code = '') => ({
            key, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
            rawEvent: { code, target: document.createElement('canvas') },
            cancel: vi.fn(), preventDefault: vi.fn(),
        });
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([]),
            current: {
                cell: [0, 0],
                range: { x: 0, y: 0, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        await act(async () => on_key_down(key_args('l', 'KeyL')));
        expect((grid_mock.props!.gridSelection as any).current.cell).toEqual([1, 0]);
        on_key_down({
            ...key_args('A', 'KeyA'), altKey: true, shiftKey: true,
        });
        expect(on_transform_change).toHaveBeenLastCalledWith({
            sort: [{ colIndex: 2, direction: 'asc' }], filters: [],
        });

        on_transform_change.mockClear();
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([]),
            current: {
                cell: [0, 0],
                range: { x: 0, y: 0, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        await act(async () => on_key_down(key_args('ArrowRight')));
        on_key_down({
            ...key_args('D', 'KeyD'), altKey: true, shiftKey: true,
        });
        expect(on_transform_change).toHaveBeenLastCalledWith({
            sort: [{ colIndex: 2, direction: 'desc' }], filters: [],
        });
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
                    hidden_count: 3,
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
                    hidden_count: 3,
                },
            })));
        });
        expect(container!.querySelector('[role="status"]')).not.toBeNull();

        await act(async () => {
            root!.render(React.createElement(GridShell, props({ row_count: 200 })));
        });
        expect(grid_mock.scroll_to).toHaveBeenCalledWith(1, 75);
    });

    it('retains an App-owned preview scroll target while all columns are hidden', async () => {
        const on_applied = vi.fn();
        const GridShell = await render_grid(props({
            row_count: 200,
            preview_mode: true,
            pending_preview_scroll: { row: 150, sequence: 1 },
            on_preview_scroll_applied: on_applied,
            column_projection: { visible_to_source: [], source_to_visible: [], hidden_count: 3 },
        }));
        expect(grid_mock.scroll_to).not.toHaveBeenCalled();

        await act(async () => root!.render(React.createElement(GridShell, props({
            row_count: 200,
            preview_mode: true,
            pending_preview_scroll: { row: 150, sequence: 1 },
            on_preview_scroll_applied: on_applied,
        }))));
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 40)));
        expect(grid_mock.scroll_to).toHaveBeenLastCalledWith(
            0, 150, 'vertical', 0, 0, { vAlign: 'start' },
        );
        expect(on_applied).toHaveBeenCalledWith(1);
    });

    it('survives a generation remount hidden, then applies only the latest row after delayed Glide readiness', async () => {
        vi.useFakeTimers();
        const on_applied = vi.fn();
        const hidden_projection = {
            visible_to_source: [], source_to_visible: [], hidden_count: 3,
        };
        const GridShell = await render_grid(props({
            row_count: 200,
            preview_mode: true,
            pending_preview_scroll: { row: 100, sequence: 1 },
            on_preview_scroll_applied: on_applied,
            column_projection: hidden_projection,
        }));

        // A snapshot refresh changes the generation key while hidden. App supplies the
        // latest sequence to the replacement GridShell.
        await act(async () => root!.render(React.createElement(GridShell, {
            ...props({
                generation: 2,
                row_count: 200,
                preview_mode: true,
                pending_preview_scroll: { row: 150, sequence: 2 },
                on_preview_scroll_applied: on_applied,
                column_projection: hidden_projection,
            }),
            key: 'generation-2',
        })));
        expect(grid_mock.scroll_to).not.toHaveBeenCalled();

        grid_mock.get_bounds
            .mockReturnValueOnce(undefined)
            .mockReturnValueOnce(undefined)
            .mockReturnValue({ x: 30, y: 10, width: 100, height: 36 });
        await act(async () => root!.render(React.createElement(GridShell, {
            ...props({
                generation: 2,
                row_count: 200,
                preview_mode: true,
                pending_preview_scroll: { row: 150, sequence: 2 },
                on_preview_scroll_applied: on_applied,
            }),
            key: 'generation-2',
        })));
        expect(grid_mock.scroll_to).not.toHaveBeenCalled();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(32);
        });
        expect(grid_mock.scroll_to).not.toHaveBeenCalled();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(16);
        });
        expect(grid_mock.scroll_to).not.toHaveBeenCalled();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(16);
        });
        expect(grid_mock.scroll_to).toHaveBeenCalledOnce();
        expect(grid_mock.scroll_to).toHaveBeenCalledWith(
            0, 150, 'vertical', 0, 0, { vAlign: 'start' },
        );
        expect(on_applied).toHaveBeenCalledOnce();
        expect(on_applied).toHaveBeenCalledWith(2);
        await act(async () => {
            await vi.runAllTimersAsync();
        });
        expect(grid_mock.scroll_to).toHaveBeenCalledOnce();
    });

    it('restores the last visible preview row through hidden meta reload without a row-zero echo', async () => {
        vi.useFakeTimers();
        const on_applied = vi.fn();
        const on_visible_row = vi.fn();
        const hidden_projection = {
            visible_to_source: [], source_to_visible: [], hidden_count: 3,
        };
        const GridShell = await render_grid(props({
            row_count: 200,
            preview_mode: true,
            on_preview_visible_row_change: on_visible_row,
        }));
        const on_visible_region_changed = grid_mock.props!.onVisibleRegionChanged as
            (range: { x: number; y: number; width: number; height: number }) => void;
        await act(async () => on_visible_region_changed({
            x: 0, y: 75, width: 1, height: 10,
        }));
        expect(on_visible_row).toHaveBeenCalledWith(75);
        expect(grid_mock.post_message).toHaveBeenCalledWith({
            type: 'visibleRowChanged', row: 75,
        });

        await act(async () => root!.render(React.createElement(GridShell, props({
            row_count: 200,
            preview_mode: true,
            on_preview_visible_row_change: on_visible_row,
            column_projection: hidden_projection,
        }))));
        await act(async () => root!.render(React.createElement(GridShell, {
            ...props({
                generation: 2,
                row_count: 200,
                preview_mode: true,
                pending_preview_scroll: { row: 75, sequence: 1 },
                on_preview_scroll_applied: on_applied,
                on_preview_visible_row_change: on_visible_row,
                column_projection: hidden_projection,
            }),
            key: 'preview-generation-2',
        })));

        grid_mock.post_message.mockClear();
        on_visible_row.mockClear();
        grid_mock.get_bounds
            .mockReturnValueOnce(undefined)
            .mockReturnValueOnce(undefined)
            .mockReturnValue({ x: 30, y: 10, width: 100, height: 36 });
        await act(async () => root!.render(React.createElement(GridShell, {
            ...props({
                generation: 2,
                row_count: 200,
                preview_mode: true,
                pending_preview_scroll: { row: 75, sequence: 1 },
                on_preview_scroll_applied: on_applied,
                on_preview_visible_row_change: on_visible_row,
            }),
            key: 'preview-generation-2',
        })));
        const initial_after_show = grid_mock.props!.onVisibleRegionChanged as
            (range: { x: number; y: number; width: number; height: number }) => void;
        await act(async () => initial_after_show({
            x: 0, y: 0, width: 1, height: 10,
        }));
        expect(grid_mock.post_message).not.toHaveBeenCalledWith({
            type: 'visibleRowChanged', row: 0,
        });
        expect(on_visible_row).not.toHaveBeenCalledWith(0);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(32);
            await vi.advanceTimersByTimeAsync(16);
            await vi.advanceTimersByTimeAsync(16);
        });
        expect(grid_mock.scroll_to).toHaveBeenCalledOnce();
        expect(grid_mock.scroll_to).toHaveBeenCalledWith(
            0, 75, 'vertical', 0, 0, { vAlign: 'start' },
        );
        expect(on_applied).toHaveBeenCalledOnce();
        expect(on_applied).toHaveBeenCalledWith(1);

        // App clears the acknowledged sequence before Glide may report the final
        // viewport. That matching callback is part of the programmatic restore,
        // not a user scroll, so it must not echo the target row to the host either.
        await act(async () => root!.render(React.createElement(GridShell, {
            ...props({
                generation: 2,
                row_count: 200,
                preview_mode: true,
                on_preview_scroll_applied: on_applied,
                on_preview_visible_row_change: on_visible_row,
            }),
            key: 'preview-generation-2',
        })));
        const confirmed_region = grid_mock.props!.onVisibleRegionChanged as
            (range: { x: number; y: number; width: number; height: number }) => void;
        await act(async () => confirmed_region({
            x: 0, y: 75, width: 1, height: 10,
        }));
        await act(async () => vi.runAllTimersAsync());
        expect(grid_mock.scroll_to).toHaveBeenCalledOnce();
        expect(grid_mock.post_message).not.toHaveBeenCalledWith({
            type: 'visibleRowChanged', row: 0,
        });
        expect(grid_mock.post_message).not.toHaveBeenCalledWith({
            type: 'visibleRowChanged', row: 75,
        });
    });

    it('header clicks only update focus and preserve Glide multi-column selection', async () => {
        await render_grid(props());
        const selection = { columns: { native: 'multi' }, rows: {} };
        const on_selection_change = grid_mock.props!.onGridSelectionChange as (value: unknown) => void;
        await act(async () => on_selection_change(selection));
        const before = grid_mock.props!.gridSelection;
        const on_header_clicked = grid_mock.props!.onHeaderClicked as (column: number) => void;
        await act(async () => on_header_clicked(1));
        expect(grid_mock.props!.gridSelection).toBe(before);
    });

    it('maps header menus and shortcuts from displayed columns to source columns', async () => {
        const on_transform_change = vi.fn();
        const on_open_filter = vi.fn();
        const on_hide_column = vi.fn();
        await render_grid(props({
            transform_state: { sort: [{ colIndex: 0, direction: 'desc' }], filters: [] },
            transform_sections: true,
            on_transform_change,
            on_open_filter,
            on_hide_column,
        }));
        const on_header_context_menu = grid_mock.props!.onHeaderContextMenu as
            (column: number, event: Record<string, unknown>) => void;
        await act(async () => on_header_context_menu(1, {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 0, width: 100, height: 36 },
            localEventX: 20,
            localEventY: 10,
        }));
        expect(document.body.textContent).toContain('Copy column');
        expect(document.body.textContent).toContain('Add ascending to sort');
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent?.includes('Sort ascending'))!.click());
        expect(on_transform_change).toHaveBeenCalledWith({
            sort: [{ colIndex: 2, direction: 'asc' }],
            filters: [],
        });

        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: {},
            rows: {},
            current: {
                cell: [1, 0],
                range: { x: 1, y: 0, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        on_transform_change.mockClear();
        const on_key_down = grid_mock.props!.onKeyDown as (args: Record<string, unknown>) => void;
        on_key_down({
            key: 'A', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
            rawEvent: { code: 'KeyA', target: document.createElement('canvas') },
            cancel: vi.fn(), preventDefault: vi.fn(),
        });
        expect(on_transform_change).toHaveBeenCalledWith({
            sort: [{ colIndex: 2, direction: 'asc' }],
            filters: [],
        });
        on_key_down({
            key: 'F', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
            rawEvent: { code: 'KeyF', target: document.createElement('canvas') },
            cancel: vi.fn(), preventDefault: vi.fn(),
        });
        expect(on_open_filter).toHaveBeenCalledWith(
            2,
            { left: 30, top: 46 },
            expect.any(Function),
        );
        expect(on_hide_column).not.toHaveBeenCalled();
    });

    it('focuses the Columns trigger after keyboard-hiding the final visible header', async () => {
        const GridShell = await render_grid(props({
            column_projection: {
                visible_to_source: [2],
                source_to_visible: [undefined, undefined, 0],
                hidden_count: 2,
            },
        }));
        const columns_trigger = document.createElement('button');
        columns_trigger.textContent = 'Columns';
        document.body.appendChild(columns_trigger);
        const hidden_props = props({
            column_projection: {
                visible_to_source: [],
                source_to_visible: [undefined, undefined, undefined],
                hidden_count: 3,
            },
        });
        const on_hide_column = vi.fn(() => {
            root!.render(React.createElement(GridShell, hidden_props));
        });
        const on_focus_columns = vi.fn(() => columns_trigger.focus());
        await act(async () => root!.render(React.createElement(GridShell, props({
            column_projection: {
                visible_to_source: [2],
                source_to_visible: [undefined, undefined, 0],
                hidden_count: 2,
            },
            on_hide_column,
            on_focus_columns,
        }))));

        const on_header_context_menu = grid_mock.props!.onHeaderContextMenu as
            (column: number, event: Record<string, unknown>) => void;
        await act(async () => on_header_context_menu(0, {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 0, width: 100, height: 36 },
            localEventX: 20,
            localEventY: 10,
        }));
        const hide = Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Hide column') as HTMLButtonElement;
        await act(async () => {
            hide.focus();
            hide.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                detail: 0,
            }));
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });

        expect(on_hide_column).toHaveBeenCalledWith(2);
        expect(container!.querySelector('[role="status"]')).not.toBeNull();
        expect(on_focus_columns).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(columns_trigger);
        expect(grid_mock.focus).not.toHaveBeenCalled();
    });

    it('copies a projected source column with its visible header title', async () => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        await render_grid(props());
        const on_header_context_menu = grid_mock.props!.onHeaderContextMenu as
            (column: number, event: Record<string, unknown>) => void;
        await act(async () => on_header_context_menu(1, {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 0, width: 100, height: 36 },
            localEventX: 20,
            localEventY: 10,
        }));
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Copy column')!.click());
        expect(write_text).toHaveBeenCalledWith('C name\nsource-c');
    });

    it('copies a committed dirty edit instead of the resident source value', async () => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            initial_edits: { '0:2': { value: 'edited-c', base: 'source-c' } },
        }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([1, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 36, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Copy cell')!.click());
        expect(write_text).toHaveBeenCalledWith('edited-c');
    });

    it('copies the still-open editor value ahead of dirty and source values', async () => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            initial_edits: { '0:2': { value: 'dirty-c', base: 'source-c' } },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([]),
            current: {
                cell: [1, 0],
                range: { x: 1, y: 0, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        const clip = document.createElement('div');
        clip.className = 'gdg-clip-region';
        const input = document.createElement('input');
        input.value = 'live-c';
        clip.appendChild(input);
        document.body.appendChild(clip);
        const on_key_down = grid_mock.props!.onKeyDown as
            (args: Record<string, unknown>) => void;
        await act(async () => on_key_down({
            key: 'c', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
            rawEvent: { code: 'KeyC', target: document.createElement('canvas') },
            cancel: vi.fn(), preventDefault: vi.fn(),
        }));
        expect(write_text).toHaveBeenCalledWith('live-c');
    });

    it('copies source-keyed edits through a projection with a hidden leading column', async () => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            initial_edits: { '0:2': { value: 'projected-edit', base: 'source-c' } },
            column_projection: {
                visible_to_source: [1, 2],
                source_to_visible: [undefined, 0, 1],
                hidden_count: 1,
            },
        }));
        const on_header_context_menu = grid_mock.props!.onHeaderContextMenu as
            (column: number, event: Record<string, unknown>) => void;
        await act(async () => on_header_context_menu(1, {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 0, width: 100, height: 36 },
            localEventX: 20,
            localEventY: 10,
        }));
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Copy column')!.click());
        expect(write_text).toHaveBeenCalledWith('C name\nprojected-edit');
    });

    it('keeps dirty-only nonresident rows blank and warns during copy', async () => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        grid_mock.get_row.mockReturnValue(undefined);
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            initial_edits: { '0:2': { value: 'known-dirty', base: 'source-c' } },
        }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([1, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 36, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Copy cell')!.click());
        expect(write_text).toHaveBeenCalledWith('');
        expect(grid_mock.post_message).toHaveBeenCalledWith({
            type: 'showWarning',
            message: expect.stringMatching(/loaded range/),
        });
    });

    it('guards keyboard header copy with projected source order and headers', async () => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        await render_grid(props());
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([0, 1]), rows: compact([]),
        }));
        const cancel = vi.fn();
        const prevent_default = vi.fn();
        const on_key_down = grid_mock.props!.onKeyDown as
            (args: Record<string, unknown>) => void;
        await act(async () => on_key_down({
            key: 'c', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
            rawEvent: { code: 'KeyC', target: document.createElement('canvas') },
            cancel, preventDefault: prevent_default,
        }));
        expect(cancel).toHaveBeenCalledOnce();
        expect(prevent_default).toHaveBeenCalledOnce();
        expect(write_text).toHaveBeenCalledWith('A name\tC name\nsource-a\tsource-c');
    });

    it('guards noncontiguous row copy and warns for nonresident rows', async () => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        grid_mock.get_row.mockImplementation((row?: number) => row === 0
            ? [
                { raw: 'r0-a', formatted: 'r0-a', bold: false, italic: false },
                null,
                { raw: 'r0-c', formatted: 'r0-c', bold: false, italic: false },
            ] as any
            : undefined);
        await render_grid(props({ row_count: 3 }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([0, 2]),
        }));
        const on_key_down = grid_mock.props!.onKeyDown as
            (args: Record<string, unknown>) => void;
        await act(async () => on_key_down({
            key: 'C', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false,
            rawEvent: { code: 'KeyC', target: document.createElement('canvas') },
            cancel: vi.fn(), preventDefault: vi.fn(),
        }));
        expect(write_text).toHaveBeenCalledWith('r0-a\tr0-c\n\t');
        expect(grid_mock.post_message).toHaveBeenCalledWith({
            type: 'showWarning',
            message: expect.stringMatching(/loaded range/),
        });
    });

    it('draws acknowledged source-indexed sort glyphs after normal header content', async () => {
        await render_grid(props({
            transform_state: {
                sort: [
                    { colIndex: 0, direction: 'asc' },
                    { colIndex: 2, direction: 'desc' },
                ],
                filters: [],
            },
        }));
        const draw_header = grid_mock.props!.drawHeader as Function;
        const draw_content = vi.fn();
        const ctx = {
            save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
            moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(),
            arc: vi.fn(), fillText: vi.fn(), restore: vi.fn(),
        } as unknown as CanvasRenderingContext2D;
        draw_header({
            ctx,
            columnIndex: 1,
            rect: { x: 0, y: 0, width: 100, height: 36 },
            theme: { textHeader: '#fff', bgHeader: '#222', bgCell: '#111', fontFamily: 'sans' },
        }, draw_content);
        expect(draw_content).toHaveBeenCalledOnce();
        expect(ctx.fillText).toHaveBeenCalledWith('2', expect.any(Number), expect.any(Number));
    });

    it('opens row-marker actions instead of cell actions', async () => {
        await render_grid(props({ row_count: 4, transform_sections: true }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([-1, 3], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 96, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        expect(menu_button_labels()).toEqual(expect.arrayContaining(['Copy row', 'Hide row']));
        expect(menu_button_labels()).not.toContain('Use row as header');
        expect(menu_button_labels()).not.toContain('Copy cell');
    });

    it('promotes the clicked Excel row from the row-marker menu', async () => {
        const on_promote_row_to_header = vi.fn();
        const base = props();
        await render_grid(props({
            row_count: 4,
            sheet_meta: {
                ...base.sheet_meta,
                rowCount: 4,
                sourceRowCount: 4,
                excelFirstRowHeader: {
                    mode: 'off', detected: false, active: false, available: true,
                },
            },
            transform_sections: true,
            can_promote_row_to_header: true,
            on_promote_row_to_header,
        }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([-1, 2], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 72, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));

        const action = Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Use row as header')!;
        await act(async () => action.click());

        expect(on_promote_row_to_header).toHaveBeenCalledWith(2);
    });

    it('omits row promotion while sorting changes the meaning of rows above', async () => {
        const base = props();
        await render_grid(props({
            row_count: 4,
            sheet_meta: {
                ...base.sheet_meta,
                rowCount: 4,
                sourceRowCount: 4,
                excelFirstRowHeader: {
                    mode: 'off', detected: false, active: false, available: true,
                },
            },
            transform_sections: true,
            transform_state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
            },
            can_promote_row_to_header: true,
        }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([-1, 2], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 72, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));

        expect(menu_button_labels()).not.toContain('Use row as header');
    });

    it('preserves an inside multi-row marker selection and hides its coalesced intervals', async () => {
        const on_hide_rows = vi.fn();
        await render_grid(props({
            row_count: 5,
            transform_sections: true,
            on_hide_rows,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([1, 2, 4]),
        }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([-1, 2], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 72, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        expect(menu_button_labels()).toEqual(expect.arrayContaining([
            'Hide 3 rows', 'Copy 3 rows',
        ]));
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Hide 3 rows')!.click());
        expect(on_hide_rows).toHaveBeenCalledWith([
            { start: 1, end: 2 },
            { start: 4, end: 4 },
        ]);
    });

    it('collapses an outside row selection and copies visible columns without headers', async () => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        grid_mock.get_row.mockImplementation((row?: number) => [
            { raw: `r${row}-a`, formatted: `r${row}-a`, bold: false, italic: false },
            { raw: `r${row}-b`, formatted: `r${row}-b`, bold: false, italic: false },
            { raw: `r${row}-c`, formatted: `r${row}-c`, bold: false, italic: false },
        ] as any);
        await render_grid(props({ row_count: 5, transform_sections: true }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([0, 1]),
        }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => {
            on_cell_context_menu([-1, 3], {
                preventDefault: vi.fn(),
                bounds: { x: 0, y: 96, width: 40, height: 24 },
                localEventX: 10,
                localEventY: 10,
            });
            // Glide follows an outside marker context-menu callback synchronously
            // by trying to select the first data cell in that row.
            on_selection_change({
                columns: compact([]), rows: compact([]),
                current: {
                    cell: [0, 3],
                    range: { x: 0, y: 3, width: 1, height: 1 },
                    rangeStack: [],
                },
            });
            await Promise.resolve();
        });
        expect(menu_button_labels()).toContain('Copy row');
        expect(menu_button_labels()).not.toContain('Copy 2 rows');
        expect((grid_mock.props!.gridSelection as { rows: { toArray(): number[] } })
            .rows.toArray()).toEqual([3]);
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Copy row')!.click());
        expect(write_text).toHaveBeenCalledWith('r3-a\tr3-c');
    });

    it('retires the marker context guard when Glide cell selection is already active', async () => {
        await render_grid(props({ row_count: 5 }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        const current = (column: number) => ({
            columns: compact([]), rows: compact([]),
            current: {
                cell: [column, 3],
                range: { x: column, y: 3, width: 1, height: 1 },
                rangeStack: [],
            },
        });
        await act(async () => on_selection_change(current(0)));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => {
            on_cell_context_menu([-1, 3], {
                preventDefault: vi.fn(),
                bounds: { x: 0, y: 96, width: 40, height: 24 },
                localEventX: 10,
                localEventY: 10,
            });
            await Promise.resolve();
        });
        // updateSelectedCell is a no-op when Glide's old current cell was already
        // [0, 3]; a later cell selection on that row must not hit a stale guard.
        await act(async () => on_selection_change(current(1)));
        expect((grid_mock.props!.gridSelection as {
            current?: { cell: [number, number] };
        }).current?.cell).toEqual([1, 3]);
    });

    it('sweeps a row-marker drag through hovered rows and back', async () => {
        await render_grid(props({ row_count: 10 }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        const on_item_hovered = grid_mock.props!.onItemHovered as
            (args: Record<string, unknown>) => void;
        // Marker mousedown: Glide reports the clicked row before any movement.
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([2]),
        }));
        // Sweep down to row 5 (marker gutter hovers report col -1).
        await act(async () => on_item_hovered({
            kind: 'cell', location: [-1, 5], buttons: 1,
        }));
        expect((grid_mock.props!.gridSelection as { rows: { toArray(): number[] } })
            .rows.toArray()).toEqual([2, 3, 4, 5]);
        // Shrink back to row 3: rows only covered by the wider sweep drop out.
        await act(async () => on_item_hovered({
            kind: 'cell', location: [0, 3], buttons: 1,
        }));
        expect((grid_mock.props!.gridSelection as { rows: { toArray(): number[] } })
            .rows.toArray()).toEqual([2, 3]);
    });

    it('keeps a sole selected row on plain re-click and can drag from it', async () => {
        await render_grid(props({ row_count: 10 }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        const on_item_hovered = grid_mock.props!.onItemHovered as
            (args: Record<string, unknown>) => void;
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([2]),
        }));
        // Hover identifies the marker for the root capture handler before the
        // next pointerdown reaches Glide.
        on_item_hovered({
            kind: 'cell', location: [-1, 2], buttons: 0,
            bounds: { x: 0, y: 48, width: 40, height: 24 }, localEventY: 12,
        });
        await act(async () => container!.querySelector('.data-editor-stub')!.dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        ));
        // Glide's clickable-number behavior tries to toggle the sole row off.
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([]),
        }));
        expect((grid_mock.props!.gridSelection as { rows: { toArray(): number[] } })
            .rows.toArray()).toEqual([2]);
        await act(async () => on_item_hovered({
            kind: 'cell', location: [-1, 5], buttons: 1,
        }));
        expect((grid_mock.props!.gridSelection as { rows: { toArray(): number[] } })
            .rows.toArray()).toEqual([2, 3, 4, 5]);
    });

    it('restores a plain re-click when no prior marker hover was observed', async () => {
        vi.useFakeTimers();
        await render_grid(props({ row_count: 10 }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        const on_cell_clicked = grid_mock.props!.onCellClicked as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([2]),
        }));
        await act(async () => {
            window.dispatchEvent(new Event('pointerup'));
            vi.runAllTimers();
        });
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([]),
        }));
        await act(async () => on_cell_clicked([-1, 2], {
            button: 0, shiftKey: false, ctrlKey: false, metaKey: false,
        }));
        expect((grid_mock.props!.gridSelection as { rows: { toArray(): number[] } })
            .rows.toArray()).toEqual([2]);
    });

    it('preserves a sole selected row across Glide touch re-click ordering', async () => {
        await render_grid(props({ row_count: 10 }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        const on_cell_clicked = grid_mock.props!.onCellClicked as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([2]),
        }));
        // On touch, Glide invokes onCellClicked before handleSelect toggles the
        // sole selected row off.
        await act(async () => on_cell_clicked([-1, 2], {
            isTouch: true,
            isLongTouch: false,
            button: 0,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
            preventDefault: vi.fn(),
        }));
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([]),
        }));
        expect((grid_mock.props!.gridSelection as { rows: { toArray(): number[] } })
            .rows.toArray()).toEqual([2]);
    });

    it('opens row actions on a marker long-press and preserves selected rows', async () => {
        await render_grid(props({ row_count: 10, transform_sections: true }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        const on_cell_clicked = grid_mock.props!.onCellClicked as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([1, 2, 4]),
        }));
        await act(async () => on_cell_clicked([-1, 2], {
            isLongTouch: true,
            button: 0,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 72, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        expect(menu_button_labels()).toEqual(expect.arrayContaining([
            'Hide 3 rows', 'Copy 3 rows',
        ]));
        // Glide continues into its touch selection after onCellClicked; reject
        // that replacement and retain the rows targeted by the open menu.
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([1, 2]),
        }));
        expect((grid_mock.props!.gridSelection as { rows: { toArray(): number[] } })
            .rows.toArray()).toEqual([1, 2, 4]);
    });

    it('keeps cmd/ctrl-selected rows while sweeping and ignores native replacements', async () => {
        vi.useFakeTimers();
        await render_grid(props({ row_count: 10 }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        const on_item_hovered = grid_mock.props!.onItemHovered as
            (args: Record<string, unknown>) => void;
        // Row 0 already selected; releasing that click clears its armed drag.
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([0]),
        }));
        await act(async () => {
            window.dispatchEvent(new Event('pointerup'));
            vi.runAllTimers();
        });
        // Cmd-click adds row 4 (the drag anchor) and the press stays down.
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([0, 4]),
        }));
        // Glide's native marker drag reports a bare contiguous replacement;
        // the armed sweep must ignore it rather than dropping row 0.
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([4, 5]),
        }));
        expect((grid_mock.props!.gridSelection as { rows: { toArray(): number[] } })
            .rows.toArray()).toEqual([0, 4]);
        await act(async () => on_item_hovered({
            kind: 'cell', location: [-1, 6], buttons: 1,
        }));
        expect((grid_mock.props!.gridSelection as { rows: { toArray(): number[] } })
            .rows.toArray()).toEqual([0, 4, 5, 6]);
    });

    it('ends a marker drag on pointerup so a later hover cannot resume it', async () => {
        vi.useFakeTimers();
        await render_grid(props({ row_count: 10 }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        const on_item_hovered = grid_mock.props!.onItemHovered as
            (args: Record<string, unknown>) => void;
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([2]),
        }));
        await act(async () => {
            window.dispatchEvent(new Event('pointerup'));
            vi.runAllTimers();
        });
        await act(async () => on_item_hovered({
            kind: 'cell', location: [-1, 7], buttons: 1,
            bounds: { x: 0, y: 96, width: 40, height: 24 }, localEventY: 12,
        }));
        expect((grid_mock.props!.gridSelection as { rows: { toArray(): number[] } })
            .rows.toArray()).toEqual([2]);
    });

    it('groups cell hide/select actions into submenus and projects Hide column', async () => {
        const on_hide_column = vi.fn();
        await render_grid(props({
            transform_sections: true,
            on_hide_column,
        }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([1, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 36, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        expect(menu_button_labels()).toContain('Copy cell');
        expect(menu_button_labels()).toContain('Hide›');
        expect(menu_button_labels()).toContain('Select›');
        expect(menu_button_labels()).not.toContain('Select row');

        const hide = Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Hide›')!;
        await act(async () => hide.click());
        expect(menu_button_labels()).toContain('Hide row');
        expect(menu_button_labels()).toContain('Hide column');
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Hide column')!.click());
        expect(on_hide_column).toHaveBeenCalledWith(2);
    });

    it('focuses Columns after hiding the final visible column from the cell submenu', async () => {
        const GridShell = await render_grid(props());
        const columns_trigger = document.createElement('button');
        document.body.appendChild(columns_trigger);
        const hidden_props = props({
            column_projection: {
                visible_to_source: [],
                source_to_visible: [undefined, undefined, undefined],
                hidden_count: 3,
            },
        });
        const on_hide_column = vi.fn(() => {
            root!.render(React.createElement(GridShell, hidden_props));
        });
        const on_focus_columns = vi.fn(() => columns_trigger.focus());
        await act(async () => root!.render(React.createElement(GridShell, props({
            column_projection: {
                visible_to_source: [2],
                source_to_visible: [undefined, undefined, 0],
                hidden_count: 2,
            },
            on_hide_column,
            on_focus_columns,
        }))));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([0, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 40, y: 36, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Hide›')!.click());
        await act(async () => {
            Array.from(document.querySelectorAll('button'))
                .find((button) => button.textContent === 'Hide column')!.click();
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
        expect(on_hide_column).toHaveBeenCalledWith(2);
        expect(on_focus_columns).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(columns_trigger);
    });

    it('keeps select actions off the root and exposes all three in its submenu', async () => {
        await render_grid(props());
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([1, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 36, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        const root_menu = document.querySelector('[aria-label="Context menu"]')!;
        expect(root_menu.textContent).not.toContain('Select row');
        const select = Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Select›')!;
        await act(async () => select.click());
        expect(menu_button_labels()).toEqual(expect.arrayContaining([
            'Select row', 'Select column', 'Select all',
        ]));
    });

    it('evaluates an outside right-click as the projected single source cell', async () => {
        const initial = props({
            cell_highlights: { schema: 'accepted', cells: { '0:0': 'yellow' } },
        });
        const GridShell = await render_grid(initial);
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([]),
            current: {
                cell: [0, 0],
                range: { x: 0, y: 0, width: 1, height: 1 },
                rangeStack: [],
            },
        }));

        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([1, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 36, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        expect(menu_button_labels()).not.toContain('Clear highlight');
        expect(menu_button_labels()).not.toContain('Clear highlights');

        await act(async () => root!.render(React.createElement(GridShell, {
            ...initial,
            cell_highlights: {
                schema: 'accepted',
                cells: { '0:0': 'yellow', '0:2': 'blue' },
            },
        })));
        expect(menu_button_labels()).toContain('Clear highlight');
        expect(menu_button_labels()).not.toContain('Clear highlights');
    });

    it('preserves an inside multi-selection and shows clear only when any cell is highlighted', async () => {
        const on_highlight_selection = vi.fn();
        const initial = props({
            row_count: 2,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 2,
                sourceRowCount: 2,
            },
            cell_highlights: { schema: 'accepted', cells: { '1:2': 'green' } },
            on_highlight_selection,
        });
        const GridShell = await render_grid(initial);
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([]),
            current: {
                cell: [0, 0],
                range: { x: 0, y: 0, width: 2, height: 1 },
                rangeStack: [],
            },
        }));

        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([1, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 36, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        expect(menu_button_labels()).not.toContain('Clear highlights');

        await act(async () => root!.render(React.createElement(GridShell, {
            ...initial,
            cell_highlights: {
                schema: 'accepted',
                cells: { '1:2': 'green', '0:2': 'pink' },
            },
        })));
        expect(menu_button_labels()).toContain('Clear highlights');
        expect(menu_button_labels()).not.toContain('Clear highlight');

        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Clear highlights')!.click());
        expect(on_highlight_selection).toHaveBeenCalledWith({
            displayRows: [{ start: 0, end: 0 }],
            sourceColumns: [0, 2],
        }, { type: 'clear' });
    });

    it('redirects the corner marker toggle to a full-grid select-all and back', async () => {
        await render_grid(props({
            row_count: 2,
            sheet_meta: { ...props().sheet_meta, rowCount: 2, sourceRowCount: 2 },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        // Glide's native corner toggle proposes a bare all-rows selection.
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([0, 1]),
        }));
        const after_select = grid_mock.props!.gridSelection as {
            current?: { range: unknown };
            rows: { length: number };
        };
        expect(after_select.current?.range).toEqual({ x: 0, y: 0, width: 2, height: 2 });
        expect(after_select.rows.length).toBe(0);

        // A second corner click, with the full rectangle already held, clears.
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([0, 1]),
        }));
        const after_clear = grid_mock.props!.gridSelection as {
            current?: unknown;
            rows: { length: number };
        };
        expect(after_clear.current).toBeUndefined();
        expect(after_clear.rows.length).toBe(0);
    });

    it('publishes grid actions that select all and copy the whole sheet', async () => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        const grid_actions_ref = React.createRef<
            import('../webview/grid-shell').GridActionsHandle | null
        >() as React.MutableRefObject<
            import('../webview/grid-shell').GridActionsHandle | null
        >;
        const GridShell = await render_grid(props({
            row_count: 2,
            sheet_meta: { ...props().sheet_meta, rowCount: 2, sourceRowCount: 2 },
            grid_actions_ref,
        }));
        expect(grid_actions_ref.current?.sheet_index).toBe(0);

        await act(async () => grid_actions_ref.current!.select_all());
        const selection = grid_mock.props!.gridSelection as { current?: { range: unknown } };
        expect(selection.current?.range).toEqual({ x: 0, y: 0, width: 2, height: 2 });

        await act(async () => { await grid_actions_ref.current!.copy_sheet(); });
        // The whole-sheet copy loads its full row range before serializing, so an
        // unscrolled/inactive sheet doesn't come back blank.
        expect(grid_mock.ensure_rows_loaded).toHaveBeenCalledWith(0, 1);
        const load_order = grid_mock.ensure_rows_loaded.mock.invocationCallOrder[0];
        const write_order = write_text.mock.invocationCallOrder[0];
        expect(load_order).toBeLessThan(write_order);
        // Header row followed by both source rows across the two visible columns.
        expect(write_text).toHaveBeenCalledWith(
            'A name\tC name\nsource-a\tsource-c\nsource-a\tsource-c',
        );

        await act(async () => root!.unmount());
        expect(grid_actions_ref.current).toBeNull();
        // Guard the shared afterEach unmount against a second call.
        root = null;
        void GridShell;
    });

    it('renders an unrecoverable message for a genuine zero-column sheet', async () => {
        await render_grid(props({
            sheet_meta: {
                name: 'Empty', rowCount: 0, sourceRowCount: 0,
                columnCount: 0, columnNames: [], merges: [], hasFormatting: false,
            },
            row_count: 0,
            column_projection: {
                visible_to_source: [], source_to_visible: [], hidden_count: 0,
            },
        }));
        const status = container!.querySelector('[role="status"]');
        expect(status?.textContent).toContain('This sheet contains no columns.');
        expect(status?.textContent).not.toContain('Show one or more columns');
        expect(container!.querySelector('.data-editor-stub')).toBeNull();
        expect(grid_mock.loader_enabled.at(-1)).toBe(false);
        expect(grid_mock.ensure_rows).not.toHaveBeenCalled();
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
                hidden_count: 3,
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

describe('GridShell row resizing', () => {
    it('resizes every selected row when the dragged row belongs to the selection', async () => {
        const on_row_resize = vi.fn();
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 6,
                sourceRowCount: 6,
            },
            row_count: 6,
            on_row_resize,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => {
            on_selection_change({
                columns: compact([]),
                rows: compact([1, 3, 4]),
            });
        });
        const on_visible_region_changed = grid_mock.props!.onVisibleRegionChanged as
            (region: { x: number; y: number; width: number; height: number }) => void;
        act(() => on_visible_region_changed({ x: 0, y: 3, width: 2, height: 1 }));

        const on_resize_start = grid_mock.row_resize_props!.on_resize_start as
            (row: number, height: number) => void;
        const on_resize = grid_mock.row_resize_props!.on_resize as
            (row: number, height: number) => void;
        const on_resize_end = grid_mock.row_resize_props!.on_resize_end as
            (row: number, height: number) => void;
        grid_mock.overlay_repaint.mockClear();
        act(() => on_resize_start(3, 24));
        act(() => on_resize(3, 52));

        expect(on_row_resize).not.toHaveBeenCalled();
        const get_row_height = grid_mock.props!.rowHeight as (row: number) => number;
        // Row 3 is not the first selected row, so previewing row 1 would shift
        // the dragged boundary away from the pointer. All rows commit on end.
        expect(get_row_height(1)).toBe(24);
        expect(get_row_height(2)).toBe(24);
        expect(get_row_height(3)).toBe(52);
        expect(get_row_height(4)).toBe(24);
        expect(grid_mock.update_cells).toHaveBeenCalledWith([
            { cell: [0, 3] }, { cell: [1, 3] },
        ]);
        expect(grid_mock.overlay_repaint).toHaveBeenCalled();
        act(() => on_resize_end(3, 52));
        expect(on_row_resize).toHaveBeenCalledOnce();
        expect(on_row_resize).toHaveBeenCalledWith([1, 3, 4], 52);
    });

    it('previews all selected rows when dragging the first selected row', async () => {
        const on_row_resize = vi.fn();
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 6,
                sourceRowCount: 6,
            },
            row_count: 6,
            row_heights: { 1: 24, 3: 36, 4: 44 },
            on_row_resize,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([1, 3, 4]),
        }));
        const on_resize_start = grid_mock.row_resize_props!.on_resize_start as
            (row: number, height: number) => void;
        const on_resize = grid_mock.row_resize_props!.on_resize as
            (row: number, height: number) => void;
        act(() => on_resize_start(1, 24));
        let get_row_height = grid_mock.props!.rowHeight as (row: number) => number;
        expect(get_row_height(1)).toBe(24);
        expect(get_row_height(3)).toBe(36);
        expect(get_row_height(4)).toBe(44);
        act(() => on_resize(1, 48));

        get_row_height = grid_mock.props!.rowHeight as (row: number) => number;
        expect(get_row_height(1)).toBe(48);
        expect(get_row_height(2)).toBe(24);
        expect(get_row_height(3)).toBe(48);
        expect(get_row_height(4)).toBe(48);
        expect(on_row_resize).not.toHaveBeenCalled();
    });

    it('resizes only the dragged row when it is outside the selection', async () => {
        const on_row_resize = vi.fn();
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 6,
                sourceRowCount: 6,
            },
            row_count: 6,
            on_row_resize,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => {
            on_selection_change({
                columns: compact([]),
                rows: compact([1, 3, 4]),
            });
        });

        const on_resize_start = grid_mock.row_resize_props!.on_resize_start as
            (row: number, height: number) => void;
        const on_resize = grid_mock.row_resize_props!.on_resize as
            (row: number, height: number) => void;
        const on_resize_end = grid_mock.row_resize_props!.on_resize_end as
            (row: number, height: number) => void;
        act(() => on_resize_start(2, 24));
        act(() => on_resize(2, 48));

        expect(on_row_resize).not.toHaveBeenCalled();
        act(() => on_resize_end(2, 48));
        expect(on_row_resize).toHaveBeenCalledOnce();
        expect(on_row_resize).toHaveBeenCalledWith([2], 48);
        expect(grid_mock.update_cells).not.toHaveBeenCalled();
    });

    it('bounds repaint damage for a large selected range to the visible viewport', async () => {
        const on_row_resize = vi.fn();
        const selected = Array.from({ length: 10_000 }, (_, row) => row);
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 20_000,
                sourceRowCount: 20_000,
            },
            row_count: 20_000,
            on_row_resize,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => {
            on_selection_change({ columns: compact([]), rows: compact(selected) });
        });
        const on_visible_region_changed = grid_mock.props!.onVisibleRegionChanged as
            (region: { x: number; y: number; width: number; height: number }) => void;
        act(() => on_visible_region_changed({ x: 1, y: 0, width: 1, height: 2 }));

        const on_resize_start = grid_mock.row_resize_props!.on_resize_start as
            (row: number, height: number) => void;
        const on_resize = grid_mock.row_resize_props!.on_resize as
            (row: number, height: number) => void;
        const on_resize_end = grid_mock.row_resize_props!.on_resize_end as
            (row: number, height: number) => void;
        act(() => on_resize_start(0, 24));
        act(() => on_resize(0, 40));
        act(() => on_resize(0, 50));
        act(() => on_resize(0, 60));

        expect(on_row_resize).not.toHaveBeenCalled();
        expect(grid_mock.update_cells).toHaveBeenCalledWith([
            { cell: [1, 0] },
            { cell: [1, 1] },
        ]);
        act(() => on_resize_end(0, 60));
        expect(on_row_resize).toHaveBeenCalledOnce();
        expect(on_row_resize.mock.calls[0][0]).toHaveLength(10_000);
    });

    it('repaints merge geometry after committed row heights render', async () => {
        const initial = props({ row_heights: { 1: 24 } });
        const GridShell = await render_grid(initial);
        grid_mock.overlay_repaint.mockClear();

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                row_heights: { 1: 52, 3: 52 },
            }));
        });

        expect(grid_mock.overlay_repaint).toHaveBeenCalled();
    });
});
