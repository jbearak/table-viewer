// @vitest-environment jsdom

// The grid's half of a held press of Undo or Redo (plan 2.3, 2.4): no gesture
// opens an editor or saves while a press is held, and work asked for before
// the press carries the ticket it took into the continuation that finishes it.

import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    AppendRowsAdmission,
    EditingHandle,
    GridShellProps,
    HighlightSelectionHandle,
    StructuralInsertAdmission,
    StructuralInsertRequest,
} from '../webview/grid-shell';
import { create_edit_session_store } from '../webview/edit-session-store';
import { create_history_store } from '../webview/history-store';
import { peek_history } from '../webview/history-stack-model';
import { create_pending_row_store, type PendingRowStore } from '../webview/pending-row-store';
import { button } from './helpers/dom-interaction';

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
            toRanges: () => sorted.map((value) => [value, value + 1] as [number, number]),
            hasIndex: (index: number) => sorted.includes(index),
            first: () => sorted[0],
            last: () => sorted[sorted.length - 1],
            add: (value: number | readonly [number, number]) => make([
                ...sorted,
                ...(typeof value === 'number'
                    ? [value]
                    : Array.from({ length: value[1] - value[0] }, (_, offset) => value[0] + offset)),
            ]),
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

type Cell = {
    kind: string;
    data?: unknown;
    allowOverlay?: boolean;
    readonly?: boolean;
};

const grid_mock = vi.hoisted(() => ({
    props: null as null | Record<string, unknown>,
    open_overlay: vi.fn((_cell: [number, number], _initial?: string): boolean => true),
    post_message: vi.fn(),
    get_row: vi.fn((_row?: number) => [] as unknown[]),
}));

vi.mock('../webview/glide-data-grid', () => {
    const React = require('react') as typeof import('react');
    return {
        CompactSelection: {
            empty: () => make_compact([]),
            fromSingleSelection: (value: number | readonly [number, number]) => (
                typeof value === 'number'
                    ? make_compact([value])
                    : make_compact(Array.from({ length: value[1] - value[0] }, (_, offset) => value[0] + offset))
            ),
        },
        DataEditor: React.forwardRef((props: unknown, ref: React.ForwardedRef<unknown>) => {
            grid_mock.props = props as Record<string, unknown>;
            React.useImperativeHandle(ref, () => ({
                updateCells: vi.fn(),
                scrollTo: vi.fn(),
                focus: vi.fn(),
                dismissOverlay: vi.fn(),
                openOverlay: grid_mock.open_overlay,
                getBounds: () => ({ x: 30, y: 10, width: 100, height: 36 }),
            }));
            return React.createElement('div', { className: 'data-editor-stub', tabIndex: 0 });
        }),
        GridCellKind: { Text: 'text', Custom: 'custom' },
        direction: () => 'ltr',
    };
});

vi.mock('../webview/use-row-loader', () => ({
    use_row_loader: () => {
        const resident = (source_row: number) => source_row >= 0 && source_row < 4;
        return {
            ensure_rows: vi.fn(),
            ensure_row_intervals: vi.fn(),
            ensure_rows_loaded: vi.fn(async () => true),
            trim_rows: vi.fn(),
            pin_rows: () => Symbol('pin'),
            unpin_rows: vi.fn(),
            get_row: grid_mock.get_row,
            get_source_row: (display_row: number) => display_row,
            get_cell_raw_for_source: (source_row: number, col: number) => {
                if (!resident(source_row)) return undefined;
                const cell = grid_mock.get_row(source_row)[col] as { raw?: string } | undefined;
                return cell ? String(cell.raw ?? '') : '';
            },
            get_cell_for_source: (source_row: number, col: number) => (
                resident(source_row) ? grid_mock.get_row(source_row)[col] ?? null : undefined
            ),
            has_source_row: resident,
            get_display_row_for_source: (source_row: number) => (resident(source_row) ? source_row : undefined),
            get_compare_status: () => undefined,
            get_compare_base: () => undefined,
            sample_loaded_rows: () => [],
            get_page_size: () => 100,
            present_saved_cells: () => {},
            restore_saved_cells: () => false,
            saved_cells_active: () => false,
            loaded_generation: () => 1,
            version: 0,
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
    tint_from_color: (_color: string, _alpha: number, fallback: string) => fallback,
}));

vi.mock('../webview/row-resize-overlay', () => ({
    RowResizeOverlay: React.forwardRef((_props: unknown, ref: React.ForwardedRef<unknown>) => {
        React.useImperativeHandle(ref, () => ({ set_target: vi.fn() }));
        return null;
    }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const overlay_roots: Root[] = [];

const plain = (raw: string) => ({ raw, formatted: raw, bold: false, italic: false });
/** Row 0's cells: column 2 carries a hyperlink, so it is drawn as rich text. */
function source_rows() {
    grid_mock.get_row.mockImplementation(() => [
        plain('source-a'),
        plain('source-b'),
        { ...plain('linked'), hyperlink: { kind: 'external', target: 'https://a.test/' } },
    ]);
}

afterEach(() => {
    for (const overlay of overlay_roots.splice(0)) act(() => overlay.unmount());
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
    grid_mock.props = null;
    grid_mock.open_overlay.mockReset();
    grid_mock.open_overlay.mockImplementation(() => true);
    grid_mock.post_message.mockReset();
    grid_mock.get_row.mockReset();
    vi.unstubAllGlobals();
});

/**
 * What App answers the grid, reduced to the rule of plan 2.3: a press made
 * takes the next epoch and is held; `gestures_admitted` is false while it is
 * held unless the ambient ticket was taken before the press.
 */
function fake_app(first_epoch = 3) {
    let epoch = first_epoch;
    let held = false;
    let ambient: number | undefined;
    const app = {
        history_press_held: vi.fn(() => held),
        on_history_hold_gesture: vi.fn(),
        gesture_ticket: vi.fn(() => epoch),
        with_gesture_ticket: vi.fn((ticket: number, run: () => unknown): unknown => {
            const before = ambient;
            ambient = ticket;
            try {
                return run();
            } finally {
                ambient = before;
            }
        }),
        gestures_admitted: vi.fn(() => !held || (ambient !== undefined && ambient < epoch)),
        /** A press of Undo or Redo is made, and held. No render. */
        press() {
            epoch += 1;
            held = true;
        },
        /** The held press has been carried out. */
        release() { held = false; },
        /** An earlier press that was carried out at once: the counter moved. */
        advance() { epoch += 1; },
        ambient: () => ambient,
    };
    const grid_props = {
        history_press_held: app.history_press_held,
        on_history_hold_gesture: app.on_history_hold_gesture,
        gesture_ticket: app.gesture_ticket,
        with_gesture_ticket: app.with_gesture_ticket as unknown as NonNullable<GridShellProps['with_gesture_ticket']>,
        gestures_admitted: app.gestures_admitted,
    } satisfies Partial<GridShellProps>;
    return { ...app, grid_props };
}

function base_props(overrides: Partial<GridShellProps> = {}): GridShellProps {
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
        edit_activation_id: 1,
        column_projection: {
            visible_to_source: [0, 1, 2],
            source_to_visible: [0, 1, 2],
            hidden_count: 0,
        },
        column_widths: { 0: 100, 1: 100, 2: 100 },
        on_columns_resized: vi.fn(),
        row_heights: {},
        on_row_resize: vi.fn(),
        merges: [],
        editing_session_held: true,
        csv_editable: true,
        edit_session_id: 'session',
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
    let current = initial;
    await act(async () => {
        root!.render(React.createElement(GridShell, current));
    });
    /** Render again with some props replaced, as App does when its state moves. */
    const rerender = async (next: Partial<GridShellProps> = {}) => {
        current = { ...current, ...next };
        await act(async () => {
            root!.render(React.createElement(GridShell, current));
        });
    };
    return { rerender };
}

const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const prop = <T,>(name: string) => grid_mock.props![name] as T;
const cell_content = (cell: [number, number]) => prop<(cell: [number, number]) => Cell>('getCellContent')(cell);
const open_request = (cell: [number, number], initial: string | undefined) => (
    prop<((cell: [number, number], initial: string | undefined) => boolean) | undefined>('onOverlayOpenRequest')!(cell, initial)
);
const provide_editor = (content: Cell) => (
    prop<(content: Cell) => { editor: unknown } | undefined>('provideEditor')(content)
);
async function select_cell(cell: [number, number]) {
    await act(async () => prop<(selection: unknown) => void>('onGridSelectionChange')({
        columns: make_compact([]),
        rows: make_compact([]),
        current: { cell, range: { x: cell[0], y: cell[1], width: 1, height: 1 }, rangeStack: [] },
    }));
}
/** A grant App settles from the test, like the host answering. */
function session_request() {
    let settle!: (granted: boolean) => void;
    const request = vi.fn((_quiet?: boolean) => new Promise<boolean>((resolve) => { settle = resolve; }));
    return { request, grant: () => settle(true), refuse: () => settle(false) };
}
const no_session = (request: () => Promise<boolean>) => ({
    editing_session_held: false,
    edit_session_id: undefined,
    on_request_edit_session: request,
}) satisfies Partial<GridShellProps>;
const granted_session = {
    editing_session_held: true,
    edit_session_id: 'session',
    on_request_edit_session: undefined,
} satisfies Partial<GridShellProps>;

/**
 * A Pending Column between source columns 0 and 1 and a Pending Row after
 * source row 0: display columns s:0, p:c1, s:1, s:2, display rows 0 (source)
 * and 1 (pending).
 */
function pending_with_row_and_column(): PendingRowStore {
    const pending = create_pending_row_store({ session_id: 'session' });
    expect(pending.install({ session_id: 'session' }, {
        formatTemplates: [],
        appendedRows: [],
        tailRemovals: [],
        conflicts: [],
        columnLayout: {
            columns: [
                { kind: 'source', sourceColumn: 0 },
                { kind: 'pending', pendingColumnId: 'c1' },
                { kind: 'source', sourceColumn: 1 },
                { kind: 'source', sourceColumn: 2 },
            ],
            removedSourceColumns: [],
            discardedPendingColumns: [],
        },
        pendingColumns: [{ id: 'c1', header: 'New', cells: {}, format: { kind: 'none' }, createdOrder: 1 }],
    })).toBe(true);
    expect(pending.append_rows('session', ['pending-row'], { id: 'plain', format: { kind: 'none' } }, 2)).toBe(true);
    return pending;
}


/**
 * A menu button by its label. The row menu keeps Insert and Move in
 * submenus, so an "Insert …" or "Move …" item not shown yet opens its
 * submenu first.
 */
function find_menu_item(label: string): HTMLButtonElement | undefined {
    const find = () => Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent === label);
    const found = find();
    if (found !== undefined) return found;
    const parent = /^(Insert|Move)\b/.exec(label)?.[1];
    const trigger = parent === undefined ? undefined : Array.from(document.querySelectorAll('button'))
        .filter((candidate) => candidate.getAttribute('aria-haspopup') === 'menu'
            && candidate.querySelector('.context-menu-label')?.textContent === parent)
        .at(-1); // the menu opened last, should an earlier one still be up
    if (trigger === undefined) return undefined;
    // flushSync, not act: callers often look an item up inside their own act,
    // where a nested act would not render the submenu until it returns.
    flushSync(() => trigger.click());
    return find();
}

describe('GridShell while a press of Undo or Redo is held', () => {
    const cells: Record<string, [number, number]> = {
        'a source cell': [0, 0],
        'a rich-text cell': [3, 0],
        'a Pending Row\'s cell': [0, 1],
        'a Pending Column\'s cell': [1, 0],
    };

    for (const session of ['under a session', 'with no session'] as const) {
        it(`opens no editor for a typed key or an activation, ${session}`, async () => {
            source_rows();
            const app = fake_app();
            const { request } = session_request();
            const editing_ref = React.createRef<EditingHandle | null>();
            const { rerender } = await render_grid(base_props({
                sheet_meta: { ...base_props().sheet_meta, columnCount: 3 },
                edit_session: create_edit_session_store({ session_id: 'session' }),
                pending_row_store: pending_with_row_and_column(),
                editing_ref,
                ...app.grid_props,
                ...(session === 'with no session' ? no_session(request) : {}),
            }));
            // The cells are what the test names.
            expect(cell_content(cells['a rich-text cell']!)).toMatchObject({
                kind: 'custom',
                data: { kind: 'rich-text' },
            });
            expect(cell_content(cells['a Pending Row\'s cell']!).kind).toBe('text');
            expect(prop<(column: number) => string | undefined>('getColumnAccessibilityLabel')(1))
                .toBe('Column B, inserted');
            expect(prop<(row: number) => string | undefined>('getRowAccessibilityLabel')(1))
                .toMatch(/Pending appended row 2$/);

            // Passed with a session and without one.
            expect(prop('onOverlayOpenRequest')).toBeTypeOf('function');
            const shown = () => Object.fromEntries(Object.entries(cells).map(([name, cell]) => {
                const content = cell_content(cell);
                return [name, {
                    allowOverlay: content.allowOverlay,
                    readonly: content.readonly,
                    editor: provide_editor(content)?.editor,
                }];
            }));
            const free = shown();
            if (session === 'under a session') {
                // Under a session every one of these cells takes its editor.
                for (const [name, cell] of Object.entries(free)) {
                    expect(cell.allowOverlay, name).toBe(true);
                    expect(cell.editor, name).toBeTypeOf('function');
                }
            }

            // The press is made, and the next key and the next double click
            // land in the same task: no render in between.
            app.press();
            let refusals = 0;
            for (const [name, cell] of Object.entries(cells)) {
                for (const initial of ['h', undefined]) {
                    expect(open_request(cell, initial), `${name} ${initial}`).toBe(true);
                    refusals += 1;
                    expect(app.on_history_hold_gesture).toHaveBeenCalledTimes(refusals);
                }
            }
            expect(request).not.toHaveBeenCalled();
            expect(editing_ref.current!.typing_pending()).toBe(false);
            expect(grid_mock.open_overlay).not.toHaveBeenCalled();
            // What each cell hands Glide is what it hands it with no press
            // held, before a render and after one.
            expect(shown()).toEqual(free);
            await rerender();
            expect(prop('onOverlayOpenRequest')).toBeTypeOf('function');
            expect(shown()).toEqual(free);
            await flush();
            expect(request).not.toHaveBeenCalled();
            expect(grid_mock.open_overlay).not.toHaveBeenCalled();

            // Carried out: the grid answers as it does today, and says nothing.
            app.release();
            app.on_history_hold_gesture.mockClear();
            if (session === 'under a session') {
                for (const [name, cell] of Object.entries(cells)) {
                    expect(open_request(cell, 'h'), name).toBe(false);
                    expect(open_request(cell, undefined), name).toBe(false);
                }
                expect(editing_ref.current!.typing_pending()).toBe(false);
            } else {
                expect(open_request(cells['a source cell']!, 'h')).toBe(true);
                expect(request).toHaveBeenCalledTimes(1);
                expect(editing_ref.current!.typing_pending()).toBe(true);
            }
            expect(app.on_history_hold_gesture).not.toHaveBeenCalled();
            expect(shown()).toEqual(free);
        });
    }

    it('refuses a Save, says so, and folds nothing', async () => {
        source_rows();
        const app = fake_app();
        const editing_ref = React.createRef<EditingHandle | null>();
        const edit_session = create_edit_session_store({ session_id: 'session' });
        const on_save_request = vi.fn(() => ({
            editSessionId: 'session',
            saveRequestId: 'save-1',
            worksheets: [],
        }));
        await render_grid(base_props({
            edit_session,
            editing_ref,
            on_save_request,
            ...app.grid_props,
        }));
        // An editor open on [0, 0] with text typed into it.
        await select_cell([0, 0]);
        const content = cell_content([0, 0]);
        const provided = provide_editor(content)!.editor as React.ComponentType<Record<string, unknown>>;
        const on_finished_editing = vi.fn();
        // Where Glide portals its overlay, and where the grid reads it from.
        const clip = document.body.appendChild(document.createElement('div'));
        clip.className = 'gdg-clip-region';
        const overlay = createRoot(clip);
        overlay_roots.push(overlay);
        await act(async () => overlay.render(React.createElement(provided, {
            value: content,
            initialValue: 'typed',
            onChange: vi.fn(),
            onFinishedEditing: on_finished_editing,
        })));
        const input = () => document.querySelector<HTMLInputElement | HTMLTextAreaElement>('.cell-editor-input');
        await vi.waitFor(() => expect(input()?.value).toBe('typed'));
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);

        app.press();
        let saved = true;
        await act(async () => { saved = editing_ref.current!.request_save(); });

        expect(saved).toBe(false);
        expect(app.on_history_hold_gesture).toHaveBeenCalledTimes(1);
        expect(on_save_request).not.toHaveBeenCalled();
        // Nothing folded: the editor is open with its text, and the store
        // holds no edit.
        expect([...edit_session.snapshot()]).toEqual([]);
        expect(input()?.value).toBe('typed');
        expect(on_finished_editing).not.toHaveBeenCalled();
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);

        // Carried out: the same Save folds the editor and goes through.
        app.release();
        await act(async () => { saved = editing_ref.current!.request_save(); });
        expect(saved).toBe(true);
        expect(on_save_request).toHaveBeenCalledTimes(1);
        expect(app.on_history_hold_gesture).toHaveBeenCalledTimes(1);
        expect([...edit_session.snapshot()]).toEqual([
            ['0:0', expect.objectContaining({ value: 'typed' })],
        ]);
    });
});

describe('GridShell work asked for before a press, carried out behind it', () => {
    it('settles a claim granted while the press is held, and runs its gesture under its ticket', async () => {
        source_rows();
        const app = fake_app(3);
        const { request, grant } = session_request();
        const editing_ref = React.createRef<EditingHandle | null>();
        const edit_session = create_edit_session_store({ session_id: 'session' });
        const { rerender } = await render_grid(base_props({
            edit_session,
            editing_ref,
            ...app.grid_props,
            ...no_session(request),
        }));
        const affordances = () => ({
            allowOverlay: cell_content([0, 0]).allowOverlay,
            readonly: cell_content([0, 0]).readonly,
            paste: prop('onPaste') === false ? 'refused' : 'accepted',
            open_request: typeof prop('onOverlayOpenRequest'),
        });
        expect(editing_ref.current!.gesture_pending()).toBe(false);

        // A delete made before any session: it asks for one, and takes its
        // ticket now.
        let result: unknown;
        await act(async () => {
            result = prop<(items: unknown[], source: string) => unknown>('onCellsEdited')(
                [{ location: [0, 0], value: { kind: 'text', data: '' } }],
                'delete',
            );
        });
        expect(result).toBe('refused');
        expect(request).toHaveBeenCalledTimes(1);
        expect(editing_ref.current!.gesture_pending()).toBe(true);
        const armed = affordances();
        expect(armed).toEqual({ allowOverlay: true, readonly: undefined, paste: 'refused', open_request: 'function' });

        // Undo is pressed before the host answers. The grid is told nothing
        // that changes what it renders.
        app.press();
        await rerender();
        expect(affordances()).toEqual(armed);
        expect(editing_ref.current!.gesture_pending()).toBe(true);

        // The grant lands and App renders the grid that holds the session,
        // with the press still held. The delete counts as pending until its
        // continuation has run, not only until the grant lands: no render in
        // between may find nothing pending and carry the press out first.
        const run_ticketed = app.with_gesture_ticket.getMockImplementation()!;
        const pending_while_continuing: boolean[] = [];
        app.with_gesture_ticket.mockImplementation((ticket: number, run: () => unknown) => {
            pending_while_continuing.push(editing_ref.current!.gesture_pending());
            return run_ticketed(ticket, run);
        });
        grant();
        await flush();
        await rerender(granted_session);
        await vi.waitFor(() => expect(editing_ref.current!.gesture_pending()).toBe(false));

        // The delete ran as the gesture made before the press.
        expect(app.with_gesture_ticket).toHaveBeenCalledWith(3, expect.any(Function));
        expect(pending_while_continuing).toEqual([true]);
        expect([...edit_session.snapshot()]).toEqual([
            ['0:0', expect.objectContaining({ value: '', base: 'source-a' })],
        ]);
        // Editable as it is with no press held.
        expect(affordances()).toEqual({ allowOverlay: true, readonly: undefined, paste: 'accepted', open_request: 'function' });
        app.release();
        await rerender();
        expect(affordances()).toEqual({ allowOverlay: true, readonly: undefined, paste: 'accepted', open_request: 'function' });
    });

    const admission = (row_ids: readonly string[], ambient: () => number | undefined) => {
        const calls: { ambient: number | undefined }[] = [];
        const settled: { accepted: boolean; ambient: number | undefined }[] = [];
        const answers: ((value: AppendRowsAdmission | undefined) => void)[] = [];
        const on_append_rows = vi.fn((_count: number) => {
            calls.push({ ambient: ambient() });
            return new Promise<AppendRowsAdmission | undefined>((resolve) => { answers.push(resolve); });
        });
        const answer = (index: number) => answers[index]!({
            rowIds: [row_ids[index]!],
            formatTemplate: { id: 'plain', format: { kind: 'none' } },
            appendBasis: {
                sourceRowCount: 1,
                provisionalStartRow: 1,
                ...(index > 0 ? { provisionalRowCount: 1 + index } : {}),
                columnCount: 3,
                schemaFingerprint: 'schema',
            },
            settle: (accepted) => { settled.push({ accepted, ambient: ambient() }); },
        });
        return { calls, settled, on_append_rows, answer };
    };
    const open_append_dock = async () => {
        const launcher = document.querySelector<HTMLButtonElement>('.append-dock-launcher');
        if (!launcher) throw new Error('append dock launcher is not rendered');
        await act(async () => { launcher.click(); });
    };

    it('installs an append already waiting for admission when the press is made', async () => {
        source_rows();
        const app = fake_app(3);
        const editing_ref = React.createRef<EditingHandle | null>();
        const pending = create_pending_row_store({ session_id: 'session' });
        const history = create_history_store();
        const host = admission(['host-row-1'], app.ambient);
        const { rerender } = await render_grid(base_props({
            edit_session: create_edit_session_store({ session_id: 'session' }),
            pending_row_store: pending,
            history_store: history,
            on_append_rows: host.on_append_rows,
            editing_ref,
            ...app.grid_props,
        }));
        const editable_before = cell_content([0, 0]).allowOverlay;
        await open_append_dock();
        await act(async () => { button('Add row').click(); });
        await vi.waitUntil(() => host.calls.length === 1);
        // Posted as the gesture it is, and counted until it has finished.
        expect(host.calls[0]).toEqual({ ambient: 3 });
        expect(editing_ref.current!.gesture_pending()).toBe(true);

        app.press();
        await rerender();
        expect(cell_content([0, 0]).allowOverlay).toBe(editable_before);
        await act(async () => host.answer(0));
        await vi.waitFor(() => expect(host.settled).toEqual([{ accepted: true, ambient: 3 }]));

        expect(pending.snapshot().appendedRows.map((row) => row.id)).toEqual(['host-row-1']);
        const undo = peek_history(history.snapshot(), 'undo');
        expect(undo.kind === 'available' && undo.entry.action.label).toBe('Append row');
        await vi.waitFor(() => expect(editing_ref.current!.gesture_pending()).toBe(false));
    });

    it('runs two Quick adds, the second queued behind the first, each under its own ticket', async () => {
        source_rows();
        const app = fake_app(3);
        const editing_ref = React.createRef<EditingHandle | null>();
        const pending = create_pending_row_store({ session_id: 'session' });
        const host = admission(['host-row-1', 'host-row-2'], app.ambient);
        await render_grid(base_props({
            edit_session: create_edit_session_store({ session_id: 'session' }),
            pending_row_store: pending,
            on_append_rows: host.on_append_rows,
            editing_ref,
            ...app.grid_props,
        }));
        await open_append_dock();
        // Two clicks in one task: the dock has not yet rendered itself busy.
        const add = button('Add row');
        await act(async () => {
            add.click();
            // An earlier press, carried out at once, moved the counter
            // between the two clicks, so their tickets differ.
            app.advance();
            add.click();
        });
        await vi.waitUntil(() => host.calls.length === 1);
        expect(app.gesture_ticket.mock.results.map((result) => result.value)).toEqual([3, 4]);

        // Undo is pressed before the second request is posted.
        app.press();
        expect(app.gesture_ticket()).toBe(5);
        await act(async () => host.answer(0));
        await vi.waitUntil(() => host.calls.length === 2);
        await act(async () => host.answer(1));
        await vi.waitFor(() => expect(host.settled).toHaveLength(2));

        expect(host.calls).toEqual([{ ambient: 3 }, { ambient: 4 }]);
        expect(host.settled).toEqual([
            { accepted: true, ambient: 3 },
            { accepted: true, ambient: 4 },
        ]);
        expect(pending.snapshot().appendedRows.map((row) => row.id)).toEqual(['host-row-1', 'host-row-2']);
        await vi.waitFor(() => expect(editing_ref.current!.gesture_pending()).toBe(false));
    });

    it('installs a row insert already waiting for admission when the press is made', async () => {
        source_rows();
        const app = fake_app(3);
        const editing_ref = React.createRef<EditingHandle | null>();
        const pending = create_pending_row_store({ session_id: 'session' });
        const history = create_history_store();
        const basis = {
            kind: 'delimited' as const,
            byteLength: 10,
            digest: 'digest',
            sourceRowCount: 4,
            sourceColumnCount: 3,
        };
        const settled: boolean[] = [];
        let grant!: () => void;
        const on_insert_rows = vi.fn((_request: StructuralInsertRequest) => (
            new Promise<StructuralInsertAdmission | undefined>((resolve) => {
                grant = () => resolve({
                    rowIds: ['ins-a'],
                    formatTemplate: { id: 'plain', format: { kind: 'none' } },
                    structuralBasis: basis,
                    appendBasis: { sourceRowCount: 4, columnCount: 3, schemaFingerprint: 'sha256:x' },
                    settle: (accepted) => { settled.push(accepted); },
                });
            })
        ));
        const { rerender } = await render_grid(base_props({
            sheet_meta: { ...base_props().sheet_meta, rowCount: 4, sourceRowCount: 4 },
            row_count: 4,
            transform_sections: true,
            structural_support: { rows: { supported: true }, columns: { supported: true }, basis },
            edit_session: create_edit_session_store({ session_id: 'session' }),
            pending_row_store: pending,
            history_store: history,
            on_insert_rows,
            editing_ref,
            ...app.grid_props,
        }));
        await act(async () => prop<(cell: [number, number], event: Record<string, unknown>) => void>(
            'onCellContextMenu',
        )([-1, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 24, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        const insert = find_menu_item('Insert row below')!;
        await act(async () => insert.click());
        expect(on_insert_rows).toHaveBeenCalledTimes(1);
        expect(app.gesture_ticket).toHaveBeenCalledTimes(1);

        app.press();
        await rerender();
        await act(async () => grant());
        await vi.waitFor(() => expect(settled).toEqual([true]));

        expect(app.with_gesture_ticket).toHaveBeenCalledWith(3, expect.any(Function));
        expect(pending.snapshot().rowLayout?.runs).toEqual([
            { kind: 'source', start: 0, count: 1 },
            { kind: 'pending', ids: ['ins-a'] },
            { kind: 'source', start: 1, count: 3 },
        ]);
        const undo = peek_history(history.snapshot(), 'undo');
        expect(undo.kind === 'available' && undo.entry.action.label).toBe('Insert row');
    });

    it('says a row or column structure gesture made while a press is held was not applied', async () => {
        source_rows();
        const app = fake_app(3);
        const basis = {
            kind: 'delimited' as const,
            byteLength: 10,
            digest: 'digest',
            sourceRowCount: 4,
            sourceColumnCount: 3,
        };
        const on_insert_rows = vi.fn(async (_request: StructuralInsertRequest) => undefined);
        const history = create_history_store();
        await render_grid(base_props({
            sheet_meta: { ...base_props().sheet_meta, rowCount: 4, sourceRowCount: 4 },
            row_count: 4,
            transform_sections: true,
            structural_support: { rows: { supported: true }, columns: { supported: true }, basis },
            edit_session: create_edit_session_store({ session_id: 'session' }),
            pending_row_store: create_pending_row_store({ session_id: 'session' }),
            history_store: history,
            on_insert_rows,
            ...app.grid_props,
        }));
        const open_row_menu = () => act(async () => prop<(cell: [number, number], event: Record<string, unknown>) => void>(
            'onCellContextMenu',
        )([-1, 0], {
            preventDefault: vi.fn(),
            bounds: { x: 0, y: 24, width: 40, height: 24 },
            localEventX: 10,
            localEventY: 10,
        }));
        const click = async (label: string) => {
            const item = find_menu_item(label);
            expect(item, label).toBeDefined();
            await act(async () => item!.click());
        };
        // Each menu was opened before the press, and is clicked while it is held.
        // (A menu opened while a press is held offers these items disabled.)
        await open_row_menu();
        app.press();
        await click('Insert row below');
        expect(on_insert_rows).not.toHaveBeenCalled();
        expect(app.on_history_hold_gesture).toHaveBeenCalledTimes(1);

        app.release();
        await open_row_menu();
        app.press();
        await click('Delete row');
        expect(app.on_history_hold_gesture).toHaveBeenCalledTimes(2);

        expect(prop<(rows: { start: number; end: number }) => boolean>('canMoveRows')({ start: 0, end: 1 })).toBe(false);
        expect(app.on_history_hold_gesture).toHaveBeenCalledTimes(3);
        expect(history.snapshot().undoStack).toEqual([]);
    });

    it('says a highlight made while a press is held was not applied', async () => {
        source_rows();
        const app = fake_app(3);
        const highlight_ref: { current: HighlightSelectionHandle | null } = { current: null };
        const on_highlight_selection = vi.fn();
        await render_grid(base_props({
            edit_session: create_edit_session_store({ session_id: 'session' }),
            history_store: create_history_store(),
            highlight_ref,
            on_highlight_selection,
            ...app.grid_props,
        }));
        await select_cell([0, 0]);
        app.press();

        expect(highlight_ref.current!.apply('yellow')).toBe(false);
        expect(highlight_ref.current!.clear()).toBe(false);
        expect(on_highlight_selection).not.toHaveBeenCalled();
        expect(app.on_history_hold_gesture).toHaveBeenCalledTimes(2);
    });

    it('runs a paste that has no entry in the queue under no ticket: refused while a press is held, applied when none is', async () => {
        source_rows();
        const app = fake_app(3);
        const editing_ref = React.createRef<EditingHandle | null>();
        const edit_session = create_edit_session_store({ session_id: 'session' });
        await render_grid(base_props({
            edit_session,
            editing_ref,
            ...app.grid_props,
        }));
        // An earlier paste went through the hook and has finished: its
        // ticket is no longer the head of the queue.
        let finish!: () => void;
        await act(async () => {
            await prop<(pasted: Promise<void>) => Promise<unknown>>('onPasteAdmission')(
                new Promise<void>((resolve) => { finish = resolve; }),
            );
        });
        expect(editing_ref.current!.gesture_pending()).toBe(true);
        finish();
        await vi.waitFor(() => expect(editing_ref.current!.gesture_pending()).toBe(false));

        // A paste whose event found focus outside the grid: Glide never
        // called the hook, and then runs it.
        const run_paste = () => {
            let result: unknown;
            act(() => {
                result = prop<(items: unknown[], source: string) => unknown>('onCellsEdited')(
                    [{ location: [1, 0], value: { kind: 'text', data: 'pasted' } }],
                    'paste',
                );
            });
            return result;
        };
        app.press();
        app.with_gesture_ticket.mockClear();
        expect(run_paste()).toBe('refused');
        expect(app.with_gesture_ticket).not.toHaveBeenCalled();
        expect([...edit_session.snapshot()]).toEqual([]);

        app.release();
        expect(run_paste()).not.toBe('refused');
        expect([...edit_session.snapshot()]).toEqual([
            ['0:1', expect.objectContaining({ value: 'pasted' })],
        ]);
    });
});

describe('GridShell telling App held keys have reached an editor, or will not', () => {
    /** Glide's openOverlay: mounts the editor before it returns. */
    function open_editors_as_glide_does() {
        grid_mock.open_overlay.mockImplementation((cell, initial) => {
            const content = cell_content(cell);
            const { editor } = provide_editor(content) as { editor: React.ComponentType<Record<string, unknown>> };
            const overlay = createRoot(document.body.appendChild(document.createElement('div')));
            overlay_roots.push(overlay);
            act(() => overlay.render(React.createElement(editor, {
                value: content,
                initialValue: initial,
                onChange: vi.fn(),
                onFinishedEditing: vi.fn(),
            })));
            return true;
        });
    }

    it('calls on_held_typing_end once the editor for the held keys has mounted, in a microtask', async () => {
        source_rows();
        open_editors_as_glide_does();
        const on_held_typing_end = vi.fn();
        const { request, grant } = session_request();
        const editing_ref = React.createRef<EditingHandle | null>();
        const { rerender } = await render_grid(base_props({
            edit_session: create_edit_session_store({ session_id: 'session' }),
            editing_ref,
            on_held_typing_end,
            ...no_session(request),
        }));
        await select_cell([0, 0]);
        expect(open_request([0, 0], 'h')).toBe(true);
        expect(editing_ref.current!.typing_pending()).toBe(true);
        grant();
        await flush();
        expect(on_held_typing_end).not.toHaveBeenCalled();

        let called_in_task: number | undefined;
        grid_mock.open_overlay.mockImplementationOnce((cell, initial) => {
            const content = cell_content(cell);
            const { editor } = provide_editor(content) as { editor: React.ComponentType<Record<string, unknown>> };
            const overlay = createRoot(document.body.appendChild(document.createElement('div')));
            overlay_roots.push(overlay);
            act(() => overlay.render(React.createElement(editor, {
                value: content,
                initialValue: initial,
                onChange: vi.fn(),
                onFinishedEditing: vi.fn(),
            })));
            // The editor's mount effect has run; App is told after it.
            called_in_task = on_held_typing_end.mock.calls.length;
            return true;
        });
        await rerender(granted_session);
        await vi.waitFor(() => expect(on_held_typing_end).toHaveBeenCalledTimes(1));
        expect(called_in_task).toBe(0);
        expect(grid_mock.open_overlay).toHaveBeenCalledWith([0, 0], 'h');
        expect(editing_ref.current!.typing_pending()).toBe(false);
        expect(document.querySelector<HTMLInputElement | HTMLTextAreaElement>('.cell-editor-input')?.value).toBe('h');
    });

    it('calls on_held_typing_end when the intent ends with no editor', async () => {
        source_rows();
        open_editors_as_glide_does();
        const on_held_typing_end = vi.fn();
        const { request, refuse } = session_request();
        const editing_ref = React.createRef<EditingHandle | null>();
        await render_grid(base_props({
            edit_session: create_edit_session_store({ session_id: 'session' }),
            editing_ref,
            on_held_typing_end,
            ...no_session(request),
        }));
        await select_cell([0, 0]);
        expect(open_request([0, 0], 'h')).toBe(true);
        expect(editing_ref.current!.typing_pending()).toBe(true);

        // The host refuses the session: nothing will open.
        refuse();
        await vi.waitFor(() => expect(on_held_typing_end).toHaveBeenCalledTimes(1));
        expect(grid_mock.open_overlay).not.toHaveBeenCalled();
        expect(editing_ref.current!.typing_pending()).toBe(false);
    });
    it('tells App when the Add rows dock opened for a session has run, so a press held behind its claim asks again', async () => {
        source_rows();
        const app = fake_app(3);
        const { request, grant } = session_request();
        const on_edit_session_idle = vi.fn();
        const { rerender } = await render_grid(base_props({
            ...app.grid_props,
            ...no_session(request),
            pending_row_store: create_pending_row_store({ session_id: 'session' }),
            on_append_rows: vi.fn(async () => undefined),
            on_edit_session_idle,
        }));

        const launcher = document.querySelector('.append-dock-launcher') as HTMLButtonElement;
        expect(launcher).not.toBeNull();
        await act(async () => { launcher.click(); });
        expect(request).toHaveBeenCalledTimes(1);
        app.press();
        on_edit_session_idle.mockClear();
        grant();
        await flush();
        await rerender(granted_session);

        await vi.waitFor(() => expect(on_edit_session_idle).toHaveBeenCalled());
    });
    it('says a delete made while a press is held was not applied, and leaves a refused paste to Glide', async () => {
        source_rows();
        const app = fake_app(3);
        const edit_session = create_edit_session_store({ session_id: 'session' });
        await render_grid(base_props({ edit_session, ...app.grid_props, ...granted_session }));
        app.press();
        const edit = (source: string) => prop<(items: unknown[], source: string) => unknown>('onCellsEdited')(
            [{ location: [0, 0], value: { kind: 'text', data: '' } }],
            source,
        );

        let result: unknown;
        await act(async () => { result = edit('delete'); });
        expect(result).toBe('refused');
        expect(app.on_history_hold_gesture).toHaveBeenCalledTimes(1);
        await act(async () => { result = edit('paste'); });
        expect(result).toBe('refused');
        expect(app.on_history_hold_gesture).toHaveBeenCalledTimes(1);
        expect([...edit_session.snapshot()]).toEqual([]);
    });
    it('tells App a delete made before the press recorded nothing when its session is refused', async () => {
        source_rows();
        const app = fake_app(3);
        const { request, refuse } = session_request();
        const on_gesture_unrecorded = vi.fn();
        const edit_session = create_edit_session_store({ session_id: 'session' });
        await render_grid(base_props({
            edit_session,
            ...app.grid_props,
            ...no_session(request),
            on_gesture_unrecorded,
        }));
        await act(async () => {
            prop<(items: unknown[], source: string) => unknown>('onCellsEdited')(
                [{ location: [0, 0], value: { kind: 'text', data: '' } }],
                'delete',
            );
        });
        app.press();
        refuse();
        await flush();

        await vi.waitFor(() => expect(on_gesture_unrecorded).toHaveBeenCalledWith(3));
        expect([...edit_session.snapshot()]).toEqual([]);
    });
    it('tells App a paste recorded nothing when it finishes with no edit taken, and not when its edit was', async () => {
        source_rows();
        const app = fake_app(3);
        const on_gesture_unrecorded = vi.fn();
        const edit_session = create_edit_session_store({ session_id: 'session' });
        await render_grid(base_props({ edit_session, ...app.grid_props, on_gesture_unrecorded }));
        const paste = async (run: () => void) => {
            let finish!: () => void;
            await act(async () => {
                await prop<(pasted: Promise<void>) => Promise<unknown>>('onPasteAdmission')(
                    new Promise<void>((resolve) => { finish = resolve; }),
                );
            });
            await act(async () => { run(); });
            finish();
            await flush();
        };
        const edit = (data: string) => prop<(items: unknown[], source: string) => unknown>('onCellsEdited')(
            [{ location: [1, 0], value: { kind: 'text', data } }],
            'paste',
        );

        // Glide gave up before any edit (its rows or rectangle refused).
        await paste(() => {});
        await vi.waitFor(() => expect(on_gesture_unrecorded).toHaveBeenCalledTimes(1));
        expect(on_gesture_unrecorded).toHaveBeenLastCalledWith(3);

        // Its edit taken: nothing to report.
        await paste(() => { expect(edit('pasted')).not.toBe('refused'); });
        expect(on_gesture_unrecorded).toHaveBeenCalledTimes(1);

        // Its edit refused (here a press made before the paste holds the gate).
        app.press();
        await paste(() => { expect(edit('again')).toBe('refused'); });
        await vi.waitFor(() => expect(on_gesture_unrecorded).toHaveBeenCalledTimes(2));
    });
});
