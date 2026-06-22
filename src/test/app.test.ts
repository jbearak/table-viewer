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
}));

// Glide's DataEditor renders to a <canvas>, which jsdom can't drive. Replace the
// grid with a DOM stub that surfaces the props App feeds it (sheet index,
// generation, formatting flag, preview flag, column widths) and exposes a button
// that fires `on_column_resize`, so we can exercise App's wiring without canvas.
vi.mock('../webview/grid-shell', () => ({
    GridShell: (props: {
        sheet_index: number;
        generation: number;
        show_formatting: boolean;
        preview_mode?: boolean;
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
                has_uncommitted_changes: () => boolean;
            } | null;
        };
        on_column_resize: (col: number, width: number) => void;
        on_row_resize: (row: number, height: number) => void;
        auto_fit_ref?: {
            current: (() => Record<number, number> | null) | null;
        };
    }) => {
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
                has_uncommitted_changes: () => grid_shell_mock.has_uncommitted_changes,
            };
        }
        // Mirror the real GridShell: publish a measure function into the ref so
        // App's auto-fit toggle has fitted widths to apply.
        if (props.auto_fit_ref) {
            props.auto_fit_ref.current = () => ({ 0: 120 });
        }
        return React.createElement(
            'div',
            {
                className: 'grid-shell-stub',
                'data-sheet-index': String(props.sheet_index),
                'data-generation': String(props.generation),
                'data-show-formatting': String(props.show_formatting),
                'data-preview': String(props.preview_mode ?? false),
                'data-edit-mode': String(props.edit_mode ?? false),
                'data-initial-edits': JSON.stringify(props.initial_edits ?? null),
                'data-mount-id': String(mount_id.current),
                'data-col-widths': JSON.stringify(props.column_widths),
                'data-row-heights': JSON.stringify(props.row_heights),
                'data-merges': String(props.merges?.length ?? 0),
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
