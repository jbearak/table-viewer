// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type {
    EditingHandle,
    GridFocusHandle,
    GridShellProps,
} from '../webview/grid-shell';
import { matches_filter } from '../table-transform';
import type { CsvSaveOperation, FilterEntry, SheetTransformState } from '../types';
import { CsvDataSource } from '../data-source/csv-source';
import { create_edit_session_store } from '../webview/edit-session-store';
import { create_history_store, type HistoryStore } from '../webview/history-store';
import {
    LAST_COLUMN_RESIZE_GUTTER_PX,
    MAX_AUTO_FIT_COLUMN_WIDTH_PX,
    MAX_COLUMN_WIDTH_PX,
} from '../webview/grid-model';
import { highlight_rgba, history_flash_rgba } from '../webview/highlight-theme';
import { HISTORY_FLASH_DURATION_MS } from '../webview/history-focus-model';
import { button, field, find_button, set_input_value } from './helpers/dom-interaction';
import {
    MAX_ROW_HEIGHT_PX,
    default_row_height_for_font,
    line_height_for_font,
    natural_row_height,
} from '../webview/row-heights';

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

/**
 * Drive one cell through the grid's batch edit callback.
 *
 * The shell takes edits as batches now — that is what makes a paste one
 * undoable gesture — so a test that means "the user typed into this cell"
 * sends a one-item batch tagged 'edit'.
 */
function edit_one(
    on_cells_edited: unknown,
): (cell: [number, number], value: { kind: string; data: string }) => void {
    const handler = on_cells_edited as (
        items: readonly { location: [number, number]; value: { kind: string; data: string } }[],
        source: string,
    ) => void;
    return (cell, value) => handler([{ location: cell, value }], 'edit');
}

const grid_mock = vi.hoisted(() => ({
    props: null as null | Record<string, unknown>,
    row_resize_props: null as null | Record<string, unknown>,
    row_resize_set_target: vi.fn(),
    update_cells: vi.fn(),
    scroll_to: vi.fn(),
    focus: vi.fn(),
    dismiss_overlay: vi.fn(),
    get_bounds: vi.fn((): { x: number; y: number; width: number; height: number } | undefined => ({
        x: 30, y: 10, width: 100, height: 36,
    })),
    loader_enabled: [] as boolean[],
    loader_version: 0,
    // Display row → canonical source row; null means identity, which is what a
    // CSV with no transform installed reports. Overridable so a test can make the
    // two row spaces diverge — the only condition under which an assertion about
    // durable edit-key row space is non-vacuous.
    source_row_for_display: null as null | ((display_row: number) => number | undefined),
    ensure_rows: vi.fn(),
    ensure_rows_loaded: vi.fn(async () => true),
    // Eviction holds. Recorded rather than simulated: what the loader does with a
    // pin is pinned by use-row-loader.test.ts; what matters here is that GridShell
    // takes one when an overlay opens and gives it back when the overlay closes.
    pin_rows: vi.fn((_start: number, _end: number) => Symbol('test-pin')),
    unpin_rows: vi.fn((_token: symbol) => {}),
    post_message: vi.fn(),
    get_row: vi.fn((_row?: number) => [
        { raw: 'source-a', formatted: 'source-a', bold: false, italic: false },
        { raw: 'hidden-b', formatted: 'hidden-b', bold: false, italic: false },
        { raw: 'source-c', formatted: 'source-c', bold: false, italic: false },
    ] as any),
}));

vi.mock('../webview/glide-data-grid', () => {
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
                dismissOverlay: grid_mock.dismiss_overlay,
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

// Lowest display row claiming `source_row`, or undefined if none does. Scanning a
// bounded display window stands in for the loader's source→page index; the harness
// only ever renders a handful of rows.
const SCANNED_DISPLAY_ROWS = vi.hoisted(() => 64);
const resident_display_row = vi.hoisted(() => (source_row: number): number | undefined => {
    for (let display_row = 0; display_row < SCANNED_DISPLAY_ROWS; display_row++) {
        const claimed = grid_mock.source_row_for_display
            ? grid_mock.source_row_for_display(display_row)
            : display_row;
        if (claimed === source_row) return display_row;
    }
    return undefined;
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
            pin_rows: grid_mock.pin_rows,
            unpin_rows: grid_mock.unpin_rows,
            get_row: grid_mock.get_row,
            // Identity unless a test installs a permutation. See the knob's
            // declaration: with display === source, a display-keyed and a
            // source-keyed implementation cannot be told apart.
            get_source_row: (display_row: number) => (
                grid_mock.source_row_for_display
                    ? grid_mock.source_row_for_display(display_row)
                    : display_row
            ),
            // Residency as the real loader's source→page index defines it: a source
            // row is readable exactly when some display row in the window claims it.
            get_cell_raw_for_source: (source_row: number, col: number) => {
                const display_row = resident_display_row(source_row);
                if (display_row === undefined) return undefined;
                const cell = grid_mock.get_row(display_row)?.[col];
                return cell ? String(cell.raw ?? '') : '';
            },
            get_cell_for_source: (source_row: number, col: number) => {
                const display_row = resident_display_row(source_row);
                if (display_row === undefined) return undefined;
                return grid_mock.get_row(display_row)?.[col] ?? null;
            },
            has_source_row: (source_row: number) => (
                resident_display_row(source_row) !== undefined
            ),
            sample_loaded_rows: () => [],
            version: grid_mock.loader_version,
        };
    },
}));

vi.mock('../webview/vscode-theme', () => ({
    use_vscode_theme: () => ({
        theme: {},
        highContrast: false,
        dirtyBg: 'rgba(204, 167, 0, 0.16)',
        conflictBg: 'rgba(229, 75, 75, 0.22)',
    }),
    theme_font_size_px: () => 13,
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

// Mount the overlay editor Glide would portal into `.gdg-clip-region`, for the
// currently rendered grid. Selecting the cell first is load-bearing: the capture
// reads the selection, exactly as Glide's overlay does (it owns the overlay's
// coordinates and our hook's editing_cell stays null). A separate React root
// stands in for the portal; the component still closes over this GridShell's
// refs, which is all the capture needs.
async function open_tracking_overlay(
    cell: [number, number],
    text: string,
    on_finished_editing: (...args: unknown[]) => void = () => {},
) {
    const on_selection_change = grid_mock.props!.onGridSelectionChange as
        (selection: unknown) => void;
    await act(async () => on_selection_change({
        columns: compact([]),
        rows: compact([]),
        current: {
            cell,
            range: { x: cell[0], y: cell[1], width: 1, height: 1 },
            rangeStack: [],
        },
    }));
    const value = { kind: 'text', data: text, displayData: text, allowOverlay: true };
    const provide_editor = grid_mock.props!.provideEditor as
        (cell: unknown) => { editor: React.ComponentType<any> } | undefined;
    const provided = provide_editor(value);
    if (!provided) throw new Error('No overlay editor provided');
    const clip = document.createElement('div');
    clip.className = 'gdg-clip-region';
    document.body.appendChild(clip);
    const overlay_root = createRoot(clip);
    await act(async () => {
        overlay_root.render(React.createElement(provided.editor, {
            value,
            onChange: () => {},
            onFinishedEditing: on_finished_editing,
        }));
    });
    return async function close_overlay() {
        await act(async () => overlay_root.unmount());
        clip.remove();
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
    // Back to identity: a leaked permutation would silently change which source
    // row every later test's edits land on.
    grid_mock.source_row_for_display = null;
    grid_mock.row_resize_props = null;
    grid_mock.row_resize_set_target.mockReset();
    grid_mock.update_cells.mockReset();
    grid_mock.scroll_to.mockReset();
    grid_mock.focus.mockReset();
    grid_mock.dismiss_overlay.mockReset();
    grid_mock.get_bounds.mockReset();
    grid_mock.get_bounds.mockImplementation(() => ({
        x: 30, y: 10, width: 100, height: 36,
    }));
    grid_mock.ensure_rows.mockReset();
    grid_mock.ensure_rows_loaded.mockReset();
    grid_mock.ensure_rows_loaded.mockImplementation(async () => true);
    grid_mock.pin_rows.mockReset();
    grid_mock.pin_rows.mockImplementation(() => Symbol('test-pin'));
    grid_mock.unpin_rows.mockReset();
    grid_mock.post_message.mockReset();
    grid_mock.get_row.mockReset();
    grid_mock.get_row.mockImplementation(() => [
        { raw: 'source-a', formatted: 'source-a', bold: false, italic: false },
        { raw: 'hidden-b', formatted: 'hidden-b', bold: false, italic: false },
        { raw: 'source-c', formatted: 'source-c', bold: false, italic: false },
    ] as any);
    grid_mock.loader_enabled = [];
    grid_mock.loader_version = 0;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'clipboard');
    vi.useRealTimers();
});

describe('GridShell cell wrapping', () => {
    it('does not tooltip fitted produce cells when canvas scaling makes bounds fractional', async () => {
        vi.useFakeTimers();
        const canvas_context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
            .mockReturnValue({
                font: '',
                measureText: (text: string) => ({ width: text.length * 7.4 }),
            } as unknown as CanvasRenderingContext2D);
        onTestFinished(() => canvas_context.mockRestore());
        const source = new CsvDataSource(
            readFileSync('src/test/fixtures/produce-nutrients.csv'),
            ',',
            10_000,
            { firstRowIsHeader: true },
        );
        const sheet = source.meta().sheets[0];
        grid_mock.get_row.mockImplementation((row?: number) => (
            row === undefined ? undefined : source.read_rows(0, row, 1).rows[0]
        ));
        const visible_to_source = Array.from(
            { length: sheet.columnCount },
            (_, column) => column,
        );
        await render_grid(props({
            sheet_meta: sheet,
            row_count: sheet.rowCount,
            column_projection: {
                visible_to_source,
                source_to_visible: visible_to_source,
                hidden_count: 0,
            },
            column_widths: Object.fromEntries(
                visible_to_source.map((column) => [column, 120]),
            ),
        }));

        const on_item_hovered = grid_mock.props!.onItemHovered as
            (args: Record<string, unknown>) => void;
        await act(async () => {
            on_item_hovered({
                kind: 'cell', location: [0, 0], buttons: 0,
                // Glide's 121x25 logical hit bounds at a 0.98 canvas scale.
                bounds: { x: 32, y: 36, width: 118.5, height: 24.5 },
                localEventX: 20, localEventY: 12,
            });
            await vi.runAllTimersAsync();
        });
        expect(container!.querySelector('[role="tooltip"]')).toBeNull();

        // A near-edge value still fits the logical 120px painted column even
        // though its measured width exceeds the downscaled client-space budget.
        await act(async () => {
            on_item_hovered({
                kind: 'cell', location: [20, 1], buttons: 0,
                bounds: { x: 32, y: 36, width: 118.5, height: 24.5 },
                localEventX: 20, localEventY: 12,
            });
            await vi.runAllTimersAsync();
        });
        expect(container!.querySelector('[role="tooltip"]')).toBeNull();

        // The regression guard must not disable legitimate truncation tips.
        await act(async () => {
            on_item_hovered({
                kind: 'cell', location: [21, 0], buttons: 0,
                bounds: { x: 32, y: 36, width: 118.5, height: 24.5 },
                localEventX: 20, localEventY: 12,
            });
            await vi.runAllTimersAsync();
        });
        expect(container!.querySelector('[role="tooltip"]')?.textContent)
            .toBe('Crisp when eaten fresh');
    });

    it('uses a vertical merge full height when deciding whether to soft-wrap', async () => {
        grid_mock.get_row.mockImplementation(() => [
            {
                raw: 'a long single-line value that needs the second merged row',
                formatted: 'a long single-line value that needs the second merged row',
                bold: false,
                italic: false,
            },
            { raw: 'hidden-b', formatted: 'hidden-b', bold: false, italic: false },
            { raw: 'source-c', formatted: 'source-c', bold: false, italic: false },
        ] as any);
        const merge = { startRow: 0, startCol: 0, endRow: 1, endCol: 0 };
        await render_grid(props({
            row_count: 2,
            merges: [merge],
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 2,
                sourceRowCount: 2,
                merges: [merge],
            },
        }));

        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { allowWrapping?: boolean };
        expect(get_cell_content([0, 0]).allowWrapping).toBe(true);
        // The neighboring ordinary cell is still only one default row high.
        expect(get_cell_content([1, 0]).allowWrapping).toBeUndefined();
    });
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
        expect(grid_mock.props!.maxColumnWidth).toBe(MAX_COLUMN_WIDTH_PX);
        expect(grid_mock.props!.maxColumnAutoWidth).toBe(MAX_AUTO_FIT_COLUMN_WIDTH_PX);
        expect(grid_mock.props!.maxColumnAutoWidth).toBe(MAX_COLUMN_WIDTH_PX / 4);
        expect(grid_mock.props!.overscrollX).toBe(LAST_COLUMN_RESIZE_GUTTER_PX);

        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { data: string };
        expect(get_cell_content([1, 0]).data).toBe('source-c');

        const on_column_resize_grid = grid_mock.props!.onColumnResize as
            (column: unknown, size: number, display_column: number) => void;
        on_column_resize_grid({}, 222, 1);
        expect(on_column_resize).toHaveBeenCalledWith(2, 222);
    });

    it('notifies App when a deferred auto-fit becomes measurable', async () => {
        const on_auto_fit_sample_change = vi.fn();
        const initial = props({ on_auto_fit_sample_change });
        const GridShell = await render_grid(initial);
        const rerender = async (next: GridShellProps) => {
            await act(async () => {
                root!.render(React.createElement(GridShell, next));
            });
        };

        // Version zero is the newly mounted, still-empty loader.
        expect(on_auto_fit_sample_change).not.toHaveBeenCalled();

        grid_mock.loader_version = 1;
        await rerender(initial);
        expect(on_auto_fit_sample_change).toHaveBeenCalledOnce();

        grid_mock.loader_version = 2;
        await rerender(initial);
        expect(on_auto_fit_sample_change).toHaveBeenCalledTimes(2);

        // A pending fit can also become measurable when columns are revealed after
        // rows are already resident, without another loader version bump. Hiding all
        // columns is not itself a reason to retry an impossible measurement.
        await rerender(props({
            on_auto_fit_sample_change,
            column_projection: {
                visible_to_source: [],
                source_to_visible: [undefined, undefined, undefined],
                hidden_count: 3,
            },
        }));
        expect(on_auto_fit_sample_change).toHaveBeenCalledTimes(2);

        await rerender(props({
            on_auto_fit_sample_change,
            column_projection: {
                visible_to_source: [0, 1, 2],
                source_to_visible: [0, 1, 2],
                hidden_count: 0,
            },
        }));
        expect(on_auto_fit_sample_change).toHaveBeenCalledTimes(3);
    });

    it('exposes an imperative focus handle for the mounted Glide grid', async () => {
        const grid_focus_ref = React.createRef<GridFocusHandle | null>();
        await render_grid(props({ grid_focus_ref }));

        expect(grid_focus_ref.current?.focus()).toBe(true);
        expect(document.activeElement).toBe(
            container!.querySelector('.data-editor-stub'),
        );
    });

    it('wraps Tab and Shift+Tab through displayed columns', async () => {
        await render_grid(props({
            sheet_meta: { ...props().sheet_meta, rowCount: 3, sourceRowCount: 3 },
            row_count: 3,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        const on_key_down = grid_mock.props!.onKeyDown as
            (args: Record<string, unknown>) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([]),
            current: {
                cell: [1, 0],
                range: { x: 1, y: 0, width: 1, height: 1 },
                rangeStack: [],
            },
        }));

        const tab = {
            key: 'Tab',
            altKey: false,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
            rawEvent: { code: 'Tab', target: document.createElement('canvas') },
            cancel: vi.fn(),
            preventDefault: vi.fn(),
        };
        await act(async () => on_key_down(tab));
        expect((grid_mock.props!.gridSelection as any).current.cell).toEqual([0, 1]);
        expect(grid_mock.scroll_to).toHaveBeenLastCalledWith(0, 1);
        expect(tab.cancel).toHaveBeenCalled();
        expect(tab.preventDefault).toHaveBeenCalled();

        await act(async () => on_key_down({ ...tab, shiftKey: true }));
        expect((grid_mock.props!.gridSelection as any).current.cell).toEqual([1, 0]);
    });

    it('keeps Tab focus inside the grid at the outer boundaries', async () => {
        await render_grid(props({
            sheet_meta: { ...props().sheet_meta, rowCount: 2, sourceRowCount: 2 },
            row_count: 2,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        const on_key_down = grid_mock.props!.onKeyDown as
            (args: Record<string, unknown>) => void;
        const select = async (cell: [number, number]) => act(async () => {
            on_selection_change({
                columns: compact([]),
                rows: compact([]),
                current: {
                    cell,
                    range: { x: cell[0], y: cell[1], width: 1, height: 1 },
                    rangeStack: [],
                },
            });
        });
        const key = (shiftKey: boolean) => ({
            key: 'Tab',
            altKey: false,
            shiftKey,
            ctrlKey: false,
            metaKey: false,
            rawEvent: { code: 'Tab', target: document.createElement('canvas') },
            cancel: vi.fn(),
            preventDefault: vi.fn(),
        });

        await select([0, 0]);
        const backward = key(true);
        await act(async () => on_key_down(backward));
        expect((grid_mock.props!.gridSelection as any).current.cell).toEqual([0, 0]);
        expect(backward.cancel).toHaveBeenCalled();

        await select([1, 1]);
        const forward = key(false);
        await act(async () => on_key_down(forward));
        expect((grid_mock.props!.gridSelection as any).current.cell).toEqual([1, 1]);
        expect(forward.cancel).toHaveBeenCalled();
    });

    it('restores grid focus after an edited Tab wraps to the next row', async () => {
        await render_grid(props({
            sheet_meta: { ...props().sheet_meta, rowCount: 3, sourceRowCount: 3 },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
        }));
        const finished = vi.fn();
        const close_overlay = await open_tracking_overlay([1, 0], 'typed', finished);
        const input = document.querySelector<HTMLInputElement>('.cell-editor-input')!;
        expect(document.activeElement).toBe(input);

        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            }));
        });
        expect(finished).toHaveBeenCalledWith(
            expect.objectContaining({ data: 'typed' }),
            [0, 0],
        );
        expect((grid_mock.props!.gridSelection as any).current.cell).toEqual([1, 0]);

        await close_overlay();
        expect((grid_mock.props!.gridSelection as any).current.cell).toEqual([0, 1]);
        expect(document.activeElement).toBe(
            container!.querySelector('.data-editor-stub'),
        );

        const on_key_down = grid_mock.props!.onKeyDown as
            (args: Record<string, unknown>) => void;
        await act(async () => on_key_down({
            key: 'Tab',
            altKey: false,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
            rawEvent: { code: 'Tab', target: document.activeElement },
            cancel: vi.fn(),
            preventDefault: vi.fn(),
        }));
        expect((grid_mock.props!.gridSelection as any).current.cell).toEqual([1, 1]);
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

    it('dismisses an open overlay and keeps a late finish on its original source column', async () => {
        const store = create_edit_session_store({ session_id: 'session-1' });
        const initial = props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session-1',
            edit_session: store,
        });
        const GridShell = await render_grid(initial);
        const close_overlay = await open_tracking_overlay([0, 0], 'typed');
        grid_mock.dismiss_overlay.mockClear();

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                // Display column 0 used to mean source A; it now means C.
                column_projection: {
                    visible_to_source: [2],
                    source_to_visible: [undefined, undefined, 0],
                    hidden_count: 2,
                },
            }));
        });
        expect(grid_mock.dismiss_overlay).toHaveBeenCalled();

        // Model an already-queued onFinishedEditing callback from the overlay
        // whose dismissal raced the projection commit. It must not write A's
        // text into the source column now occupying display slot 0.
        const on_cell_edited = edit_one(grid_mock.props!.onCellsEdited);
        await act(async () => on_cell_edited([0, 0], { kind: 'text', data: 'typed' }));
        expect(Object.fromEntries(store.snapshot())).toEqual({
            '0:0': { value: 'typed', base: 'source-a' },
        });

        await close_overlay();
    });

    it('dismisses and rejects an open overlay when a highlight revokes editing', async () => {
        const store = create_edit_session_store({ session_id: 'session-1' });
        const initial = props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session-1',
            edit_session: store,
        });
        const GridShell = await render_grid(initial);
        const close_overlay = await open_tracking_overlay([0, 0], 'typed');
        const pin = grid_mock.pin_rows.mock.results.at(-1)!.value as symbol;
        grid_mock.dismiss_overlay.mockClear();
        grid_mock.unpin_rows.mockClear();

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                highlight_in_flight: true,
            }));
        });

        expect(grid_mock.dismiss_overlay).toHaveBeenCalled();
        expect(grid_mock.unpin_rows).toHaveBeenCalledWith(pin);
        const on_cell_edited = edit_one(grid_mock.props!.onCellsEdited);
        await act(async () => on_cell_edited([0, 0], { kind: 'text', data: 'late' }));
        expect(store.snapshot().size).toBe(0);

        await close_overlay();
    });

    it('dismisses and rejects an overlay owned by a replaced edit session', async () => {
        const old_store = create_edit_session_store({ session_id: 'session-1' });
        const next_store = create_edit_session_store({ session_id: 'session-2' });
        const initial = props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session-1',
            edit_session: old_store,
        });
        const GridShell = await render_grid(initial);
        const close_overlay = await open_tracking_overlay([0, 0], 'typed');
        const pin = grid_mock.pin_rows.mock.results.at(-1)!.value as symbol;
        grid_mock.dismiss_overlay.mockClear();
        grid_mock.unpin_rows.mockClear();

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                edit_session_id: 'session-2',
                edit_session: next_store,
            }));
        });

        expect(grid_mock.dismiss_overlay).toHaveBeenCalled();
        expect(grid_mock.unpin_rows).toHaveBeenCalledWith(pin);
        const on_cell_edited = edit_one(grid_mock.props!.onCellsEdited);
        await act(async () => on_cell_edited([0, 0], { kind: 'text', data: 'late' }));
        expect(old_store.snapshot().size).toBe(0);
        expect(next_store.snapshot().size).toBe(0);

        await close_overlay();
    });

    it('retains display selection when a projection is recreated unchanged', async () => {
        const GridShell = await render_grid(props());
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

        await act(async () => root!.render(React.createElement(GridShell, props({
            column_projection: {
                visible_to_source: [0, 2],
                source_to_visible: [0, undefined, 1],
                hidden_count: 1,
            },
        }))));

        expect((grid_mock.props!.gridSelection as any).current.cell).toEqual([1, 0]);
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

    it('retargets shortcuts after programmatic vim and native arrow navigation', async () => {
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
        // Arrow keys defer to Glide (which is merge-aware natively); the moved
        // selection arrives back through onGridSelectionChange and must retarget
        // the focused column exactly like an interception used to.
        const arrow_args = key_args('ArrowRight');
        await act(async () => on_key_down(arrow_args));
        expect(arrow_args.cancel).not.toHaveBeenCalled();
        await act(async () => on_selection_change({
            columns: compact([]), rows: compact([]),
            current: {
                cell: [1, 0],
                range: { x: 1, y: 0, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
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
        // Glide readiness is deferred, so wait for the scroll to happen rather
        // than for a fixed delay to elapse: a loaded CI runner overruns any one
        // number, which is how this failed intermittently and only there.
        await act(async () => {
            for (let attempt = 0; attempt < 100 && !grid_mock.scroll_to.mock.calls.length; attempt++) {
                await new Promise((resolve) => window.setTimeout(resolve, 20));
            }
        });
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

    // Hiding rows is a transform like any other, so edit mode no longer withholds
    // it: the host admits it from the panel that owns the session. Preview keeps its
    // refusal, because natural source order is a trust boundary there.
    async function open_row_marker_menu(overrides: Partial<GridShellProps>) {
        await render_grid(props({
            row_count: 4,
            sheet_meta: { ...props().sheet_meta, rowCount: 4, sourceRowCount: 4 },
            transform_sections: true,
            ...overrides,
        }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([-1, 2], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 72, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
    }

    it('offers hiding rows from the row-marker menu in edit mode', async () => {
        await open_row_marker_menu({ edit_mode: true, csv_editable: true });
        expect(menu_button_labels()).toContain('Hide row');
    });

    it('refuses hiding rows from the row-marker menu in preview mode', async () => {
        await open_row_marker_menu({ preview_mode: true });
        expect(menu_button_labels()).not.toContain('Hide row');
    });

    it('offers hiding rows from the cell menu in edit mode but not in preview', async () => {
        const select_row_2 = async () => {
            const on_selection_change = grid_mock.props!.onGridSelectionChange as
                (selection: unknown) => void;
            await act(async () => on_selection_change({
                columns: compact([]),
                rows: compact([2]),
            }));
        };
        // Hide row lives in the cell menu's Hide submenu, so the submenu has to be
        // opened before its labels are readable.
        const open_cell_hide_submenu = async () => {
            const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
                (cell: [number, number], event: Record<string, unknown>) => void;
            await act(async () => on_cell_context_menu([0, 2], {
                preventDefault: vi.fn(),
                bounds: { x: 0, y: 72, width: 100, height: 24 },
                localEventX: 10,
                localEventY: 10,
            }));
            const hide = Array.from(document.querySelectorAll('button'))
                .find((button) => button.textContent === 'Hide›');
            if (hide) await act(async () => hide.click());
        };

        await render_grid(props({
            row_count: 4,
            sheet_meta: { ...props().sheet_meta, rowCount: 4, sourceRowCount: 4 },
            transform_sections: true,
            edit_mode: true,
            csv_editable: true,
        }));
        await select_row_2();
        await open_cell_hide_submenu();
        expect(menu_button_labels()).toContain('Hide row');

        act(() => root!.unmount());
        root = null;
        container?.remove();
        document.body.innerHTML = '';
        await render_grid(props({
            row_count: 4,
            sheet_meta: { ...props().sheet_meta, rowCount: 4, sourceRowCount: 4 },
            transform_sections: true,
            preview_mode: true,
        }));
        await select_row_2();
        await open_cell_hide_submenu();
        expect(menu_button_labels()).not.toContain('Hide row');
    });

    it('omits row promotion under an edit-mode sort', async () => {
        // `transform_state` is no longer emptied in edit mode, so this restriction —
        // promoting a row hides the rows above it, which only means anything in
        // natural order — now actually sees the sort a user installed while editing.
        const base = props();
        await open_row_marker_menu({
            sheet_meta: {
                ...base.sheet_meta,
                rowCount: 4,
                sourceRowCount: 4,
                excelFirstRowHeader: {
                    mode: 'off', detected: false, active: false, available: true,
                },
            },
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
            can_promote_row_to_header: true,
            edit_mode: true,
            csv_editable: true,
        });
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
        expect(menu_button_labels()).toContain('Copy cell');
        expect(menu_button_labels()).not.toContain('Copy selection');

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

    it('copies a preserved multi-cell range through the contextual copy action', async () => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        await render_grid(props());
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
        expect(menu_button_labels()).toContain('Copy selection');
        expect(menu_button_labels()).not.toContain('Copy cell');
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Copy selection')!.click());
        expect(write_text).toHaveBeenCalledWith('source-a\tsource-c');
    });

    it.each([
        {
            name: 'row',
            selection: { columns: compact([]), rows: compact([0]) },
            cell: [1, 0] as [number, number],
            copied: 'source-a\tsource-c',
        },
        {
            name: 'column',
            selection: { columns: compact([1]), rows: compact([]) },
            cell: [1, 0] as [number, number],
            copied: 'C name\nsource-c',
        },
    ])('copies a preserved $name selection through Copy selection', async ({
        selection,
        cell,
        copied,
    }) => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        await render_grid(props());
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change(selection));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu(cell, {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 36, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        expect(menu_button_labels()).toContain('Copy selection');
        expect(menu_button_labels()).not.toContain('Copy cell');
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Copy selection')!.click());
        expect(write_text).toHaveBeenCalledWith(copied);
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

describe('GridShell link-only edits', () => {
    it('keeps the formatted display when only the hyperlink changed', async () => {
        // A link-only entry's `value` is the unedited cell's raw text, and the
        // save deliberately emits no text edit for it — so substituting it for
        // the display would swap a formatted number for its raw form on a cell
        // whose value dimension was never touched.
        grid_mock.get_row.mockImplementation(() => [
            { raw: '1234.5', formatted: '1,234.50', bold: false, italic: false },
            { raw: 'hidden-b', formatted: 'hidden-b', bold: false, italic: false },
            { raw: 'source-c', formatted: 'source-c', bold: false, italic: false },
        ] as any);
        await render_grid(props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            initial_edits: {
                '0:0': {
                    value: '1234.5',
                    base: '1234.5',
                    link: { kind: 'external', target: 'https://a.test/' },
                    baseLink: null,
                },
            },
        }));
        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { displayData: string };
        expect(get_cell_content([0, 0]).displayData).toBe('1,234.50');
    });

    it('still substitutes the dirty text when the value itself changed', async () => {
        grid_mock.get_row.mockImplementation(() => [
            { raw: '1234.5', formatted: '1,234.50', bold: false, italic: false },
            { raw: 'hidden-b', formatted: 'hidden-b', bold: false, italic: false },
            { raw: 'source-c', formatted: 'source-c', bold: false, italic: false },
        ] as any);
        await render_grid(props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            initial_edits: {
                '0:0': {
                    value: 'typed',
                    base: '1234.5',
                    link: { kind: 'external', target: 'https://a.test/' },
                    baseLink: null,
                },
            },
        }));
        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { displayData: string };
        expect(get_cell_content([0, 0]).displayData).toBe('typed');
    });
});

// Every test here installs a NON-IDENTITY display→source mapping. Under identity
// a display-keyed and a source-keyed implementation are indistinguishable, so an
// identity fixture would make each of these assertions vacuous.
describe('GridShell source-row edit identity', () => {
    // Display row 1's source identity is unresolved (its page has not landed);
    // every other display row maps to itself.
    const unresolved_row_1 = (display_row: number) => (
        display_row === 1 ? undefined : display_row
    );

    it('refuses to open an overlay on a row whose source identity is unresolved', async () => {
        grid_mock.source_row_for_display = unresolved_row_1;
        await render_grid(props({
            sheet_meta: { ...props().sheet_meta, rowCount: 3, sourceRowCount: 3 },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
        }));
        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { allowOverlay: boolean; readonly?: boolean };

        // No source row ⇒ no durable key ⇒ no overlay, and `readonly` closes
        // Glide's paste path, which never consults allowOverlay.
        const blocked = get_cell_content([0, 1]);
        expect(blocked.allowOverlay).toBe(false);
        expect(blocked.readonly).toBe(true);

        // A resolved row on the same render stays editable.
        const open = get_cell_content([0, 0]);
        expect(open.allowOverlay).toBe(true);
        expect(open.readonly).toBeUndefined();
    });

    it('keeps a resident blank cell editable', async () => {
        // Today's behavior, and the thing the overlay-open gate must not regress:
        // a resident row whose cell is empty is still typeable.
        grid_mock.get_row.mockImplementation(() => [
            { raw: '', formatted: '', bold: false, italic: false },
            { raw: '', formatted: '', bold: false, italic: false },
            { raw: '', formatted: '', bold: false, italic: false },
        ] as any);
        grid_mock.source_row_for_display = unresolved_row_1;
        await render_grid(props({
            sheet_meta: { ...props().sheet_meta, rowCount: 3, sourceRowCount: 3 },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
        }));
        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { data: string; allowOverlay: boolean };
        const blank = get_cell_content([0, 2]);
        expect(blank.data).toBe('');
        expect(blank.allowOverlay).toBe(true);
    });

    // Mid-edit eviction. The overlay's lifetime spans "opened" and "committed", and
    // Glide's overlay does not close on scroll, so the page holding the edited row
    // can be evicted between the two. Re-deriving identity at commit time then
    // yields undefined for a row that was resolvable when the user started typing,
    // and the commit guards — there to refuse a *genuinely* unresolvable row —
    // silently drop the text instead. `has_uncommitted_changes` would then report
    // false, so the exit dialog would not even offer to save it.
    //
    // Both tests below use display 0 ↔ source 5 so the surviving key proves *which*
    // identity was used, and flip the mapping to fully-unresolved to model the
    // eviction rather than a permutation change.
    const evict_everything = () => { grid_mock.source_row_for_display = () => undefined; };

    it('commits an evicted overlay under the source key it opened with', async () => {
        const statuses: { edits: Record<string, { value: string; base: string }> }[] = [];
        const editing_ref = React.createRef<EditingHandle | null>();
        grid_mock.source_row_for_display = (display_row: number) => (
            display_row === 0 ? 5 : display_row + 100
        );
        await render_grid(props({
            sheet_meta: { ...props().sheet_meta, rowCount: 3, sourceRowCount: 3 },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            editing_ref,
            on_editing_change: (status) => { statuses.push(status as never); },
        }));
        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { allowOverlay: boolean };
        // Resolvable at open time — the precondition the drop silently violates.
        expect(get_cell_content([0, 0]).allowOverlay).toBe(true);

        const close_overlay = await open_tracking_overlay([0, 0], 'typed');
        // Opening takes an eviction hold on the edited display row, which is the
        // other half of the fix: without it the base below is unreadable.
        expect(grid_mock.pin_rows).toHaveBeenCalledWith(0, 0);

        evict_everything();
        const on_cell_edited = edit_one(grid_mock.props!.onCellsEdited);
        await act(async () => on_cell_edited([0, 0], { kind: 'text', data: 'typed' }));

        // Under the captured identity, not a guess and not nothing: '0:0' would be
        // some other row's cell, and dropping it would lose typed text.
        expect(Object.keys(statuses.at(-1)!.edits)).toEqual(['5:0']);
        expect(statuses.at(-1)!.edits['5:0'].value).toBe('typed');
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);

        // And the hold is given back on close, so the pin cannot outlive the edit.
        await close_overlay();
        const token = grid_mock.pin_rows.mock.results[0]!.value as symbol;
        expect(grid_mock.unpin_rows).toHaveBeenCalledWith(token);
    });

    it('folds an evicted overlay into the save under the key it opened with', async () => {
        // The same drop on the read_live_edit path, which is what collect_save_payload
        // consumes: an overlay the user never closed before hitting Save.
        const editing_ref = React.createRef<EditingHandle | null>();
        grid_mock.source_row_for_display = (display_row: number) => (
            display_row === 0 ? 5 : display_row + 100
        );
        const edit_session = create_edit_session_store({ session_id: 'session-1' });
        await render_grid(props({
            sheet_meta: { ...props().sheet_meta, rowCount: 3, sourceRowCount: 3 },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            editing_ref,
            edit_session_id: 'session-1',
            edit_session,
            on_save_request: () => {
                const snapshot = edit_session.snapshot();
                const operation: CsvSaveOperation = {
                    editSessionId: 'session-1',
                    saveRequestId: 'save-1',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: Object.fromEntries([...snapshot].map(([key, entry]) => [
                            key,
                            entry.value,
                        ])),
                        dirtyEdits: Object.fromEntries(snapshot),
                    }],
                };
                grid_mock.post_message({ type: 'saveCsv', operation });
                return operation;
            },
        }));

        await open_tracking_overlay([0, 0], 'live text');
        evict_everything();

        let posted = false;
        await act(async () => { posted = editing_ref.current!.request_save(); });
        expect(posted).toBe(true);

        const save = [...grid_mock.post_message.mock.calls]
            .reverse()
            .map(([message]) => message as { type?: string; operation?: CsvSaveOperation })
            .find((message) => message?.type === 'saveCsv');
        // Dropped, this save posts nothing at all (request_save returns false on an
        // empty map); display-keyed, it posts '0:0'.
        expect(save!.operation!.worksheets[0].edits).toEqual({ '5:0': 'live text' });
    });

    it('commits nothing when onCellEdited fires on an unresolved row', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        grid_mock.source_row_for_display = unresolved_row_1;
        await render_grid(props({
            sheet_meta: { ...props().sheet_meta, rowCount: 3, sourceRowCount: 3 },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            editing_ref,
        }));
        const on_cell_edited = edit_one(grid_mock.props!.onCellsEdited);

        // Glide's paste path can reach onCellEdited without an overlay, so this is
        // the second guard: an unresolvable row must land no edit at all rather
        // than land one under a guessed key.
        await act(async () => on_cell_edited([0, 1], { kind: 'text', data: 'pasted' }));
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(false);

        // Same grid, resolved row: the edit does land, so the guard is not simply
        // disabling all editing.
        await act(async () => on_cell_edited([0, 0], { kind: 'text', data: 'typed' }));
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);
    });

    it('discards the edit under the clicked row\'s source key and reports it dirty', async () => {
        // Display row 1 ↔ source row 7. A display-keyed discard would target
        // '1:2' — an entry that does not exist — and leave '7:2' dirty.
        grid_mock.source_row_for_display = (display_row: number) => (
            display_row === 1 ? 7 : display_row
        );
        const editing_ref = React.createRef<EditingHandle | null>();
        await render_grid(props({
            sheet_meta: { ...props().sheet_meta, rowCount: 3, sourceRowCount: 3 },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            editing_ref,
            initial_edits: { '7:2': { value: 'dirty-c', base: 'source-c' } },
        }));
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);

        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([1, 1], {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 36, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        // The menu's `dirty` probe is source-keyed too: a display-keyed probe would
        // miss and hide this item entirely.
        const discard = Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Discard edit');
        expect(discard).toBeDefined();

        await act(async () => discard!.click());
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(false);
    });

    it('copies a dirty cell keyed by source row under a permuted mapping', async () => {
        const write_text = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        grid_mock.source_row_for_display = (display_row: number) => (
            display_row === 1 ? 7 : display_row
        );
        await render_grid(props({
            sheet_meta: { ...props().sheet_meta, rowCount: 3, sourceRowCount: 3 },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            initial_edits: { '7:2': { value: 'edited-c', base: 'source-c' } },
        }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([1, 1], {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 36, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Copy cell')!.click());
        // A display-keyed copy overlay would miss the edit and copy 'source-c'.
        expect(write_text).toHaveBeenCalledWith('edited-c');
    });

    it('damages the display coordinates of a source-keyed tint change', async () => {
        // Source row 7 is displayed at row 1. A tint repaint that treated the
        // changed key's row as a display coordinate would damage row 7 — outside
        // the visible region entirely — and paint nothing.
        grid_mock.source_row_for_display = (display_row: number) => (
            display_row === 1 ? 7 : display_row
        );
        const editing_ref = React.createRef<EditingHandle | null>();
        await render_grid(props({
            sheet_meta: { ...props().sheet_meta, rowCount: 3, sourceRowCount: 3 },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            editing_ref,
            initial_edits: { '7:2': { value: 'dirty-c', base: 'source-c' } },
        }));
        const on_visible_region_changed = grid_mock.props!.onVisibleRegionChanged as
            (region: { x: number; y: number; width: number; height: number }) => void;
        act(() => on_visible_region_changed({ x: 0, y: 0, width: 2, height: 3 }));
        grid_mock.update_cells.mockClear();

        // Bulk transition: clear_dirty drops '7:2' from the dirty set.
        await act(async () => editing_ref.current!.clear_dirty());

        // Source column 2 is display column 1; source row 7 is display row 1.
        expect(grid_mock.update_cells).toHaveBeenCalledWith([{ cell: [1, 1] }]);
    });

    it('repaints a cell the host named on a rejected save', async () => {
        // The webview cannot derive this conflict: '7:2' still agrees with source
        // row 7's text, so is_entry_conflicted is false for it. Only the union with
        // the host's rejected keys can tint the cell — and the targeted repaint
        // effect has to actually notice that union change, which is the leg this
        // test pins rather than assumes.
        grid_mock.source_row_for_display = (display_row: number) => (
            display_row === 1 ? 7 : display_row
        );
        const base_props = props({
            sheet_meta: { ...props().sheet_meta, rowCount: 3, sourceRowCount: 3 },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            initial_edits: { '7:2': { value: 'dirty-c', base: 'source-c' } },
        });
        const GridShell = await render_grid(base_props);
        const on_visible_region_changed = grid_mock.props!.onVisibleRegionChanged as
            (region: { x: number; y: number; width: number; height: number }) => void;
        act(() => on_visible_region_changed({ x: 0, y: 0, width: 2, height: 3 }));
        grid_mock.update_cells.mockClear();

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...base_props,
                host_rejected_keys: ['7:2'],
            }));
        });
        expect(grid_mock.update_cells).toHaveBeenCalledWith([{ cell: [1, 1] }]);

        // Un-marked by the same machinery once the rejection is resolved.
        grid_mock.update_cells.mockClear();
        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...base_props,
                host_rejected_keys: [],
            }));
        });
        expect(grid_mock.update_cells).toHaveBeenCalledWith([{ cell: [1, 1] }]);
    });
});

/**
 * Rows must never move mid-edit. A sort or filter now survives edit mode, and it
 * deliberately does not recompute while the session is live: the user keeps typing
 * into the cell they clicked, exactly as a spreadsheet behaves. These are the
 * user-facing guarantees of the admission change, so they are pinned here rather
 * than left implied by the absence of re-sorting code.
 */
describe('GridShell stable rows during an edit session', () => {
    // Column 0 values by *source* row. Distinct per row, so the value a display row
    // paints identifies which source row that display row is showing — which is how
    // the display→source mapping below is observed rather than asserted against the
    // harness knob that produces it.
    const SOURCE_VALUES = ['q', 'a', 'z', 'm'];

    function install_permutation(display_to_source: readonly number[]) {
        // Non-identity on purpose: with display === source, a grid that silently
        // re-sorted and one that did not are indistinguishable, so an identity
        // mapping would make everything below pass trivially.
        grid_mock.source_row_for_display = (display_row: number) => (
            display_to_source[display_row]
        );
        grid_mock.get_row.mockImplementation(((display_row?: number) => {
            const source_row = display_to_source[display_row ?? 0];
            if (source_row === undefined) return undefined;
            const value = SOURCE_VALUES[source_row]!;
            return [
                { raw: value, formatted: value, bold: false, italic: false },
                { raw: `b${source_row}`, formatted: `b${source_row}`, bold: false, italic: false },
                { raw: `c${source_row}`, formatted: `c${source_row}`, bold: false, italic: false },
            ];
        }) as never);
    }

    function stable_props(
        display_to_source: readonly number[],
        transform_state: SheetTransformState,
        overrides: Partial<GridShellProps> = {},
    ): GridShellProps {
        return props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: display_to_source.length,
                sourceRowCount: SOURCE_VALUES.length,
            },
            row_count: display_to_source.length,
            // All three columns visible, so display column 0 is source column 0 and
            // the sorted/filtered column is the one being edited.
            column_projection: {
                visible_to_source: [0, 1, 2],
                source_to_visible: [0, 1, 2],
                hidden_count: 0,
            },
            transform_state,
            transform_sections: true,
            edit_mode: true,
            csv_editable: true,
            ...overrides,
        });
    }

    /** What every display row paints in column 0 — the observable display order. */
    function displayed_column_0(row_count: number): string[] {
        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { data: string };
        return Array.from(
            { length: row_count },
            (_, display_row) => get_cell_content([0, display_row]).data,
        );
    }

    function posted_transforms() {
        return grid_mock.post_message.mock.calls
            .map(([message]) => message as { type?: string })
            .filter((message) => message?.type === 'setTransform');
    }

    it('committing an edit to a sorted column does not change any row\'s display position', async () => {
        // Ascending on column 0 over ['q','a','z','m'] puts the sources in this
        // order — no display row keeps its source row, so nothing here can pass by
        // the two row spaces happening to coincide.
        const display_to_source = [1, 3, 0, 2];
        install_permutation(display_to_source);
        const on_transform_change = vi.fn();
        const statuses: { edits: Record<string, { value: string; base: string }> }[] = [];
        await render_grid(stable_props(
            display_to_source,
            { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
            {
                on_transform_change,
                on_editing_change: (status) => { statuses.push(status as never); },
            },
        ));
        const rows_before = grid_mock.props!.rows;
        const before = displayed_column_0(display_to_source.length);
        expect(before).toEqual(['a', 'm', 'q', 'z']);

        // 'zzz' sorts after every other value, so a view that recomputed would move
        // this row from display 0 to display 3.
        const on_cell_edited = edit_one(grid_mock.props!.onCellsEdited);
        await act(async () => on_cell_edited([0, 0], { kind: 'text', data: 'zzz' }));
        await vi.waitUntil(() => statuses.some(
            (status) => status.edits['1:0']?.value === 'zzz',
        ));

        // Positively applied, and readable where the user left it: without this the
        // test would also pass if the edit had simply been dropped.
        expect(statuses.at(-1)!.edits['1:0']!.value).toBe('zzz');
        const after = displayed_column_0(display_to_source.length);
        expect(after[0]).toBe('zzz');
        // Every other display row still shows the same source row's value, so the
        // whole display→source mapping is unchanged.
        expect(after.slice(1)).toEqual(before.slice(1));
        expect(grid_mock.props!.rows).toBe(rows_before);
        // The mechanized form of the product rule: nothing asks the host to re-sort.
        expect(on_transform_change).not.toHaveBeenCalled();
        expect(posted_transforms()).toEqual([]);
    });

    it('an edited row that fails an enabled filter stays visible until save', async () => {
        const filter: FilterEntry = {
            id: 'filter-1',
            colIndex: 0,
            operator: 'notEquals',
            value: 'q',
            caseSensitive: false,
            enabled: true,
        };
        // Anti-vacuity first: if the filter accepted the new value too, everything
        // below would hold for reasons having nothing to do with stable rows.
        const cell = (raw: string) => ({
            raw, formatted: raw, bold: false, italic: false,
        });
        expect(matches_filter(cell('a'), filter)).toBe(true);
        expect(matches_filter(cell('q'), filter)).toBe(false);

        // Source 0 ('q') is filtered out, so the surviving display rows are 1, 2, 3.
        const display_to_source = [1, 2, 3];
        install_permutation(display_to_source);
        const on_transform_change = vi.fn();
        const statuses: { edits: Record<string, { value: string; base: string }> }[] = [];
        await render_grid(stable_props(
            display_to_source,
            { sort: [], filters: [filter] },
            {
                on_transform_change,
                on_editing_change: (status) => { statuses.push(status as never); },
            },
        ));
        const rows_before = grid_mock.props!.rows;
        const before = displayed_column_0(display_to_source.length);
        expect(before).toEqual(['a', 'z', 'm']);

        const on_cell_edited = edit_one(grid_mock.props!.onCellsEdited);
        await act(async () => on_cell_edited([0, 0], { kind: 'text', data: 'q' }));
        await vi.waitUntil(() => statuses.some(
            (status) => status.edits['1:0']?.value === 'q',
        ));

        expect(statuses.at(-1)!.edits['1:0']!.value).toBe('q');
        // Still there, still where it was, showing the value that no longer matches.
        // It leaves the view on the next save + reload, not before.
        expect(grid_mock.props!.rows).toBe(rows_before);
        const after = displayed_column_0(display_to_source.length);
        expect(after).toEqual(['q', 'z', 'm']);
        expect(on_transform_change).not.toHaveBeenCalled();
        expect(posted_transforms()).toEqual([]);
    });

    // Multiline auto-grow used to be gated on a `transformed` prop, because the height it
    // wrote was keyed by the display row it measured and that named another source row
    // under a permutation. The write is now a display *interval* the host maps through
    // the permutation it installed, so the gate is gone — and so is the prop, since
    // nothing in the shell needed to know any more.
    //
    // Still asserted as a pair, over rules that describe a permutation and rules that do
    // not, because a permuted view is the one place transforms and edit mode coexist and
    // this row's rendered position is a permuted one in both runs. That the two runs now
    // differ only in the rule set — and grow the same row to the same height either way —
    // is the point: the shell has no notion of being permuted left to branch on.
    const MULTILINE = 'one\ntwo\nthree';
    const expected_grown_height = natural_row_height(
        MULTILINE,
        line_height_for_font(13),
        undefined,
        default_row_height_for_font(13),
    );

    async function commit_multiline(sorted: boolean, on_row_resize: () => void) {
        const display_to_source = [1, 3, 0, 2];
        install_permutation(display_to_source);
        await render_grid(stable_props(
            display_to_source,
            sorted
                ? { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] }
                : { sort: [], filters: [] },
            { on_row_resize },
        ));
        grid_mock.update_cells.mockClear();
        const on_cell_edited = edit_one(grid_mock.props!.onCellsEdited);
        await act(async () => on_cell_edited([0, 0], { kind: 'text', data: MULTILINE }));
    }

    it('grows the row for a multiline edit while transformed', async () => {
        const on_row_resize = vi.fn();
        await commit_multiline(true, on_row_resize);

        // The display row it was measured at, as a one-row interval. This site knows the
        // source row too (it resolved one to key the edit) and deliberately does not use
        // it: the host is the only display→source mapper.
        //
        // Exactly once, for the same reason as the forced-commit case below: one commit
        // must produce one durable host write, and `auto_grow_row_for_text` now has two
        // callers between which a double post is the plausible regression.
        expect(on_row_resize).toHaveBeenCalledExactlyOnceWith(
            [{ start: 0, end: 0 }],
            expected_grown_height,
        );
    });

    it('grows no row for a gesture the replay reservation refuses', async () => {
        // `run_edit_gesture` drops a batch that is not admitted, so nothing reaches
        // the store or the history. The row resize is a DURABLE host write and runs
        // per item on the way there, so without the same gate a refused paste
        // persisted a height for text the document never took.
        const on_row_resize = vi.fn();
        const display_to_source = [1, 3, 0, 2];
        install_permutation(display_to_source);
        await render_grid(stable_props(
            display_to_source,
            { sort: [], filters: [] },
            { on_row_resize, gestures_admitted: () => false },
        ));
        const on_cell_edited = edit_one(grid_mock.props!.onCellsEdited);
        await act(async () => on_cell_edited([0, 0], { kind: 'text', data: MULTILINE }));

        expect(on_row_resize).not.toHaveBeenCalled();
    });

    it('grows the row for a multiline edit when not transformed', async () => {
        const on_row_resize = vi.fn();
        await commit_multiline(false, on_row_resize);

        expect(on_row_resize).toHaveBeenCalledExactlyOnceWith(
            [{ start: 0, end: 0 }],
            expected_grown_height,
        );
    });

    /**
     * An open Glide overlay editor holding `value`, portalled where the shell reads it.
     *
     * A `textarea`, not an `input`, and that is not incidental: `HTMLInputElement.value`
     * strips newlines, so a single-line element cannot express the only value auto-grow
     * reacts to — the multiline case would silently arrive as `onetwothree` and the test
     * would pass against an implementation that never grew anything. Glide's overlay is a
     * textarea for a multiline editor anyway, and the shell's selector accepts both.
     */
    function open_overlay_editor(value: string): () => void {
        const clip = document.createElement('div');
        clip.className = 'gdg-clip-region';
        const editor = document.createElement('textarea');
        editor.value = value;
        clip.appendChild(editor);
        document.body.appendChild(clip);
        return () => clip.remove();
    }

    /**
     * Mount permuted with an editor open on display row 1 — not row 0, so a handler that
     * read a source row (3 here) or defaulted to the first row would name a visibly wrong
     * interval — then fold it the way App does.
     */
    async function fold_open_editor(value: string): Promise<ReturnType<typeof vi.fn>> {
        const display_to_source = [1, 3, 0, 2];
        const editing_ref = React.createRef<EditingHandle | null>();
        const on_row_resize = vi.fn();
        install_permutation(display_to_source);
        await render_grid(stable_props(
            display_to_source,
            { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
            { on_row_resize, editing_ref },
        ));
        await act(async () => {
            (grid_mock.props!.onGridSelectionChange as (selection: unknown) => void)({
                columns: {},
                rows: {},
                current: {
                    cell: [0, 1],
                    range: { x: 0, y: 1, width: 1, height: 1 },
                    rangeStack: [],
                },
            });
        });
        const close = open_overlay_editor(value);
        try {
            await act(async () => editing_ref.current?.commit_live_edit());
        } finally {
            close();
        }
        return on_row_resize;
    }

    it('grows the row when a forced commit folds an open multiline editor', async () => {
        // The commit path that is *not* Glide's. App folds an open editor through
        // `commit_live_edit` whenever something is about to remount or re-project the grid
        // — a transform completing, a column-visibility change — and that path wrote through
        // `commit_edit` directly, so it skipped auto-grow entirely: the text survived, the
        // row kept its old height, and it clipped what the user had just typed with nothing
        // to explain why. Newly reachable precisely because auto-grow stopped being gated
        // on an unpermuted view, which is what makes it this change's to fix.
        //
        // Whether the *host* keeps the height depends on why the fold happened, and that is
        // deliberately not the shell's business: a fold for a column-visibility change or an
        // install on another sheet is accepted (`mapping_generation` in `viewer-controller`),
        // one for an install on this sheet is refused like any other resize naming an
        // arrangement that has moved. The shell's job is to ask.
        const on_row_resize = await fold_open_editor(MULTILINE);

        // Exactly once, not merely at least once, and the exactness is the point of the
        // refactor this test guards: `auto_grow_row_for_text` is now reached from two
        // callers (`on_cell_edited` and this forced-commit path), so a fold that reached it
        // through both would post two `setRowHeights` — two durable host writes and two
        // deliveries for one keystroke — and the permissive matcher would have passed.
        expect(on_row_resize).toHaveBeenCalledExactlyOnceWith(
            [{ start: 1, end: 1 }],
            expected_grown_height,
        );
    });

    it('leaves the row alone when a forced commit folds a single-line editor', async () => {
        // The negative half, so the test above pins "grows for hard line breaks" rather
        // than "posts a resize on every fold" — which would cost a durable write and a
        // delivery on every column-visibility change made with an editor open.
        //
        // Held *jointly* by the two guards in `auto_grow_row_for_text`, and probing says so:
        // the newline test survives its own deletion because `natural_row_height` floors at
        // the default, so a one-line value measures exactly the default and the height
        // comparison refuses it; the comparison survives its deletion because the newline
        // test refuses it first. This fails only when both are gone. What is pinned is the
        // behaviour, therefore, not either line.
        const on_row_resize = await fold_open_editor('one line only');

        expect(on_row_resize).not.toHaveBeenCalled();
    });

    it('caps auto-grow at the ceiling and stops re-posting once it is reached', async () => {
        // `natural_row_height` is `lines * line_height + padding`, unbounded in the number
        // of hard newlines a cell holds — so this path, not a malformed message, is the
        // realistic way to reach an absurd height. It is also the path where an unclamped
        // height does more than persist a silly number: the comparison guarding this post
        // is against the *stored* height, which is clamped, so an unclamped `needed` stays
        // strictly greater forever and re-posts a resize on every single edit commit to
        // that row — each one a no-op the host now answers with a delivery.
        //
        // Both halves in one case because they are one behaviour: the value posted is the
        // ceiling, and a row already sitting at the ceiling posts nothing at all.
        const huge = 'x\n'.repeat(5_000);
        expect(natural_row_height(huge, line_height_for_font(13)))
            .toBeGreaterThan(MAX_ROW_HEIGHT_PX);
        const display_to_source = [1, 3, 0, 2];

        const from_default = vi.fn();
        install_permutation(display_to_source);
        await render_grid(stable_props(
            display_to_source,
            { sort: [], filters: [] },
            { on_row_resize: from_default },
        ));
        await act(async () => edit_one(grid_mock.props!.onCellsEdited)(
            [0, 0], { kind: 'text', data: huge }));

        expect(from_default).toHaveBeenCalledWith(
            [{ start: 0, end: 0 }],
            MAX_ROW_HEIGHT_PX,
        );

        const already_capped = vi.fn();
        install_permutation(display_to_source);
        await render_grid(stable_props(
            display_to_source,
            { sort: [], filters: [] },
            { on_row_resize: already_capped, row_heights: { 0: MAX_ROW_HEIGHT_PX } },
        ));
        await act(async () => edit_one(grid_mock.props!.onCellsEdited)(
            [0, 0], { kind: 'text', data: huge }));

        expect(already_capped).not.toHaveBeenCalled();
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
        act(() => on_resize_end(3, 52));
        expect(on_row_resize).toHaveBeenCalledOnce();
        // Coalesced into display-row intervals: 1 alone, then 3–4.
        expect(on_row_resize).toHaveBeenCalledWith(
            [{ start: 1, end: 1 }, { start: 3, end: 4 }],
            52,
        );
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
        expect(on_row_resize).toHaveBeenCalledWith([{ start: 2, end: 2 }], 48);
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
        // Ten thousand contiguous selected rows leave as one interval, not ten thousand
        // row numbers: the request that crosses to the host is the size of the gesture,
        // not of the selection.
        expect(on_row_resize.mock.calls[0][0]).toEqual([{ start: 0, end: 9_999 }]);
    });
});

describe('GridShell hyperlink dialog admission', () => {
    // Opening the dialog: Edit mode on a markdown sheet, right-click a cell,
    // click "Hyperlink…", then Save a valid target.
    async function open_dialog() {
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([0, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 0, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        const open = find_button((text) => text.startsWith('Hyperlink'));
        expect(open).toBeDefined();
        await act(async () => open!.click());
    }

    async function save_link() {
        await act(async () => set_input_value(
            field('hyperlink-target') as HTMLInputElement,
            'https://link.test/',
        ));
        await act(async () => button('Save').click());
    }

    const link_props = (editing_ref: React.RefObject<EditingHandle | null>) => props({
        edit_mode: true,
        csv_editable: true,
        edit_syntax: 'markdown',
        editing_ref,
        edit_session_id: 'session-1',
    });

    it('commits a hyperlink while edits are still admitted', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        await render_grid(link_props(editing_ref));
        await open_dialog();
        await save_link();
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);
    });

    it('refuses a hyperlink once the close barrier is raised', async () => {
        // The barrier goes up while the dialog is already open — the one
        // ordering the menu gate cannot catch. Past it `post_pending_edits`
        // refuses to publish, so a link accepted here would sit in the store
        // and never reach the host: a silently dropped edit rather than a
        // refused one. Every other mutation path refuses at the same gate.
        const editing_ref = React.createRef<EditingHandle | null>();
        await render_grid(link_props(editing_ref));
        await open_dialog();
        await act(async () => editing_ref.current!.stop_edit_admission());
        await save_link();
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(false);
    });
});

describe('GridShell history capture', () => {
    function capture_props(history_store: HistoryStore, overrides: Partial<GridShellProps> = {}) {
        return props({
            sheet_meta: {
                ...props().sheet_meta,
                name: 'Sheet1',
                worksheetId: 'rId1',
                rowCount: 3,
                sourceRowCount: 3,
            },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session-1',
            history_store,
            ...overrides,
        });
    }

    function cells_edited(
        items: readonly { location: [number, number]; value: string }[],
        source: string,
    ) {
        const handler = grid_mock.props!.onCellsEdited as (
            batch: readonly { location: [number, number]; value: { kind: string; data: string } }[],
            gesture: string,
        ) => boolean;
        return handler(
            items.map(({ location, value }) => ({
                location,
                value: { kind: 'text', data: value },
            })),
            source,
        );
    }

    it('offers paste and the fill handle only while cells are editable', async () => {
        const history = create_history_store();
        await render_grid(capture_props(history));
        // A bare `true`, not a vetting callback: every refusal paste needs is
        // already made per cell (see the prop's comment in grid-shell).
        expect(grid_mock.props!.onPaste).toBe(true);
        expect(grid_mock.props!.fillHandle).toBe(true);

        await render_grid(capture_props(history, { edit_mode: false }));
        expect(grid_mock.props!.onPaste).toBe(false);
        expect(grid_mock.props!.fillHandle).toBe(false);

        await render_grid(capture_props(history, { csv_editable: false }));
        expect(grid_mock.props!.onPaste).toBe(false);
        expect(grid_mock.props!.fillHandle).toBe(false);
    });

    it('records a multi-cell paste as one action, named for the gesture', async () => {
        const history = create_history_store();
        await render_grid(capture_props(history));

        await act(async () => {
            cells_edited([
                { location: [0, 0], value: 'x' },
                { location: [0, 1], value: 'y' },
            ], 'paste');
        });

        const stack = history.snapshot().undoStack;
        expect(stack).toHaveLength(1);
        expect(stack[0].action.label).toBe('Paste');
        expect(stack[0].action.changes).toHaveLength(2);
    });

    it('names a gesture from what the user did, not from what the cells became', async () => {
        const history = create_history_store();
        await render_grid(capture_props(history));

        await act(async () => {
            cells_edited([
                { location: [0, 0], value: '' },
                { location: [0, 1], value: '' },
            ], 'delete');
        });
        await act(async () => { cells_edited([{ location: [0, 2], value: '' }], 'delete'); });
        await act(async () => { cells_edited([{ location: [1, 0], value: 'z' }], 'fill'); });

        expect(history.snapshot().undoStack.map((entry) => entry.action.label))
            .toEqual(['Clear cells', 'Clear cell', 'Fill']);
    });

    it('claims the batch, so Glide does not replay it per cell', async () => {
        const history = create_history_store();
        await render_grid(capture_props(history));
        let claimed: boolean | undefined;
        await act(async () => {
            claimed = cells_edited([{ location: [0, 0], value: 'x' }], 'edit');
        });
        expect(claimed).toBe(true);
    });

    it('records the full worksheet identity, not just the index', async () => {
        const history = create_history_store();
        await render_grid(capture_props(history, { sheet_index: 2 }));

        await act(async () => { cells_edited([{ location: [0, 0], value: 'x' }], 'edit'); });

        const change = history.snapshot().undoStack[0].action.changes[0];
        if (change.kind !== 'cell') throw new Error('expected a cell change');
        // A bare index cannot survive a sheet reorder between the edit and the
        // undo, which is a real possibility for a workbook-wide history.
        expect(change.delta.worksheet).toEqual({
            sheetIndex: 2, sheetName: 'Sheet1', worksheetId: 'rId1',
        });
    });

    it('records nothing once the close barrier is raised', async () => {
        const history = create_history_store();
        const editing_ref = React.createRef<EditingHandle | null>();
        await render_grid(capture_props(history, { editing_ref }));
        await act(async () => editing_ref.current!.stop_edit_admission());

        await act(async () => { cells_edited([{ location: [0, 0], value: 'x' }], 'edit'); });

        expect(history.snapshot().undoStack).toEqual([]);
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(false);
    });

    it('records only the cells whose rows resolve', async () => {
        const history = create_history_store();
        // Display row 1's source identity is unresolved (its page has not landed).
        grid_mock.source_row_for_display = (display_row: number) => (
            display_row === 1 ? undefined : display_row
        );
        await render_grid(capture_props(history));

        await act(async () => {
            cells_edited([
                { location: [0, 0], value: 'x' },
                { location: [0, 1], value: 'y' },
            ], 'paste');
        });

        const stack = history.snapshot().undoStack;
        expect(stack[0].action.changes).toHaveLength(1);
    });
});

describe('the cursor and flash an undo leaves behind', () => {
    /** The whole visible viewport, so damage is not clipped away to nothing. */
    async function report_visible(range: { x: number; y: number; width: number; height: number }) {
        const on_visible_region_changed = grid_mock.props!.onVisibleRegionChanged as
            (r: { x: number; y: number; width: number; height: number }) => void;
        await act(async () => on_visible_region_changed(range));
    }

    function cell_background(cell: [number, number]): string | undefined {
        const get_cell_content = grid_mock.props!.getCellContent as
            (item: [number, number]) => { themeOverride?: { bgCell?: string } };
        return get_cell_content(cell).themeOverride?.bgCell;
    }

    function focus_props(overrides: Partial<GridShellProps> = {}): GridShellProps {
        return props({
            row_count: 40,
            // Identity projection, so the source-column interval a request carries
            // reads directly as display columns and the assertions stay about rows.
            column_projection: {
                visible_to_source: [0, 1, 2],
                source_to_visible: [0, 1, 2],
                hidden_count: 0,
            },
            mapping_generation: 3,
            ...overrides,
        });
    }

    const request = {
        sequence: 1,
        // The grid does not read this — it is App that turns it into wording — but
        // the request type carries it, so the fixture does too.
        direction: 'undo' as const,
        sheetIndex: 0,
        displayRowStart: 4,
        displayRowEnd: 5,
        sourceColumnStart: 1,
        sourceColumnEnd: 2,
        mappingGeneration: 3,
    };

    it('selects the replayed region, scrolls to it, and tints it', async () => {
        vi.useFakeTimers();
        try {
            const on_applied = vi.fn();
            const GridShell = await render_grid(focus_props());
            await report_visible({ x: 0, y: 0, width: 3, height: 20 });
            grid_mock.update_cells.mockClear();

            await act(async () => {
                root!.render(React.createElement(GridShell, focus_props({
                    history_focus: request,
                    on_history_focus_applied: on_applied,
                })));
            });

            const selection = grid_mock.props!.gridSelection as {
                current?: { cell: [number, number]; range: { x: number; y: number; width: number; height: number } };
            };
            expect(selection.current?.cell).toEqual([1, 4]);
            expect(selection.current?.range).toEqual({ x: 1, y: 4, width: 2, height: 2 });
            expect(grid_mock.scroll_to).toHaveBeenCalledWith(
                1,
                4,
                'both',
                0,
                0,
                { hAlign: 'start-if-oversized' },
            );
            expect(on_applied).toHaveBeenCalledWith(1, expect.objectContaining({ kind: 'applied' }));

            // Every cell of the region, and only those: the flash outranks whatever
            // persistent tint the cells carry, and a cell outside it is untouched.
            expect(cell_background([1, 4])).toBe(history_flash_rgba(false));
            expect(cell_background([2, 5])).toBe(history_flash_rgba(false));
            expect(cell_background([0, 4])).toBeUndefined();
            expect(cell_background([1, 6])).toBeUndefined();
            expect(grid_mock.update_cells.mock.calls.at(-1)![0]).toEqual([
                { cell: [1, 4] }, { cell: [1, 5] }, { cell: [2, 4] }, { cell: [2, 5] },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops tinting at the deadline, without waiting for one in the test', async () => {
        // The timer is the production mechanism; the assertion advances a fake
        // clock. A real delay here would be a CI flake already written.
        vi.useFakeTimers();
        try {
            const GridShell = await render_grid(focus_props());
            await report_visible({ x: 0, y: 0, width: 3, height: 20 });
            await act(async () => {
                root!.render(React.createElement(GridShell, focus_props({
                    history_focus: request,
                })));
            });
            expect(cell_background([1, 4])).toBe(history_flash_rgba(false));

            await act(async () => { vi.advanceTimersByTime(HISTORY_FLASH_DURATION_MS - 1); });
            expect(cell_background([1, 4])).toBe(history_flash_rgba(false));

            grid_mock.update_cells.mockClear();
            await act(async () => { vi.advanceTimersByTime(1); });
            expect(cell_background([1, 4])).toBeUndefined();
            // The same cells damaged again, so the persistent tint underneath comes
            // back rather than waiting for an unrelated repaint.
            expect(grid_mock.update_cells.mock.calls.at(-1)![0]).toEqual([
                { cell: [1, 4] }, { cell: [1, 5] }, { cell: [2, 4] }, { cell: [2, 5] },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('applies one request once, however often it rerenders', async () => {
        vi.useFakeTimers();
        try {
            const on_applied = vi.fn();
            const GridShell = await render_grid(focus_props());
            await report_visible({ x: 0, y: 0, width: 3, height: 20 });
            const with_focus = () => React.createElement(GridShell, focus_props({
                history_focus: request,
                on_history_focus_applied: on_applied,
            }));
            await act(async () => { root!.render(with_focus()); });
            grid_mock.scroll_to.mockClear();
            await act(async () => { root!.render(with_focus()); });

            expect(on_applied).toHaveBeenCalledTimes(1);
            expect(grid_mock.scroll_to).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('lets a newer replay supersede an older flash, including its deadline', async () => {
        vi.useFakeTimers();
        try {
            const GridShell = await render_grid(focus_props());
            await report_visible({ x: 0, y: 0, width: 3, height: 20 });
            await act(async () => {
                root!.render(React.createElement(GridShell, focus_props({
                    history_focus: request,
                })));
            });
            await act(async () => { vi.advanceTimersByTime(HISTORY_FLASH_DURATION_MS - 50); });
            await act(async () => {
                root!.render(React.createElement(GridShell, focus_props({
                    history_focus: {
                        ...request,
                        sequence: 2,
                        displayRowStart: 9,
                        displayRowEnd: 9,
                    },
                })));
            });

            // The first flash's timer is about to fire. It must not clear the
            // second flash, which has only just begun.
            await act(async () => { vi.advanceTimersByTime(50); });
            expect(cell_background([1, 9])).toBe(history_flash_rgba(false));
            expect(cell_background([1, 4])).toBeUndefined();

            await act(async () => { vi.advanceTimersByTime(HISTORY_FLASH_DURATION_MS); });
            expect(cell_background([1, 9])).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('outranks the persistent tint a flashed cell already carries', async () => {
        // The common case, not an edge one: undoing a cell edit leaves the cell
        // dirty or highlighted, and a flash that lost to those tints would never
        // be visible on the region it exists to point at.
        vi.useFakeTimers();
        try {
            const GridShell = await render_grid(focus_props());
            await report_visible({ x: 0, y: 0, width: 3, height: 20 });
            const highlighted = focus_props({
                cell_highlights: { schema: 'accepted', cells: { '4:1': 'yellow' } },
            });
            await act(async () => { root!.render(React.createElement(GridShell, highlighted)); });
            const persistent = cell_background([1, 4]);
            expect(persistent).toBe(highlight_rgba('yellow', false));

            await act(async () => {
                root!.render(React.createElement(GridShell, focus_props({
                    cell_highlights: { schema: 'accepted', cells: { '4:1': 'yellow' } },
                    history_focus: request,
                })));
            });
            expect(cell_background([1, 4])).toBe(history_flash_rgba(false));

            // And the highlight is not lost — it is underneath, and comes back.
            await act(async () => { vi.advanceTimersByTime(HISTORY_FLASH_DURATION_MS); });
            expect(cell_background([1, 4])).toBe(persistent);
        } finally {
            vi.useRealTimers();
        }
    });

    it('moves nothing when every affected column is hidden', async () => {
        const on_applied = vi.fn();
        const GridShell = await render_grid(focus_props());
        await report_visible({ x: 0, y: 0, width: 3, height: 20 });
        grid_mock.scroll_to.mockClear();

        await act(async () => {
            root!.render(React.createElement(GridShell, focus_props({
                // Only source column 0 is visible; the request names 1-2.
                column_projection: {
                    visible_to_source: [0],
                    source_to_visible: [0, undefined, undefined],
                    hidden_count: 2,
                },
                history_focus: request,
                on_history_focus_applied: on_applied,
            })));
        });

        expect(on_applied).toHaveBeenCalledWith(1, { kind: 'columns-hidden' });
        expect(grid_mock.scroll_to).not.toHaveBeenCalled();
        expect(cell_background([0, 4])).toBeUndefined();
    });

    it('declines a focus resolved against a mapping that has since moved', async () => {
        const on_applied = vi.fn();
        const GridShell = await render_grid(focus_props());
        await report_visible({ x: 0, y: 0, width: 3, height: 20 });
        grid_mock.scroll_to.mockClear();

        await act(async () => {
            root!.render(React.createElement(GridShell, focus_props({
                mapping_generation: 4,
                history_focus: request,
                on_history_focus_applied: on_applied,
            })));
        });

        expect(on_applied).toHaveBeenCalledWith(1, { kind: 'stale-mapping' });
        expect(grid_mock.scroll_to).not.toHaveBeenCalled();
    });

    it('cancels a pending flash timer when the grid goes away', async () => {
        // A cross-sheet undo unmounts this grid while its flash is still running.
        // A timer left armed would fire against a disposed grid.
        vi.useFakeTimers();
        try {
            await render_grid(focus_props());
            await report_visible({ x: 0, y: 0, width: 3, height: 20 });
            const GridShell = await render_grid(focus_props({ history_focus: request }));
            void GridShell;
            grid_mock.update_cells.mockClear();

            const armed = vi.getTimerCount();
            expect(armed).toBeGreaterThan(0);

            await act(async () => { root!.unmount(); });
            root = null;

            // Asserted on the timer, not on a repaint: `grid_ref.current` is null
            // after unmount, so a leaked timer firing would be silent here — and
            // still a leak. Cancelling it is what the cleanup is for.
            expect(vi.getTimerCount()).toBeLessThan(armed);
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves a request for another sheet unanswered, mid-switch', async () => {
        // App switches sheets first and this grid unmounts; answering here would
        // clear the request before the grid that can honour it ever mounts.
        const on_applied = vi.fn();
        const GridShell = await render_grid(focus_props());
        await report_visible({ x: 0, y: 0, width: 3, height: 20 });

        await act(async () => {
            root!.render(React.createElement(GridShell, focus_props({
                history_focus: { ...request, sheetIndex: 1 },
                on_history_focus_applied: on_applied,
            })));
        });

        expect(on_applied).not.toHaveBeenCalled();
    });
});
