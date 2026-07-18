// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage } from '../types';
import type { WorkbookMeta } from '../data-source/interface';

const grid_shell_mock = vi.hoisted(() => ({
    is_dirty: false,
    has_live_uncommitted: false,
    has_uncommitted_changes: false,
    mount_count: 0,
    on_editing_change: null as null | ((status: { is_dirty: boolean; has_live_uncommitted: boolean; edits: Record<string, { value: string; base: string }>; conflicted: string[] }) => void),
    request_save: vi.fn(() => false),
    clear_dirty: vi.fn(),
    discard_conflicted: vi.fn(),
    commit_live_edit: vi.fn(),
    auto_fit_result: { 0: 120 } as Record<number, number> | null,
    latest_props: null as Record<string, unknown> | null,
}));

// Glide's DataEditor renders to a <canvas>, which jsdom can't drive. Replace the
// grid with a DOM stub that surfaces the props App feeds it (sheet index,
// generation, formatting flag, preview flag, column widths) and exposes a button
// that fires `on_column_resize`, so we can exercise App's wiring without canvas.
vi.mock('../webview/grid-shell', () => ({
    GridShell: (props: {
        sheet_index: number;
        generation: number;
        row_count?: number;
        transformed?: boolean;
        show_formatting: boolean;
        preview_mode?: boolean;
        column_projection: {
            visible_to_source: number[];
            source_to_visible: (number | undefined)[];
        };
        column_widths: Record<number, number>;
        row_heights: Record<number, number>;
        merges: { startRow: number }[];
        edit_mode?: boolean;
        initial_edits?: Record<string, string | { value: string; base: string }>;
        on_editing_change?: (status: { is_dirty: boolean; has_live_uncommitted: boolean; edits: Record<string, { value: string; base: string }>; conflicted: string[] }) => void;
        editing_ref?: {
            current: {
                request_save: () => boolean;
                clear_dirty: () => void;
                discard_conflicted: () => void;
                commit_live_edit: () => void;
                has_uncommitted_changes: () => boolean;
            } | null;
        };
        on_column_resize: (col: number, width: number) => void;
        on_row_resize: (row: number, height: number) => void;
        auto_fit_ref?: {
            current: (() => Record<number, number> | null) | null;
        };
        transform_sections: boolean;
        transform_pending: boolean;
        on_open_filter: (source_column: number, anchor: { left: number; top: number }, restore_focus: () => void) => void;
    }) => {
        grid_shell_mock.latest_props = props as unknown as Record<string, unknown>;
        const mount_id = React.useRef(++grid_shell_mock.mount_count);
        React.useEffect(() => {
            grid_shell_mock.on_editing_change = props.on_editing_change ?? null;
            grid_shell_mock.on_editing_change?.({
                is_dirty: grid_shell_mock.is_dirty,
                has_live_uncommitted: grid_shell_mock.has_live_uncommitted,
                edits: grid_shell_mock.is_dirty ? { '0:0': { value: 'dirty', base: 'base' } } : {},
                conflicted: [],
            });
            return () => {
                grid_shell_mock.on_editing_change = null;
            };
        }, [props.on_editing_change]);
        if (props.editing_ref) {
            props.editing_ref.current = {
                request_save: grid_shell_mock.request_save,
                clear_dirty: grid_shell_mock.clear_dirty,
                discard_conflicted: grid_shell_mock.discard_conflicted,
                commit_live_edit: grid_shell_mock.commit_live_edit,
                has_uncommitted_changes: () => grid_shell_mock.has_uncommitted_changes,
            };
        }
        // Mirror the real GridShell: publish a measure function into the ref so
        // App's auto-fit toggle has fitted widths to apply.
        if (props.auto_fit_ref) {
            props.auto_fit_ref.current = () => grid_shell_mock.auto_fit_result;
        }
        return React.createElement(
            'div',
            {
                className: 'grid-shell-stub',
                'data-sheet-index': String(props.sheet_index),
                'data-generation': String(props.generation),
                'data-row-count': String(props.row_count ?? ''),
                'data-transformed': String(props.transformed ?? false),
                'data-show-formatting': String(props.show_formatting),
                'data-preview': String(props.preview_mode ?? false),
                'data-edit-mode': String(props.edit_mode ?? false),
                'data-initial-edits': JSON.stringify(props.initial_edits ?? null),
                'data-mount-id': String(mount_id.current),
                'data-projection': JSON.stringify(props.column_projection.visible_to_source),
                'data-source-to-visible': JSON.stringify(props.column_projection.source_to_visible),
                'data-col-widths': JSON.stringify(props.column_widths),
                'data-row-heights': JSON.stringify(props.row_heights),
                'data-merges': String(props.merges?.length ?? 0),
                'data-merges-json': JSON.stringify(props.merges ?? []),
            },
            React.createElement(
                'button',
                {
                    className: 'stub-resize',
                    onClick: () => props.on_column_resize(2, 222),
                },
                'resize'
            ),
            React.createElement(
                'button',
                {
                    className: 'stub-row-resize',
                    onClick: () => props.on_row_resize(3, 50),
                },
                'row-resize'
            )
        );
    },
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function make_meta(sheet_names: string[], has_formatting = true): WorkbookMeta {
    return {
        hasFormatting: has_formatting,
        sheets: sheet_names.map((name) => ({
            name,
            rowCount: 1,
            columnCount: 1,
            merges: [],
            hasFormatting: has_formatting,
        })),
    };
}

async function render_app() {
    vi.resetModules();
    const post_message = vi.fn();

    vi.stubGlobal('acquireVsCodeApi', () => ({
        postMessage: post_message,
        getState: vi.fn(),
        setState: vi.fn(),
    }));

    const { App } = await import('../webview/app');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
        root!.render(React.createElement(App));
    });

    return { post_message };
}

async function dispatch_host_message(msg: HostMessage) {
    await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data: msg }));
    });
}

function get_button(label: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === label
    );
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
}

async function click_button(label: string) {
    await act(async () => {
        get_button(label).click();
    });
}

function columns_trigger(): HTMLButtonElement {
    const trigger = document.querySelector<HTMLButtonElement>(
        '.column-visibility-trigger',
    );
    expect(trigger).not.toBeNull();
    return trigger!;
}

async function open_columns() {
    await act(async () => columns_trigger().click());
    expect(document.querySelector('[role="dialog"][aria-label="Choose visible columns"]'))
        .not.toBeNull();
}

async function enter_edit_mode(post_message: ReturnType<typeof vi.fn>) {
    await click_button('Edit');
    expect(post_message).toHaveBeenCalledWith({ type: 'requestEditSession' });
    await dispatch_host_message({ type: 'editSessionResult', granted: true });
}

async function report_grid_editing(
    dirty: boolean,
    uncommitted = dirty,
    conflicted: string[] = [],
) {
    // The overlay-attributable part of "uncommitted" is whatever is uncommitted
    // beyond the committed dirty map — i.e. an open overlay differing from base.
    const has_live_uncommitted = uncommitted && !dirty;
    grid_shell_mock.is_dirty = dirty;
    grid_shell_mock.has_live_uncommitted = has_live_uncommitted;
    grid_shell_mock.has_uncommitted_changes = uncommitted;
    await act(async () => {
        grid_shell_mock.on_editing_change?.({
            is_dirty: dirty,
            has_live_uncommitted,
            edits: dirty ? { '0:0': { value: 'dirty', base: 'base' } } : {},
            conflicted,
        });
    });
}

function grid_stub(): HTMLDivElement {
    const stub = container!.querySelector('.grid-shell-stub');
    expect(stub).not.toBeNull();
    return stub as HTMLDivElement;
}

function sheet_meta_message(
    meta: WorkbookMeta,
    extra: Partial<Extract<HostMessage, { type: 'sheetMeta' }>> = {}
): HostMessage {
    return {
        type: 'sheetMeta',
        meta,
        state: {},
        defaultTabOrientation: 'horizontal',
        generation: 1,
        sourceGeneration: 1,
        ...extra,
    };
}

function meta_reload_message(
    meta: WorkbookMeta,
    extra: Partial<Extract<HostMessage, { type: 'metaReload' }>> = {}
): HostMessage {
    return {
        type: 'metaReload',
        meta,
        generation: 2,
        sourceGeneration: 2,
        ...extra,
    };
}

function cleanup() {
    act(() => {
        root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
    grid_shell_mock.is_dirty = false;
    grid_shell_mock.has_live_uncommitted = false;
    grid_shell_mock.has_uncommitted_changes = false;
    grid_shell_mock.mount_count = 0;
    grid_shell_mock.on_editing_change = null;
    grid_shell_mock.request_save.mockReset();
    grid_shell_mock.request_save.mockReturnValue(false);
    grid_shell_mock.clear_dirty.mockReset();
    grid_shell_mock.discard_conflicted.mockReset();
    grid_shell_mock.commit_live_edit.mockReset();
    grid_shell_mock.auto_fit_result = { 0: 120 };
    vi.useRealTimers();
    vi.unstubAllGlobals();
}

afterEach(() => {
    cleanup();
});

describe('initial render', () => {
    it('shows a loading placeholder before any message arrives', async () => {
        await render_app();
        expect(container!.querySelector('.loading')).not.toBeNull();
        expect(container!.querySelector('.grid-shell-stub')).toBeNull();
    });

    it('posts a ready message on mount', async () => {
        const { post_message } = await render_app();
        expect(post_message).toHaveBeenCalledWith({ type: 'ready' });
    });

    it('mounts the grid and toolbar after sheetMeta', async () => {
        await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        expect(container!.querySelector('.grid-shell-stub')).not.toBeNull();
        expect(get_button('Auto-fit Columns')).toBeDefined();
    });

    it('threads sheet index and generation into the grid', async () => {
        await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        expect(grid_stub().getAttribute('data-generation')).toBe('1');
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');

        await dispatch_host_message(meta_reload_message(make_meta(['Sheet1'])));
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
    });
});

describe('formatting toggle', () => {
    it('passes show_formatting to the grid and flips it on toggle', async () => {
        await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));

        // Defaults on.
        expect(grid_stub().getAttribute('data-show-formatting')).toBe('true');

        await click_button('Formatting');
        expect(grid_stub().getAttribute('data-show-formatting')).toBe('false');
    });

    it('hides the Formatting button when the workbook has no formatting', async () => {
        await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false))
        );
        const formatting = Array.from(
            container!.querySelectorAll('button')
        ).find((b) => b.textContent === 'Formatting');
        expect(formatting).toBeUndefined();
    });
});

describe('sheet tabs', () => {
    it('hides tabs and the vertical-tabs button for a single sheet', async () => {
        await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Only'])));
        const vtab = Array.from(container!.querySelectorAll('button')).find(
            (b) => b.textContent === 'Vertical Tabs'
        );
        expect(vtab).toBeUndefined();
    });

    it('switches the active sheet and persists the selection', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['First', 'Second']))
        );
        post_message.mockClear();

        await click_button('Second');

        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(post_message).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'stateChanged',
                state: expect.objectContaining({ activeSheetIndex: 1 }),
            })
        );
    });
});

describe('column width persistence', () => {
    it('stores a column resize per sheet and persists it', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        post_message.mockClear();

        await act(async () => {
            (container!.querySelector('.stub-resize') as HTMLButtonElement).click();
        });

        // Grid receives the updated width for column 2.
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({
            2: 222,
        });
        // And it is persisted under the active sheet's column-width slot.
        const last = post_message.mock.calls.at(-1)![0];
        expect(last.type).toBe('stateChanged');
        expect(last.state.columnWidths[0]).toEqual({ 2: 222 });
    });

    it('restores saved column widths from sheetMeta state', async () => {
        await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1']), {
                state: { columnWidths: [{ 0: 150 }] },
            })
        );
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({
            0: 150,
        });
    });
});

describe('column visibility projection', () => {
    it('hydrates a schema-safe non-contiguous projection', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 5;
        await dispatch_host_message(sheet_meta_message(meta, {
            state: {
                columnVisibility: [{
                    hiddenColumns: [3, 1],
                    schema: '["Sheet1",5,null]',
                }],
            },
        }));

        expect(JSON.parse(grid_stub().getAttribute('data-projection')!))
            .toEqual([0, 2, 4]);
        expect(JSON.parse(grid_stub().getAttribute('data-source-to-visible')!))
            .toEqual([0, null, 1, null, 2]);
        expect(post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'stateChanged')?.state.columnVisibility)
            .toEqual([{
                hiddenColumns: [1, 3],
                schema: '["Sheet1",5,null]',
            }]);
    });

    it('sanitizes invalid columns and persists the corrected descriptor', async () => {
        const { post_message } = await render_app();
        post_message.mockClear();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 3;
        await dispatch_host_message(sheet_meta_message(meta, {
            state: {
                columnVisibility: [{
                    hiddenColumns: [2, 9, -1, 2],
                    schema: '["Sheet1",3,null]',
                }],
            },
        }));

        expect(JSON.parse(grid_stub().getAttribute('data-projection')!))
            .toEqual([0, 1]);
        const persisted = post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'stateChanged');
        expect(persisted.state.columnVisibility).toEqual([{
            hiddenColumns: [2],
            schema: '["Sheet1",3,null]',
        }]);
    });

    it('drops stale visibility on load and reload', async () => {
        const { post_message } = await render_app();
        const initial = make_meta(['Sheet1']);
        initial.sheets[0].columnCount = 3;
        await dispatch_host_message(sheet_meta_message(initial, {
            state: {
                columnVisibility: [{
                    hiddenColumns: [1],
                    schema: '["Old",3,null]',
                }],
            },
        }));
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!))
            .toEqual([0, 1, 2]);

        await dispatch_host_message(sheet_meta_message(initial, {
            state: {
                columnVisibility: [{
                    hiddenColumns: [1],
                    schema: '["Sheet1",3,null]',
                }],
            },
            generation: 2,
        }));
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!))
            .toEqual([0, 2]);

        post_message.mockClear();
        const reloaded = make_meta(['Renamed']);
        reloaded.sheets[0].columnCount = 3;
        await dispatch_host_message(meta_reload_message(reloaded));
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!))
            .toEqual([0, 1, 2]);
        const persisted = post_message.mock.calls.at(-1)![0];
        expect(persisted.state.columnVisibility).toEqual([undefined]);
    });

    it('supports an all-hidden projection', async () => {
        await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 2;
        await dispatch_host_message(sheet_meta_message(meta, {
            state: {
                columnVisibility: [{
                    hiddenColumns: [0, 1],
                    schema: '["Sheet1",2,null]',
                }],
            },
        }));
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!)).toEqual([]);
    });

    it('toggles and restores source columns with immediate per-sheet persistence only', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1', 'Sheet2']);
        meta.sheets[0].columnCount = 3;
        meta.sheets[0].columnNames = ['Name', 'Value', 'Notes'];
        meta.sheets[1].columnCount = 2;
        await dispatch_host_message(sheet_meta_message(meta, {
            state: {
                columnVisibility: [undefined, {
                    hiddenColumns: [1],
                    schema: '["Sheet2",2,null]',
                }],
            },
        }));
        post_message.mockClear();
        const mount_id = grid_stub().getAttribute('data-mount-id');
        const generation = grid_stub().getAttribute('data-generation');

        await open_columns();
        const value_checkbox = document.querySelector<HTMLInputElement>(
            'input[aria-label^="Hide Value;"]',
        )!;
        await act(async () => value_checkbox.click());

        expect(JSON.parse(grid_stub().getAttribute('data-projection')!))
            .toEqual([0, 2]);
        expect(grid_stub().getAttribute('data-mount-id')).toBe(mount_id);
        expect(grid_stub().getAttribute('data-generation')).toBe(generation);
        expect(columns_trigger().querySelector('.hidden-count-badge')?.textContent)
            .toBe('1');
        expect(grid_shell_mock.commit_live_edit).toHaveBeenCalledTimes(1);
        const state_messages = post_message.mock.calls
            .map((call) => call[0])
            .filter((message) => message.type === 'stateChanged');
        expect(state_messages).toHaveLength(1);
        expect(state_messages[0].state.columnVisibility).toEqual([
            {
                hiddenColumns: [1],
                schema: '["Sheet1",3,["Name","Value","Notes"]]',
            },
            {
                hiddenColumns: [1],
                schema: '["Sheet2",2,null]',
            },
        ]);
        expect(post_message.mock.calls
            .map((call) => call[0])
            .some((message) => message.type === 'setTransform')).toBe(false);
        expect(grid_shell_mock.commit_live_edit.mock.invocationCallOrder.at(-1))
            .toBeLessThan(post_message.mock.invocationCallOrder.at(-1)!);

        post_message.mockClear();
        await click_button('Show all');
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!))
            .toEqual([0, 1, 2]);
        expect(columns_trigger().querySelector('.hidden-count-badge')).toBeNull();
        const restored = post_message.mock.calls.at(-1)![0];
        expect(restored.type).toBe('stateChanged');
        expect(restored.state.columnVisibility).toEqual([
            undefined,
            {
                hiddenColumns: [1],
                schema: '["Sheet2",2,null]',
            },
        ]);
    });

    it('hides every column, preserves fitted widths, and disables auto-fit until recovery', async () => {
        grid_shell_mock.auto_fit_result = { 0: 120, 1: 220 };
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 2;
        meta.sheets[0].columnNames = ['First', 'Second'];
        await dispatch_host_message(sheet_meta_message(meta, {
            state: { columnWidths: [{ 0: 80, 1: 90 }] },
        }));

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({
            0: 120,
            1: 220,
        });

        post_message.mockClear();
        await open_columns();
        await click_button('Hide all');
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!)).toEqual([]);
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({
            0: 120,
            1: 220,
        });
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
        expect(get_button('Auto-fit Columns').disabled).toBe(true);
        expect(columns_trigger().disabled).toBe(false);
        expect(columns_trigger().querySelector('.hidden-count-badge')?.textContent)
            .toBe('2');
        expect(post_message.mock.calls
            .map((call) => call[0])
            .some((message) => message.type === 'setTransform')).toBe(false);

        await click_button('Show all');
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!))
            .toEqual([0, 1]);
        expect(get_button('Auto-fit Columns').disabled).toBe(false);
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
    });

    it('keeps Columns available in preview, edit-session pending, edit, and transform-pending states', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Preview']), {
            previewMode: true,
        }));
        expect(columns_trigger().disabled).toBe(false);

        await dispatch_host_message(sheet_meta_message(make_meta(['Editable'], false), {
            csvEditable: true,
            csvEditingSupported: true,
            generation: 2,
        }));
        expect(columns_trigger().disabled).toBe(false);
        await click_button('Edit');
        expect(columns_trigger().disabled).toBe(false);
        await dispatch_host_message({ type: 'editSessionResult', granted: true });
        expect(columns_trigger().disabled).toBe(false);

        await dispatch_host_message(sheet_meta_message(make_meta(['Pending']), {
            state: {
                transforms: [{
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Pending",1,null]',
                }],
            },
            generation: 3,
        }));
        expect(post_message.mock.calls
            .map((call) => call[0])
            .some((message) => message.type === 'setTransform')).toBe(true);
        expect(columns_trigger().disabled).toBe(false);
    });
});

describe('row height persistence', () => {
    it('stores a row resize per sheet and persists it', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        post_message.mockClear();

        await act(async () => {
            (container!.querySelector('.stub-row-resize') as HTMLButtonElement).click();
        });

        // Grid receives the updated height for row 3.
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!)).toEqual({
            3: 50,
        });
        const last = post_message.mock.calls.at(-1)![0];
        expect(last.type).toBe('stateChanged');
        expect(last.state.rowHeights[0]).toEqual({ 3: 50 });
    });

    it('restores saved row heights from sheetMeta state', async () => {
        await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1']), {
                state: { rowHeights: [{ 1: 44 }] },
            })
        );
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!)).toEqual({
            1: 44,
        });
    });
});

describe('merges', () => {
    it('threads the active sheet merge ranges into the grid', async () => {
        await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].merges = [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 2 },
        ];
        await dispatch_host_message(sheet_meta_message(meta));
        expect(grid_stub().getAttribute('data-merges')).toBe('1');
    });

    it('flattens every merge when any column is hidden but preserves row heights', async () => {
        await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 4;
        meta.sheets[0].merges = [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
        ];
        await dispatch_host_message(sheet_meta_message(meta, {
            state: {
                rowHeights: [{ 0: 48 }],
                columnVisibility: [{
                    hiddenColumns: [3],
                    schema: '["Sheet1",4,null]',
                }],
            },
        }));

        expect(grid_stub().getAttribute('data-merges')).toBe('0');
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!))
            .toEqual({ 0: 48 });
        expect(document.body.textContent).toContain('Merged cells shown unmerged');
    });

    it('flattens merges on hide and restores them on Show all', async () => {
        await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 2;
        meta.sheets[0].columnNames = ['Left', 'Right'];
        meta.sheets[0].merges = [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
        ];
        await dispatch_host_message(sheet_meta_message(meta));
        expect(grid_stub().getAttribute('data-merges')).toBe('1');

        await open_columns();
        const right = document.querySelector<HTMLInputElement>(
            'input[aria-label^="Hide Right;"]',
        )!;
        await act(async () => right.click());
        expect(grid_stub().getAttribute('data-merges')).toBe('0');
        expect(document.body.textContent).toContain('Merged cells shown unmerged');

        await click_button('Show all');
        expect(grid_stub().getAttribute('data-merges')).toBe('1');
        expect(document.body.textContent).not.toContain('Merged cells shown unmerged');
    });
});

describe('auto-fit state', () => {
    it('clears auto-fit state when a new workbook loads', async () => {
        await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['First'])));

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);

        await dispatch_host_message(sheet_meta_message(make_meta(['Second'])));
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
    });

    it('clears auto-fit state on live reload', async () => {
        await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Source'])));

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);

        await dispatch_host_message(meta_reload_message(make_meta(['Reloaded'])));
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
    });

    it('merges fitted visible widths without deleting hidden source widths', async () => {
        grid_shell_mock.auto_fit_result = { 0: 120, 2: 220 };
        await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 3;
        await dispatch_host_message(sheet_meta_message(meta, {
            state: {
                columnWidths: [{ 0: 80, 1: 160, 2: 180 }],
                columnVisibility: [{
                    hiddenColumns: [1],
                    schema: '["Sheet1",3,null]',
                }],
            },
        }));

        await click_button('Auto-fit Columns');
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({
            0: 120,
            1: 160,
            2: 220,
        });
    });
});

describe('truncation banner', () => {
    it('shows editing-disabled text when csvEditingSupported and truncated', async () => {
        await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                truncationMessage: 'Showing 10,000 of 50,000 rows',
                csvEditable: false,
                csvEditingSupported: true,
            })
        );

        const banner = container!.querySelector('.truncation-banner');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toBe(
            'Showing 10,000 of 50,000 rows. Editing is disabled for truncated files.'
        );
    });

    it('omits editing-disabled text in preview mode (editing never available)', async () => {
        await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                truncationMessage: 'Showing 10,000 of 50,000 rows',
                previewMode: true,
            })
        );

        const banner = container!.querySelector('.truncation-banner');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toBe('Showing 10,000 of 50,000 rows');
    });

    it('does not render the banner when truncationMessage is absent', async () => {
        await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        expect(container!.querySelector('.truncation-banner')).toBeNull();
    });

    it('introduces the banner when a reload reports truncation', async () => {
        await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                csvEditable: true,
                csvEditingSupported: true,
            })
        );
        expect(container!.querySelector('.truncation-banner')).toBeNull();

        await dispatch_host_message(
            meta_reload_message(make_meta(['Sheet1'], false), {
                truncationMessage: 'Showing 10,000 of 50,000 rows',
                csvEditable: false,
            })
        );
        const banner = container!.querySelector('.truncation-banner');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toBe(
            'Showing 10,000 of 50,000 rows. Editing is disabled for truncated files.'
        );
    });
});

describe('edit mode save exit', () => {
    it('discarding from the save dialog clears persisted edits before releasing edit ownership', async () => {
        grid_shell_mock.is_dirty = true;
        grid_shell_mock.has_uncommitted_changes = true;

        const { post_message } = await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                csvEditable: true,
                csvEditingSupported: true,
            })
        );
        await enter_edit_mode(post_message);

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith({ type: 'showSaveDialog' });

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'discard' });

        expect(grid_shell_mock.clear_dirty).toHaveBeenCalledTimes(1);
        expect(post_message).toHaveBeenCalledWith({ type: 'discardEditSession' });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('enters edit mode with pending edits returned by the host session grant', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                csvEditable: true,
                csvEditingSupported: true,
            })
        );
        const first_mount_id = grid_stub().getAttribute('data-mount-id');

        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith({ type: 'requestEditSession' });

        const pendingEdits = { '0:0': { value: 'restored', base: 'base' } };
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            pendingEdits,
        } as HostMessage);

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(grid_stub().getAttribute('data-initial-edits')).toBe(
            JSON.stringify(pendingEdits)
        );
        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(first_mount_id);
    });

    it('stays in edit mode when save is requested while dirty work is already saving', async () => {
        grid_shell_mock.is_dirty = true;
        grid_shell_mock.has_uncommitted_changes = true;
        grid_shell_mock.request_save.mockReturnValue(false);

        const { post_message } = await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                csvEditable: true,
                csvEditingSupported: true,
            })
        );

        await enter_edit_mode(post_message);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith({ type: 'showSaveDialog' });

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });

        expect(grid_shell_mock.request_save).toHaveBeenCalledTimes(1);
        await dispatch_host_message({ type: 'saveResult', success: true });
        await report_grid_editing(true);

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
    });

    it('exits edit mode after a busy save-on-exit succeeds with no remaining dirty work', async () => {
        grid_shell_mock.is_dirty = true;
        grid_shell_mock.has_uncommitted_changes = true;
        grid_shell_mock.request_save.mockReturnValue(false);

        const { post_message } = await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                csvEditable: true,
                csvEditingSupported: true,
            })
        );

        await enter_edit_mode(post_message);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith({ type: 'showSaveDialog' });

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        expect(grid_shell_mock.request_save).toHaveBeenCalledTimes(1);

        await dispatch_host_message({ type: 'saveResult', success: true });
        await report_grid_editing(false);

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('stays in edit mode after save success when only a live editor remains uncommitted', async () => {
        grid_shell_mock.is_dirty = false;
        grid_shell_mock.has_uncommitted_changes = true;
        grid_shell_mock.request_save.mockReturnValue(false);

        const { post_message } = await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                csvEditable: true,
                csvEditingSupported: true,
            })
        );

        await enter_edit_mode(post_message);
        await report_grid_editing(false, true);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith({ type: 'showSaveDialog' });

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        expect(grid_shell_mock.request_save).toHaveBeenCalledTimes(1);

        await dispatch_host_message({ type: 'saveResult', success: true });

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
    });

    it('exits after a successful save once a still-open overlay later resolves clean (no timer)', async () => {
        grid_shell_mock.is_dirty = false;
        grid_shell_mock.has_uncommitted_changes = true;
        grid_shell_mock.request_save.mockReturnValue(false);

        const { post_message } = await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                csvEditable: true,
                csvEditingSupported: true,
            })
        );

        await enter_edit_mode(post_message);
        await report_grid_editing(false, true);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith({ type: 'showSaveDialog' });

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        await dispatch_host_message({ type: 'saveResult', success: true });
        // Overlay is still open and uncommitted: must stay in edit mode.
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        // The overlay commits/clears — GridShell reports the live-editor state
        // going clean. The editing-status effect (not a timer) completes the exit.
        await report_grid_editing(false, false);

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('ignores stray failed save results after a pending exit save already succeeded', async () => {
        grid_shell_mock.is_dirty = false;
        grid_shell_mock.has_uncommitted_changes = true;
        grid_shell_mock.request_save.mockReturnValue(false);

        const { post_message } = await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                csvEditable: true,
                csvEditingSupported: true,
            })
        );

        await enter_edit_mode(post_message);
        await report_grid_editing(false, true);
        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith({ type: 'showSaveDialog' });

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        await dispatch_host_message({ type: 'saveResult', success: true });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        // A stray failed save after success must not cancel the pending exit;
        // when the overlay later resolves clean, the exit still completes.
        await dispatch_host_message({ type: 'saveResult', success: false });
        await report_grid_editing(false, false);

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('does not let a stale pending exit close a fresh document with restored edits', async () => {
        grid_shell_mock.is_dirty = false;
        grid_shell_mock.has_uncommitted_changes = true;
        grid_shell_mock.request_save.mockReturnValue(false);

        const { post_message } = await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                csvEditable: true,
                csvEditingSupported: true,
            })
        );

        await enter_edit_mode(post_message);
        await report_grid_editing(false, true);
        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith({ type: 'showSaveDialog' });

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        await dispatch_host_message({ type: 'saveResult', success: true });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        // A fresh document arrives (resetting pending-exit bookkeeping) and brings
        // restored edits, so edit mode re-engages. The earlier pending exit must
        // not fire against this new document when its editing state goes clean.
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Fresh'], false), {
                csvEditable: true,
                csvEditingSupported: true,
                state: { pendingEdits: { '0:0': { value: 'restored', base: 'base' } } },
                generation: 2,
            })
        );
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        await report_grid_editing(false, false);

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
    });

    it('discard all from the conflict banner releases edit ownership', async () => {
        grid_shell_mock.is_dirty = true;
        grid_shell_mock.has_uncommitted_changes = true;

        const { post_message } = await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                csvEditable: true,
                csvEditingSupported: true,
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, ['0:0']);

        post_message.mockClear();
        await click_button('Discard All');

        expect(grid_shell_mock.clear_dirty).toHaveBeenCalledTimes(1);
        expect(post_message).toHaveBeenCalledWith({ type: 'discardEditSession' });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });
});

describe('preview mode', () => {
    it('passes preview_mode through to the grid', async () => {
        await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1']), { previewMode: true })
        );
        expect(grid_stub().getAttribute('data-preview')).toBe('true');
    });
});

describe('sorting and filtering', () => {
    it('disables transform controls while an edit-session request is pending', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1'], false), {
                csvEditable: true,
                csvEditingSupported: true,
            }),
        );

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith({ type: 'requestEditSession' });
        expect(grid_shell_mock.latest_props?.transform_sections).toBe(false);

        await dispatch_host_message({ type: 'editSessionResult', granted: true });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
    });

    it('drops and persists invalid saved transforms on initial load', async () => {
        const { post_message } = await render_app();
        post_message.mockClear();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1']), {
            state: {
                transforms: [{
                    sort: [{ colIndex: 9, direction: 'asc' }],
                    filters: [],
                    schema: '["Sheet1",1,null]',
                }],
            },
        }));

        expect(document.body.textContent).not.toContain('9.');
        const persisted = post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'stateChanged');
        expect(persisted.state.transforms).toEqual([undefined]);
        expect(post_message.mock.calls
            .map((call) => call[0])
            .some((message) => message.type === 'setTransform')).toBe(false);
    });

    it('uses an acknowledged disabled filter as the rollback baseline', async () => {
        const { post_message } = await render_app();
        const disabled = {
            id: 'disabled-filter', colIndex: 0, operator: 'between' as const,
            value: 'low', secondValue: 'high', caseSensitive: false, enabled: false,
        };
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1']), {
            state: { transforms: [{
                sort: [], filters: [disabled], schema: '["Sheet1",1,null]',
            }] },
        }));
        expect(post_message.mock.calls.map((call) => call[0])
            .some((message) => message.type === 'setTransform')).toBe(false);

        post_message.mockClear();
        await act(async () => (
            document.querySelector('.filter-chip-kebab') as HTMLButtonElement
        ).click());
        await click_button('Enable');
        expect(post_message.mock.calls.map((call) => call[0])
            .find((message) => message.type === 'setTransform')?.state.filters[0].enabled)
            .toBe(true);

        post_message.mockClear();
        await click_button('Cancel');
        const cancel = post_message.mock.calls.map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        expect(cancel.state.filters).toEqual([disabled]);
    });

    it('suppresses semantically unchanged transform requests without remounting', async () => {
        const { post_message } = await render_app();
        const schema = '["Sheet1",1,null]';
        const filter = {
            id: 'f', colIndex: 0, operator: 'contains' as const,
            value: 'x', caseSensitive: false, enabled: true,
        };
        const filter_state = { sort: [], filters: [filter], schema };
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1']), {
            state: { transforms: [filter_state] },
        }));
        const restore = post_message.mock.calls.map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        await dispatch_host_message({
            type: 'transformApplied', sheetIndex: 0, state: restore.state,
            rowCount: 1, requestId: restore.requestId, generation: 2,
            sourceGeneration: 1, intent: restore.intent,
        });
        post_message.mockClear();
        const mount_id = grid_stub().getAttribute('data-mount-id');
        const on_transform_change = grid_shell_mock.latest_props?.on_transform_change as
            (state: typeof filter_state) => void;

        await act(async () => on_transform_change({ ...filter_state, sort: [] }));
        expect(post_message.mock.calls.map((call) => call[0])
            .some((message) => message.type === 'setTransform')).toBe(false);
        expect(grid_stub().getAttribute('data-mount-id')).toBe(mount_id);

        await act(async () => (
            document.querySelector('.filter-chip-body') as HTMLButtonElement
        ).click());
        await click_button('Apply');
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
        expect(post_message.mock.calls.map((call) => call[0])
            .some((message) => message.type === 'setTransform')).toBe(false);
        expect(grid_stub().getAttribute('data-mount-id')).toBe(mount_id);

        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1']), {
            state: { transforms: [{
                sort: [{ colIndex: 0, direction: 'asc' }], filters: [], schema,
            }] },
        }));
        const sort_restore = post_message.mock.calls.map((call) => call[0])
            .filter((message) => message.type === 'setTransform').at(-1);
        await dispatch_host_message({
            type: 'transformApplied', sheetIndex: 0, state: sort_restore.state,
            rowCount: 1, requestId: sort_restore.requestId, generation: 2,
            sourceGeneration: 1, intent: sort_restore.intent,
        });
        post_message.mockClear();
        const sort_mount_id = grid_stub().getAttribute('data-mount-id');
        const change_sort = grid_shell_mock.latest_props?.on_transform_change as
            (state: { sort: Array<{ colIndex: number; direction: 'asc' }>; filters: []; schema?: string }) => void;
        await act(async () => change_sort({
            sort: [{ colIndex: 0, direction: 'asc' }], filters: [], schema,
        }));
        await act(async () => change_sort({
            sort: [{ colIndex: 0, direction: 'asc' }], filters: [], schema,
        }));
        expect(post_message.mock.calls.map((call) => call[0])
            .some((message) => message.type === 'setTransform')).toBe(false);
        expect(grid_stub().getAttribute('data-mount-id')).toBe(sort_mount_id);

        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        post_message.mockClear();
        const empty_mount_id = grid_stub().getAttribute('data-mount-id');
        const clear_empty = grid_shell_mock.latest_props?.on_transform_change as
            (state: { sort: []; filters: [] }) => void;
        await act(async () => clear_empty({ sort: [], filters: [] }));
        await act(async () => clear_empty({ sort: [], filters: [] }));
        expect(post_message.mock.calls.map((call) => call[0])
            .some((message) => message.type === 'setTransform')).toBe(false);
        expect(grid_stub().getAttribute('data-mount-id')).toBe(empty_mount_id);
    });

    it('keeps a keyboard filter opener focused while Apply is pending and after ack', async () => {
        const { post_message } = await render_app();
        const schema = '["Sheet1",1,null]';
        const filter = {
            id: 'f', colIndex: 0, operator: 'contains' as const,
            value: 'old', caseSensitive: false, enabled: true,
        };
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1']), {
            state: { transforms: [{ sort: [], filters: [filter], schema }] },
        }));
        const restore = post_message.mock.calls.map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        await dispatch_host_message({
            type: 'transformApplied', sheetIndex: 0, state: restore.state,
            rowCount: 1, requestId: restore.requestId, generation: 2,
            sourceGeneration: 1, intent: restore.intent,
        });
        const chip = document.querySelector('.filter-chip-body') as HTMLButtonElement;
        chip.focus();
        await act(async () => chip.click());
        const input = document.querySelector('[aria-label="Filter value"]') as HTMLInputElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
                .set!.call(input, 'new');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        post_message.mockClear();
        await click_button('Apply');
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
        const request = post_message.mock.calls.map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        expect(request).toBeDefined();
        expect(document.activeElement).toBe(chip);
        expect(chip.disabled).toBe(false);
        expect(chip.getAttribute('aria-disabled')).toBe('true');

        await dispatch_host_message({
            type: 'transformApplied', sheetIndex: 0, state: request.state,
            rowCount: 1, requestId: request.requestId, generation: 3,
            sourceGeneration: 1, intent: request.intent,
        });
        expect(document.activeElement).toBe(chip);
        expect(chip.getAttribute('aria-disabled')).toBeNull();
        await act(async () => chip.click());
        expect(document.querySelector('.filter-popover')).not.toBeNull();
    });

    it('keeps persisted transforms unapplied until the fresh source acknowledges them', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        meta.sheets[0] = {
            ...meta.sheets[0],
            rowCount: 2,
            merges: [{
                startRow: 0,
                startCol: 0,
                endRow: 1,
                endCol: 0,
            }],
        };
        await dispatch_host_message(sheet_meta_message(meta, {
            state: {
                transforms: [{
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Sheet1",1,null]',
                }],
            },
        }));

        expect(grid_stub().getAttribute('data-transformed')).toBe('false');
        expect(grid_stub().getAttribute('data-merges')).toBe('1');
        expect(JSON.parse(grid_stub().getAttribute('data-merges-json')!)).toEqual(
            meta.sheets[0].merges,
        );
        const request = post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        expect(request).toBeDefined();

        post_message.mockClear();
        await dispatch_host_message({
            type: 'transformApplied',
            sheetIndex: 0,
            state: request.state,
            rowCount: 2,
            requestId: request.requestId,
            generation: 2,
            sourceGeneration: 1,
            intent: request.intent,
        });
        expect(grid_stub().getAttribute('data-transformed')).toBe('true');
        expect(grid_stub().getAttribute('data-merges')).toBe('0');
        expect(post_message.mock.calls
            .map((call) => call[0])
            .some((message) => message.type === 'stateChanged')).toBe(false);
    });

    it('lets the user cancel a pending saved transform and forgets it', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1']), {
            state: {
                transforms: [{
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Sheet1",1,null]',
                }],
            },
        }));
        const restore_request = post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        expect(restore_request).toBeDefined();

        post_message.mockClear();
        await click_button('Cancel');
        const cancel_request = post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        expect(cancel_request.state.sort).toEqual([]);
        expect(cancel_request.state.filters).toEqual([]);
        post_message.mockClear();
        await click_button('Cancel');
        expect(post_message.mock.calls.map((call) => call[0])
            .some((message) => message.type === 'setTransform')).toBe(false);

        await dispatch_host_message({
            type: 'transformApplied',
            sheetIndex: 0,
            state: cancel_request.state,
            rowCount: 1,
            requestId: cancel_request.requestId,
            generation: 2,
            sourceGeneration: 1,
            intent: cancel_request.intent,
        });
        expect(document.body.textContent).not.toContain('Sort:');
    });

    it('waits for host acknowledgement, flattens merges, and restores them on clear', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        meta.sheets[0] = {
            ...meta.sheets[0],
            rowCount: 3,
            columnCount: 1,
            merges: [{
                startRow: 0,
                startCol: 0,
                endRow: 1,
                endCol: 0,
            }],
        };
        await dispatch_host_message(sheet_meta_message(meta, {
            csvEditable: true,
            csvEditingSupported: true,
        }));
        expect(grid_stub().getAttribute('data-merges')).toBe('1');

        post_message.mockClear();
        await act(async () => {
            const open_filter = grid_shell_mock.latest_props?.on_open_filter as (
                source_column: number,
                anchor: { left: number; top: number },
                restore_focus: () => void,
            ) => void;
            open_filter(0, { left: 20, top: 20 }, vi.fn());
        });
        const input = document.querySelector(
            'input[aria-label="Filter value"]',
        ) as HTMLInputElement;
        expect(input).not.toBeNull();
        await act(async () => {
            Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value',
            )!.set!.call(input, 'group');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click_button('Apply');

        const request = post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        expect(request).toBeDefined();
        expect(request.state.filters[0]).toMatchObject({
            colIndex: 0,
            operator: 'contains',
            value: 'group',
        });
        // Old rows/merges remain authoritative while the host computes.
        expect(grid_stub().getAttribute('data-merges')).toBe('1');
        expect(get_button('Edit').disabled).toBe(true);

        await dispatch_host_message({
            type: 'transformApplied',
            sheetIndex: 0,
            state: request.state,
            rowCount: 2,
            requestId: request.requestId,
            generation: 2,
            sourceGeneration: 1,
            intent: request.intent,
        });
        expect(grid_stub().getAttribute('data-transformed')).toBe('true');
        expect(grid_stub().getAttribute('data-row-count')).toBe('2');
        expect(grid_stub().getAttribute('data-merges')).toBe('0');
        expect(document.body.textContent).toContain('Merged cells shown unmerged');

        // Disabling the only filter restores natural rows but keeps the chip so
        // it can be re-enabled (Sight behavior; avoids losing saved intent).
        post_message.mockClear();
        await act(async () => (
            document.querySelector('.filter-chip-kebab') as HTMLButtonElement
        ).click());
        await click_button('Disable');
        const disable_request = post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        expect(disable_request.state.filters[0].enabled).toBe(false);
        await dispatch_host_message({
            type: 'transformApplied',
            sheetIndex: 0,
            state: disable_request.state,
            rowCount: 3,
            requestId: disable_request.requestId,
            generation: 3,
            sourceGeneration: 1,
            intent: disable_request.intent,
        });
        expect(document.body.textContent).toContain('✗');
        expect(grid_stub().getAttribute('data-transformed')).toBe('false');
        expect(grid_stub().getAttribute('data-merges')).toBe('1');

        post_message.mockClear();
        await act(async () => (
            document.querySelector('.filter-chip-kebab') as HTMLButtonElement
        ).click());
        await click_button('Enable');
        const enable_request = post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        await dispatch_host_message({
            type: 'transformApplied',
            sheetIndex: 0,
            state: enable_request.state,
            rowCount: 2,
            requestId: enable_request.requestId,
            generation: 4,
            sourceGeneration: 1,
            intent: enable_request.intent,
        });
        expect(grid_stub().getAttribute('data-transformed')).toBe('true');

        post_message.mockClear();
        await act(async () => (
            document.querySelector('button[aria-label="Clear all filters"]') as HTMLButtonElement
        ).click());
        const clear_request = post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        expect(clear_request.state).toEqual({
            sort: [],
            filters: [],
            schema: '["Sheet1",1,null]',
        });

        await dispatch_host_message({
            type: 'transformApplied',
            sheetIndex: 0,
            state: clear_request.state,
            rowCount: 3,
            requestId: clear_request.requestId,
            generation: 5,
            sourceGeneration: 1,
            intent: clear_request.intent,
        });
        expect(grid_stub().getAttribute('data-transformed')).toBe('false');
        expect(grid_stub().getAttribute('data-merges')).toBe('1');
        expect(JSON.parse(grid_stub().getAttribute('data-merges-json')!)).toEqual(
            meta.sheets[0].merges,
        );
        expect(get_button('Edit').disabled).toBe(false);
    });

    it('does not restore an old filter opener when outside-clicking into another popover', async () => {
        await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        const first_restore = vi.fn();
        const second_restore = vi.fn();
        const open_filter = grid_shell_mock.latest_props?.on_open_filter as (
            source_column: number,
            anchor: { left: number; top: number },
            restore_focus: () => void,
        ) => void;
        await act(async () => open_filter(0, { left: 10, top: 10 }, first_restore));
        await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
        await act(async () => open_filter(0, { left: 20, top: 20 }, second_restore));
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
        expect(first_restore).not.toHaveBeenCalled();
        expect(document.querySelector('.filter-popover')).not.toBeNull();
        await click_button('Cancel');
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
        expect(second_restore).toHaveBeenCalledOnce();
    });

    it('disables transforms in synchronized preview mode', async () => {
        await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1']), { previewMode: true }),
        );
        expect(grid_shell_mock.latest_props?.transform_sections).toBe(false);
    });
});
