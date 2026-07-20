// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage, SheetTransformState, WebviewMessage } from '../types';
import type { WorkbookMeta } from '../data-source/interface';
import type { WorkbookSnapshot } from '../viewer-snapshot';

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
    focus_grid: vi.fn(),
    auto_fit_result: { 0: 120 } as Record<number, number> | null,
    latest_props: null as Record<string, unknown> | null,
    emit_pending_edits_on_mount: false,
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
        grid_focus_ref?: {
            current: { generation: number; focus: () => boolean } | null;
        };
        pending_preview_scroll?: { row: number; sequence: number } | null;
        on_preview_scroll_applied?: (sequence: number) => void;
        on_preview_visible_row_change?: (row: number) => void;
        transform_sections: boolean;
        transform_pending: boolean;
        on_transform_change: (state: { sort: Array<{ colIndex: number; direction: 'asc' | 'desc' }>; filters: unknown[] }) => void;
        on_open_filter: (source_column: number, anchor: { left: number; top: number }, restore_focus: () => void) => void;
        on_focus_columns?: () => void;
    }) => {
        grid_shell_mock.latest_props = props as unknown as Record<string, unknown>;
        const mount_id = React.useRef(++grid_shell_mock.mount_count);
        React.useLayoutEffect(() => {
            if (!props.grid_focus_ref) return;
            const handle = {
                generation: props.generation,
                focus: () => {
                    grid_shell_mock.focus_grid();
                    return true;
                },
            };
            props.grid_focus_ref.current = handle;
            return () => {
                if (props.grid_focus_ref?.current === handle) {
                    props.grid_focus_ref.current = null;
                }
            };
        }, [props.generation, props.grid_focus_ref]);
        React.useEffect(() => {
            grid_shell_mock.on_editing_change = props.on_editing_change ?? null;
            grid_shell_mock.on_editing_change?.({
                is_dirty: grid_shell_mock.is_dirty,
                has_live_uncommitted: grid_shell_mock.has_live_uncommitted,
                edits: grid_shell_mock.is_dirty ? { '0:0': { value: 'dirty', base: 'base' } } : {},
                conflicted: [],
            });
            if (grid_shell_mock.emit_pending_edits_on_mount) {
                (globalThis as typeof globalThis & {
                    acquireVsCodeApi: () => { postMessage: (message: unknown) => void };
                }).acquireVsCodeApi().postMessage({
                    type: 'pendingEditsChanged',
                    edits: props.initial_edits ?? null,
                });
            }
            return () => {
                grid_shell_mock.on_editing_change = null;
            };
        }, [props.initial_edits, props.on_editing_change]);
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
                'data-pending-preview-scroll': JSON.stringify(props.pending_preview_scroll ?? null),
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
            ),
            React.createElement(
                'button',
                {
                    className: 'stub-shortcut-transform',
                    onClick: () => props.on_transform_change({
                        sort: [{ colIndex: 0, direction: 'asc' }],
                        filters: [],
                    }),
                },
                'grid-shortcut-transform'
            ),
            React.createElement(
                'button',
                {
                    className: 'stub-header-transform',
                    onClick: () => props.on_transform_change({
                        sort: [{ colIndex: 0, direction: 'desc' }],
                        filters: [],
                    }),
                },
                'grid-header-transform'
            ),
            props.pending_preview_scroll && React.createElement(
                'button',
                {
                    className: 'stub-ack-preview-scroll',
                    onClick: () => props.on_preview_scroll_applied?.(
                        props.pending_preview_scroll!.sequence,
                    ),
                },
                'ack-preview-scroll'
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

function latest_transform_request(post_message: ReturnType<typeof vi.fn>) {
    const request = post_message.mock.calls
        .map((call) => call[0] as WebviewMessage)
        .filter((message): message is Extract<WebviewMessage, { type: 'setTransform' }> => (
            message.type === 'setTransform'
        ))
        .at(-1);
    expect(request).toBeDefined();
    return request!;
}

async function acknowledge_transform(
    request: Extract<WebviewMessage, { type: 'setTransform' }>,
    generation: number,
) {
    await dispatch_host_message({
        type: 'transformApplied',
        sheetIndex: request.sheetIndex,
        state: request.state,
        rowCount: 1,
        requestId: request.requestId,
        generation,
        sourceGeneration: request.sourceGeneration,
        intent: request.intent,
    });
}

async function flush_focus_restore() {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
}

async function load_acknowledged_transform(
    post_message: ReturnType<typeof vi.fn>,
    state: SheetTransformState,
) {
    await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1']), {
        state: { transforms: [state] },
    }));
    const restore = latest_transform_request(post_message);
    await acknowledge_transform(restore, 2);
    post_message.mockClear();
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
    edits: Record<string, { value: string; base: string }> = dirty
        ? { '0:0': { value: 'dirty', base: 'base' } }
        : {},
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
            edits,
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

function workbook_snapshot_message(
    meta: WorkbookMeta,
    extra: Partial<WorkbookSnapshot> = {},
): Extract<HostMessage, { type: 'workbookSnapshot' }> {
    const delivery_id = extra.identity?.deliveryId ?? 1;
    return {
        type: 'workbookSnapshot',
        snapshot: {
            generation: 1,
            sourceGeneration: 1,
            presentation: 'initial',
            reason: 'ready',
            meta,
            state: {
                columnWidths: [],
                rowHeights: [],
                scrollPosition: [],
                activeSheetIndex: 0,
                tabOrientation: null,
                transforms: meta.sheets.map(() => undefined),
                columnVisibility: meta.sheets.map(() => undefined),
            },
            configuration: {
                defaultTabOrientation: 'horizontal',
                previewMode: false,
            },
            capabilities: {
                csvEditable: false,
                csvEditingSupported: false,
            },
            truncationMessage: null,
            identity: {
                deliveryId: delivery_id,
                authority: {
                    fileId: 'file:test',
                    revision: delivery_id,
                },
                stateRevision: delivery_id,
                sourceBasis: {
                    physicalRevision: delivery_id,
                    projectionRevision: 0,
                },
            },
            ...extra,
        },
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
    grid_shell_mock.focus_grid.mockReset();
    grid_shell_mock.auto_fit_result = { 0: 120 };
    grid_shell_mock.emit_pending_edits_on_mount = false;
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

describe('workbook snapshot hydration', () => {
    it('matches fresh initial hydration and acknowledges independently', async () => {
        const { post_message } = await render_app();
        post_message.mockClear();
        const meta = make_meta(['First', 'Second']);
        const message = workbook_snapshot_message(meta, {
            generation: 4,
            sourceGeneration: 7,
            state: {
                columnWidths: [undefined, { 0: 155 }],
                rowHeights: [],
                scrollPosition: [],
                activeSheetIndex: 1,
                tabOrientation: 'vertical',
                pendingEdits: { '0:0': { value: 'new', base: 'old' } },
                transforms: [],
                columnVisibility: [],
            },
            configuration: {
                defaultTabOrientation: 'horizontal',
                previewMode: true,
            },
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
            },
        });
        await dispatch_host_message(message);

        expect(grid_stub().getAttribute('data-generation')).toBe('4');
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(grid_stub().getAttribute('data-preview')).toBe('true');
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(JSON.parse(grid_stub().getAttribute('data-initial-edits')!))
            .toEqual({ '0:0': { value: 'new', base: 'old' } });
        expect(get_button('Vertical Tabs').getAttribute('aria-pressed')).toBe('true');
        expect(post_message.mock.calls.map((call) => call[0])).toContainEqual({
            type: 'snapshotApplied',
            identity: message.snapshot.identity,
            disposition: 'applied',
        });
    });

    it('keeps visible sheet and orientation on refresh while updating state authority', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['First', 'Second']);
        await dispatch_host_message(workbook_snapshot_message(meta));
        await click_button('Vertical Tabs');
        post_message.mockClear();

        const refresh = workbook_snapshot_message(meta, {
            identity: {
                deliveryId: 2,
                authority: { fileId: 'file:test', revision: 2 },
                stateRevision: 8,
                sourceBasis: { physicalRevision: 2, projectionRevision: 0 },
            },
            generation: 2,
            sourceGeneration: 2,
            presentation: 'refresh',
            reason: 'fileReload',
            state: {
                columnWidths: [undefined, { 0: 210 }],
                rowHeights: [],
                scrollPosition: [],
                activeSheetIndex: 1,
                tabOrientation: 'horizontal',
                transforms: [],
                columnVisibility: [],
            },
        });
        await dispatch_host_message(refresh);

        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        expect(get_button('Vertical Tabs').getAttribute('aria-pressed')).toBe('true');
        await act(async () => {
            (container!.querySelector('.stub-resize') as HTMLButtonElement).click();
        });
        expect(post_message.mock.calls.map((call) => call[0])
            .filter((message) => message.type === 'stateChanged').at(-1))
            .toMatchObject({
                sourceGeneration: 2,
                snapshotIdentity: refresh.snapshot.identity,
                state: {
                    activeSheetIndex: 1,
                    tabOrientation: 'horizontal',
                },
            });
    });

    it('acknowledges a duplicate without rehydrating or correcting twice', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 2;
        const message = workbook_snapshot_message(meta, {
            state: {
                columnWidths: [], rowHeights: [], scrollPosition: [],
                activeSheetIndex: 0, tabOrientation: null, transforms: [],
                columnVisibility: [{
                    hiddenColumns: [1, 9],
                    schema: '["Sheet1",2,null]',
                }],
            },
        });
        await dispatch_host_message(message);
        const mount = grid_stub().getAttribute('data-mount-id');
        const correction_count = post_message.mock.calls.map((call) => call[0])
            .filter((item) => item.type === 'stateChanged').length;

        await dispatch_host_message(message);

        expect(grid_stub().getAttribute('data-mount-id')).toBe(mount);
        expect(post_message.mock.calls.map((call) => call[0])
            .filter((item) => item.type === 'stateChanged')).toHaveLength(
                correction_count,
            );
        expect(post_message.mock.calls.map((call) => call[0]).at(-1)).toEqual({
            type: 'snapshotApplied',
            identity: message.snapshot.identity,
            disposition: 'duplicate',
        });
    });

    it('applies a same-authority re-adoption when panel generations advance', async () => {
        const { post_message } = await render_app();
        const first = workbook_snapshot_message(make_meta(['First']), {
            generation: 1,
            sourceGeneration: 1,
        });
        await dispatch_host_message(first);
        post_message.mockClear();
        const readopted = workbook_snapshot_message(make_meta(['Readopted']), {
            identity: { ...first.snapshot.identity, deliveryId: 2 },
            generation: 2,
            sourceGeneration: 2,
            presentation: 'refresh',
        });

        await dispatch_host_message(readopted);

        expect(grid_stub().getAttribute('data-generation')).toBe('2');
        expect(post_message.mock.calls.map((call) => call[0]).at(-1)).toEqual({
            type: 'snapshotApplied',
            identity: readopted.snapshot.identity,
            disposition: 'applied',
        });
    });

    it('ignores and acknowledges stale snapshots after a newer authority', async () => {
        const { post_message } = await render_app();
        const newer = workbook_snapshot_message(make_meta(['New']), {
            identity: {
                deliveryId: 3,
                authority: { fileId: 'file:test', revision: 3 },
                stateRevision: 3,
                sourceBasis: { physicalRevision: 3, projectionRevision: 0 },
            },
            generation: 3,
        });
        await dispatch_host_message(newer);
        const mount = grid_stub().getAttribute('data-mount-id');
        const older = workbook_snapshot_message(make_meta(['Old']), {
            identity: {
                deliveryId: 2,
                authority: { fileId: 'file:test', revision: 2 },
                stateRevision: 2,
                sourceBasis: { physicalRevision: 2, projectionRevision: 0 },
            },
            generation: 2,
        });
        await dispatch_host_message(older);

        expect(grid_stub().getAttribute('data-generation')).toBe('3');
        expect(grid_stub().getAttribute('data-mount-id')).toBe(mount);
        expect(post_message.mock.calls.map((call) => call[0]).at(-1)).toEqual({
            type: 'snapshotApplied',
            identity: older.snapshot.identity,
            disposition: 'stale',
        });
    });

    it('restores authoritative pending edits before a native refresh remount', async () => {
        grid_shell_mock.emit_pending_edits_on_mount = true;
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(workbook_snapshot_message(meta, {
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
            },
        }));
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '0:0': { value: 'local', base: 'base' },
        });
        post_message.mockClear();
        const authoritative = {
            '1:0': { value: 'host', base: 'old' },
        };

        await dispatch_host_message(workbook_snapshot_message(meta, {
            identity: {
                deliveryId: 2,
                authority: { fileId: 'file:test', revision: 2 },
                stateRevision: 8,
                sourceBasis: { physicalRevision: 2, projectionRevision: 0 },
            },
            presentation: 'refresh',
            reason: 'fileReload',
            generation: 2,
            sourceGeneration: 2,
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
            },
            state: {
                columnWidths: [], rowHeights: [], scrollPosition: [],
                activeSheetIndex: 0, tabOrientation: null,
                pendingEdits: authoritative,
                transforms: [undefined],
                columnVisibility: [undefined],
            },
        }));

        expect(JSON.parse(grid_stub().getAttribute('data-initial-edits')!))
            .toEqual(authoritative);
        const pending_messages = post_message.mock.calls.map((call) => call[0])
            .filter((item) => item.type === 'pendingEditsChanged');
        expect(pending_messages).toContainEqual({
            type: 'pendingEditsChanged',
            edits: authoritative,
        });
        expect(pending_messages.some((item) => item.edits === null)).toBe(false);
    });

    it('preserves live dirty edits across a state-less legacy refresh', async () => {
        grid_shell_mock.emit_pending_edits_on_mount = true;
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(sheet_meta_message(meta, {
            csvEditable: true,
            csvEditingSupported: true,
        }));
        await enter_edit_mode(post_message);
        const live_edits = {
            '2:0': { value: 'live', base: 'before' },
        };
        await report_grid_editing(true, true, [], live_edits);
        post_message.mockClear();

        await dispatch_host_message(meta_reload_message(meta, {
            generation: 2,
            sourceGeneration: 2,
        }));

        expect(JSON.parse(grid_stub().getAttribute('data-initial-edits')!))
            .toEqual(live_edits);
        const pending_messages = post_message.mock.calls.map((call) => call[0])
            .filter((item) => item.type === 'pendingEditsChanged');
        expect(pending_messages).toContainEqual({
            type: 'pendingEditsChanged',
            edits: live_edits,
        });
        expect(pending_messages.some((item) => item.edits === null)).toBe(false);
    });

    it('clears a pending header request only when an initial snapshot changes files', async () => {
        const { post_message } = await render_app();
        const file_a = make_meta(['People']);
        file_a.sheets[0].excelFirstRowHeader = {
            mode: 'auto', detected: true, active: true, available: true,
        };
        await dispatch_host_message(workbook_snapshot_message(file_a, {
            identity: {
                deliveryId: 1,
                authority: { fileId: 'file:A', revision: 1 },
                stateRevision: 1,
                sourceBasis: { physicalRevision: 1, projectionRevision: 0 },
            },
        }));
        await click_button('First Row as Header');
        const request = post_message.mock.calls.map((call) => call[0] as WebviewMessage)
            .find((item): item is Extract<WebviewMessage, { type: 'setExcelFirstRowHeader' }> =>
                item.type === 'setExcelFirstRowHeader')!;
        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBe('true');
        post_message.mockClear();

        const file_b = make_meta(['Orders']);
        file_b.sheets[0].columnNames = ['Id'];
        file_b.sheets[0].excelFirstRowHeader = {
            mode: 'auto', detected: true, active: true, available: true,
        };
        const transform: SheetTransformState = {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: '["Orders",1,["Id"]]',
        };
        await dispatch_host_message(workbook_snapshot_message(file_b, {
            identity: {
                deliveryId: 2,
                authority: { fileId: 'file:B', revision: 1 },
                stateRevision: 1,
                sourceBasis: { physicalRevision: 1, projectionRevision: 0 },
            },
            state: {
                columnWidths: [], rowHeights: [], scrollPosition: [],
                activeSheetIndex: 0, tabOrientation: null,
                transforms: [transform],
                columnVisibility: [undefined],
            },
        }));

        const restored_transform = latest_transform_request(post_message);
        expect(restored_transform).toMatchObject({
            state: transform,
            generation: 1,
            sourceGeneration: 1,
        });
        await acknowledge_transform(restored_transform, 2);
        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBeNull();

        await dispatch_host_message(workbook_snapshot_message(file_a, {
            identity: {
                deliveryId: 1,
                authority: { fileId: 'file:A', revision: 2 },
                stateRevision: 2,
                sourceBasis: { physicalRevision: 1, projectionRevision: 1 },
            },
            presentation: 'refresh',
            reason: 'excelHeader',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: request.requestId,
                outcome: 'applied',
            },
        }));
        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBeNull();
        expect(document.querySelector('[role="status"]')?.textContent ?? '').toBe('');
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
    });

    it('does not let delayed legacy metadata regress a native snapshot', async () => {
        await render_app();
        await dispatch_host_message(workbook_snapshot_message(make_meta(['Native']), {
            generation: 5,
        }));
        const mount = grid_stub().getAttribute('data-mount-id');

        await dispatch_host_message(sheet_meta_message(make_meta(['Legacy']), {
            generation: 1,
            sourceGeneration: 1,
        }));

        expect(grid_stub().getAttribute('data-generation')).toBe('5');
        expect(grid_stub().getAttribute('data-mount-id')).toBe(mount);
    });

    it('settles only a matching retained header result and only once', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['People']);
        meta.sheets[0].excelFirstRowHeader = {
            mode: 'auto', detected: true, active: true, available: true,
        };
        await dispatch_host_message(workbook_snapshot_message(meta));
        await click_button('First Row as Header');
        const request = post_message.mock.calls.map((call) => call[0] as WebviewMessage)
            .find((item): item is Extract<WebviewMessage, { type: 'setExcelFirstRowHeader' }> =>
                item.type === 'setExcelFirstRowHeader')!;

        await dispatch_host_message(workbook_snapshot_message(meta, {
            identity: {
                deliveryId: 2,
                authority: { fileId: 'file:test', revision: 2 },
                stateRevision: 2,
                sourceBasis: { physicalRevision: 1, projectionRevision: 1 },
            },
            presentation: 'refresh',
            reason: 'excelHeader',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: 'another-panel-request',
                outcome: 'applied',
            },
        }));
        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBe('true');

        const result = workbook_snapshot_message(meta, {
            identity: {
                deliveryId: 3,
                authority: { fileId: 'file:test', revision: 3 },
                stateRevision: 3,
                sourceBasis: { physicalRevision: 1, projectionRevision: 2 },
            },
            presentation: 'refresh',
            reason: 'excelHeader',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: request.requestId,
                outcome: 'applied',
            },
        });
        await dispatch_host_message(result);
        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBeNull();
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Column names updated.');
        await dispatch_host_message(result);
        expect(post_message.mock.calls.map((call) => call[0])
            .filter((item) => item.type === 'showWarning')).toHaveLength(0);
    });

    it('acknowledges before a correction and attaches exact authority to it', async () => {
        const { post_message } = await render_app();
        post_message.mockClear();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 2;
        const message = workbook_snapshot_message(meta, {
            state: {
                columnWidths: [], rowHeights: [], scrollPosition: [],
                activeSheetIndex: 0, tabOrientation: null, transforms: [],
                columnVisibility: [{
                    hiddenColumns: [1, 8],
                    schema: '["Sheet1",2,null]',
                }],
            },
        });
        await dispatch_host_message(message);
        const outbound = post_message.mock.calls.map((call) => call[0]);
        const ack_index = outbound.findIndex((item) => item.type === 'snapshotApplied');
        const correction_index = outbound.findIndex((item) => item.type === 'stateChanged');
        expect(ack_index).toBeGreaterThanOrEqual(0);
        expect(correction_index).toBeGreaterThan(ack_index);
        expect(outbound[correction_index]).toMatchObject({
            snapshotIdentity: message.snapshot.identity,
            sourceGeneration: 1,
        });
    });

    it('acknowledges an accepted clean snapshot even without correction', async () => {
        const { post_message } = await render_app();
        post_message.mockClear();
        const message = workbook_snapshot_message(make_meta(['Sheet1']));
        await dispatch_host_message(message);
        const outbound = post_message.mock.calls.map((call) => call[0]);
        expect(outbound).toContainEqual({
            type: 'snapshotApplied',
            identity: message.snapshot.identity,
            disposition: 'applied',
        });
        expect(outbound.some((item) => item.type === 'stateChanged')).toBe(false);
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

describe('Excel first-row header toggle', () => {
    function excel_meta(active: boolean, mode: 'auto' | 'on' | 'off' = 'auto') {
        const meta = make_meta(['People'], false);
        meta.sheets[0] = {
            ...meta.sheets[0],
            rowCount: active ? 2 : 3,
            columnCount: 2,
            columnNames: active ? ['Name', 'Age'] : undefined,
            excelFirstRowHeader: {
                mode,
                detected: true,
                active,
                available: true,
            },
        };
        return meta;
    }

    it('is shown only for Excel-capable sheet metadata', async () => {
        await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'], false)));
        expect(Array.from(document.querySelectorAll('button')).some(
            (button) => button.textContent === 'First Row as Header',
        )).toBe(false);

        await dispatch_host_message(sheet_meta_message(excel_meta(true)));
        const button = get_button('First Row as Header');
        expect(button.getAttribute('aria-pressed')).toBe('true');
    });

    it('keeps an active unavailable header override disable-able', async () => {
        const { post_message } = await render_app();
        const active_empty = excel_meta(true, 'on');
        active_empty.sheets[0].rowCount = 0;
        active_empty.sheets[0].excelFirstRowHeader = {
            mode: 'on',
            detected: false,
            active: true,
            available: false,
        };
        await dispatch_host_message(sheet_meta_message(active_empty));
        post_message.mockClear();

        const button = get_button('First Row as Header');
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.getAttribute('aria-disabled')).toBeNull();
        await click_button('First Row as Header');
        const request = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .find((message): message is Extract<
                WebviewMessage,
                { type: 'setExcelFirstRowHeader' }
            > => message.type === 'setExcelFirstRowHeader')!;
        expect(request.enabled).toBe(false);

        const inactive_empty = excel_meta(false, 'off');
        inactive_empty.sheets[0].rowCount = 0;
        inactive_empty.sheets[0].excelFirstRowHeader = {
            mode: 'off',
            detected: false,
            active: false,
            available: false,
        };
        await dispatch_host_message(meta_reload_message(inactive_empty, {
            projectionChange: 'excelHeader',
            headerRequestId: request.requestId,
        }));
        expect(get_button('First Row as Header').getAttribute('aria-pressed')).toBe('false');
        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBe('true');
        const request_count = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'setExcelFirstRowHeader').length;
        await click_button('First Row as Header');
        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'setExcelFirstRowHeader')).toHaveLength(
                request_count,
            );
    });

    it('requests an authoritative toggle and waits for metaReload', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(excel_meta(true), {
            state: { rowHeights: [{ 0: 44 }] },
            generation: 4,
            sourceGeneration: 7,
        }));
        post_message.mockClear();
        const old_mount = grid_stub().getAttribute('data-mount-id');

        const header_button = get_button('First Row as Header');
        await act(async () => {
            header_button.focus();
            header_button.click();
        });

        const request = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .find((message): message is Extract<
                WebviewMessage,
                { type: 'setExcelFirstRowHeader' }
            > => message.type === 'setExcelFirstRowHeader')!;
        expect(request).toMatchObject({
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            generation: 4,
            sourceGeneration: 7,
        });
        expect(request.requestId).toMatch(/^header:[a-z0-9]+-[a-z0-9]+:1$/);
        expect(get_button('First Row as Header').getAttribute('aria-pressed')).toBe('true');
        expect(get_button('First Row as Header').disabled).toBe(false);
        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBe('true');
        expect(document.activeElement).toBe(get_button('First Row as Header'));
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Updating column names…');
        expect(grid_shell_mock.latest_props?.transform_sections).toBe(false);
        await act(async () => {
            (container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement)
                .click();
            const open_filter = grid_shell_mock.latest_props?.on_open_filter as (
                column_index: number,
                anchor: { left: number; top: number },
                restore_focus: () => void,
            ) => void;
            open_filter(0, { left: 10, top: 20 }, vi.fn());
        });
        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .some((message) => message.type === 'setTransform')).toBe(false);
        expect(document.querySelector('.filter-popover')).toBeNull();
        expect(grid_stub().getAttribute('data-row-count')).toBe('2');

        await dispatch_host_message(meta_reload_message(excel_meta(false, 'off'), {
            projectionChange: 'excelHeader',
            headerRequestId: request.requestId,
            generation: 5,
            sourceGeneration: 8,
        }));
        expect(get_button('First Row as Header').getAttribute('aria-pressed')).toBe('false');
        expect(get_button('First Row as Header').disabled).toBe(false);
        expect(document.activeElement).toBe(get_button('First Row as Header'));
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Column names updated.');
        expect(grid_stub().getAttribute('data-row-count')).toBe('3');
        expect(grid_stub().getAttribute('data-row-heights')).toBe('{}');
        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(old_mount);
    });

    it('does not restore another sheet transform while a header request is pending', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['People', 'Notes'], false);
        for (const sheet of meta.sheets) {
            sheet.excelFirstRowHeader = {
                mode: 'auto', detected: true, active: true, available: true,
            };
            sheet.columnNames = ['Name'];
        }
        await dispatch_host_message(sheet_meta_message(meta, {
            state: {
                transforms: [undefined, {
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Notes",1,["Name"]]',
                }],
            },
        }));
        await click_button('First Row as Header');
        post_message.mockClear();

        await click_button('Notes');

        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .some((message) => message.type === 'setTransform')).toBe(false);
    });

    it('tracks the header state independently per active sheet', async () => {
        await render_app();
        const meta = make_meta(['People', 'Notes'], false);
        meta.sheets[0].excelFirstRowHeader = {
            mode: 'auto', detected: true, active: true, available: true,
        };
        meta.sheets[0].columnNames = ['Name'];
        meta.sheets[1].excelFirstRowHeader = {
            mode: 'off', detected: false, active: false, available: true,
        };
        await dispatch_host_message(sheet_meta_message(meta));
        expect(get_button('First Row as Header').getAttribute('aria-pressed')).toBe('true');
        await click_button('Notes');
        expect(get_button('First Row as Header').getAttribute('aria-pressed')).toBe('false');
    });

    it('keeps the toggle enabled for active transforms but disables it while one is pending', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['People', 'Notes'], false);
        for (const sheet of meta.sheets) {
            sheet.excelFirstRowHeader = {
                mode: 'auto', detected: true, active: true, available: true,
            };
            sheet.columnNames = ['Name'];
        }
        const people_transform: SheetTransformState = {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: '["People",1,["Name"]]',
        };
        const notes_transform: SheetTransformState = {
            sort: [{ colIndex: 0, direction: 'desc' }],
            filters: [],
            schema: '["Notes",1,["Name"]]',
        };
        await dispatch_host_message(sheet_meta_message(meta, {
            state: { transforms: [people_transform, notes_transform] },
        }));
        await acknowledge_transform(latest_transform_request(post_message), 2);

        expect(get_button('First Row as Header').disabled).toBe(false);

        await click_button('Notes');
        const button = get_button('First Row as Header');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        await act(async () => button.focus());
        expect(document.querySelector('[role="tooltip"]')?.textContent)
            .toBe('Wait for sorting and filtering to finish.');
    });

    it('restores a saved transform after a header-changing metaReload', async () => {
        const { post_message } = await render_app();
        const transform: SheetTransformState = {
            sort: [{ colIndex: 1, direction: 'asc' }],
            filters: [],
            schema: '["People",2,["Name","Age"]]',
        };
        await dispatch_host_message(sheet_meta_message(excel_meta(true), {
            state: { transforms: [transform] },
            generation: 4,
            sourceGeneration: 7,
        }));
        await acknowledge_transform(latest_transform_request(post_message), 4);
        post_message.mockClear();

        await dispatch_host_message(meta_reload_message(excel_meta(false, 'off'), {
            state: {
                transforms: [{
                    sort: [{ colIndex: 1, direction: 'asc' }],
                    filters: [],
                    schema: '["People",2,null]',
                }],
                columnVisibility: [{
                    hiddenColumns: [1],
                    schema: '["People",2,null]',
                }],
            },
            projectionChange: 'excelHeader',
            generation: 5,
            sourceGeneration: 8,
        }));

        expect(latest_transform_request(post_message)).toMatchObject({
            sheetIndex: 0,
            state: {
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: '["People",2,null]',
            },
            generation: 5,
            sourceGeneration: 8,
            intent: 'restore',
        });
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!)).toEqual([0]);
    });

    it('hydrates authoritative unrelated-sheet layout on a header reload', async () => {
        const { post_message } = await render_app();
        const initial = make_meta(['People', 'Other']);
        initial.sheets[0] = excel_meta(true).sheets[0];
        await dispatch_host_message(sheet_meta_message(initial, {
            state: {
                columnWidths: [undefined, { 0: 120 }],
                rowHeights: [undefined, { 2: 40 }],
                scrollPosition: [undefined, { top: 20, left: 5 }],
                activeSheetIndex: 0,
                tabOrientation: 'horizontal',
            },
            generation: 4,
            sourceGeneration: 7,
        }));
        post_message.mockClear();

        const reloaded = make_meta(['People', 'Other']);
        reloaded.sheets[0] = excel_meta(false).sheets[0];
        await dispatch_host_message(meta_reload_message(reloaded, {
            state: {
                columnWidths: [undefined, { 0: 222 }],
                rowHeights: [undefined, { 2: 77 }],
                scrollPosition: [undefined, { top: 300, left: 25 }],
                activeSheetIndex: 1,
                tabOrientation: 'vertical',
                transforms: [undefined, undefined],
                columnVisibility: [undefined, undefined],
            },
            projectionChange: 'excelHeader',
            headerRequestId: 'other-tab-header',
            generation: 5,
            sourceGeneration: 8,
        }));

        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .some((message) => message.type === 'stateChanged')).toBe(false);
        // Active sheet and tab orientation remain local view choices, but the
        // persisted snapshot is authoritative until this tab changes them.
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        await act(async () => {
            (container!.querySelector('.stub-resize') as HTMLButtonElement).click();
        });
        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'stateChanged')
            .at(-1)).toMatchObject({
                sourceGeneration: 8,
                state: {
                    activeSheetIndex: 1,
                    tabOrientation: 'vertical',
                    columnWidths: [{ 2: 222 }, { 0: 222 }],
                    rowHeights: [undefined, { 2: 77 }],
                    scrollPosition: [undefined, { top: 300, left: 25 }],
                },
            });
        await click_button('Other');
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!))
            .toEqual({ 0: 222 });
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!))
            .toEqual({ 2: 77 });
    });

    it('does not persist a clean reload that has no authoritative state', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['People']);
        await dispatch_host_message(sheet_meta_message(meta, {
            state: {
                columnWidths: [{ 0: 140 }],
                rowHeights: [{ 2: 44 }],
                scrollPosition: [{ top: 30, left: 5 }],
                activeSheetIndex: 0,
                tabOrientation: 'horizontal',
            },
            generation: 4,
            sourceGeneration: 7,
        }));
        post_message.mockClear();

        await dispatch_host_message(meta_reload_message(meta, {
            generation: 5,
            sourceGeneration: 8,
        }));

        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .some((message) => message.type === 'stateChanged')).toBe(false);
    });

    it('does not migrate view descriptors for an ordinary detection change', async () => {
        const { post_message } = await render_app();
        const old_schema = '["People",2,["Name","Age"]]';
        const transform: SheetTransformState = {
            sort: [{ colIndex: 1, direction: 'asc' }],
            filters: [],
            schema: old_schema,
        };
        await dispatch_host_message(sheet_meta_message(excel_meta(true), {
            state: {
                transforms: [transform],
                columnVisibility: [{ hiddenColumns: [1], schema: old_schema }],
            },
            generation: 4,
            sourceGeneration: 7,
        }));
        await acknowledge_transform(latest_transform_request(post_message), 4);
        post_message.mockClear();

        await dispatch_host_message(meta_reload_message(excel_meta(false), {
            generation: 5,
            sourceGeneration: 8,
        }));

        const messages = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage);
        expect(messages.some((message) => message.type === 'setTransform')).toBe(false);
        expect(messages.filter((message) => message.type === 'stateChanged').at(-1))
            .toMatchObject({
                state: {
                    transforms: [undefined],
                    columnVisibility: [undefined],
                },
            });
    });

    it('applies terminal header recovery before clearing the request', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(excel_meta(true), {
            state: {
                rowHeights: [{ 0: 44 }],
                scrollPosition: [{ top: 100, left: 20 }],
            },
            generation: 1,
            sourceGeneration: 1,
        }));
        post_message.mockClear();
        await click_button('First Row as Header');
        const request = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .find((message): message is Extract<
                WebviewMessage,
                { type: 'setExcelFirstRowHeader' }
            > => message.type === 'setExcelFirstRowHeader')!;

        await dispatch_host_message(meta_reload_message(excel_meta(false), {
            generation: 7,
            sourceGeneration: 5,
        }));
        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBe('true');

        await dispatch_host_message({
            type: 'metaReloadRecovery',
            meta: excel_meta(false),
            state: {
                rowHeights: [undefined],
                scrollPosition: [undefined],
                transforms: [undefined],
                columnVisibility: [undefined],
            },
            projectionChange: 'excelHeader',
            headerRequestId: request.requestId,
            generation: 8,
            sourceGeneration: 6,
            error: 'The normal metadata delivery retries were exhausted.',
        });

        expect(grid_stub().getAttribute('data-generation')).toBe('8');
        expect(grid_stub().getAttribute('data-row-count')).toBe('3');
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!)).toEqual({});
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Column names were updated, but recovery was required.');
        expect(post_message).toHaveBeenCalledWith({
            type: 'showWarning',
            message: expect.stringContaining('saved after recovery'),
        });

        await act(async () => {
            (container!.querySelector('.stub-header-transform') as HTMLButtonElement).click();
        });
        const transform_request = latest_transform_request(post_message);
        expect(transform_request).toMatchObject({
            generation: 8,
            sourceGeneration: 6,
        });
        await acknowledge_transform(transform_request, 9);

        await click_button('First Row as Header');
        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'setExcelFirstRowHeader')
            .at(-1)).toMatchObject({
                generation: 9,
                sourceGeneration: 6,
            });
    });

    it('settles a dormant header request on a later correlated reload', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(excel_meta(true), {
            generation: 1,
            sourceGeneration: 1,
        }));
        post_message.mockClear();
        await click_button('First Row as Header');
        const request = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .find((message): message is Extract<
                WebviewMessage,
                { type: 'setExcelFirstRowHeader' }
            > => message.type === 'setExcelFirstRowHeader')!;

        await dispatch_host_message(meta_reload_message(excel_meta(false), {
            generation: 8,
            sourceGeneration: 6,
        }));
        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBe('true');

        await dispatch_host_message(meta_reload_message(excel_meta(false), {
            state: {
                rowHeights: [undefined],
                scrollPosition: [undefined],
                transforms: [undefined],
                columnVisibility: [undefined],
            },
            projectionChange: 'excelHeader',
            headerRequestId: request.requestId,
            generation: 9,
            sourceGeneration: 7,
        }));
        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBeNull();
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Column names updated.');

        await act(async () => {
            (container!.querySelector('.stub-header-transform') as HTMLButtonElement).click();
        });
        const transform_request = latest_transform_request(post_message);
        expect(transform_request).toMatchObject({
            generation: 9,
            sourceGeneration: 7,
        });
        await acknowledge_transform(transform_request, 10);
        await click_button('First Row as Header');
        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'setExcelFirstRowHeader')
            .at(-1)).toMatchObject({
                generation: 10,
                sourceGeneration: 7,
            });
    });

    it('clears pending state and surfaces a retained rejected result once', async () => {
        const { post_message } = await render_app();
        const initial = workbook_snapshot_message(excel_meta(false));
        await dispatch_host_message(initial);
        post_message.mockClear();
        await click_button('First Row as Header');
        const request = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .find((message): message is Extract<
                WebviewMessage,
                { type: 'setExcelFirstRowHeader' }
            > => message.type === 'setExcelFirstRowHeader')!;
        const rejected = workbook_snapshot_message(excel_meta(false), {
            identity: {
                ...initial.snapshot.identity,
                deliveryId: 2,
            },
            presentation: 'refresh',
            reason: 'excelHeader',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: request.requestId,
                outcome: 'rejected',
                error: 'The worksheet changed.',
            },
        });
        await dispatch_host_message(rejected);
        await dispatch_host_message(rejected);
        expect(get_button('First Row as Header').disabled).toBe(false);
        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBeNull();
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Column names were not updated.');
        expect(post_message).toHaveBeenCalledWith({
            type: 'showWarning',
            message: 'Could not change the header row: The worksheet changed.',
        });
        expect(post_message.mock.calls.filter(([message]) => (
            (message as WebviewMessage).type === 'showWarning'
        ))).toHaveLength(1);
    });

    it('settles a native recovered header result after applying its source snapshot', async () => {
        const { post_message } = await render_app();
        const initial_meta = excel_meta(false);
        const initial = workbook_snapshot_message(initial_meta);
        await dispatch_host_message(initial);
        post_message.mockClear();
        await click_button('First Row as Header');
        const request = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .find((message): message is Extract<
                WebviewMessage,
                { type: 'setExcelFirstRowHeader' }
            > => message.type === 'setExcelFirstRowHeader')!;
        const recovered_meta = excel_meta(true);
        await dispatch_host_message(workbook_snapshot_message(recovered_meta, {
            identity: {
                deliveryId: 2,
                authority: { fileId: 'file:test', revision: 2 },
                stateRevision: 2,
                sourceBasis: { physicalRevision: 2, projectionRevision: 1 },
            },
            generation: 2,
            sourceGeneration: 2,
            presentation: 'refresh',
            reason: 'recovery',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: request.requestId,
                outcome: 'recovered',
                error: 'The workbook view was rebuilt.',
            },
        }));

        expect(get_button('First Row as Header').getAttribute('aria-disabled')).toBeNull();
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Column names were updated, but recovery was required.');
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
        expect(post_message).toHaveBeenCalledWith({
            type: 'showWarning',
            message: 'The header setting was saved after recovery: The workbook view was rebuilt.',
        });
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'snapshotApplied',
            identity: expect.objectContaining({ deliveryId: 2 }),
        }));
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
        const messages = post_message.mock.calls.map((call) => call[0]);
        const persisted = messages.find((message) => message.type === 'stateChanged');
        expect(persisted.state.columnVisibility).toEqual([{
            hiddenColumns: [2],
            schema: '["Sheet1",3,null]',
        }]);
        expect(messages.some((message) => message.type === 'setColumnVisibility'))
            .toBe(false);
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
        expect(post_message.mock.calls.map((call) => call[0])
            .some((message) => message.type === 'setColumnVisibility')).toBe(false);

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
        const reload_messages = post_message.mock.calls.map((call) => call[0]);
        const persisted = reload_messages.find((message) => message.type === 'stateChanged');
        expect(persisted.state.columnVisibility).toEqual([undefined]);
        expect(reload_messages.some((message) => message.type === 'setColumnVisibility'))
            .toBe(false);
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

    it('exposes the stable Columns trigger as grid focus recovery', async () => {
        await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        const other = document.createElement('button');
        document.body.appendChild(other);
        other.focus();

        const recover_columns = grid_shell_mock.latest_props
            ?.on_focus_columns as (() => void) | undefined;
        await act(async () => recover_columns?.());

        expect(document.activeElement).toBe(columns_trigger());
    });

    it('adds column letters only to duplicate names', async () => {
        await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 3;
        meta.sheets[0].columnNames = ['Revenue', 'Revenue', 'Region'];
        await dispatch_host_message(sheet_meta_message(meta));

        await open_columns();
        const labels = Array.from(document.querySelectorAll(
            '.column-visibility-item',
        )).map((row) => row.textContent);
        expect(labels).toEqual([
            'Revenue (column A)',
            'Revenue (column B)',
            'Region',
        ]);
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
            'input[aria-label="Hide Value"]',
        )!;
        await act(async () => value_checkbox.click());

        expect(JSON.parse(grid_stub().getAttribute('data-projection')!))
            .toEqual([0, 2]);
        expect(grid_stub().getAttribute('data-mount-id')).toBe(mount_id);
        expect(grid_stub().getAttribute('data-generation')).toBe(generation);
        expect(columns_trigger().querySelector('.hidden-count-badge')?.textContent)
            .toBe('1');
        expect(grid_shell_mock.commit_live_edit).toHaveBeenCalledTimes(1);
        const visibility_messages = post_message.mock.calls.map((call) => call[0]);
        const targeted_messages = visibility_messages
            .filter((message) => message.type === 'setColumnVisibility');
        const state_messages = visibility_messages
            .filter((message) => message.type === 'stateChanged');
        expect(targeted_messages).toEqual([{
            type: 'setColumnVisibility',
            sheetIndex: 0,
            sheetName: 'Sheet1',
            sourceGeneration: 1,
            state: {
                hiddenColumns: [1],
                schema: '["Sheet1",3,["Name","Value","Notes"]]',
            },
        }]);
        expect(state_messages).toHaveLength(1);
        expect(visibility_messages.indexOf(targeted_messages[0]))
            .toBeLessThan(visibility_messages.indexOf(state_messages[0]));
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
        expect(post_message.mock.calls.map((call) => call[0])).toContainEqual({
            type: 'setColumnVisibility',
            sheetIndex: 0,
            sheetName: 'Sheet1',
            state: undefined,
            sourceGeneration: 1,
        });
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
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1']), {
            sourceGeneration: 7,
        }));
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
        expect(last.sourceGeneration).toBe(7);
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
            'input[aria-label="Hide Right"]',
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

    it('retains the latest queued scroll across metaReload until GridShell acknowledges it', async () => {
        await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1']), { previewMode: true })
        );
        await dispatch_host_message({ type: 'scrollToRow', row: 40 });
        await dispatch_host_message({ type: 'scrollToRow', row: 80 });
        const pending_before = JSON.parse(
            grid_stub().getAttribute('data-pending-preview-scroll')!,
        );
        expect(pending_before).toMatchObject({ row: 80 });

        await dispatch_host_message(meta_reload_message(make_meta(['Sheet1'])));
        expect(JSON.parse(grid_stub().getAttribute('data-pending-preview-scroll')!))
            .toEqual(pending_before);

        await act(async () => (
            container!.querySelector('.stub-ack-preview-scroll') as HTMLButtonElement
        ).click());
        expect(grid_stub().getAttribute('data-pending-preview-scroll')).toBe('null');
    });

    it('queues the last visible preview row across metaReload when no host scroll is pending', async () => {
        await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Sheet1']), { previewMode: true })
        );
        const report_visible = grid_shell_mock.latest_props
            ?.on_preview_visible_row_change as ((row: number) => void) | undefined;
        await act(async () => report_visible?.(75));
        expect(grid_stub().getAttribute('data-pending-preview-scroll')).toBe('null');

        await dispatch_host_message(meta_reload_message(make_meta(['Sheet1'])));
        const retained = JSON.parse(
            grid_stub().getAttribute('data-pending-preview-scroll')!,
        );
        expect(retained).toMatchObject({ row: 75 });

        await act(async () => (
            container!.querySelector('.stub-ack-preview-scroll') as HTMLButtonElement
        ).click());
        expect(grid_stub().getAttribute('data-pending-preview-scroll')).toBe('null');
    });

    it('drops queued preview scrolls on a fresh document or when preview mode ends', async () => {
        await render_app();
        await dispatch_host_message(
            sheet_meta_message(make_meta(['Preview']), { previewMode: true })
        );
        await dispatch_host_message({ type: 'scrollToRow', row: 25 });
        expect(grid_stub().getAttribute('data-pending-preview-scroll')).not.toBe('null');

        await dispatch_host_message(sheet_meta_message(make_meta(['Fresh']), {
            previewMode: true,
            generation: 2,
        }));
        expect(grid_stub().getAttribute('data-pending-preview-scroll')).toBe('null');

        await dispatch_host_message({ type: 'scrollToRow', row: 30 });
        await dispatch_host_message(sheet_meta_message(make_meta(['Editor']), {
            previewMode: false,
            generation: 3,
        }));
        expect(grid_stub().getAttribute('data-pending-preview-scroll')).toBe('null');
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

    it.each([
        ['grid shortcut', '.stub-shortcut-transform'],
        ['header menu', '.stub-header-transform'],
    ])('restores grid focus after a %s transform acknowledgement remount', async (_label, selector) => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        post_message.mockClear();
        const previous_mount = grid_stub().getAttribute('data-mount-id');
        const toolbar_focus = vi.spyOn(
            container!.querySelector('.toolbar') as HTMLElement,
            'focus',
        );

        await act(async () => (
            container!.querySelector(selector) as HTMLButtonElement
        ).click());
        const request = post_message.mock.calls.map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        expect(request).toBeDefined();
        expect(grid_shell_mock.focus_grid).not.toHaveBeenCalled();

        await dispatch_host_message({
            type: 'transformApplied', sheetIndex: 0, state: request.state,
            rowCount: 1, requestId: request.requestId, generation: 2,
            sourceGeneration: 1, intent: request.intent,
        });
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 40)));

        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(previous_mount);
        expect(grid_shell_mock.focus_grid).toHaveBeenCalledOnce();
        expect(toolbar_focus).not.toHaveBeenCalled();
    });

    it('does not restore grid focus after the webview loses focus before acknowledgement', async () => {
        const has_focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        post_message.mockClear();

        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        const request = latest_transform_request(post_message);
        await acknowledge_transform(request, 2);
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 40)));

        expect(grid_shell_mock.focus_grid).not.toHaveBeenCalled();
        has_focus.mockReturnValue(true);
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 160)));
        expect(grid_shell_mock.focus_grid).not.toHaveBeenCalled();
    });

    it('restores grid focus after a grid-opened filter applies and remounts', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        const restore_old_grid = vi.fn();
        const open_filter = grid_shell_mock.latest_props?.on_open_filter as (
            source_column: number,
            anchor: { left: number; top: number },
            restore_focus: () => void,
        ) => void;
        await act(async () => open_filter(0, { left: 20, top: 20 }, restore_old_grid));
        const input = document.querySelector(
            'input[aria-label="Filter value"]',
        ) as HTMLInputElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
                .set!.call(input, 'group');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        post_message.mockClear();
        await click_button('Apply');
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
        const request = post_message.mock.calls.map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        expect(request).toBeDefined();
        expect(restore_old_grid).not.toHaveBeenCalled();
        expect(grid_shell_mock.focus_grid).not.toHaveBeenCalled();

        await dispatch_host_message({
            type: 'transformApplied', sheetIndex: 0, state: request.state,
            rowCount: 1, requestId: request.requestId, generation: 2,
            sourceGeneration: 1, intent: request.intent,
        });
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 40)));
        expect(grid_shell_mock.focus_grid).toHaveBeenCalledOnce();
    });

    it('restores grid focus when a grid transform fails without a generation bump', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        post_message.mockClear();
        const previous_mount = grid_stub().getAttribute('data-mount-id');
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        const request = post_message.mock.calls.map((call) => call[0])
            .find((message) => message.type === 'setTransform');

        await dispatch_host_message({
            type: 'transformApplied', sheetIndex: 0,
            state: { sort: [], filters: [] }, rowCount: 1,
            requestId: request.requestId, generation: 1,
            sourceGeneration: 1, intent: request.intent, error: 'failed',
        });
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 40)));

        expect(grid_stub().getAttribute('data-mount-id')).toBe(previous_mount);
        expect(grid_shell_mock.focus_grid).toHaveBeenCalledOnce();
    });

    it('restores filter focus only for Escape and explicit Cancel', async () => {
        await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1'])));
        const open_filter = grid_shell_mock.latest_props!.on_open_filter as (
            source_column: number,
            anchor: { left: number; top: number },
            restore_focus: () => void,
        ) => void;
        const open = async (restore_focus: () => void) => {
            await act(async () => open_filter(0, { left: 20, top: 20 }, restore_focus));
            expect(document.querySelector('.filter-popover')).not.toBeNull();
        };

        const restore_after_scroll = vi.fn();
        await open(restore_after_scroll);
        await act(async () => {
            grid_stub().dispatchEvent(new Event('scroll'));
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
        expect(document.querySelector('.filter-popover')).toBeNull();
        expect(restore_after_scroll).not.toHaveBeenCalled();

        const restore_after_outside = vi.fn();
        await open(restore_after_outside);
        await act(async () => {
            document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
        expect(document.querySelector('.filter-popover')).toBeNull();
        expect(restore_after_outside).not.toHaveBeenCalled();

        const restore_after_escape = vi.fn();
        await open(restore_after_escape);
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', bubbles: true,
            }));
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
        expect(restore_after_escape).toHaveBeenCalledOnce();

        const restore_after_cancel = vi.fn();
        await open(restore_after_cancel);
        await act(async () => {
            const cancel = Array.from(document.querySelectorAll('button'))
                .find((button) => button.textContent === 'Cancel') as HTMLButtonElement;
            cancel.click();
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
        expect(restore_after_cancel).toHaveBeenCalledOnce();
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
        expect(grid_shell_mock.focus_grid).not.toHaveBeenCalled();
        await act(async () => chip.click());
        expect(document.querySelector('.filter-popover')).not.toBeNull();
    });

    it('focuses the toolbar root after Remove acknowledgement unmounts its filter chip', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        const { post_message } = await render_app();
        const schema = '["Sheet1",1,null]';
        await load_acknowledged_transform(post_message, {
            sort: [],
            filters: [{
                id: 'remove-me', colIndex: 0, operator: 'equals', value: 'x',
                caseSensitive: false, enabled: true,
            }],
            schema,
        });
        const toolbar = document.querySelector('.toolbar') as HTMLElement;
        const toolbar_focus = vi.spyOn(toolbar, 'focus');

        await act(async () => (
            document.querySelector('.filter-chip-kebab') as HTMLButtonElement
        ).click());
        const remove = get_button('Remove');
        await act(async () => {
            remove.focus();
            remove.click();
        });
        const request = latest_transform_request(post_message);
        await acknowledge_transform(request, 3);
        await flush_focus_restore();

        expect(document.querySelector('.filter-strip')).toBeNull();
        expect(document.activeElement).toBe(toolbar);
        expect(toolbar_focus).toHaveBeenCalledOnce();
        await flush_focus_restore();
        expect(toolbar_focus).toHaveBeenCalledOnce();
        expect(grid_shell_mock.focus_grid).not.toHaveBeenCalled();
    });

    it('focuses the toolbar root after Clear all acknowledgement removes its strip', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        const { post_message } = await render_app();
        await load_acknowledged_transform(post_message, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: '["Sheet1",1,null]',
        });
        const toolbar = document.querySelector('.toolbar') as HTMLElement;
        const toolbar_focus = vi.spyOn(toolbar, 'focus');

        const clear = document.querySelector('.sort-strip-clear') as HTMLButtonElement;
        await act(async () => {
            clear.focus();
            clear.click();
        });
        const request = latest_transform_request(post_message);
        await acknowledge_transform(request, 3);
        await flush_focus_restore();

        expect(document.querySelector('.sort-strip')).toBeNull();
        expect(document.activeElement).toBe(toolbar);
        expect(toolbar_focus).toHaveBeenCalledOnce();
    });

    it('does not pull focus back after the webview loses focus before acknowledgement', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        const { post_message } = await render_app();
        await load_acknowledged_transform(post_message, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: '["Sheet1",1,null]',
        });
        const toolbar = document.querySelector('.toolbar') as HTMLElement;
        const toolbar_focus = vi.spyOn(toolbar, 'focus');
        const clear = document.querySelector('.sort-strip-clear') as HTMLButtonElement;
        await act(async () => {
            clear.focus();
            clear.click();
        });

        await acknowledge_transform(latest_transform_request(post_message), 3);
        await flush_focus_restore();

        expect(document.activeElement).toBe(document.body);
        expect(toolbar_focus).not.toHaveBeenCalled();
    });

    it('focuses the toolbar root after Cancel acknowledgement removes the pending control', async () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        const { post_message } = await render_app();
        await load_acknowledged_transform(post_message, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: '["Sheet1",1,null]',
        });

        await act(async () => (
            document.querySelector('.sort-chip') as HTMLButtonElement
        ).click());
        const flip = get_button('Flip direction');
        await act(async () => {
            flip.focus();
            flip.click();
        });
        await flush_focus_restore();
        post_message.mockClear();
        const toolbar = document.querySelector('.toolbar') as HTMLElement;
        const toolbar_focus = vi.spyOn(toolbar, 'focus');
        const cancel = get_button('Cancel');
        await act(async () => {
            cancel.focus();
            cancel.click();
        });
        const request = latest_transform_request(post_message);
        await acknowledge_transform(request, 3);
        await flush_focus_restore();

        expect(Array.from(document.querySelectorAll('button'))
            .some((button) => button.textContent === 'Cancel')).toBe(false);
        expect(document.activeElement).toBe(toolbar);
        expect(toolbar_focus).toHaveBeenCalledOnce();
        expect(document.querySelector('.sort-chip')).not.toBeNull();
    });

    it('preserves a surviving sort chip across Flip acknowledgement', async () => {
        const { post_message } = await render_app();
        await load_acknowledged_transform(post_message, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: '["Sheet1",1,null]',
        });
        const toolbar_focus = vi.spyOn(
            document.querySelector('.toolbar') as HTMLElement,
            'focus',
        );
        const chip = document.querySelector('.sort-chip') as HTMLButtonElement;
        await act(async () => chip.click());
        const flip = get_button('Flip direction');
        await act(async () => {
            flip.focus();
            flip.click();
        });
        await flush_focus_restore();
        expect(document.activeElement).toBe(chip);

        const request = latest_transform_request(post_message);
        await acknowledge_transform(request, 3);
        await flush_focus_restore();

        expect(chip.isConnected).toBe(true);
        expect(document.activeElement).toBe(chip);
        expect(toolbar_focus).not.toHaveBeenCalled();
        expect(document.querySelector('.sort-chip-arrow')?.textContent).toBe('▼');
    });

    it('preserves a surviving filter chip across Enable acknowledgement', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(sheet_meta_message(make_meta(['Sheet1']), {
            state: { transforms: [{
                sort: [],
                filters: [{
                    id: 'enable-me', colIndex: 0, operator: 'equals', value: 'x',
                    caseSensitive: false, enabled: false,
                }],
                schema: '["Sheet1",1,null]',
            }] },
        }));
        post_message.mockClear();
        const toolbar_focus = vi.spyOn(
            document.querySelector('.toolbar') as HTMLElement,
            'focus',
        );
        const kebab = document.querySelector('.filter-chip-kebab') as HTMLButtonElement;
        await act(async () => kebab.click());
        const enable = get_button('Enable');
        await act(async () => {
            enable.focus();
            enable.click();
        });
        await flush_focus_restore();
        expect(document.activeElement).toBe(kebab);

        const request = latest_transform_request(post_message);
        await acknowledge_transform(request, 3);
        await flush_focus_restore();

        expect(kebab.isConnected).toBe(true);
        expect(document.activeElement).toBe(kebab);
        expect(toolbar_focus).not.toHaveBeenCalled();
        expect(document.querySelector('.filter-chip')?.classList.contains('disabled'))
            .toBe(false);
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
