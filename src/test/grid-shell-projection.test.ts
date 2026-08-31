// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type {
    AppendRowsAdmission,
    EditingHandle,
    GridFocusHandle,
    HighlightSelectionHandle,
    GridShellProps,
} from '../webview/grid-shell';
import { matches_filter } from '../table-transform';
import type { CsvSaveOperation, FilterEntry, SheetTransformState } from '../types';
import { CsvDataSource } from '../data-source/csv-source';
import {
    create_edit_session_store,
    type DirtyEntry,
} from '../webview/edit-session-store';
import { create_history_store, type HistoryStore } from '../webview/history-store';
import { create_pending_row_store } from '../webview/pending-row-store';
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
        toRanges: () => readonly [number, number][];
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
            toRanges: () => {
                const ranges: [number, number][] = [];
                for (const value of sorted) {
                    const last = ranges.at(-1);
                    if (last !== undefined && last[1] === value) last[1] = value + 1;
                    else ranges.push([value, value + 1]);
                }
                return ranges;
            },
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
    // Git compare sidecar state, keyed by display row (status) and
    // `row:col` (per-cell base text). Empty = everything unchanged.
    compare_status: {} as Record<number, 'added' | 'deleted' | 'moved' | undefined>,
    compare_base: {} as Record<string, string | undefined>,
    // Display row → canonical source row; null means identity, which is what a
    // CSV with no transform installed reports. Overridable so a test can make the
    // two row spaces diverge — the only condition under which an assertion about
    // durable edit-key row space is non-vacuous.
    source_row_for_display: null as null | ((display_row: number) => number | undefined),
    ensure_rows: vi.fn(),
    ensure_rows_loaded: vi.fn(async (_start?: number, _end?: number) => true),
    trim_rows: vi.fn(),
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
        GridCellKind: { Text: 'text', Custom: 'custom' },
        direction: () => 'ltr',
    };
});

// Lowest display row claiming `source_row`, or undefined if none does. Scanning a
// bounded display window stands in for the loader's source→page index; the harness
// only ever renders a handful of rows.
const SCANNED_DISPLAY_ROWS = vi.hoisted(() => 64);
const additionally_loaded_source_rows = vi.hoisted(() => new Map<number, number>());
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
            trim_rows: grid_mock.trim_rows,
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
                additionally_loaded_source_rows.has(source_row)
                || resident_display_row(source_row) !== undefined
            ),
            get_display_row_for_source: (source_row: number) => (
                additionally_loaded_source_rows.has(source_row)
                    ? additionally_loaded_source_rows.get(source_row)
                    : resident_display_row(source_row)
            ),
            get_compare_status: (row: number) => grid_mock.compare_status[row],
            get_compare_base: (row: number, col: number) =>
                grid_mock.compare_base[`${row}:${col}`],
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
        diffDeletedFg: '#c74e39',
        diffAddedFg: '#81b88b',
        diffMovedFg: '#9333ea',
    }),
    theme_font_size_px: () => 13,
    // Echoes the color rather than the fallback, which is what the real one
    // does for any parseable color. Returning the fallback unconditionally
    // made every band that shares a fallback look identical here.
    tint_from_color: (color: string, alpha: number, fallback: string) =>
        (color ? `${color}@${alpha}` : fallback),
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
        source_generation: 1,
        show_formatting: false,
        edit_activation_id: 0,
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
    additionally_loaded_source_rows.clear();
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
    grid_mock.trim_rows.mockReset();
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
    grid_mock.compare_status = {};
    grid_mock.compare_base = {};
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'clipboard');
    vi.useRealTimers();
});

describe('GridShell cell wrapping', () => {
    it('shows physical Excel row numbers after header promotion and row reordering', async () => {
        grid_mock.source_row_for_display = (display_row: number) => [8, 1, 4][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 100_001,
                excelFirstRowHeader: {
                    mode: 'on',
                    detected: false,
                    active: true,
                    available: true,
                    sourceRow: 0,
                },
            },
            row_count: 3,
        }));

        const row_markers = grid_mock.props!.rowMarkers as {
            kind: string;
            width: number;
            getRowNumber(row: number): number;
        };
        expect(row_markers.kind).toBe('clickable-number');
        expect(row_markers.width).toBe(48);
        expect([0, 1, 2].map(row_markers.getRowNumber)).toEqual([9, 2, 5]);
    });

    it('uses projection-aware physical row markers for non-Excel sources', async () => {
        grid_mock.source_row_for_display = (display_row: number) => [6, 2, 9][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 10,
            },
            row_count: 3,
        }));

        const row_markers = grid_mock.props!.rowMarkers as {
            kind: string;
            getRowNumber(row: number): number;
        };
        expect(row_markers.kind).toBe('clickable-number');
        expect([0, 1, 2].map(row_markers.getRowNumber)).toEqual([7, 3, 10]);
    });

    it('renders pending XLSX rows with inherited font style and row height', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        const template = {
            id: 'xlsx-template',
            format: {
                kind: 'xlsx' as const,
                templateSourceRow: 0,
                styleFingerprint: 'style-fingerprint',
                cellStyleIndexes: [1, 0, 0],
                cellFontStyles: [
                    { bold: true, italic: true },
                    { bold: false, italic: false },
                    { bold: false, italic: false },
                ],
                viewerRowHeight: 60,
            },
        };
        pending.append_rows('session', ['pending-row-1'], template, 1);
        pending.set_cell('session', 'pending-row-1', 0, { value: 'Styled' });
        await render_grid(props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
        }));

        const cell = (grid_mock.props!.getCellContent as (
            location: [number, number],
        ) => { displayData: string; themeOverride?: { baseFontStyle?: string } })([0, 1]);
        expect(cell.displayData).toBe('Styled');
        expect(cell.themeOverride?.baseFontStyle).toContain('italic');
        expect(cell.themeOverride?.baseFontStyle).toContain('600');
        expect((grid_mock.props!.rowHeight as (row: number) => number)(1)).toBe(60);
    });

    it('uses the retargeted pending formula for editing and clipboard metadata', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.append_rows('session', ['pending-row-1'], {
            id: 'xlsx-template',
            format: {
                kind: 'xlsx',
                templateSourceRow: 0,
                styleFingerprint: 'style-fingerprint',
                cellStyleIndexes: [null, null, null],
            },
        }, 1);
        pending.set_cell('session', 'pending-row-1', 0, {
            value: '=A1',
            valueEditOrder: 7,
        });
        const retarget = vi.fn((_formula: string, _sheet: number, order?: number) => (
            order === 7 ? '=B1' : '=A1'
        ));
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            edit_session_id: 'session',
            pending_row_store: pending,
            formula_move_retargeter: retarget,
        }));

        const cell = (grid_mock.props!.getCellContent as (
            location: [number, number],
        ) => {
            data?: { edit_value?: string };
            clipboardData?: { formula?: string };
        })([0, 1]);
        expect(cell.data?.edit_value).toBe('=B1');
        expect(cell.clipboardData?.formula).toBe('=B1');
        expect(retarget).toHaveBeenCalledWith('=A1', 0, 7);
    });

    it('preserves pending cut provenance when its destination is edited', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.append_rows('session', ['pending-row-1'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        const movedFrom = {
            row: 0,
            col: 0,
            order: 4,
            rowIdentity: { kind: 'source' as const, sourceRow: 0 },
        };
        pending.set_cell('session', 'pending-row-1', 0, { value: 'moved', movedFrom });
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
        }));

        await act(async () => edit_one(grid_mock.props!.onCellsEdited)(
            [0, 1],
            { kind: 'text', data: 'retyped' },
        ));
        expect(pending.snapshot().appendedRows[0].cells[0]).toMatchObject({
            value: 'retyped',
            movedFrom,
        });
    });

    it('discards a source-to-pending cut and its formula conflict atomically', async () => {
        const cells = create_edit_session_store({ session_id: 'session' }, {
            '0:0': { value: '', base: 'source-a', valueEditOrder: 4 },
        });
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.install({ session_id: 'session' }, {
            formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
            appendedRows: [{
                id: 'pending-row-1',
                formatTemplateId: 'plain',
                createdOrder: 1,
                cells: { 0: { value: '=A1', movedFrom: {
                    row: 0,
                    col: 0,
                    order: 4,
                    rowIdentity: { kind: 'source', sourceRow: 0 },
                } } },
            }],
            tailRemovals: [],
            conflicts: [{
                reason: 'ambiguousPendingFormula',
                pendingRowIds: ['pending-row-1'],
                tailRemovalIds: [],
                formulaCells: [{
                    rowIdentity: { kind: 'pending', pendingRowId: 'pending-row-1' },
                    sourceColumn: 0,
                }],
            }],
        });
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            edit_session: cells,
            pending_row_store: pending,
        }));
        const on_context = grid_mock.props!.onCellContextMenu as (
            cell: [number, number], event: Record<string, unknown>,
        ) => void;
        await act(async () => on_context([0, 1], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 24, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        const discard = find_button((text) =>
            text === 'Discard all pending edits in 2 related cells');
        expect(discard).toBeDefined();
        await act(async () => discard!.click());

        expect(cells.snapshot()).toEqual(new Map());
        expect(pending.snapshot().appendedRows[0].cells).toEqual({});
        expect(pending.snapshot().conflicts).toEqual([]);
    });

    it('loads and sizes source rows through a compressed tail-removal gap', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.install({ session_id: 'session' }, {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [{
                appendHistoryId: 'saved-tail',
                sourceRow: 4,
                savedFingerprint: 'fingerprint',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }],
            conflicts: [],
        });
        // The physical suffix row is currently sorted into raw display row 1.
        grid_mock.source_row_for_display = (display_row: number) => [0, 4, 1, 2, 3][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 5,
                sourceRowCount: 5,
            },
            row_count: 5,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
            row_heights: { 2: 48 },
        }));

        grid_mock.ensure_rows.mockClear();
        const on_visible = grid_mock.props!.onVisibleRegionChanged as (
            range: { x: number; y: number; width: number; height: number },
        ) => void;
        act(() => on_visible({ x: 0, y: 1, width: 2, height: 2 }));
        // Compressed rows 1–2 are raw source-display rows 2–3, not 1–2.
        expect(grid_mock.ensure_rows).toHaveBeenCalledWith(2, 3);
        const row_height = grid_mock.props!.rowHeight as (row: number) => number;
        expect(row_height(1)).toBe(48);
    });

    it('changes the paste topology when a transformed tail removal resolves', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.append_rows('session', ['pending-a'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        pending.replace_tail_removals('session', [{
            appendHistoryId: 'saved-tail',
            sourceRow: 0,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }]);
        grid_mock.source_row_for_display = () => undefined;
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            mapping_generation: 7,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows',
        ));
        const request = grid_mock.post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'requestSourceDisplayRows');
        const before = grid_mock.props!.pasteTopologyKey;
        expect(grid_mock.props!.rows).toBe(2);

        await act(async () => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'sourceDisplayRows',
            requestId: request.requestId,
            sheetIndex: 0,
            generation: 1,
            mappingGeneration: 7,
            sourceRows: [0],
            displayRows: [0],
        } })));
        await vi.waitUntil(() => grid_mock.props!.pasteTopologyKey !== before);

        expect(grid_mock.props!.rows).toBe(1);
    });

    it('changes the paste topology when natural-order pending rows are removed', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.append_rows('session', ['pending-a', 'pending-b'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
        }));
        const before = grid_mock.props!.pasteTopologyKey;

        act(() => {
            pending.remove_rows('session', new Set(['pending-a']));
        });
        await vi.waitUntil(() => grid_mock.props!.pasteTopologyKey !== before);

        expect(grid_mock.props!.rows).toBe(2);
    });

    it('keeps the selected pending-row identity when replay inserts before it', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.append_rows('session', ['pending-a', 'pending-b', 'pending-c'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        const before_removal = pending.snapshot();
        pending.remove_rows('session', new Set(['pending-b']));
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([]),
            current: {
                cell: [0, 2],
                range: { x: 0, y: 2, width: 1, height: 1 },
                rangeStack: [],
            },
        }));

        await act(async () => {
            expect(pending.install({ session_id: 'session' }, before_removal)).toBe(true);
        });

        expect((grid_mock.props!.gridSelection as {
            current?: { cell: [number, number] };
        }).current?.cell).toEqual([0, 3]);
    });

    it('clears a selected final append when replay removes its identity', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.append_rows('session', ['pending-final'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([]),
            current: {
                cell: [0, 1],
                range: { x: 0, y: 1, width: 1, height: 1 },
                rangeStack: [],
            },
        }));

        await act(async () => {
            expect(pending.install({ session_id: 'session' }, {
                formatTemplates: [],
                appendedRows: [],
                tailRemovals: [],
                conflicts: [],
            })).toBe(true);
        });

        expect((grid_mock.props!.gridSelection as { current?: unknown }).current)
            .toBeUndefined();
    });

    it('keeps an active interior pending row inside the range when the endpoint is removed', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.append_rows('session', ['pending-a', 'pending-b', 'pending-c'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([]),
            current: {
                cell: [0, 2],
                range: { x: 0, y: 1, width: 1, height: 3 },
                rangeStack: [],
            },
        }));
        const before = pending.snapshot();

        await act(async () => {
            expect(pending.install({ session_id: 'session' }, {
                ...before,
                appendedRows: before.appendedRows.slice(0, 2),
            })).toBe(true);
        });

        expect((grid_mock.props!.gridSelection as {
            current?: { cell: [number, number]; range: unknown };
        }).current).toEqual({
            cell: [0, 2],
            range: { x: 0, y: 1, width: 1, height: 2 },
            rangeStack: [],
        });
    });

    it('keeps surviving row-marker identities when the selected endpoint is removed', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.append_rows('session', ['pending-a', 'pending-b', 'pending-c'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([1, 2, 3]),
        }));
        const before = pending.snapshot();

        await act(async () => {
            expect(pending.install({ session_id: 'session' }, {
                ...before,
                appendedRows: before.appendedRows.slice(0, 2),
            })).toBe(true);
        });

        expect((grid_mock.props!.gridSelection as {
            rows: { toArray(): number[] };
        }).rows.toArray()).toEqual([1, 2]);
    });

    it('keeps an interior sorted source row when it moves into the deletion band', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        // Source 2 starts between the selected endpoints in display order even
        // though it is the physical suffix row that the replay removes.
        grid_mock.source_row_for_display = (display_row) => [0, 2, 1][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 3,
            },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([0, 1, 2]),
            current: {
                cell: [0, 0],
                range: { x: 0, y: 0, width: 1, height: 3 },
                rangeStack: [],
            },
        }));

        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-tail',
                sourceRow: 2,
                savedFingerprint: 'fingerprint',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });

        const selection = grid_mock.props!.gridSelection as {
            rows: { toArray(): number[] };
            current?: { range: unknown };
        };
        expect(selection.rows.toArray()).toEqual([0, 1, 2]);
        expect(selection.current?.range).toEqual({ x: 0, y: 0, width: 1, height: 3 });
    });

    it('keeps both selections when a deletion row coalesces into a replacement', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        expect(pending.replace_tail_removals('session', [{
            appendHistoryId: 'saved-tail',
            sourceRow: 2,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }])).toBe(true);
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 3,
            },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([2]),
            current: {
                cell: [0, 2],
                range: { x: 0, y: 2, width: 1, height: 1 },
                rangeStack: [],
            },
        }));

        await act(async () => {
            expect(pending.append_rows('session', ['pending-a'], {
                id: 'plain', format: { kind: 'none' },
            }, 1)).toBe(true);
        });

        const selection = grid_mock.props!.gridSelection as {
            rows: { toArray(): number[] };
            current?: { cell: [number, number]; range: unknown };
        };
        expect(selection.rows.toArray()).toEqual([2]);
        expect(selection.current).toEqual({
            cell: [0, 2],
            range: { x: 0, y: 2, width: 1, height: 1 },
            rangeStack: [],
        });
    });

    it('keeps a nonresident sorted tail row when its inverse lookup resolves', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        // The selected endpoints are resident, but source 2's interior display
        // position is known only to the host until the inverse response lands.
        grid_mock.source_row_for_display = (display_row) => [0, undefined, 1][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 3,
            },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            mapping_generation: 7,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([0, 1, 2]),
            current: {
                cell: [0, 0],
                range: { x: 0, y: 0, width: 1, height: 3 },
                rangeStack: [],
            },
        }));
        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-tail',
                sourceRow: 2,
                savedFingerprint: 'fingerprint',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows',
        ));
        const request = grid_mock.post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'requestSourceDisplayRows');

        await act(async () => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'sourceDisplayRows',
            requestId: request.requestId,
            sheetIndex: 0,
            generation: 1,
            mappingGeneration: 7,
            sourceRows: [2],
            displayRows: [1],
        } })));
        await vi.waitUntil(() => grid_mock.props!.rows === 3);

        const selection = grid_mock.props!.gridSelection as {
            rows: { toArray(): number[] };
            current?: { range: unknown };
        };
        expect(selection.rows.toArray()).toEqual([0, 1, 2]);
        expect(selection.current?.range).toEqual({ x: 0, y: 0, width: 1, height: 3 });
    });

    it('keeps a nonresident tail row selected when it moves from an endpoint', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        grid_mock.source_row_for_display = (display_row) => [0, undefined, 1][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 3,
            },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            mapping_generation: 7,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([1]),
            current: {
                cell: [0, 1],
                range: { x: 0, y: 1, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-endpoint',
                sourceRow: 2,
                savedFingerprint: 'fingerprint',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows',
        ));
        const request = grid_mock.post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'requestSourceDisplayRows');

        await act(async () => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'sourceDisplayRows',
            requestId: request.requestId,
            sheetIndex: 0,
            generation: 1,
            mappingGeneration: 7,
            sourceRows: [2],
            displayRows: [1],
        } })));
        await vi.waitUntil(() => grid_mock.props!.rows === 3);

        const selection = grid_mock.props!.gridSelection as {
            rows: { toArray(): number[] };
            current?: { cell: [number, number]; range: unknown };
        };
        expect(selection.rows.toArray()).toEqual([2]);
        expect(selection.current).toEqual({
            cell: [0, 2],
            range: { x: 0, y: 2, width: 1, height: 1 },
            rangeStack: [],
        });
    });

    it('keeps a range ending at a nonresident tail row after inverse lookup', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        grid_mock.source_row_for_display = (display_row) => [0, undefined, 1][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 3,
            },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            mapping_generation: 7,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([0, 1]),
            current: {
                cell: [0, 0],
                range: { x: 0, y: 0, width: 1, height: 2 },
                rangeStack: [],
            },
        }));
        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-range-end',
                sourceRow: 2,
                savedFingerprint: 'fingerprint',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows',
        ));
        const request = grid_mock.post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'requestSourceDisplayRows');

        await act(async () => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'sourceDisplayRows',
            requestId: request.requestId,
            sheetIndex: 0,
            generation: 1,
            mappingGeneration: 7,
            sourceRows: [2],
            displayRows: [1],
        } })));
        await vi.waitUntil(() => grid_mock.props!.rows === 3);

        const selection = grid_mock.props!.gridSelection as {
            rows: { toArray(): number[] };
            current?: { range: unknown };
        };
        expect(selection.rows.toArray()).toEqual([0, 1, 2]);
        expect(selection.current?.range).toEqual({ x: 0, y: 0, width: 1, height: 3 });
    });

    it('does not overwrite Tab navigation when a delayed inverse arrives', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        grid_mock.source_row_for_display = (display_row) => [0, undefined, 1][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 3,
            },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            mapping_generation: 7,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([]),
            current: {
                cell: [0, 0],
                range: { x: 0, y: 0, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-delayed-tab',
                sourceRow: 2,
                savedFingerprint: 'fingerprint',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows',
        ));
        const request = grid_mock.post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'requestSourceDisplayRows');
        const on_key_down = grid_mock.props!.onKeyDown as
            (args: Record<string, unknown>) => void;
        await act(async () => on_key_down({
            key: 'Tab',
            altKey: false,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
            rawEvent: { code: 'Tab', target: document.createElement('canvas') },
            cancel: vi.fn(),
            preventDefault: vi.fn(),
        }));
        expect((grid_mock.props!.gridSelection as any).current.cell).toEqual([1, 0]);

        await act(async () => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'sourceDisplayRows',
            requestId: request.requestId,
            sheetIndex: 0,
            generation: 1,
            mappingGeneration: 7,
            sourceRows: [2],
            displayRows: [1],
        } })));
        await vi.waitUntil(() => grid_mock.props!.rows === 3);
        expect((grid_mock.props!.gridSelection as any).current.cell).toEqual([1, 0]);
    });

    it('keeps the earliest selection through sequential unresolved removals', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        grid_mock.source_row_for_display = (display_row) =>
            [0, undefined, undefined, 1][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 4,
                sourceRowCount: 4,
            },
            row_count: 4,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            mapping_generation: 7,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([1]),
            current: {
                cell: [0, 1],
                range: { x: 0, y: 1, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-later-tail',
                sourceRow: 3,
                savedFingerprint: 'fingerprint-3',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-earlier-tail',
                sourceRow: 2,
                savedFingerprint: 'fingerprint-2',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }, {
                appendHistoryId: 'saved-later-tail',
                sourceRow: 3,
                savedFingerprint: 'fingerprint-3',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows'
                && message.sourceRows.length === 2,
        ));
        const request = [...grid_mock.post_message.mock.calls]
            .reverse()
            .map(([message]) => message)
            .find((message) => message?.type === 'requestSourceDisplayRows'
                && message.sourceRows.length === 2);

        await act(async () => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'sourceDisplayRows',
            requestId: request.requestId,
            sheetIndex: 0,
            generation: 1,
            mappingGeneration: 7,
            sourceRows: [2, 3],
            displayRows: [2, 1],
        } })));
        await vi.waitUntil(() => grid_mock.props!.rows === 4);

        const selection = grid_mock.props!.gridSelection as {
            rows: { toArray(): number[] };
            current?: { cell: [number, number]; range: unknown };
        };
        expect(selection.rows.toArray()).toEqual([3]);
        expect(selection.current).toEqual({
            cell: [0, 3],
            range: { x: 0, y: 3, width: 1, height: 1 },
            rangeStack: [],
        });
    });

    it('restores an unresolved endpoint when its removal is cancelled', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        grid_mock.source_row_for_display = (display_row) => [0, undefined, 1][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 3,
            },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            mapping_generation: 7,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([1]),
            current: {
                cell: [0, 1],
                range: { x: 0, y: 1, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-cancelled-before-inverse',
                sourceRow: 2,
                savedFingerprint: 'fingerprint',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows',
        ));
        await act(async () => {
            expect(pending.replace_tail_removals('session', [])).toBe(true);
        });

        const selection = grid_mock.props!.gridSelection as {
            rows: { toArray(): number[] };
            current?: { cell: [number, number]; range: unknown };
        };
        expect(selection.rows.toArray()).toEqual([1]);
        expect(selection.current).toEqual({
            cell: [0, 1],
            range: { x: 0, y: 1, width: 1, height: 1 },
            rangeStack: [],
        });
    });

    it('restores a partially cancelled unresolved tail row', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        grid_mock.source_row_for_display = (display_row) =>
            [0, undefined, undefined, 1][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 4,
                sourceRowCount: 4,
            },
            row_count: 4,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            mapping_generation: 7,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([2]),
            current: {
                cell: [0, 2],
                range: { x: 0, y: 2, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        // First remove source 3, then source 2. Both inverse positions remain
        // held by the host. Cancelling source 2 leaves source 3 pending, so the
        // original source-2 endpoint must stay in the deferred candidate set.
        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-source-3',
                sourceRow: 3,
                savedFingerprint: 'fingerprint-3',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-source-2',
                sourceRow: 2,
                savedFingerprint: 'fingerprint-2',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }, {
                appendHistoryId: 'saved-source-3',
                sourceRow: 3,
                savedFingerprint: 'fingerprint-3',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-source-3',
                sourceRow: 3,
                savedFingerprint: 'fingerprint-3',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows'
                && message.sourceRows.includes(2)
                && message.sourceRows.includes(3),
        ));
        const request = [...grid_mock.post_message.mock.calls]
            .reverse()
            .map(([message]) => message)
            .find((message) => message?.type === 'requestSourceDisplayRows'
                && message.sourceRows.includes(2)
                && message.sourceRows.includes(3));

        await act(async () => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'sourceDisplayRows',
            requestId: request.requestId,
            sheetIndex: 0,
            generation: 1,
            mappingGeneration: 7,
            sourceRows: request.sourceRows,
            displayRows: request.sourceRows.map((sourceRow: number) =>
                sourceRow === 2 ? 2 : 1),
        } })));
        await vi.waitUntil(() => grid_mock.props!.rows === 4);

        const selection = grid_mock.props!.gridSelection as {
            rows: { toArray(): number[] };
            current?: { cell: [number, number]; range: unknown };
        };
        expect(selection.rows.toArray()).toEqual([1]);
        expect(selection.current).toEqual({
            cell: [0, 1],
            range: { x: 0, y: 1, width: 1, height: 1 },
            rangeStack: [],
        });
    });

    it('keeps an unrelated unloaded selection when a removal inverse is null', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        // Raw row 1 is selected but not resident. The removed physical tail row
        // is filtered out entirely, so its host inverse resolves to null.
        grid_mock.source_row_for_display = (display_row) => [0, undefined, 1][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 3,
            },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            mapping_generation: 7,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([1]),
            current: {
                cell: [0, 1],
                range: { x: 0, y: 1, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-filtered-tail',
                sourceRow: 2,
                savedFingerprint: 'fingerprint',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows',
        ));
        const request = grid_mock.post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'requestSourceDisplayRows');

        await act(async () => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'sourceDisplayRows',
            requestId: request.requestId,
            sheetIndex: 0,
            generation: 1,
            mappingGeneration: 7,
            sourceRows: [2],
            displayRows: [null],
        } })));
        // The null inverse filters source row 2 out of the source band, but its
        // saved-filtered-tail removal still adds one deletion row after the
        // three retained source rows.
        await vi.waitUntil(() => grid_mock.props!.rows === 4);

        const selection = grid_mock.props!.gridSelection as {
            rows: { toArray(): number[] };
            current?: { cell: [number, number]; range: unknown };
        };
        expect(selection.rows.toArray()).toEqual([1]);
        expect(selection.current).toEqual({
            cell: [0, 1],
            range: { x: 0, y: 1, width: 1, height: 1 },
            rangeStack: [],
        });
    });

    it('compresses a delayed inverse past removals already in the projection', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        expect(pending.replace_tail_removals('session', [{
            appendHistoryId: 'saved-first',
            sourceRow: 4,
            savedFingerprint: 'fingerprint-first',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }])).toBe(true);
        // Raw display order is [4, 0, 3, 1, 2]. Source 4 is resident and is
        // already compressed out. Source 3 stays nonresident until the host
        // answers its inverse lookup at raw row 2.
        grid_mock.source_row_for_display = (display_row) =>
            [4, 0, undefined, 1, 2][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 5,
                sourceRowCount: 5,
            },
            row_count: 5,
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            mapping_generation: 7,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([0, 1, 2]),
            current: {
                cell: [0, 0],
                range: { x: 0, y: 0, width: 1, height: 3 },
                rangeStack: [],
            },
        }));

        await act(async () => {
            expect(pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-delayed',
                sourceRow: 3,
                savedFingerprint: 'fingerprint-delayed',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }, {
                appendHistoryId: 'saved-first',
                sourceRow: 4,
                savedFingerprint: 'fingerprint-first',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }])).toBe(true);
        });
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows'
                && message.sourceRows.includes(3),
        ));
        const request = [...grid_mock.post_message.mock.calls]
            .reverse()
            .map(([message]) => message)
            .find((message) => message?.type === 'requestSourceDisplayRows'
                && message.sourceRows.includes(3));

        await act(async () => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'sourceDisplayRows',
            requestId: request.requestId,
            sheetIndex: 0,
            generation: 1,
            mappingGeneration: 7,
            sourceRows: request.sourceRows,
            displayRows: request.sourceRows.map((sourceRow: number) =>
                sourceRow === 3 ? 2 : 0),
        } })));
        await vi.waitUntil(() => grid_mock.props!.rows === 5);

        const selection = grid_mock.props!.gridSelection as {
            rows: { toArray(): number[] };
            current?: { range: unknown };
        };
        expect(selection.rows.toArray()).toEqual([0, 1, 2, 3]);
        expect(selection.current?.range).toEqual({ x: 0, y: 0, width: 1, height: 4 });
    });

    it('offers no mutating cell actions on a transformed tail-removal row', async () => {
        const cells = create_edit_session_store({ session_id: 'session' }, {
            '1:0': { value: 'unrelated dirty row', base: 'source-a' },
        });
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.install({ session_id: 'session' }, {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [{
                appendHistoryId: 'saved-tail',
                sourceRow: 2,
                savedFingerprint: 'fingerprint',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }],
            conflicts: [],
        });
        // Source row 2 is removed from raw display row 0. The deletion band is
        // numeric row 2, where a fallback lookup would resolve unrelated source
        // row 1 under this permutation.
        grid_mock.source_row_for_display = (display_row) => [2, 0, 1][display_row];
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 3,
            },
            row_count: 3,
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            edit_session_id: 'session',
            edit_session: cells,
            pending_row_store: pending,
            mapping_generation: 4,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        }));
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows',
        ));
        const request = grid_mock.post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'requestSourceDisplayRows');
        await act(async () => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'sourceDisplayRows',
            requestId: request.requestId,
            sheetIndex: 0,
            generation: 1,
            mappingGeneration: 4,
            sourceRows: [2],
            displayRows: [0],
        } })));
        await vi.waitUntil(() => grid_mock.props!.rows === 3);

        const on_context = grid_mock.props!.onCellContextMenu as (
            cell: [number, number], event: Record<string, unknown>,
        ) => void;
        await act(async () => on_context([0, 2], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 48, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));

        expect(find_button((text) => text === 'Discard edit')).toBeUndefined();
        expect(find_button((text) => text.startsWith('Hyperlink'))).toBeUndefined();
        expect(find_button((text) => text.startsWith('Highlight '))).toBeUndefined();
        expect(find_button((text) => text.startsWith('Clear highlight'))).toBeUndefined();
        expect(cells.snapshot().get('1:0')?.value).toBe('unrelated dirty row');
    });

    it('invalidates cuts after either source or pending cell payload changes', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        const cells = create_edit_session_store({ session_id: 'session' });
        pending.append_rows('session', ['pending-a'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            edit_session: cells,
            pending_row_store: pending,
        }));
        const before_source = grid_mock.props!.cutValidationKey;

        act(() => edit_one(grid_mock.props!.onCellsEdited)(
            [0, 0],
            { kind: 'text', data: 'new source value' },
        ));
        await vi.waitUntil(() => grid_mock.props!.cutValidationKey !== before_source);
        const before_pending = grid_mock.props!.cutValidationKey;

        act(() => {
            pending.set_cell('session', 'pending-a', 0, {
                value: 'new pending value',
                valueEditOrder: 2,
            });
        });
        await vi.waitUntil(() => grid_mock.props!.cutValidationKey !== before_pending);
    });

    it('uses the promoted physical row while Excel row data is still loading', async () => {
        grid_mock.source_row_for_display = () => undefined;
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 4,
                sourceRowCount: 5,
                excelFirstRowHeader: {
                    mode: 'on',
                    detected: false,
                    active: true,
                    available: true,
                    sourceRow: 2,
                },
            },
            row_count: 4,
        }));

        const get_row_number = (grid_mock.props!.rowMarkers as {
            getRowNumber(row: number): number;
        }).getRowNumber;
        expect([0, 1, 2, 3].map(get_row_number)).toEqual([1, 2, 4, 5]);
    });

    it('leaves Excel row markers blank until a transformed mapping loads', async () => {
        grid_mock.source_row_for_display = () => undefined;
        await render_grid(props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 3,
                sourceRowCount: 100,
                excelFirstRowHeader: {
                    mode: 'on',
                    detected: false,
                    active: true,
                    available: true,
                    sourceRow: 0,
                },
            },
            row_count: 3,
            transform_state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
            },
        }));

        const get_row_number = (grid_mock.props!.rowMarkers as {
            getRowNumber(row: number): number | undefined;
        }).getRowNumber;
        expect([0, 1, 2].map(get_row_number)).toEqual([
            undefined,
            undefined,
            undefined,
        ]);
    });

    it('shows physical Excel letters over promoted column names', async () => {
        vi.useFakeTimers();
        const initial = props({
            sheet_meta: {
                ...props().sheet_meta,
                columnNames: ['Name', 'Hidden', 'Price'],
                excelFirstRowHeader: {
                    mode: 'on',
                    detected: false,
                    active: true,
                    available: true,
                    sourceRow: 0,
                },
            },
            column_projection: {
                visible_to_source: [2, 0],
                source_to_visible: [1, undefined, 0],
                hidden_count: 1,
            },
        });
        const GridShell = await render_grid(initial);
        const on_item_hovered = grid_mock.props!.onItemHovered as
            (args: Record<string, unknown>) => void;

        await act(async () => {
            on_item_hovered({
                kind: 'header', location: [0, -1], buttons: 0,
                bounds: { x: 30, y: 0, width: 120, height: 36 },
                localEventX: 60, localEventY: 18,
            });
            await vi.runAllTimersAsync();
        });
        expect(container!.querySelector('[role="tooltip"]')?.textContent)
            .toBe('Excel column C');

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                sheet_meta: {
                    ...initial.sheet_meta,
                    excelFirstRowHeader: {
                        ...initial.sheet_meta.excelFirstRowHeader!,
                        active: false,
                    },
                },
            }));
        });
        const on_inactive_header_hovered = grid_mock.props!.onItemHovered as
            (args: Record<string, unknown>) => void;
        await act(async () => {
            on_inactive_header_hovered({
                kind: 'header', location: [0, -1], buttons: 0,
                bounds: { x: 30, y: 0, width: 120, height: 36 },
                localEventX: 60, localEventY: 18,
            });
            await vi.runAllTimersAsync();
        });
        expect(container!.querySelector('[role="tooltip"]')).toBeNull();
    });

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

    it('passes a manually enlarged row wrapping decision into a rich cell', async () => {
        const text = 'A long information-note paragraph with styled labels';
        grid_mock.get_row.mockImplementation(() => [
            null,
            null,
            {
                raw: text,
                formatted: text,
                bold: false,
                italic: false,
                richText: {
                    runs: [
                        { text: 'A long information-note paragraph with ' },
                        { text: 'styled labels', style: { bold: true } },
                    ],
                },
            },
        ] as any);
        await render_grid(props({
            show_formatting: true,
            row_heights: { 0: 80 },
        }));

        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { data?: { allow_wrapping?: true } };
        expect(get_cell_content([1, 0]).data?.allow_wrapping).toBe(true);
    });

    it('keeps a merged source-rich cell wrapping when Formatting is off', async () => {
        const text = 'A long information note with plain and styled sections';
        grid_mock.get_row.mockImplementation(() => [
            null,
            {
                raw: text,
                formatted: text,
                bold: false,
                italic: false,
                richText: {
                    runs: [
                        { text: 'A long information note with ' },
                        { text: 'plain and styled sections', style: { bold: true } },
                    ],
                },
            },
            null,
        ] as any);
        const merge = { startRow: 0, startCol: 1, endRow: 0, endCol: 2 };
        await render_grid(props({
            show_formatting: false,
            auto_fit_active: false,
            row_heights: { 0: 80 },
            column_projection: {
                visible_to_source: [0, 1, 2],
                source_to_visible: [0, 1, 2],
                hidden_count: 0,
            },
            merges: [merge],
            sheet_meta: {
                ...props().sheet_meta,
                merges: [merge],
            },
        }));

        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => {
                kind: string;
                allowWrapping?: boolean;
                displayData?: string;
            };
        const cell = get_cell_content([1, 0]);
        expect(cell.kind).toBe('text');
        expect(cell.allowWrapping).toBe(true);
        expect(cell.displayData).toBe(text);
    });

    it('keeps wrapping enabled when auto-fit caps a column at its maximum', async () => {
        const text = 'A long value whose fitted width is capped';
        grid_mock.get_row.mockImplementation(() => [
            {
                raw: text,
                formatted: text,
                bold: false,
                italic: false,
            },
            null,
            null,
        ] as any);
        await render_grid(props({
            auto_fit_active: true,
            column_widths: { 0: MAX_AUTO_FIT_COLUMN_WIDTH_PX },
        }));

        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { allowWrapping?: boolean };
        expect(get_cell_content([0, 0]).allowWrapping).toBe(true);
    });

    it('keeps wrapping for auto-fitted columns below the cap', async () => {
        await render_grid(props({
            auto_fit_active: true,
            column_widths: { 0: MAX_AUTO_FIT_COLUMN_WIDTH_PX - 1 },
        }));

        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { allowWrapping?: boolean };
        expect(get_cell_content([0, 0]).allowWrapping).toBe(true);
    });
});

describe('GridShell git compare painting', () => {
    it('paints row bands and per-cell before-text from the compare sidecar', async () => {
        grid_mock.compare_status = { 1: 'added' };
        grid_mock.compare_base = { '0:0': 'before-a' };
        await render_grid(props({ git_compare: true }));

        const get_cell_content = grid_mock.props!.getCellContent as (
            cell: [number, number],
        ) => {
            themeOverride?: { bgCell?: string };
            data: string | { kind: string; lines: { text: string }[][] };
        };
        // The changed cell diffs its own text against the sidecar's base
        // through the same rich-text channel the Diff toggle uses.
        const changed = get_cell_content([0, 0]);
        expect(changed.data).toMatchObject({ kind: 'rich-text' });
        const diff_texts = (changed.data as { lines: { text: string }[][] })
            .lines.flat().map((run) => run.text);
        expect(diff_texts).toContain('before-a');
        expect(diff_texts).toContain('source-a');
        // The added row gets a whole-row band; its cells carry no diff.
        const added = get_cell_content([0, 1]);
        expect(added.themeOverride?.bgCell).toBeDefined();
        expect(added.data).toBe('source-a');
        // An untouched cell is a plain cell: no band, no diff payload.
        const plain = get_cell_content([1, 0]);
        expect(plain.themeOverride).toBeUndefined();
        expect(plain.data).toBe('source-c');
    });

    it('strikes deleted-row cells whole instead of diffing them', async () => {
        grid_mock.compare_status = { 0: 'deleted', 1: 'added' };
        await render_grid(props({ git_compare: true }));
        const get_cell_content = grid_mock.props!.getCellContent as (
            cell: [number, number],
        ) => {
            themeOverride?: { bgCell?: string };
            data: { lines: { text: string; style?: { strikethrough?: boolean } }[][] };
        };
        const cell = get_cell_content([0, 0]);
        // A band that is distinct from the added band — the exact colors are
        // the theme's business, the distinction is the behavior.
        expect(cell.themeOverride?.bgCell).toBeDefined();
        expect(cell.themeOverride?.bgCell).not.toBe(
            get_cell_content([0, 1]).themeOverride?.bgCell,
        );
        // Struck through whole: one line of the cell's own text, no diff pair.
        expect(cell.data.lines).toEqual([[
            expect.objectContaining({
                text: 'source-a',
                style: { strikethrough: true },
            }),
        ]]);
    });

    it('bands a moved row distinctly and does not strike it through', async () => {
        // A purely moved row has no changed cells, so the band is the only
        // thing saying it moved — reusing added's or deleted's would make it
        // read as one of those.
        grid_mock.compare_status = { 0: 'moved', 1: 'added', 2: 'deleted' };
        await render_grid(props({ git_compare: true }));
        const get_cell_content = grid_mock.props!.getCellContent as (
            cell: [number, number],
        ) => {
            themeOverride?: { bgCell?: string };
            data: string | { lines: { style?: { strikethrough?: boolean } }[][] };
        };
        const moved = get_cell_content([0, 0]);
        const bands = [0, 1, 2].map((row) => get_cell_content([0, row]).themeOverride?.bgCell);
        expect(bands.every((band) => band !== undefined)).toBe(true);
        expect(new Set(bands).size).toBe(3);
        // Its cells are the modified side's own text, not struck-through
        // originals — the strikethrough belongs to deleted rows alone.
        expect(moved.data).toBe('source-a');
    });

    it('ignores the compare sidecar entirely when git_compare is off', async () => {
        grid_mock.compare_status = { 0: 'added' };
        grid_mock.compare_base = { '0:0': 'before-a' };
        await render_grid(props());
        const get_cell_content = grid_mock.props!.getCellContent as (
            cell: [number, number],
        ) => { themeOverride?: unknown; data: string };
        const cell = get_cell_content([0, 0]);
        expect(cell.themeOverride).toBeUndefined();
        expect(cell.data).toBe('source-a');
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

        // Glide moves the live cell editor outside the grid tree into #portal.
        // It is still the grid's focus for save/rejection handoff purposes.
        const portal = document.createElement('div');
        portal.id = 'portal';
        const clip = document.createElement('div');
        clip.className = 'gdg-clip-region';
        const editor = document.createElement('textarea');
        clip.appendChild(editor);
        portal.appendChild(clip);
        document.body.appendChild(portal);
        editor.focus();
        expect(grid_focus_ref.current?.has_focus()).toBe(true);

        const unrelated = document.createElement('input');
        document.body.appendChild(unrelated);
        unrelated.focus();
        expect(grid_focus_ref.current?.has_focus()).toBe(false);
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
            '0:0': { value: 'typed', base: 'source-a', formattingKnown: true },
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
            '0:2': {
                value: 'typed but not closed', base: 'source-c', formattingKnown: true,
            },
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
        const write_text = vi.fn(async (_text: string) => {});
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

    it('copies a pending Header Row rename before save', async () => {
        const write_text = vi.fn(async (_text: string) => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        grid_mock.source_row_for_display = (row) => row + 1;
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            initial_edits: { '0:2': { value: 'Pending C', base: 'C name' } },
            sheet_meta: {
                ...props().sheet_meta,
                sourceRowCount: 2,
                columnHeaderEditTexts: ['A name', 'B name', 'C name'],
                columnHeaderEditable: [true, true, true],
                excelFirstRowHeader: {
                    mode: 'on', detected: true, active: true, available: true, sourceRow: 0,
                },
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

        expect(write_text).toHaveBeenCalledWith('Pending C\nsource-c');
    });

    it('opens a repeat column rename from the pending value', async () => {
        grid_mock.source_row_for_display = (row) => row + 1;
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            initial_edits: { '0:2': { value: 'Pending C', base: 'C name' } },
            sheet_meta: {
                ...props().sheet_meta,
                sourceRowCount: 2,
                columnHeaderEditTexts: ['A name', 'B name', 'C name'],
                columnHeaderEditable: [true, true, true],
                excelFirstRowHeader: {
                    mode: 'on', detected: true, active: true, available: true, sourceRow: 0,
                },
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
            .find((button) => button.textContent === 'Rename column…')!.click());

        const input = document.querySelector('#rename-column-name') as HTMLInputElement;
        expect(input.value).toBe('Pending C');
        await act(async () => set_input_value(input, '  Final\t  C  '));
        await act(async () => button('Rename').click());

        await act(async () => on_header_context_menu(1, {
            preventDefault: vi.fn(),
            bounds: { x: 100, y: 0, width: 100, height: 36 },
            localEventX: 20,
            localEventY: 10,
        }));
        await act(async () => button('Rename column…').click());
        const repeated = document.querySelector('#rename-column-name') as HTMLInputElement;
        expect(repeated.value).toBe('Final C');
        await act(async () => set_input_value(repeated, '  Final   C  '));
        expect(button('Rename').disabled).toBe(true);
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

    it('closes a pending-row menu across topology changes', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.append_rows('session', ['pending-a', 'pending-b'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            transform_sections: true,
        }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([-1, 1], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 48, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        expect(menu_button_labels()).toContain('Remove pending row');

        // Replacing the source tail shifts pending-a from display row 1 to 0;
        // pending-b now occupies the coordinate the menu originally received.
        await act(async () => {
            pending.replace_tail_removals('session', [{
                appendHistoryId: 'saved-tail',
                sourceRow: 0,
                savedFingerprint: 'fingerprint',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }]);
        });
        expect(menu_button_labels()).not.toContain('Remove pending row');
        expect(pending.snapshot().appendedRows.map((row) => row.id))
            .toEqual(['pending-a', 'pending-b']);
    });

    it('offers both structural actions for a replacement row', async () => {
        const pending = create_pending_row_store({ session_id: 'session' });
        pending.append_rows('session', ['pending-a'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        pending.replace_tail_removals('session', [{
            appendHistoryId: 'saved-tail',
            sourceRow: 0,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }]);
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_session_id: 'session',
            pending_row_store: pending,
            transform_sections: true,
        }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([-1, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 24, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));

        expect(menu_button_labels()).toEqual(expect.arrayContaining([
            'Remove pending row',
            'Cancel row removal',
        ]));
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
        expect(grid_mock.trim_rows).toHaveBeenCalledTimes(1);

        await act(async () => root!.unmount());
        expect(grid_actions_ref.current).toBeNull();
        // Guard the shared afterEach unmount against a second call.
        root = null;
        void GridShell;
    });

    it('budgets whole-sheet loading by source width when most columns are hidden', async () => {
        const write_text = vi.fn(async (_text: string) => {});
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: write_text },
        });
        const source_to_visible = new Array<number | undefined>(5_972);
        source_to_visible[0] = 0;
        const grid_actions_ref = React.createRef<
            import('../webview/grid-shell').GridActionsHandle | null
        >() as React.MutableRefObject<
            import('../webview/grid-shell').GridActionsHandle | null
        >;
        await render_grid(props({
            row_count: 100_000,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 100_000,
                sourceRowCount: 100_000,
                columnCount: 5_972,
                columnNames: ['A name'],
            },
            column_projection: {
                visible_to_source: [0],
                source_to_visible,
                hidden_count: 5_971,
            },
            grid_actions_ref,
        }));

        await act(async () => { await grid_actions_ref.current!.copy_sheet(); });

        // Pages contain all 5,972 source columns even though the TSV has one, so
        // loading is capped at floor(1,000,000 / 5,972) = 167 rows.
        expect(grid_mock.ensure_rows_loaded).toHaveBeenCalledWith(0, 166);
        const copied = write_text.mock.calls[0][0] as string;
        expect(copied.split('\n')).toHaveLength(168); // header + 167 rows
        expect(grid_mock.post_message).toHaveBeenCalledWith({
            type: 'showWarning',
            message: expect.stringMatching(/first 167 rows/),
        });
        expect(grid_mock.trim_rows).toHaveBeenCalledTimes(1);
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
        expect(grid_mock.ensure_rows).toHaveBeenCalledWith(0, 0);
        expect(editing_ref.current?.has_uncommitted_changes()).toBe(true);
    });
});

describe('GridShell pending-edit Diff painting', () => {
    it('retries saved-row selection when a source refresh invalidates its first load', async () => {
        let finish_first_load: ((loaded: boolean) => void) | undefined;
        grid_mock.ensure_rows_loaded
            .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
                finish_first_load = resolve;
            }))
            .mockImplementationOnce(async (start = 0) => {
                additionally_loaded_source_rows.set(75, start);
                return true;
            });
        const on_applied = vi.fn();
        const saved_row_focus = {
            sequence: 1,
            sheetIndex: 0,
            sourceRow: 75,
            sourceColumn: 0,
            restoreFocus: false,
        };
        const initial = props({
            row_count: 100,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 100,
                sourceRowCount: 100,
            },
            saved_row_focus,
            on_saved_row_focus_applied: on_applied,
        });
        const GridShell = await render_grid(initial);
        expect(grid_mock.ensure_rows_loaded).toHaveBeenCalledTimes(1);

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                generation: 2,
                source_generation: 2,
            }));
        });
        finish_first_load?.(false);
        await act(async () => {});

        expect(grid_mock.ensure_rows_loaded).toHaveBeenCalledTimes(2);
        expect(grid_mock.scroll_to).toHaveBeenCalledWith(0, 75);
        expect(on_applied).toHaveBeenCalledExactlyOnceWith(1, true);
    });

    it('retries saved-row selection when the current loader rejects a stale request', async () => {
        let finish_first_load: ((loaded: boolean) => void) | undefined;
        grid_mock.ensure_rows_loaded
            .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
                finish_first_load = resolve;
            }))
            .mockImplementationOnce(async (start = 0) => {
                additionally_loaded_source_rows.set(75, start);
                return true;
            });
        const on_applied = vi.fn();
        await render_grid(props({
            row_count: 100,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 100,
                sourceRowCount: 100,
            },
            saved_row_focus: {
                sequence: 1,
                sheetIndex: 0,
                sourceRow: 75,
                sourceColumn: 0,
                restoreFocus: false,
            },
            on_saved_row_focus_applied: on_applied,
        }));

        await act(async () => finish_first_load?.(false));

        expect(grid_mock.ensure_rows_loaded).toHaveBeenCalledTimes(2);
        expect(grid_mock.scroll_to).toHaveBeenCalledWith(0, 75);
        expect(on_applied).toHaveBeenCalledExactlyOnceWith(1, true);
    });

    it.each([
        { restore_focus: true, expected_focused: true },
        { restore_focus: false, expected_focused: false },
    ])('settles exhausted saved-row retries with restore focus $restore_focus', async ({
        restore_focus,
        expected_focused,
    }) => {
        grid_mock.ensure_rows_loaded.mockResolvedValue(false);
        const on_applied = vi.fn();
        await render_grid(props({
            row_count: 100,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 100,
                sourceRowCount: 100,
            },
            saved_row_focus: {
                sequence: 1,
                sheetIndex: 0,
                sourceRow: 75,
                sourceColumn: 0,
                restoreFocus: restore_focus,
            },
            on_saved_row_focus_applied: on_applied,
        }));

        await vi.waitUntil(() => on_applied.mock.calls.length > 0);

        expect(grid_mock.ensure_rows_loaded).toHaveBeenCalledTimes(4);
        expect(document.activeElement === container!.querySelector('.data-editor-stub'))
            .toBe(expected_focused);
        expect(on_applied).toHaveBeenCalledExactlyOnceWith(1, null);
    });

    it('lets a newer saved-row request supersede an older in-flight retry', async () => {
        let finish_first_load: ((loaded: boolean) => void) | undefined;
        grid_mock.ensure_rows_loaded
            .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
                finish_first_load = resolve;
            }))
            .mockImplementationOnce(async (start = 0) => {
                additionally_loaded_source_rows.set(76, start);
                return true;
            });
        const on_applied = vi.fn();
        const initial = props({
            row_count: 100,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 100,
                sourceRowCount: 100,
            },
            saved_row_focus: {
                sequence: 1,
                sheetIndex: 0,
                sourceRow: 75,
                sourceColumn: 0,
                restoreFocus: false,
            },
            on_saved_row_focus_applied: on_applied,
        });
        const GridShell = await render_grid(initial);

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                saved_row_focus: {
                    ...initial.saved_row_focus!,
                    sequence: 2,
                    sourceRow: 76,
                },
            }));
        });
        finish_first_load?.(true);
        await act(async () => {});

        expect(grid_mock.ensure_rows_loaded).toHaveBeenCalledTimes(2);
        expect(grid_mock.scroll_to).toHaveBeenCalledTimes(1);
        expect(grid_mock.scroll_to).toHaveBeenCalledWith(0, 76);
        expect(on_applied).toHaveBeenCalledExactlyOnceWith(2, true);
    });

    it('reports a definitively filtered saved row once and restores focus', async () => {
        grid_mock.source_row_for_display = () => undefined;
        const on_applied = vi.fn();
        await render_grid(props({
            row_count: 100,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 100,
                sourceRowCount: 100,
            },
            mapping_generation: 7,
            transform_state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
            saved_row_focus: {
                sequence: 1,
                sheetIndex: 0,
                sourceRow: 75,
                sourceColumn: 0,
                restoreFocus: true,
            },
            on_saved_row_focus_applied: on_applied,
        }));
        await vi.waitUntil(() => grid_mock.post_message.mock.calls.some(
            ([message]) => message?.type === 'requestSourceDisplayRows',
        ));
        const request = grid_mock.post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'requestSourceDisplayRows');

        await act(async () => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'sourceDisplayRows',
            requestId: request.requestId,
            sheetIndex: 0,
            generation: 1,
            mappingGeneration: 7,
            sourceRows: [75],
            displayRows: [null],
        } })));

        expect(grid_mock.ensure_rows_loaded).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(container!.querySelector('.data-editor-stub'));
        expect(on_applied).toHaveBeenCalledExactlyOnceWith(1, false);
    });

    it('does not settle or focus an in-flight saved-row request after unmount', async () => {
        let finish_load: ((loaded: boolean) => void) | undefined;
        grid_mock.ensure_rows_loaded.mockImplementationOnce(
            () => new Promise<boolean>((resolve) => { finish_load = resolve; }),
        );
        const on_applied = vi.fn();
        await render_grid(props({
            row_count: 100,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 100,
                sourceRowCount: 100,
            },
            saved_row_focus: {
                sequence: 1,
                sheetIndex: 0,
                sourceRow: 75,
                sourceColumn: 0,
                restoreFocus: true,
            },
            on_saved_row_focus_applied: on_applied,
        }));

        await act(async () => root!.unmount());
        root = null;
        finish_load?.(false);
        await act(async () => {});

        expect(on_applied).not.toHaveBeenCalled();
        expect(document.activeElement).not.toBe(container!.querySelector('.data-editor-stub'));
    });

    it('loads and reveals a nonresident source row in an identity view', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        grid_mock.ensure_rows_loaded.mockImplementation(async (start = 0, end = start) => {
            for (let row = start; row <= end; row += 1) {
                additionally_loaded_source_rows.set(row, row);
            }
            return true;
        });
        await render_grid(props({
            editing_ref,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 100,
                sourceRowCount: 100,
            },
        }));

        await expect(editing_ref.current!.reveal_source_cell(75, 0)).resolves.toBe(true);
        expect(grid_mock.ensure_rows_loaded).toHaveBeenCalledWith(75, 75);
        expect(grid_mock.scroll_to).toHaveBeenCalledWith(0, 75);
        expect(document.activeElement).toBe(container!.querySelector('.data-editor-stub'));
    });

    it('does not focus a row after its navigation request was cancelled while loading', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        let finish_loading: (() => void) | undefined;
        grid_mock.ensure_rows_loaded.mockImplementation(async (start = 0, end = start) => {
            await new Promise<void>((resolve) => { finish_loading = resolve; });
            for (let row = start; row <= end; row += 1) {
                additionally_loaded_source_rows.set(row, row);
            }
            return true;
        });
        await render_grid(props({
            editing_ref,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 100,
                sourceRowCount: 100,
            },
        }));
        let current = true;
        const reveal = editing_ref.current!.reveal_source_cell(75, 0, () => current);
        current = false;
        finish_loading?.();

        await expect(reveal).resolves.toBe(false);
        expect(grid_mock.scroll_to).not.toHaveBeenCalled();
        expect(grid_mock.focus).not.toHaveBeenCalled();
    });

    it('maps the last physical row around a promoted header before loading it', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        grid_mock.ensure_rows_loaded.mockImplementation(async (start = 0, end = start) => {
            expect([start, end]).toEqual([99, 99]);
            additionally_loaded_source_rows.set(100, 99);
            return true;
        });
        await render_grid(props({
            editing_ref,
            row_count: 100,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 100,
                sourceRowCount: 101,
                excelFirstRowHeader: {
                    mode: 'on',
                    detected: true,
                    active: true,
                    available: true,
                    sourceRow: 0,
                },
            },
        }));

        expect(editing_ref.current!.can_reveal_source_cell(100, 0)).toBe(true);
        await expect(editing_ref.current!.reveal_source_cell(100, 0)).resolves.toBe(true);
        expect(grid_mock.ensure_rows_loaded).toHaveBeenCalledWith(99, 99);
        expect(grid_mock.scroll_to).toHaveBeenCalledWith(0, 99);
    });

    it('does not offer navigation for a projected nonresident source row', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        await render_grid(props({
            editing_ref,
            row_count: 100,
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 100,
                sourceRowCount: 100,
            },
            transform_state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
            },
        }));

        expect(editing_ref.current!.can_reveal_source_cell(75, 0)).toBe(false);
        await expect(editing_ref.current!.reveal_source_cell(75, 0)).resolves.toBe(false);
        expect(grid_mock.ensure_rows_loaded).not.toHaveBeenCalled();
    });

    it('shows the current file value after that cell changed', async () => {
        await render_grid(props({
            diff_mode: true,
            edit_mode: true,
            csv_editable: true,
            initial_edits: {
                '0:0': {
                    value: 'my pending edit',
                    base: 'value when editing began',
                    observedBase: { value: 'source-a' },
                },
            },
        }));

        const cell = (grid_mock.props!.getCellContent as (
            location: [number, number],
        ) => { data: string | { lines: { text: string }[][] } })([0, 0]);
        expect(cell.data).toMatchObject({ kind: 'rich-text' });
        const text = (cell.data as { lines: { text: string }[][] })
            .lines.flat().map((run) => run.text).join('');
        expect(text).toContain('source-a');
        expect(text).toContain('my pending edit');
        expect(text).not.toContain('value when editing began');
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

    it('formats a dirty numeric value immediately and keeps its edit data raw', async () => {
        const loaded = {
            raw: '1234.5',
            formatted: '1,234.50',
            bold: false,
            italic: false,
            rawType: 'number' as const,
            numberFormat: { code: '#,##0.00' },
        };
        grid_mock.get_row.mockImplementation(() => [
            loaded,
            { raw: 'hidden-b', formatted: 'hidden-b', bold: false, italic: false },
            { raw: 'source-c', formatted: 'source-c', bold: false, italic: false },
        ] as any);
        const initial = props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            initial_edits: { '0:0': { value: '9876.5', base: '1234.5' } },
        });
        const GridShell = await render_grid(initial);
        const content = () => {
            const get_cell_content = grid_mock.props!.getCellContent as
                (cell: [number, number]) => { data: string; displayData: string };
            return get_cell_content([0, 0]);
        };
        expect(content()).toMatchObject({
            data: '9876.5',
            displayData: '9,876.50',
        });

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                show_formatting: false,
            }));
        });
        expect(content()).toMatchObject({
            data: '9876.5',
            displayData: '9876.5',
        });

        await act(async () => {
            root!.render(React.createElement(GridShell, initial));
        });
        expect(content().displayData).toBe('9,876.50');
    });

    it('paints dirty XLSX formulas as cached value to unknown result', async () => {
        const on_editing_change = vi.fn();
        grid_mock.get_row.mockImplementation(() => [{
            raw: '58.5',
            formatted: '$58.50',
            bold: false,
            italic: false,
            rawType: 'number' as const,
            formula: '=E5*F5',
        }, {
            raw: '12',
            formatted: '12',
            bold: false,
            italic: false,
            rawType: 'number' as const,
        }, {
            raw: '20',
            formatted: '$20.00',
            bold: false,
            italic: false,
            rawType: 'number' as const,
            formula: '=A1+B1',
        }] as any);
        const initial = props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            on_editing_change,
            column_projection: {
                visible_to_source: [0, 1, 2],
                source_to_visible: [0, 1, 2],
                hidden_count: 0,
            },
            initial_edits: {
                '0:0': { value: '=E5*F5+1', base: '=E5*F5' },
                '0:1': { value: '=A1*2', base: '12' },
                '0:2': { value: '60', base: '=A1+B1' },
            },
        });
        const GridShell = await render_grid(initial);
        expect(on_editing_change.mock.calls.at(-1)?.[0].conflicted).toEqual([]);
        const get_cell_content = (cell: [number, number]) => (
            grid_mock.props!.getCellContent as (cell: [number, number]) => {
                kind: string;
                displayData?: string;
                data: { lines: Array<Array<{ text: string }>> };
                copyData: string;
                clipboardData?: { formula?: string; location: [number, number] };
            }
        )(cell);

        const formula = get_cell_content([0, 0]);
        expect(formula.data.lines.flat().map((part) => part.text).join(''))
            .toBe('$58.50 → ??');
        expect(formula.copyData).toBe('=E5*F5+1');
        expect(formula.clipboardData).toMatchObject({
            formula: '=E5*F5+1',
            location: [0, 0],
        });

        const promoted = get_cell_content([1, 0]);
        expect(promoted.data.lines.flat().map((part) => part.text).join(''))
            .toBe('12 → ??');
        expect(promoted.copyData).toBe('=A1*2');
        expect(promoted.clipboardData).toMatchObject({
            formula: '=A1*2',
            location: [1, 0],
        });

        expect(get_cell_content([2, 0])).toMatchObject({
            kind: 'text',
            displayData: '60',
        });

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                show_formatting: false,
            }));
        });
        expect(get_cell_content([0, 0]).data.lines
            .flat().map((part) => part.text).join('')).toBe('58.5 → ??');
    });

    it('paints recursive formula dependents as cached value to unknown result', async () => {
        grid_mock.get_row.mockImplementation(() => [{
            raw: '2',
            formatted: '2',
            bold: false,
            italic: false,
            rawType: 'number' as const,
        }, {
            raw: '4',
            formatted: '$4.00',
            bold: false,
            italic: false,
            rawType: 'number' as const,
            formula: '=A1*2',
            numberFormat: { code: '$0.00' },
        }, {
            raw: '12',
            formatted: '$12.00',
            bold: false,
            italic: false,
            rawType: 'number' as const,
            formula: '=B1*3',
            numberFormat: { code: '$0.00' },
        }, {
            raw: '99',
            formatted: '$99.00',
            bold: false,
            italic: false,
            rawType: 'number' as const,
            formula: '=Z1',
        }] as any);
        const initial = props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            sheet_meta: {
                ...props().sheet_meta,
                columnCount: 4,
            },
            pending_formula_impact: {
                size: 2,
                has: (row, column) => row === 0 && (column === 1 || column === 2),
                *keys() { yield '0:1'; yield '0:2'; },
                *cells() {
                    yield { row: 0, column: 1 };
                    yield { row: 0, column: 2 };
                },
            },
            column_projection: {
                visible_to_source: [0, 1, 2, 3],
                source_to_visible: [0, 1, 2, 3],
                hidden_count: 0,
            },
            initial_edits: {
                '0:0': { value: '3', base: '2' },
            },
            source_formula_results: new Map([
                ['0:1', '4'],
                ['0:2', '12'],
            ]),
        });
        const GridShell = await render_grid(initial);
        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => {
                kind: string;
                displayData?: string;
                data?: string | { lines: Array<Array<{ text: string }>> };
            };
        const text = (column: number) => {
            const cell = get_cell_content([column, 0]);
            return typeof cell.data === 'object'
                ? cell.data.lines.flat().map((part) => part.text).join('')
                : cell.displayData;
        };

        expect(text(0)).toBe('3');
        expect(text(1)).toBe('$4.00 → ??');
        expect(text(2)).toBe('$12.00 → ??');
        expect(text(3)).toBe('$99.00');

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                formula_results: new Map([
                    ['0:1', '6'],
                    ['0:2', '?? (unsupported function)'],
                ]),
            }));
        });
        expect(text(1)).toBe('$4.00 → $6.00');
        expect(text(2)).toBe('$12.00 → ?? (unsupported function)');

    });

    it('does not invalidate formulas for a hyperlink-only edit', async () => {
        grid_mock.get_row.mockImplementation(() => [{
            raw: '2', formatted: '2', bold: false, italic: false,
        }, {
            raw: '4', formatted: '$4.00', bold: false, italic: false,
            formula: '=A1*2',
        }] as any);
        await render_grid(props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            sheet_meta: {
                ...props().sheet_meta,
                columnCount: 2,
            },
            column_projection: {
                visible_to_source: [0, 1],
                source_to_visible: [0, 1],
                hidden_count: 0,
            },
            initial_edits: {
                '0:0': {
                    value: '2',
                    base: '2',
                    link: { kind: 'external', target: 'https://new.test/' },
                    baseLink: null,
                },
            },
        }));
        const cell = (grid_mock.props!.getCellContent as
            (location: [number, number]) => {
                displayData: string;
                clipboardData?: {
                    formula?: string;
                    location: [number, number];
                    gridLocation: [number, number];
                };
            })([1, 0]);
        expect(cell.displayData).toBe('$4.00');
        expect(cell.clipboardData).toMatchObject({
            formula: '=A1*2',
            location: [1, 0],
            gridLocation: [1, 0],
        });
    });

    it('keeps a CSV value beginning with equals as literal text', async () => {
        await render_grid(props({
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'plain',
            initial_edits: {
                '0:0': { value: '=not a formula', base: 'source-a' },
            },
        }));
        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { kind: string; displayData: string };
        expect(get_cell_content([0, 0])).toMatchObject({
            kind: 'text',
            displayData: '=not a formula',
        });
    });

    it('keeps formula-shaped XLSX rich text literal even if a result is present', async () => {
        await render_grid(props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            initial_edits: {
                '0:0': {
                    value: '=1+1',
                    base: 'source-a',
                    valueRuns: {
                        runs: [{ text: '=1+1', style: { bold: true } }],
                    },
                },
            },
            formula_results: new Map([['0:0', '2']]),
        }));
        const cell = (grid_mock.props!.getCellContent as
            (location: [number, number]) => {
                copyData: string;
                data: { lines: Array<Array<{ text: string }>> };
            })([0, 0]);

        expect(cell.copyData).toBe('=1+1');
        expect(cell.data.lines.flat().map((part) => part.text).join('')).toBe('=1+1');
    });

    it('formats dirty runs that reduce to the cell font as a scalar', async () => {
        grid_mock.get_row.mockImplementation(() => [{
            raw: '1234.5',
            formatted: '1,234.50',
            bold: true,
            italic: false,
            rawType: 'number' as const,
            numberFormat: { code: '#,##0.00' },
        }, null, null] as any);
        await render_grid(props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            initial_edits: {
                '0:0': {
                    value: '9876.5',
                    base: '1234.5',
                    valueRuns: { runs: [{ text: '9876.5', style: { bold: true } }] },
                },
            },
        }));
        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { data: string; displayData: string };
        const cell = get_cell_content([0, 0]);
        // The editor still receives Markdown spelling, while the canvas receives
        // the formatted scalar preview under the cell's whole-cell bold style.
        expect(cell.data).toBe('**9876.5**');
        expect(cell.displayData).toBe('9,876.50');
    });

    it('keeps dirty runs that differ from the cell font as literal rich text', async () => {
        grid_mock.get_row.mockImplementation(() => [{
            raw: '1234.5',
            formatted: '1,234.50',
            bold: true,
            italic: false,
            rawType: 'number' as const,
            numberFormat: { code: '#,##0.00' },
        }, null, null] as any);
        await render_grid(props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            initial_edits: {
                '0:0': {
                    value: '9876.5',
                    base: '1234.5',
                    valueRuns: { runs: [{ text: '9876.5' }] },
                },
            },
        }));
        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => {
                copyData: string;
                data: { kind: string; lines: { text: string; style?: { bold?: true } }[][] };
            };
        const cell = get_cell_content([0, 0]);
        expect(cell.copyData).toBe('9876.5');
        expect(cell.data).toMatchObject({
            kind: 'rich-text',
            lines: [[{ text: '9876.5' }]],
        });
        expect(cell.data.lines[0][0].style).toBeUndefined();
    });

    it('uses the same literal rich edit in the overflow tooltip', async () => {
        vi.useFakeTimers();
        grid_mock.get_row.mockImplementation(() => [{
            raw: '1234.5',
            formatted: '1,234.50',
            bold: true,
            italic: false,
            rawType: 'number' as const,
            numberFormat: { code: '#,##0.00' },
        }, null, null] as any);
        await render_grid(props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            column_widths: { 0: 20, 1: 150, 2: 200 },
            initial_edits: {
                '0:0': {
                    value: '9876.5',
                    base: '1234.5',
                    valueRuns: { runs: [{ text: '9876.5' }] },
                },
            },
        }));
        const on_item_hovered = grid_mock.props!.onItemHovered as
            (args: Record<string, unknown>) => void;
        await act(async () => {
            on_item_hovered({
                kind: 'cell', location: [0, 0], buttons: 0,
                bounds: { x: 30, y: 10, width: 20, height: 36 },
                localEventX: 10, localEventY: 18,
            });
            await vi.runAllTimersAsync();
        });
        expect(container!.querySelector('[role="tooltip"]')?.textContent)
            .toBe('9876.5');
    });

    it('uses the painted formula result in the overflow tooltip', async () => {
        vi.useFakeTimers();
        await render_grid(props({
            show_formatting: true,
            edit_mode: true,
            csv_editable: true,
            edit_syntax: 'markdown',
            column_widths: { 0: 20, 1: 150, 2: 200 },
            initial_edits: {
                '0:0': { value: '=1+1', base: 'source-a' },
            },
            formula_results: new Map([['0:0', '2']]),
        }));
        const cell = (grid_mock.props!.getCellContent as
            (location: [number, number]) => {
                data: { lines: Array<Array<{ text: string }>> };
            })([0, 0]);
        expect(cell.data.lines.flat().map((part) => part.text).join(''))
            .toBe('source-a → 2');

        const on_item_hovered = grid_mock.props!.onItemHovered as
            (args: Record<string, unknown>) => void;
        await act(async () => {
            on_item_hovered({
                kind: 'cell', location: [0, 0], buttons: 0,
                bounds: { x: 30, y: 10, width: 20, height: 36 },
                localEventX: 10, localEventY: 18,
            });
            await vi.runAllTimersAsync();
        });
        expect(container!.querySelector('[role="tooltip"]')?.textContent)
            .toBe('source-a → 2');
    });

    it('refreshes a hovered dependent formula when its result settles', async () => {
        vi.useFakeTimers();
        grid_mock.get_row.mockImplementation(() => [{
            raw: '4',
            formatted: '4',
            bold: false,
            italic: false,
            rawType: 'number' as const,
            formula: '=B1*2',
        }, null, null] as any);
        const impact = {
            size: 1,
            has: (row: number, column: number) => row === 0 && column === 0,
            *keys() { yield '0:0'; },
            *cells() { yield { row: 0, column: 0 }; },
        };
        const initial = props({
            show_formatting: true,
            column_widths: { 0: 20, 1: 150, 2: 200 },
            pending_formula_impact: impact,
            source_formula_results: new Map([['0:0', '4']]),
        });
        const GridShell = await render_grid(initial);
        const painted_text = () => {
            const cell = (grid_mock.props!.getCellContent as
                (location: [number, number]) => {
                    data: { lines: Array<Array<{ text: string }>> };
                })([0, 0]);
            return cell.data.lines.flat().map((part) => part.text).join('');
        };
        expect(painted_text()).toBe('4 → ??');

        const on_item_hovered = grid_mock.props!.onItemHovered as
            (args: Record<string, unknown>) => void;
        await act(async () => {
            on_item_hovered({
                kind: 'cell', location: [0, 0], buttons: 0,
                bounds: { x: 30, y: 10, width: 20, height: 36 },
                localEventX: 10, localEventY: 18,
            });
            await vi.runAllTimersAsync();
        });
        expect(container!.querySelector('[role="tooltip"]')?.textContent)
            .toBe('4 → ??');

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                formula_results: new Map([['0:0', '6']]),
            }));
        });
        await act(async () => {
            await vi.runAllTimersAsync();
        });
        expect(painted_text()).toBe('4 → 6');
        expect(container!.querySelector('[role="tooltip"]')?.textContent)
            .toBe('4 → 6');
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

// The append dock replaced Glide's trailing append row, so the append tests
// drive the real control: open the launcher, then activate quick add.
function append_launcher(): HTMLButtonElement | null {
    return document.querySelector('.append-dock-launcher');
}

async function open_append_dock(): Promise<void> {
    const launcher = append_launcher();
    if (!launcher) throw new Error('append dock launcher is not rendered');
    await act(async () => { launcher.click(); });
}

async function quick_add_rows(count = 1): Promise<void> {
    if (count !== 1) {
        const input = field('append-dock-count') as HTMLInputElement;
        await act(async () => set_input_value(input, String(count)));
    }
    const add = button(count === 1 ? 'Add row' : `Add ${count} rows`);
    // Not awaited to settlement: the click issues a host admission the test
    // resolves itself, so awaiting the handler here would deadlock.
    await act(async () => { add.click(); });
}

describe('GridShell edit-admission lifetime', () => {
    const editable = (overrides: Partial<GridShellProps> = {}) => props({
        edit_mode: true,
        edit_activation_id: 1,
        csv_editable: true,
        edit_session_id: 'session-1',
        ...overrides,
    });
    const cell_is_editable = () => {
        const get_cell_content = grid_mock.props!.getCellContent as
            (cell: [number, number]) => { allowOverlay: boolean };
        return get_cell_content([0, 0]).allowOverlay;
    };

    it('drops a host append admission after the committed edit activation closes', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const pending = create_pending_row_store({ session_id: 'session-1' });
        let settle_admission!: (result: AppendRowsAdmission | undefined) => void;
        const on_append_rows = vi.fn(() => new Promise<
            AppendRowsAdmission | undefined
        >((resolve) => { settle_admission = resolve; }));
        await render_grid(editable({
            editing_ref,
            pending_row_store: pending,
            on_append_rows,
        }));
        await open_append_dock();
        await quick_add_rows();
        await vi.waitUntil(() => on_append_rows.mock.calls.length === 1);

        await act(async () => editing_ref.current!.stop_edit_admission());
        const settle = vi.fn();
        await act(async () => {
            settle_admission({
                rowIds: ['host-row-1'],
                formatTemplate: { id: 'plain', format: { kind: 'none' } },
                appendBasis: {
                    sourceRowCount: 1,
                    provisionalStartRow: 1,
                    columnCount: 3,
                    schemaFingerprint: 'schema',
                },
                settle,
            });
        });
        await vi.waitUntil(() => settle.mock.calls.length === 1);

        expect(pending.snapshot().appendedRows).toEqual([]);
        expect(settle).toHaveBeenCalledWith(false);
    });

    it('installs an append admission through its own committed busy affordance', async () => {
        const pending = create_pending_row_store({ session_id: 'session-1' });
        let settle_admission!: (result: AppendRowsAdmission | undefined) => void;
        const on_append_rows = vi.fn(() => new Promise<
            AppendRowsAdmission | undefined
        >((resolve) => { settle_admission = resolve; }));
        const initial = editable({
            pending_row_store: pending,
            on_append_rows,
        });
        const GridShell = await render_grid(initial);
        await open_append_dock();
        await quick_add_rows();
        await vi.waitUntil(() => on_append_rows.mock.calls.length === 1);

        // App commits this prop while the host owns the request. It is an
        // affordance fence, not evidence that the activation which issued the
        // request has gone stale. The dock stays mounted across it and shows a
        // busy state rather than vanishing under its own request.
        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                append_in_flight: true,
            }));
        });
        expect(append_launcher()).not.toBeNull();
        expect(button('Adding…').disabled).toBe(true);

        const settle = vi.fn();
        await act(async () => {
            settle_admission({
                rowIds: ['host-row-1'],
                formatTemplate: { id: 'plain', format: { kind: 'none' } },
                appendBasis: {
                    sourceRowCount: 1,
                    provisionalStartRow: 1,
                    columnCount: 3,
                    schemaFingerprint: 'schema',
                },
                settle,
            });
        });
        await vi.waitUntil(() => settle.mock.calls.length === 1);

        expect(pending.snapshot().appendedRows.map((row) => row.id))
            .toEqual(['host-row-1']);
        expect(settle).toHaveBeenCalledWith(true);
    });

    it('serializes two rapid append gestures instead of dropping the second', async () => {
        const pending = create_pending_row_store({ session_id: 'session-1' });
        const resolvers: Array<(result: AppendRowsAdmission | undefined) => void> = [];
        const on_append_rows = vi.fn(() => new Promise<AppendRowsAdmission | undefined>(
            (resolve) => { resolvers.push(resolve); },
        ));
        await render_grid(editable({
            pending_row_store: pending,
            on_append_rows,
        }));
        // Driven through the in-grid path rather than the dock: the dock
        // latches busy on its own request, so two overlapping gestures can only
        // come from somewhere that does not — Tab past the last cell does.
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([]),
            current: {
                cell: [1, 0],
                range: { x: 1, y: 0, width: 1, height: 1 },
                rangeStack: [],
            },
        }));
        const on_key_down = grid_mock.props!.onKeyDown as
            (args: Record<string, unknown>) => void;
        const press_tab = () => on_key_down({
            key: 'Tab',
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            cancel: () => {},
            preventDefault: () => {},
        });
        await act(async () => { press_tab(); press_tab(); });
        await vi.waitUntil(() => on_append_rows.mock.calls.length === 1);

        const first_settle = vi.fn();
        await act(async () => resolvers[0]({
            rowIds: ['host-row-1'],
            formatTemplate: { id: 'plain', format: { kind: 'none' } },
            appendBasis: {
                sourceRowCount: 1,
                provisionalStartRow: 1,
                columnCount: 3,
                schemaFingerprint: 'schema',
            },
            settle: first_settle,
        }));
        await vi.waitUntil(() => on_append_rows.mock.calls.length === 2);

        const second_settle = vi.fn();
        await act(async () => resolvers[1]({
            rowIds: ['host-row-2'],
            formatTemplate: { id: 'plain', format: { kind: 'none' } },
            appendBasis: {
                sourceRowCount: 1,
                provisionalStartRow: 1,
                provisionalRowCount: 2,
                columnCount: 3,
                schemaFingerprint: 'schema',
            },
            settle: second_settle,
        }));
        await vi.waitUntil(() =>
            pending.snapshot().appendedRows.length === 2);

        expect(pending.snapshot().appendedRows.map((row) => row.id))
            .toEqual(['host-row-1', 'host-row-2']);
        expect(first_settle).toHaveBeenCalledWith(true);
        expect(second_settle).toHaveBeenCalledWith(true);
    });

    it('rejects a paste admission when unrelated pending topology changes before projection', async () => {
        const pending = create_pending_row_store({ session_id: 'session-1' });
        pending.append_rows('session-1', ['pending-a', 'pending-b'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        let resolve_admission!: (result: AppendRowsAdmission | undefined) => void;
        const on_append_rows = vi.fn(() => new Promise<
            AppendRowsAdmission | undefined
        >((resolve) => { resolve_admission = resolve; }));
        await render_grid(editable({
            pending_row_store: pending,
            on_append_rows,
        }));
        const topology_before = grid_mock.props!.pasteTopologyKey;
        const admit_for_paste = grid_mock.props!.onPasteRowsNeeded as (
            count: number,
            topology_key: unknown,
        ) => Promise<unknown>;
        const completion = admit_for_paste(1, topology_before);
        await vi.waitUntil(() => on_append_rows.mock.calls.length === 1);

        const settle = vi.fn((accepted: boolean) => {
            if (accepted) pending.remove_rows('session-1', new Set(['pending-a']));
        });
        let result: unknown;
        await act(async () => {
            resolve_admission({
                rowIds: ['host-row-1'],
                formatTemplate: { id: 'plain', format: { kind: 'none' } },
                appendBasis: {
                    sourceRowCount: 1,
                    provisionalStartRow: 1,
                    provisionalRowCount: 3,
                    columnCount: 3,
                    schemaFingerprint: 'schema',
                },
                settle,
            });
            result = await completion;
        });

        expect(result).toBe(false);
        expect(settle).toHaveBeenCalledWith(true);
        expect(pending.snapshot().appendedRows.map((row) => row.id))
            .toEqual(['pending-b']);
    });

    it('keeps an edit admission fenced across an ordinary rerender', async () => {
        // A failed close/reload remains fenced. The boundary is a real new
        // activation, not "some render happened after stop_edit_admission".
        const editing_ref = React.createRef<EditingHandle | null>();
        const initial = editable({ editing_ref });
        const GridShell = await render_grid(initial);
        expect(cell_is_editable()).toBe(true);

        await act(async () => editing_ref.current!.stop_edit_admission());
        expect(cell_is_editable()).toBe(false);

        await act(async () => {
            root!.render(React.createElement(GridShell, { ...initial }));
        });
        expect(cell_is_editable()).toBe(false);
    });

    it('reopens cell editing for a new edit-mode activation in the same session', async () => {
        // The desktop host deliberately reuses an already-owned session ID. The
        // close fence belongs to the activation that raised it, so false→true
        // must open a new one without requiring a remount or a different ID.
        const editing_ref = React.createRef<EditingHandle | null>();
        const initial = editable({ editing_ref });
        const GridShell = await render_grid(initial);
        expect(cell_is_editable()).toBe(true);

        await act(async () => editing_ref.current!.stop_edit_admission());
        expect(cell_is_editable()).toBe(false);

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                edit_mode: false,
            }));
        });
        expect(cell_is_editable()).toBe(false);

        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...initial,
                edit_mode: true,
                edit_activation_id: 2,
            }));
        });
        expect(cell_is_editable()).toBe(true);
        const close_overlay = await open_tracking_overlay([0, 0], 'source-a');
        expect(document.querySelector('.cell-editor-input')).not.toBeNull();
        await close_overlay();
    });

    it('does not let an abandoned re-entry render reopen the mounted admission', async () => {
        // Reproduce the concurrent-render leak directly. The committed tree is
        // fenced and inactive, then a transition renders the next activation far
        // enough to execute GridShell before a sibling suspends it. The mounted
        // imperative handle must still observe activation 1 until React commits 2.
        const editing_ref = React.createRef<EditingHandle | null>();
        const store = create_edit_session_store({ session_id: 'session-1' });
        const initial = editable({ editing_ref, edit_session: store });
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
        const never = new Promise<void>(() => {});
        function Suspend(): React.JSX.Element {
            throw never;
        }
        function Harness({
            active,
            activation,
            suspend,
        }: {
            active: boolean;
            activation: number;
            suspend: boolean;
        }): React.JSX.Element {
            return React.createElement(
                React.Suspense,
                { fallback: null },
                React.createElement(GridShell, {
                    ...initial,
                    edit_mode: active,
                    edit_activation_id: activation,
                }),
                suspend ? React.createElement(Suspend) : null,
            );
        }
        await act(async () => {
            root!.render(React.createElement(Harness, {
                active: true,
                activation: 1,
                suspend: false,
            }));
        });
        const close_overlay = await open_tracking_overlay([0, 0], 'typed');
        await act(async () => editing_ref.current!.stop_edit_admission());
        await act(async () => {
            root!.render(React.createElement(Harness, {
                active: false,
                activation: 1,
                suspend: false,
            }));
        });

        await act(async () => {
            React.startTransition(() => {
                root!.render(React.createElement(Harness, {
                    active: true,
                    activation: 2,
                    suspend: true,
                }));
            });
        });
        await act(async () => editing_ref.current!.commit_live_edit());

        expect(store.snapshot().size).toBe(0);
        await close_overlay();
    });

    it('keeps callback mirrors aligned with the committed tree during abandoned renders', async () => {
        const store = create_edit_session_store({ session_id: 'session-1' });
        const initial = editable({ edit_session: store });
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
        const never = new Promise<void>(() => {});
        function Suspend(): React.JSX.Element {
            throw never;
        }
        function Harness({
            highlight,
            session,
            suspend,
        }: {
            highlight: boolean;
            session: string;
            suspend: boolean;
        }): React.JSX.Element {
            return React.createElement(
                React.Suspense,
                { fallback: null },
                React.createElement(GridShell, {
                    ...initial,
                    highlight_in_flight: highlight,
                    edit_session_id: session,
                }),
                suspend ? React.createElement(Suspend) : null,
            );
        }
        const render = async (highlight: boolean, session: string, suspend: boolean) => {
            await act(async () => {
                root!.render(React.createElement(Harness, { highlight, session, suspend }));
            });
        };
        await render(false, 'session-1', false);

        // A queued callback belongs to the still-mounted editable tree. A render
        // that would disable editing must not reject it unless that render commits.
        const committed_edit = edit_one(grid_mock.props!.onCellsEdited);
        await act(async () => {
            React.startTransition(() => {
                root!.render(React.createElement(Harness, {
                    highlight: true,
                    session: 'session-1',
                    suspend: true,
                }));
            });
        });
        await act(async () => committed_edit([0, 0], {
            kind: 'text',
            data: 'committed admission',
        }));
        expect(store.snapshot().get('0:0')?.value).toBe('committed admission');

        // Cancel that transition, open an overlay under session 1, then abandon a
        // render for session 2. The mounted finish still belongs to session 1.
        await render(false, 'session-1', false);
        const close_overlay = await open_tracking_overlay([0, 0], 'session one finish');
        const committed_overlay_edit = edit_one(grid_mock.props!.onCellsEdited);
        await act(async () => {
            React.startTransition(() => {
                root!.render(React.createElement(Harness, {
                    highlight: false,
                    session: 'session-2',
                    suspend: true,
                }));
            });
        });
        await act(async () => committed_overlay_edit([0, 0], {
            kind: 'text',
            data: 'session one finish',
        }));
        expect(store.snapshot().get('0:0')?.value).toBe('session one finish');
        await close_overlay();
    });

    it('blocks ordinary overlay folds after the fence but permits one barrier fold', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const store = create_edit_session_store({ session_id: 'session-1' });
        await render_grid(editable({ editing_ref, edit_session: store }));
        const close_overlay = await open_tracking_overlay([0, 0], 'typed');
        const changed = vi.fn();
        const unsubscribe = store.subscribe(changed);

        await act(async () => editing_ref.current!.stop_edit_admission());
        await act(async () => editing_ref.current!.commit_live_edit());
        await act(async () => editing_ref.current!.flush_live_edit());
        expect(store.snapshot().size).toBe(0);

        await act(async () => editing_ref.current!.commit_live_edit_at_close_barrier());
        expect(store.snapshot().get('0:0')).toEqual({
            value: 'typed',
            base: 'source-a',
            formattingKnown: true,
        });
        expect(changed).toHaveBeenCalledTimes(1);

        await act(async () => editing_ref.current!.commit_live_edit_at_close_barrier());
        expect(changed).toHaveBeenCalledTimes(1);
        unsubscribe();
        await close_overlay();
    });

    it('refuses a cell-menu discard after the admission fence', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const store = create_edit_session_store(
            { session_id: 'session-1' },
            { '0:0': { value: 'dirty', base: 'source-a' } },
        );
        await render_grid(editable({ editing_ref, edit_session: store }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([0, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 0, width: 100, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        const discard = Array.from(document.querySelectorAll('button'))
            .find((candidate) => candidate.textContent === 'Discard edit');
        expect(discard).toBeDefined();

        await act(async () => editing_ref.current!.stop_edit_admission());
        await act(async () => discard!.click());

        expect(store.snapshot().get('0:0')).toEqual({
            value: 'dirty',
            base: 'source-a',
        });
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

    it('folds a hyperlink draft into a Cmd/Ctrl+S save', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const store = create_edit_session_store({ session_id: 'session-1' });
        let submitted: Record<string, DirtyEntry> = {};
        const on_save_request = vi.fn((): CsvSaveOperation => {
            submitted = Object.fromEntries(store.snapshot());
            return {
                editSessionId: 'session-1',
                saveRequestId: 'save-link-draft',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'Sheet1',
                    edits: Object.fromEntries(
                        Object.entries(submitted).map(([key, entry]) => [key, entry.value]),
                    ),
                    dirtyEdits: submitted,
                }],
            };
        });
        await render_grid({
            ...link_props(editing_ref),
            edit_session: store,
            on_save_request,
        });
        await open_dialog();
        const dialog_pin = grid_mock.pin_rows.mock.results.at(-1)!.value as symbol;
        await act(async () => set_input_value(
            field('hyperlink-target') as HTMLInputElement,
            'https://shortcut.test/path',
        ));

        await act(async () => {
            field('hyperlink-target').dispatchEvent(new KeyboardEvent('keydown', {
                key: 's',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            }));
        });

        expect(on_save_request).toHaveBeenCalledOnce();
        expect(submitted['0:0']).toEqual(expect.objectContaining({
            link: { kind: 'external', target: 'https://shortcut.test/path' },
            baseLink: null,
        }));
        expect(document.getElementById('hyperlink-target')).toBeNull();
        expect(grid_mock.unpin_rows).toHaveBeenCalledWith(dialog_pin);
    });

    it('allows Cmd/Ctrl+S through an untouched empty hyperlink dialog', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const store = create_edit_session_store({ session_id: 'session-1' }, {
            '0:1': { value: 'pending', base: 'middle' },
        });
        const on_save_request = vi.fn((): CsvSaveOperation => ({
            editSessionId: 'session-1',
            saveRequestId: 'save-with-untouched-link-dialog',
            worksheets: [],
        }));
        await render_grid({
            ...link_props(editing_ref),
            edit_session: store,
            on_save_request,
        });
        await open_dialog();

        await act(async () => {
            field('hyperlink-target').dispatchEvent(new KeyboardEvent('keydown', {
                key: 's',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            }));
        });

        expect(on_save_request).toHaveBeenCalledOnce();
        expect(document.getElementById('hyperlink-target')).toBeNull();
        expect(store.get('0:1')).toMatchObject({ value: 'pending', base: 'middle' });
        expect(store.get('0:1')?.link).toBeUndefined();
        expect(store.get('0:0')).toBeUndefined();
    });

    it('keeps an invalid hyperlink draft open and blocks Cmd/Ctrl+S', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const on_save_request = vi.fn();
        await render_grid({ ...link_props(editing_ref), on_save_request });
        await open_dialog();
        await act(async () => set_input_value(
            field('hyperlink-target') as HTMLInputElement,
            'not a web address',
        ));

        await act(async () => {
            field('hyperlink-target').dispatchEvent(new KeyboardEvent('keydown', {
                key: 'S',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            }));
        });

        expect(on_save_request).not.toHaveBeenCalled();
        expect((field('hyperlink-target') as HTMLInputElement).value)
            .toBe('not a web address');
    });

    it('keeps a hyperlink draft when history replay refuses the gesture', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const store = create_edit_session_store({ session_id: 'session-1' });
        let gestures_admitted = false;
        const on_save_request = vi.fn((): CsvSaveOperation => ({
            editSessionId: 'session-1',
            saveRequestId: 'save-after-replay',
            worksheets: [{ sheetIndex: 0, edits: {}, dirtyEdits: {} }],
        }));
        await render_grid({
            ...link_props(editing_ref),
            edit_session: store,
            gestures_admitted: () => gestures_admitted,
            on_save_request,
        });
        await open_dialog();
        await act(async () => set_input_value(
            field('hyperlink-target') as HTMLInputElement,
            'https://after-replay.test',
        ));

        const save_shortcut = () => field('hyperlink-target').dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 's',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
        await act(async () => { save_shortcut(); });
        expect(on_save_request).not.toHaveBeenCalled();
        expect(store.size()).toBe(0);
        expect(document.getElementById('hyperlink-target')).not.toBeNull();

        gestures_admitted = true;
        await act(async () => { save_shortcut(); });
        expect(on_save_request).toHaveBeenCalledOnce();
        expect(store.get('0:0')?.link).toEqual({
            kind: 'external',
            target: 'https://after-replay.test/',
        });
        expect(document.getElementById('hyperlink-target')).toBeNull();
    });

    it('keeps a hyperlink draft when its history row is no longer resident', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const store = create_edit_session_store({ session_id: 'session-1' });
        const on_save_request = vi.fn();
        await render_grid({
            ...link_props(editing_ref),
            edit_session: store,
            history_store: create_history_store(),
            on_save_request,
        });
        await open_dialog();
        await act(async () => set_input_value(
            field('hyperlink-target') as HTMLInputElement,
            'https://evicted-row.test',
        ));
        // The dialog owns the source identity, but history can no longer describe
        // the persisted side once the row leaves the loader. The gesture must be
        // refused without turning that refusal into permission to save.
        grid_mock.source_row_for_display = () => undefined;

        await act(async () => {
            field('hyperlink-target').dispatchEvent(new KeyboardEvent('keydown', {
                key: 's',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            }));
        });

        expect(on_save_request).not.toHaveBeenCalled();
        expect(store.size()).toBe(0);
        expect(document.getElementById('hyperlink-target')).not.toBeNull();
    });

    it('closes a hyperlink once the close barrier is raised', async () => {
        // The barrier goes up while the dialog is already open — the one
        // ordering the menu gate cannot catch. Past it `post_pending_edits`
        // refuses to publish, so a link accepted here would sit in the store
        // and never reach the host: a silently dropped edit rather than a
        // refused one. Every other mutation path refuses at the same gate.
        const editing_ref = React.createRef<EditingHandle | null>();
        await render_grid(link_props(editing_ref));
        await open_dialog();
        await act(async () => editing_ref.current!.stop_edit_admission());
        expect(document.getElementById('hyperlink-target')).toBeNull();
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(false);
    });

    it('closes a hyperlink draft when the edit session ends', async () => {
        // A successful save no longer remounts GridShell. The dialog therefore
        // has to follow the session identity explicitly instead of relying on
        // unmount to make its now-sessionless Save button disappear.
        const editing_ref = React.createRef<EditingHandle | null>();
        const GridShell = await render_grid(link_props(editing_ref));
        await open_dialog();
        const dialog_pin = grid_mock.pin_rows.mock.results.at(-1)!.value as symbol;
        expect(field('hyperlink-target')).not.toBeNull();

        await act(async () => root!.render(React.createElement(GridShell, {
            ...link_props(editing_ref),
            edit_mode: false,
            edit_session_id: undefined,
        })));
        expect(document.getElementById('hyperlink-target')).toBeNull();
        expect(grid_mock.unpin_rows).toHaveBeenCalledWith(dialog_pin);
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(false);

        // Reusing the same stable mount for a later session must not resurrect
        // the previous session's draft.
        await act(async () => root!.render(React.createElement(
            GridShell,
            link_props(editing_ref),
        )));
        expect(document.getElementById('hyperlink-target')).toBeNull();
    });

    it('does not carry a hyperlink draft into a replacement edit session', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const GridShell = await render_grid(link_props(editing_ref));
        await open_dialog();
        const dialog_pin = grid_mock.pin_rows.mock.results.at(-1)!.value as symbol;
        await act(async () => set_input_value(
            field('hyperlink-target') as HTMLInputElement,
            'https://old-session.test',
        ));
        field('hyperlink-target').focus();
        expect(document.activeElement).toBe(field('hyperlink-target'));

        await act(async () => root!.render(React.createElement(GridShell, {
            ...link_props(editing_ref),
            edit_session_id: 'session-2',
            edit_session: create_edit_session_store({ session_id: 'session-2' }),
        })));

        expect(document.getElementById('hyperlink-target')).toBeNull();
        expect(grid_mock.unpin_rows).toHaveBeenCalledWith(dialog_pin);
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(false);
        await vi.waitUntil(() => document.activeElement
            === document.querySelector('.data-editor-stub'));
    });

    it('does not steal focus on session replacement when another control owns it', async () => {
        const editing_ref = React.createRef<EditingHandle | null>();
        const GridShell = await render_grid(link_props(editing_ref));
        await open_dialog();
        const surviving_target = document.createElement('button');
        document.body.appendChild(surviving_target);
        surviving_target.focus();

        await act(async () => root!.render(React.createElement(GridShell, {
            ...link_props(editing_ref),
            edit_session_id: 'session-2',
            edit_session: create_edit_session_store({ session_id: 'session-2' }),
        })));

        expect(document.getElementById('hyperlink-target')).toBeNull();
        expect(document.activeElement).toBe(surviving_target);
    });
});

describe('GridShell append dock', () => {
    const MAX_PENDING = 10_000;

    function admit_immediately(prefix = 'host-row') {
        let issued = 0;
        return vi.fn(async (count: number) => ({
            rowIds: Array.from(
                { length: count },
                () => `${prefix}-${(issued += 1)}`,
            ),
            formatTemplate: { id: 'plain', format: { kind: 'none' as const } },
            appendBasis: {
                sourceRowCount: 1,
                provisionalStartRow: 1,
                columnCount: 3,
                schemaFingerprint: 'schema',
            },
            settle: () => {},
        }));
    }

    function dock_props(overrides: Partial<GridShellProps> = {}) {
        return props({
            edit_mode: true,
            edit_activation_id: 1,
            csv_editable: true,
            edit_session_id: 'session-1',
            ...overrides,
        });
    }

    it('withholds the launcher until appending is available', async () => {
        const GridShell = await render_grid(dock_props({
            pending_row_store: create_pending_row_store({ session_id: 'session-1' }),
        }));
        // No `on_append_rows`: the host cannot reserve rows, so there is
        // nothing for the dock to offer.
        expect(document.querySelector('.append-dock-launcher')).toBeNull();

        await act(async () => {
            root!.render(React.createElement(GridShell, dock_props({
                pending_row_store: create_pending_row_store({ session_id: 'session-1' }),
                on_append_rows: admit_immediately(),
            })));
        });
        expect(document.querySelector('.append-dock-launcher')).not.toBeNull();
    });

    it('names its expanded state and returns focus to the launcher on dismiss', async () => {
        await render_grid(dock_props({
            pending_row_store: create_pending_row_store({ session_id: 'session-1' }),
            on_append_rows: admit_immediately(),
        }));
        const launcher = document.querySelector('.append-dock-launcher') as HTMLButtonElement;
        expect(launcher.getAttribute('aria-expanded')).toBe('false');
        expect(launcher.getAttribute('aria-label')).toBe('Add rows');

        await act(async () => { launcher.click(); });
        expect(launcher.getAttribute('aria-expanded')).toBe('true');
        expect(launcher.getAttribute('aria-label')).toBe('Close add rows');
        expect(document.querySelector('[role="group"]')?.getAttribute('aria-label'))
            .toBe('Add rows to the end of this worksheet');

        await act(async () => {
            document.querySelector('.append-dock')!.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            );
        });
        expect(launcher.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(launcher);
    });

    it('clamps the requested count to the remaining pending-append capacity', async () => {
        const pending = create_pending_row_store({ session_id: 'session-1' });
        pending.append_rows(
            'session-1',
            Array.from({ length: MAX_PENDING - 3 }, (_, at) => `existing-${at}`),
            { id: 'plain', format: { kind: 'none' } },
            1,
        );
        await render_grid(dock_props({
            pending_row_store: pending,
            on_append_rows: admit_immediately(),
        }));
        await act(async () => {
            (document.querySelector('.append-dock-launcher') as HTMLButtonElement).click();
        });
        const count = field('append-dock-count') as HTMLInputElement;
        expect(count.max).toBe('3');

        await act(async () => set_input_value(count, '50'));
        expect(count.value).toBe('3');
        expect(button('Add 3 rows').disabled).toBe(false);
    });

    it('respects a format ceiling lower than the pending-append cap', async () => {
        await render_grid(dock_props({
            // Two source rows against a four-row ceiling leaves room for two.
            sheet_meta: { ...props().sheet_meta, rowCount: 2, sourceRowCount: 2 },
            row_count: 2,
            append_row_ceiling: 4,
            pending_row_store: create_pending_row_store({ session_id: 'session-1' }),
            on_append_rows: admit_immediately(),
        }));
        await act(async () => {
            (document.querySelector('.append-dock-launcher') as HTMLButtonElement).click();
        });
        const count = field('append-dock-count') as HTMLInputElement;
        await act(async () => set_input_value(count, '9'));
        expect(count.value).toBe('2');
        expect(button('Add 2 rows')).toBeTruthy();
    });

    it('lets a delimited source append past the worksheet row ceiling', async () => {
        await render_grid(dock_props({
            sheet_meta: {
                ...props().sheet_meta,
                rowCount: 1_048_600,
                sourceRowCount: 1_048_600,
            },
            row_count: 1_048_600,
            append_row_ceiling: Number.POSITIVE_INFINITY,
            pending_row_store: create_pending_row_store({ session_id: 'session-1' }),
            on_append_rows: admit_immediately(),
        }));
        expect(document.querySelector('.append-dock-launcher')).not.toBeNull();
    });

    it('stages N rows as one history entry and lands focus in the first of them', async () => {
        const history = create_history_store();
        const pending = create_pending_row_store({ session_id: 'session-1' });
        await render_grid(dock_props({
            pending_row_store: pending,
            history_store: history,
            on_append_rows: admit_immediately(),
        }));
        await act(async () => {
            (document.querySelector('.append-dock-launcher') as HTMLButtonElement).click();
        });
        await act(async () => set_input_value(
            field('append-dock-count') as HTMLInputElement,
            '3',
        ));
        await act(async () => { button('Add 3 rows').click(); });
        await vi.waitUntil(() => pending.snapshot().appendedRows.length === 3);

        expect(history.snapshot().undoStack.map((entry) => entry.action.label))
            .toEqual(['Append 3 rows']);
        // The staged band starts at the row after the single source row, and
        // the caret lands in its first visible column.
        await vi.waitUntil(() => (grid_mock.props!.gridSelection as {
            current?: { cell: [number, number] };
        }).current !== undefined);
        expect((grid_mock.props!.gridSelection as {
            current?: { cell: [number, number] };
        }).current?.cell).toEqual([0, 1]);
        // Focus left the dock for the grid rather than staying on the button.
        expect(document.activeElement?.closest('.append-dock')).toBeFalsy();
        // Staging moved focus into the grid, so the dock closed behind it.
        expect(document.getElementById('append-dock-count')).toBeNull();
    });

    it('keeps the dock open when admission refuses the gesture', async () => {
        const pending = create_pending_row_store({ session_id: 'session-1' });
        const on_append_rows = vi.fn(async () => undefined);
        await render_grid(dock_props({
            pending_row_store: pending,
            on_append_rows,
        }));
        await act(async () => {
            (document.querySelector('.append-dock-launcher') as HTMLButtonElement).click();
        });
        await act(async () => { button('Add row').click(); });
        await vi.waitUntil(() => on_append_rows.mock.calls.length === 1);
        await vi.waitUntil(() => document.querySelector('.append-dock-add')
            ?.textContent === 'Add row');

        expect(pending.snapshot().appendedRows).toEqual([]);
        expect(document.getElementById('append-dock-count')).not.toBeNull();
    });
});

// The composer is an input method on the same append path: it collects text
// against the visible column names and hands it to the same pending band quick
// add stages into.
describe('GridShell append composer', () => {
    function admit_immediately(prefix = 'host-row') {
        let issued = 0;
        return vi.fn(async (count: number) => ({
            rowIds: Array.from(
                { length: count },
                () => `${prefix}-${(issued += 1)}`,
            ),
            formatTemplate: { id: 'plain', format: { kind: 'none' as const } },
            appendBasis: {
                sourceRowCount: 1,
                provisionalStartRow: 1,
                columnCount: 3,
                schemaFingerprint: 'schema',
            },
            settle: () => {},
        }));
    }

    function composer_props(overrides: Partial<GridShellProps> = {}) {
        return props({
            edit_mode: true,
            edit_activation_id: 1,
            csv_editable: true,
            edit_session_id: 'session-1',
            on_append_rows: admit_immediately(),
            ...overrides,
        });
    }

    async function open_composer(): Promise<void> {
        await act(async () => {
            (document.querySelector('.append-dock-launcher') as HTMLButtonElement).click();
        });
        await act(async () => { button('Compose row…').click(); });
    }

    function field_labels(): string[] {
        return Array.from(document.querySelectorAll('.append-composer-field > label'))
            .map((label) => label.textContent ?? '');
    }

    it('offers one labeled field per visible column and nothing for hidden ones', async () => {
        await render_grid(composer_props({
            pending_row_store: create_pending_row_store({ session_id: 'session-1' }),
        }));
        await open_composer();

        // The default projection hides source column 1.
        expect(field_labels()).toEqual(['A name', 'C name']);
        expect(document.querySelector('.append-composer-panel')?.getAttribute('aria-label'))
            .toBe('Compose a row from the visible columns');
        // Every field is a real label/control pair, and the first one has focus.
        for (const label of document.querySelectorAll<HTMLLabelElement>(
            '.append-composer-field > label',
        )) {
            expect(document.getElementById(label.htmlFor)).not.toBeNull();
        }
        expect(document.activeElement).toBe(field('append-composer-0-0'));
    });

    it('stages the composed values into the pending band as one history entry', async () => {
        const history = create_history_store();
        const pending = create_pending_row_store({ session_id: 'session-1' });
        const grid_focus_ref = React.createRef<GridFocusHandle | null>();
        await render_grid(composer_props({
            pending_row_store: pending,
            history_store: history,
            grid_focus_ref,
        }));
        await open_composer();
        await act(async () => set_input_value(
            field('append-composer-0-0') as HTMLInputElement,
            'left',
        ));
        await act(async () => set_input_value(
            field('append-composer-0-1') as HTMLInputElement,
            'right',
        ));
        await act(async () => { button('Stage row').click(); });
        await vi.waitUntil(() => pending.snapshot().appendedRows.length === 1);

        const [row] = pending.snapshot().appendedRows;
        // Display column 1 is source column 2; the hidden column stages blank.
        expect(row.cells[0]?.value).toBe('left');
        expect(row.cells[1]).toBeUndefined();
        expect(row.cells[2]?.value).toBe('right');
        // One staging gesture, one entry: the append and its values undo together.
        expect(history.snapshot().undoStack.map((entry) => entry.action.label))
            .toEqual(['Compose row']);
        // Focus followed the rows into the grid, as quick add does.
        await vi.waitUntil(() => (grid_mock.props!.gridSelection as {
            current?: { cell: [number, number] };
        }).current !== undefined);
        expect((grid_mock.props!.gridSelection as {
            current?: { cell: [number, number] };
        }).current?.cell).toEqual([0, 1]);
        await vi.waitUntil(() => grid_focus_ref.current?.has_focus() === true);
        expect(document.querySelector('.append-composer-panel')).toBeNull();
        expect(document.querySelector('.append-dock-panel')).toBeNull();
        expect(document.querySelector('.append-dock-launcher')?.getAttribute('aria-expanded'))
            .toBe('false');
    });

    it('stages a batch composed with Add another row as one gesture', async () => {
        const history = create_history_store();
        const pending = create_pending_row_store({ session_id: 'session-1' });
        await render_grid(composer_props({
            pending_row_store: pending,
            history_store: history,
        }));
        await open_composer();
        await act(async () => set_input_value(
            field('append-composer-0-0') as HTMLInputElement,
            'first',
        ));
        await act(async () => set_input_value(
            field('append-composer-0-1') as HTMLInputElement,
            'first right',
        ));
        await act(async () => { button('Add another row').click(); });
        await act(async () => set_input_value(
            field('append-composer-1-0') as HTMLInputElement,
            'second',
        ));
        await act(async () => { button('Stage 2 rows').click(); });
        await vi.waitUntil(() => pending.snapshot().appendedRows.length === 2);

        expect(pending.snapshot().appendedRows.map((row) => row.cells[0]?.value))
            .toEqual(['first', 'second']);
        expect(pending.snapshot().appendedRows[0]?.cells[2]?.value).toBe('first right');
        const value_edit_orders = pending.snapshot().appendedRows.flatMap((row) =>
            Object.values(row.cells).map((cell) => cell.valueEditOrder));
        expect(value_edit_orders).toHaveLength(3);
        expect(value_edit_orders.every((order) =>
            Number.isSafeInteger(order))).toBe(true);
        expect(new Set(value_edit_orders).size).toBe(1);
        expect(history.snapshot().undoStack.map((entry) => entry.action.label))
            .toEqual(['Compose 2 rows']);
    });

    it('stages a leading-equals field as the text a cell edit would produce', async () => {
        const pending = create_pending_row_store({ session_id: 'session-1' });
        await render_grid(composer_props({
            pending_row_store: pending,
        }));
        await open_composer();
        await act(async () => set_input_value(
            field('append-composer-0-0') as HTMLInputElement,
            '=SUM(A1:A2)',
        ));
        await act(async () => { button('Stage row').click(); });
        await vi.waitUntil(() => pending.snapshot().appendedRows.length === 1);

        // No formula path of the composer's own: the same text, verbatim.
        expect(pending.snapshot().appendedRows[0].cells[0]?.value).toBe('=SUM(A1:A2)');
    });

    it('captures formula bases against every row in the composed batch', async () => {
        const pending = create_pending_row_store({ session_id: 'session-1' });
        const formula_reference_bases = vi.fn((
            _value: string,
            additional_pending_rows = 0,
        ) => additional_pending_rows === 2 ? [{
            targetSheetIndex: 0,
            targetSheetName: 'Sheet1',
            provisionalStartRow: 1,
            provisionalRowCount: 2,
        }] : []);
        await render_grid(composer_props({
            pending_row_store: pending,
            edit_syntax: 'markdown',
            formula_reference_bases,
        }));
        await open_composer();
        await act(async () => { button('Add another row').click(); });
        await act(async () => set_input_value(
            field('append-composer-1-0') as HTMLInputElement,
            '=A2',
        ));
        await act(async () => { button('Stage 2 rows').click(); });
        await vi.waitUntil(() => pending.snapshot().appendedRows.length === 2);

        expect(formula_reference_bases).toHaveBeenCalledWith('=A2', 2);
        expect(pending.snapshot().appendedRows[1].cells[0]?.formulaReferenceBases)
            .toMatchObject([{
                targetSheetIndex: 0,
                provisionalStartRow: 1,
                provisionalRowCount: 2,
            }]);
    });

    it('numbers composed rows by the worksheet row they will land on', async () => {
        const pending = create_pending_row_store({ session_id: 'session-1' });
        await render_grid(composer_props({ pending_row_store: pending }));
        await open_composer();

        // The fixture's rows are already on the sheet, so the first composed
        // row is the one after them — not "Row 1".
        const legends = () => Array.from(
            document.querySelectorAll('.append-composer-row > legend'),
        ).map((legend) => legend.textContent);
        const [first] = legends();
        expect(first).not.toBe('Row 1');
        const first_number = Number.parseInt((first ?? '').replace(/\D/g, ''), 10);
        expect(first_number).toBeGreaterThan(1);

        await act(async () => { button('Add another row').click(); });
        expect(legends()).toEqual([
            `Row ${first_number}`,
            `Row ${first_number + 1}`,
        ]);
    });

    it('keys composed values by source column, not display position', async () => {
        const pending = create_pending_row_store({ session_id: 'session-1' });
        await render_grid(composer_props({ pending_row_store: pending }));
        await open_composer();

        // The default projection hides source column 1, so the second field on
        // screen is source column 2. A draft keyed by display position would
        // stage this into column 1 — a column the user never saw.
        await act(async () => set_input_value(
            field('append-composer-0-1') as HTMLInputElement,
            'third column',
        ));
        await act(async () => { button('Stage row').click(); });
        await vi.waitUntil(() => pending.snapshot().appendedRows.length === 1);

        const { cells } = pending.snapshot().appendedRows[0];
        expect(cells['2']?.value).toBe('third column');
        expect(cells['1']).toBeUndefined();
    });

    it('returns focus to the count when an add is refused', async () => {
        await render_grid(composer_props({
            pending_row_store: create_pending_row_store({ session_id: 'session-1' }),
            // Admission refuses, so the dock stays open. The controls were
            // disabled for the attempt, which blurs them.
            on_append_rows: vi.fn(async () => undefined),
        }));
        await act(async () => {
            (document.querySelector('.append-dock-launcher') as HTMLButtonElement).click();
        });
        const count = document.getElementById('append-dock-count');
        await act(async () => {
            (document.querySelector('.append-dock-add') as HTMLButtonElement).click();
        });

        await vi.waitUntil(() => document.activeElement === count);
        expect(document.querySelector('.append-dock-panel')).not.toBeNull();
    });

    it('stages composed rows as one publication carrying their values', async () => {
        await render_grid(composer_props({
            pending_row_store: create_pending_row_store({ session_id: 'session-1' }),
        }));
        await open_composer();
        await act(async () => set_input_value(
            field('append-composer-0-0') as HTMLInputElement,
            'seeded',
        ));
        grid_mock.post_message.mockClear();
        await act(async () => { button('Stage row').click(); });

        // Appending blank and then writing the values was two store mutations,
        // so the host saw the row blank before it saw it filled — a flicker in
        // the grid and a second structural payload left outstanding behind it.
        const structural = () => grid_mock.post_message.mock.calls
            .map((call) => call[0])
            .filter((message) => message?.type === 'pendingChangesChanged');
        await vi.waitUntil(() => structural().length > 0);
        expect(structural()).toHaveLength(1);
        const [published] = structural();
        expect(published.changes.appendedRows).toHaveLength(1);
        expect(published.changes.appendedRows[0].cells['0']?.value).toBe('seeded');
    });

    it('stands the quick-add controls down while the composer is open', async () => {
        await render_grid(composer_props({
            pending_row_store: create_pending_row_store({ session_id: 'session-1' }),
        }));
        await act(async () => {
            (document.querySelector('.append-dock-launcher') as HTMLButtonElement).click();
        });
        expect(document.getElementById('append-dock-count')).not.toBeNull();

        await act(async () => { button('Compose row…').click(); });
        // Two `add` buttons at once read as alternatives to each other, when in
        // fact quick add has nothing to do with the composed values.
        expect(document.getElementById('append-dock-count')).toBeNull();
        expect(document.querySelector('.append-dock-add')).toBeNull();
        expect(Array.from(document.querySelectorAll('button')).some(
            (candidate) => candidate.textContent === 'Compose row…',
        )).toBe(false);
        expect(document.querySelector('.append-dock-launcher')).toBeNull();
        expect(document.querySelector('.append-dock-panel')?.classList)
            .toContain('is-secondary-open');

        await act(async () => { button('Close').click(); });
        expect(document.getElementById('append-dock-count')).not.toBeNull();
        expect(document.querySelector('.append-dock-add')).not.toBeNull();
        await vi.waitUntil(() => document.activeElement?.textContent === 'Compose row…');
    });

    it('keeps an un-staged draft across close and reopen, and returns focus', async () => {
        await render_grid(composer_props({
            pending_row_store: create_pending_row_store({ session_id: 'session-1' }),
        }));
        await open_composer();
        await act(async () => set_input_value(
            field('append-composer-0-0') as HTMLInputElement,
            'held',
        ));
        await act(async () => { button('Close').click(); });
        expect(document.querySelector('.append-composer-panel')).toBeNull();
        // Dismiss returns focus to the remounted control that opened the composer,
        // and the dock is still open beneath it.
        expect(document.activeElement?.textContent).toBe('Compose row…');
        expect(document.getElementById('append-dock-count')).not.toBeNull();

        await act(async () => { button('Compose row…').click(); });
        expect((field('append-composer-0-0') as HTMLInputElement).value).toBe('held');
    });

    it('restores focus after a composed row is refused', async () => {
        let finish_admission!: () => void;
        const admission_gate = new Promise<void>((resolve) => { finish_admission = resolve; });
        await render_grid(composer_props({
            pending_row_store: create_pending_row_store({ session_id: 'session-1' }),
            on_append_rows: vi.fn(async () => {
                await admission_gate;
                return undefined;
            }),
        }));
        await open_composer();
        const stage = button('Stage row');
        stage.focus();
        await act(async () => { stage.click(); });
        await vi.waitUntil(() => stage.disabled);
        // Browsers blur a focused control when it becomes disabled. jsdom does
        // not, so reproduce that observable explicitly before admission settles.
        document.body.tabIndex = -1;
        document.body.focus();
        expect(document.activeElement).not.toBe(stage);

        await act(async () => { finish_admission(); });
        await vi.waitUntil(() => document.activeElement === stage);
        expect(document.querySelector('.append-composer-panel')).not.toBeNull();
    });

    it('lets a held batch recover when append capacity shrinks', async () => {
        const pending = create_pending_row_store({ session_id: 'session-1' });
        const GridShell = await render_grid(composer_props({ pending_row_store: pending }));
        await open_composer();
        await act(async () => { button('Add another row').click(); });
        await act(async () => set_input_value(
            field('append-composer-0-0') as HTMLInputElement,
            'keep me',
        ));

        await act(async () => {
            root!.render(React.createElement(GridShell, composer_props({
                pending_row_store: pending,
                append_row_ceiling: 2,
            })));
        });
        expect(button('Stage 2 rows').disabled).toBe(true);
        const remove = button('Remove last row');
        remove.focus();
        await act(async () => { remove.click(); });
        const stage = button('Stage row');
        expect(stage.disabled).toBe(false);
        await vi.waitUntil(() => document.activeElement === stage);
        expect((field('append-composer-0-0') as HTMLInputElement).value).toBe('keep me');
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

    it('records the final pending-row removal with its append-basis transition', async () => {
        const history = create_history_store();
        const pending = create_pending_row_store({ session_id: 'session-1' });
        const basis = {
            sourceRowCount: 3,
            provisionalStartRow: 3,
            provisionalRowCount: 1,
            columnCount: 3,
            schemaFingerprint: 'schema',
        };
        pending.append_rows('session-1', ['pending-a'], {
            id: 'plain', format: { kind: 'none' },
        }, 1, basis);
        await render_grid(capture_props(history, { pending_row_store: pending }));
        const on_cell_context_menu = grid_mock.props!.onCellContextMenu as
            (cell: [number, number], event: Record<string, unknown>) => void;
        await act(async () => on_cell_context_menu([-1, 3], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 96, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        await act(async () => Array.from(document.querySelectorAll('button'))
            .find((candidate) => candidate.textContent === 'Remove pending row')!.click());

        expect(pending.snapshot().appendBasis).toBeUndefined();
        const action = history.snapshot().undoStack[0].action;
        expect(action.changes.map((change) => change.kind))
            .toEqual(['rowAppend', 'pendingRows']);
        const metadata = action.changes[1];
        if (metadata.kind !== 'pendingRows') throw new Error('Expected basis history');
        expect(metadata.delta.before.appendBasis).toEqual(basis);
        expect(metadata.delta.after.appendBasis).toBeUndefined();
    });

    it('resolves a stable source-row target before classifying stale coordinates', async () => {
        const history = create_history_store();
        const pending = create_pending_row_store({ session_id: 'session-1' });
        const cells = create_edit_session_store({ session_id: 'session-1' });
        pending.append_rows('session-1', ['pending-a'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        await render_grid(capture_props(history, {
            edit_session: cells,
            pending_row_store: pending,
        }));
        const handler = grid_mock.props!.onCellsEdited as (
            batch: readonly Record<string, unknown>[],
            gesture: string,
        ) => boolean;

        // Row 3 is the pending band. The cut payload's stable identity says
        // source row 0, because the numeric coordinate was captured before the
        // topology changed.
        const accepted = handler([{
            location: [0, 3],
            value: { kind: 'text', data: 'stable source edit' },
            targetRowIdentity: { kind: 'source', sourceRow: 0 },
            targetSourceColumn: 0,
        }], 'paste');

        expect(accepted).toBe(true);
        expect(cells.snapshot().get('0:0')?.value).toBe('stable source edit');
        expect(pending.snapshot().appendedRows[0].cells).toEqual({});
    });

    it('refuses both arms of a mixed paste when a source target is not resident', async () => {
        const history = create_history_store();
        const pending = create_pending_row_store({ session_id: 'session-1' });
        const cells = create_edit_session_store({ session_id: 'session-1' });
        pending.append_rows('session-1', ['pending-a'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        grid_mock.source_row_for_display = (display_row) => display_row + 1;
        await render_grid(capture_props(history, {
            edit_session: cells,
            pending_row_store: pending,
        }));
        const handler = grid_mock.props!.onCellsEdited as (
            batch: readonly Record<string, unknown>[],
            gesture: string,
        ) => boolean | 'refused';
        const accepted = handler([{
            location: [0, 0],
            value: { kind: 'text', data: 'source edit' },
            targetRowIdentity: { kind: 'source', sourceRow: 0 },
            targetSourceColumn: 0,
        }, {
            location: [0, 3],
            value: { kind: 'text', data: 'pending edit' },
            targetRowIdentity: { kind: 'pending', pendingRowId: 'pending-a' },
            targetSourceColumn: 0,
        }], 'paste');

        expect(accepted).toBe('refused');
        expect(cells.snapshot()).toEqual(new Map());
        expect(pending.snapshot().appendedRows[0].cells).toEqual({});
        expect(history.snapshot().undoStack).toEqual([]);
    });

    it('commits a mixed source/pending highlight as one host-confirmed action', async () => {
        const history = create_history_store();
        const pending = create_pending_row_store({ session_id: 'session-1' });
        pending.append_rows('session-1', ['pending-a'], {
            id: 'plain', format: { kind: 'none' },
        }, 1);
        const highlight_ref: { current: HighlightSelectionHandle | null } = { current: null };
        const on_highlight_selection = vi.fn();
        await render_grid(capture_props(history, {
            pending_row_store: pending,
            highlight_ref,
            on_highlight_selection,
        }));
        const on_selection_change = grid_mock.props!.onGridSelectionChange as
            (selection: unknown) => void;
        await act(async () => on_selection_change({
            columns: compact([]),
            rows: compact([]),
            current: {
                cell: [0, 2],
                range: { x: 0, y: 2, width: 1, height: 2 },
                rangeStack: [],
            },
        }));

        expect(highlight_ref.current?.apply('yellow')).toBe(true);
        expect(pending.snapshot().appendedRows[0].highlights).toBeUndefined();
        const pending_gesture = on_highlight_selection.mock.calls[0][2];
        expect(pending_gesture).toBeDefined();
        expect(pending_gesture.commit([{
            kind: 'highlight',
            delta: {
                worksheet: { sheetIndex: 0, sheetName: 'Sheet1', worksheetId: 'rId1' },
                sourceRow: 2,
                sourceColumn: 0,
                before: null,
                after: 'yellow',
            },
        }], 'Highlight cells')).toBe(true);

        expect(pending.snapshot().appendedRows[0].highlights).toEqual({ 0: 'yellow' });
        expect(history.snapshot().undoStack).toHaveLength(1);
        expect(history.snapshot().undoStack[0].action.changes.map((change) => change.kind))
            .toEqual(['highlight', 'rowAppend']);
    });

    it('offers paste only while cells are editable and never offers the fill handle', async () => {
        const history = create_history_store();
        await render_grid(capture_props(history));
        // A bare `true`, not a vetting callback: every refusal paste needs is
        // already made per cell (see the prop's comment in grid-shell).
        expect(grid_mock.props!.onPaste).toBe(true);
        expect(grid_mock.props!.fillHandle).toBe(false);

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

    it('records formula-conflict removal in the same undoable source edit', async () => {
        const history = create_history_store();
        const pending = create_pending_row_store({ session_id: 'session-1' });
        const conflict = {
            reason: 'ambiguousPendingFormula' as const,
            pendingRowIds: [],
            tailRemovalIds: [],
            formulaCells: [{
                rowIdentity: { kind: 'source' as const, sourceRow: 0 },
                sourceColumn: 0,
            }],
        };
        expect(pending.install({ session_id: 'session-1' }, {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [conflict],
        })).toBe(true);
        await render_grid(capture_props(history, { pending_row_store: pending }));

        await act(async () => {
            cells_edited([{ location: [0, 0], value: 'resolved formula' }], 'edit');
        });

        expect(pending.snapshot().conflicts).toEqual([]);
        const action = history.snapshot().undoStack[0].action;
        expect(action.changes.map((change) => change.kind)).toEqual(['cell', 'pendingRows']);
        const structural = action.changes[1];
        if (structural.kind !== 'pendingRows') throw new Error('Expected structural history');
        expect(structural.delta.before.conflicts).toEqual([conflict]);
        expect(structural.delta.after.conflicts).toEqual([]);
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
