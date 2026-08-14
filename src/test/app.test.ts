// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    CsvSaveOperation,
    HostMessage,
    SheetTransformState,
    SheetViewRecord,
    TransformIntent,
    WebviewMessage,
} from '../types';
import { MAX_PERSISTED_ROW_HEIGHTS } from '../types';
import type { WorkbookMeta } from '../data-source/interface';
import type { WorkbookSnapshot } from '../viewer-snapshot';
import type { EditSessionStore } from '../webview/edit-session-store';
import type { GridShellProps } from '../webview/grid-shell';
import { sheet_edits } from './pending-edits-helper';

const grid_shell_mock = vi.hoisted(() => ({
    is_dirty: false,
    has_live_uncommitted: false,
    save_in_flight: false,
    has_uncommitted_changes: false,
    mount_count: 0,
    on_editing_change: null as null | ((status: { is_dirty: boolean; has_live_uncommitted: boolean; save_in_flight: boolean; edits: Record<string, { value: string; base: string }>; conflicted: string[] }) => void),
    request_save: vi.fn(() => false),
    clear_dirty: vi.fn(),
    discard_conflicted: vi.fn(),
    discard_keys: vi.fn((_keys: readonly string[]) => {}),
    commit_live_edit: vi.fn(),
    flush_live_edit: vi.fn(),
    stop_edit_admission: vi.fn(),
    focus_grid: vi.fn(),
    select_all: vi.fn(),
    copy_sheet: vi.fn(async () => {}),
    copy_selection: vi.fn(),
    auto_fit_result: { 0: 120 } as Record<number, number> | null,
    latest_props: null as Record<string, unknown> | null,
    emit_pending_edits_on_mount: false,
    write_on_session_change: false,
    listen_for_save_result: false,
}));

// Stand-in store for the handful of renders that don't pass one, so the stub can
// call useSyncExternalStore unconditionally. Both functions are constants: an
// unstable subscribe would resubscribe every render, and an unstable snapshot
// would violate the store contract and loop.
const empty_edit_session = vi.hoisted(() => {
    const empty: ReadonlyMap<string, { value: string; base: string }> = new Map();
    return { subscribe: () => () => {}, snapshot: () => empty };
});

// Glide's DataEditor renders to a <canvas>, which jsdom can't drive. Replace the
// grid with a DOM stub that surfaces the props App feeds it (sheet index,
// generation, formatting flag, preview flag, column widths) and exposes a button
// that fires `on_column_resize`, so we can exercise App's wiring without canvas.
vi.mock('../webview/grid-shell', () => ({
    GridShell: (props: GridShellProps) => {
        grid_shell_mock.latest_props = props as unknown as Record<string, unknown>;
        const mount_id = React.useRef(++grid_shell_mock.mount_count);
        // Subscribe the way the real use_editing does, so `data-store-edits`
        // reports what a mounted grid would actually paint from — an install that
        // never reaches a subscriber is indistinguishable from no install at all.
        const store_edits = React.useSyncExternalStore(
            props.edit_session?.subscribe ?? empty_edit_session.subscribe,
            props.edit_session?.snapshot ?? empty_edit_session.snapshot,
        );
        // Models the real shell's session-keyed effects (the save-lifecycle
        // replace_dirty and the pendingEdits persistence effect): a child effect
        // that writes to the store under the session id it was just handed. React
        // runs this before App's own passive effects, so it is the window in which
        // a lagging session stamp would silently fence the write off.
        // The key is derived from the session id so each session's write is
        // distinguishable: keying them all the same way would let the accepted
        // write from the first session stand in for a dropped one from the second.
        React.useEffect(() => {
            if (!grid_shell_mock.write_on_session_change) return;
            if (!props.edit_session || !props.edit_session_id) return;
            props.edit_session.commit(props.edit_session_id, `session:${props.edit_session_id}`, {
                value: 'written by a session-keyed child effect',
                base: 'base',
            });
        }, [props.edit_session, props.edit_session_id]);
        // Models the real shell's own `message` listener (grid-shell.tsx:641),
        // which calls replace_dirty on a saveResult while capturing the
        // edit_session_id from the render that registered it. Child effects run
        // before the parent's, so on the first mount this listener is registered
        // ahead of App's; a remount re-registers it *after* App's, flipping the
        // dispatch order. The write then lands after App has already installed
        // and re-stamped, which is where the ownership fence could drop it.
        React.useEffect(() => {
            if (!grid_shell_mock.listen_for_save_result) return;
            const session_at_registration = props.edit_session_id;
            const store = props.edit_session;
            const handler = (event: MessageEvent) => {
                if (event.data?.type !== 'saveResult') return;
                store?.replace(session_at_registration, {
                    'restored:by:shell': { value: 'shell restore', base: 'base' },
                });
            };
            window.addEventListener('message', handler);
            return () => window.removeEventListener('message', handler);
        }, [props.edit_session, props.edit_session_id]);
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
        React.useLayoutEffect(() => {
            if (!props.grid_actions_ref) return;
            const handle = {
                sheet_index: props.sheet_index,
                select_all: () => grid_shell_mock.select_all(),
                copy_sheet: () => grid_shell_mock.copy_sheet(),
                copy_selection: () => grid_shell_mock.copy_selection(),
            };
            props.grid_actions_ref.current = handle;
            return () => {
                if (props.grid_actions_ref?.current === handle) {
                    props.grid_actions_ref.current = null;
                }
            };
        }, [props.generation, props.grid_actions_ref, props.sheet_index]);
        React.useEffect(() => {
            grid_shell_mock.on_editing_change = props.on_editing_change ?? null;
            grid_shell_mock.on_editing_change?.({
                is_dirty: grid_shell_mock.is_dirty,
                has_live_uncommitted: grid_shell_mock.has_live_uncommitted,
                save_in_flight: grid_shell_mock.save_in_flight,
                edits: grid_shell_mock.is_dirty ? { '0:0': { value: 'dirty', base: 'base' } } : {},
                conflicted: [],
            });
            if (
                grid_shell_mock.emit_pending_edits_on_mount
                && props.edit_mode
                && props.edit_session_id
            ) {
                (globalThis as typeof globalThis & {
                    acquireVsCodeApi: () => { postMessage: (message: unknown) => void };
                }).acquireVsCodeApi().postMessage({
                    type: 'pendingEditsChanged',
                    editSessionId: props.edit_session_id,
                    edits: store_edits.size > 0
                        ? Object.fromEntries(store_edits)
                        : null,
                });
            }
            return () => {
                grid_shell_mock.on_editing_change = null;
            };
        }, [props.on_editing_change, store_edits]);
        if (props.editing_ref) {
            props.editing_ref.current = {
                request_save: () => {
                    const result = grid_shell_mock.request_save();
                    if (!props.save_operation) props.on_save_request?.();
                    return result;
                },
                clear_dirty: grid_shell_mock.clear_dirty,
                discard_conflicted: grid_shell_mock.discard_conflicted,
                discard_keys: grid_shell_mock.discard_keys,
                stop_edit_admission: grid_shell_mock.stop_edit_admission,
                commit_live_edit: grid_shell_mock.commit_live_edit,
                flush_live_edit: grid_shell_mock.flush_live_edit,
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
                'data-show-formatting': String(props.show_formatting),
                'data-preview': String(props.preview_mode ?? false),
                'data-edit-mode': String(props.edit_mode ?? false),
                'data-host-rejected-keys': JSON.stringify(props.host_rejected_keys ?? []),
                'data-store-edits': JSON.stringify(Object.fromEntries(store_edits)),
                'data-mount-id': String(mount_id.current),
                'data-projection': JSON.stringify(props.column_projection.visible_to_source),
                'data-source-to-visible': JSON.stringify(props.column_projection.source_to_visible),
                'data-col-widths': JSON.stringify(props.column_widths),
                'data-row-heights': JSON.stringify(props.row_heights),
                'data-row-height-overlay': JSON.stringify(
                    props.row_height_overlay ?? null,
                ),
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
                    // Display-row intervals, the way the real shell coalesces a row
                    // selection before handing it up: rows 3, 5 and 8 as three of them.
                    onClick: () => props.on_row_resize(
                        [
                            { start: 3, end: 3 },
                            { start: 5, end: 5 },
                            { start: 8, end: 8 },
                        ],
                        50,
                    ),
                },
                'row-resize'
            ),
            React.createElement(
                'button',
                {
                    className: 'stub-row-resize-over-cap',
                    // A select-all resize on a sheet larger than a sheet may keep custom
                    // heights for: one interval, so it costs nothing to build, and the
                    // whole request is over the cap rather than the accumulated map.
                    onClick: () => props.on_row_resize(
                        [{ start: 0, end: MAX_PERSISTED_ROW_HEIGHTS }],
                        50,
                    ),
                },
                'row-resize-over-cap'
            ),
            React.createElement(
                'button',
                {
                    className: 'stub-shortcut-transform',
                    onClick: () => props.on_transform_change?.({
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
                    onClick: () => props.on_transform_change?.({
                        sort: [{ colIndex: 0, direction: 'desc' }],
                        filters: [],
                    }),
                },
                'grid-header-transform'
            ),
            React.createElement(
                'button',
                {
                    // A filter defined but left switched off: entries, so it installs and
                    // moves the view generation, but nothing active, so it produces no
                    // permutation and moves no row.
                    className: 'stub-inactive-filter-transform',
                    onClick: () => props.on_transform_change?.({
                        sort: [],
                        filters: [{
                            id: 'f1',
                            colIndex: 0,
                            operator: 'contains',
                            value: 'z',
                            caseSensitive: false,
                            enabled: false,
                        }],
                    }),
                },
                'grid-inactive-filter-transform'
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
let active_post_message: ReturnType<typeof vi.fn> | undefined;
let save_lifecycle_revision = 0;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function make_meta(sheet_names: string[], has_formatting = true): WorkbookMeta {
    return {
        hasFormatting: has_formatting,
        sheets: sheet_names.map((name) => ({
            name,
            rowCount: 1,
            sourceRowCount: 1,
            columnCount: 1,
            merges: [],
            hasFormatting: has_formatting,
        })),
    };
}

async function render_app() {
    vi.resetModules();
    const post_message = vi.fn();
    active_post_message = post_message;

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

async function dispatch_host_message(input: HostMessage | Record<string, unknown>) {
    let msg = input as Record<string, unknown>;
    const outgoing = active_post_message?.mock.calls.map((call) => call[0]) ?? [];
    if (msg.type === 'editSessionResult' && msg.requestId === undefined) {
        const request = [...outgoing].reverse().find((candidate) => (
            candidate?.type === 'requestEditSession'
        ));
        msg = {
            ...msg,
            requestId: request?.requestId ?? 'legacy-edit-request',
            ...(msg.granted === true && msg.editSessionId === undefined
                ? { editSessionId: 'test-edit-session' }
                : {}),
        };
    } else if (msg.type === 'saveDialogResult' && msg.requestId === undefined) {
        const request = [...outgoing].reverse().find((candidate) => (
            candidate?.type === 'showSaveDialog'
        ));
        msg = {
            ...msg,
            requestId: request?.requestId ?? 'legacy-dialog-request',
            editSessionId: request?.editSessionId ?? 'test-edit-session',
        };
    } else if (msg.type === 'saveOperationStarted' && msg.lifecycle === undefined) {
        const operation = msg.operation as CsvSaveOperation;
        msg = {
            type: msg.type,
            lifecycle: {
                revision: ++save_lifecycle_revision,
                state: 'active',
                operation,
            },
        };
    } else if (
        (msg.type === 'saveResult' || msg.type === 'editSessionRevoked')
        && msg.lifecycle === undefined
    ) {
        const operation = grid_shell_mock.latest_props?.save_operation as
            CsvSaveOperation | undefined;
        const terminal_operation: CsvSaveOperation = operation ?? {
            editSessionId: typeof msg.editSessionId === 'string'
                ? msg.editSessionId
                : 'test-edit-session',
            saveRequestId: typeof msg.saveRequestId === 'string'
                ? msg.saveRequestId
                : 'legacy-save-request',
            worksheets: [{
                sheetIndex: 0,
                edits: { '0:0': 'dirty' },
                dirtyEdits: { '0:0': { value: 'dirty', base: 'base' } },
            }],
        };
        msg = {
            type: msg.type,
            ...(msg.reason ? { reason: msg.reason } : {}),
            ...(msg.success !== undefined ? { success: msg.success } : {}),
            lifecycle: {
                revision: ++save_lifecycle_revision,
                state: msg.type === 'editSessionRevoked' || msg.success === true
                    ? 'succeeded'
                    : 'failed',
                operation: terminal_operation,
            },
        };
    }
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

/** Open a toolbar split button's all-sheets menu by its chevron's accessible name. */
async function open_scope_menu(aria_label: string) {
    const caret = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.toolbar-split-caret'),
    ).find((button) => button.getAttribute('aria-label') === aria_label);
    expect(caret, `no scope menu named ${aria_label}`).toBeDefined();
    await act(async () => caret!.click());
}

function get_menu_item(label: string): HTMLButtonElement {
    const item = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((node) => node.textContent === label);
    expect(item, `no menu item ${label}`).toBeDefined();
    return item!;
}

async function click_menu_item(label: string) {
    await act(async () => get_menu_item(label).click());
}

async function notify_auto_fit_sample_change() {
    const notify = grid_shell_mock.latest_props?.on_auto_fit_sample_change as
        (() => void) | undefined;
    expect(notify).toBeDefined();
    await act(async () => notify!());
}

async function click_sheet_tab(name: string) {
    const tab = Array.from(document.querySelectorAll<HTMLButtonElement>('.sheet-tab'))
        .find((button) => button.textContent === name);
    expect(tab).toBeDefined();
    await act(async () => tab!.click());
}

async function click_button(label: string) {
    await act(async () => {
        get_button(label).click();
    });
}

/** The tab-orientation control, which lives on the sheet tab strip rather than the toolbar. */
async function click_orientation_toggle() {
    const button = document.querySelector<HTMLButtonElement>('.sheet-tabs-orientation');
    expect(button).not.toBeNull();
    await act(async () => {
        button!.click();
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

/**
 * The install message the host would post, built the way PanelCore builds it: the
 * record describes what is installed and takes the arm `permuted` selects, while the
 * durable rules the webview acknowledges ride the message beside it, normalized to
 * `undefined` when they carry no entries.
 */
function transform_installed_message(
    request: {
        sheetIndex: number;
        requestId: string;
        intent: TransformIntent;
        state: SheetTransformState;
        sourceGeneration: number;
    },
    options: {
        generation: number;
        rowCount?: number;
        state?: SheetTransformState;
        permuted?: boolean;
        hiddenEditedCellKeys?: readonly string[];
        rowHeights?: Readonly<Record<number, number>>;
        mappingGeneration?: number;
    },
): Extract<HostMessage, { type: 'transformInstalled' }> {
    const rules = options.state ?? request.state;
    const has_entries = rules.sort.length > 0
        || rules.filters.length > 0
        || (rules.hiddenRows?.length ?? 0) > 0;
    const is_active = rules.sort.length > 0
        || rules.filters.some((filter) => filter.enabled)
        || (rules.hiddenRows?.length ?? 0) > 0;
    const permuted = options.permuted ?? is_active;
    const basis = {
        generation: options.generation,
        sourceGeneration: request.sourceGeneration,
        schema: rules.schema ?? '["Sheet1",1,null]',
    };
    return {
        type: 'transformInstalled',
        sheetIndex: request.sheetIndex,
        requestId: request.requestId,
        intent: request.intent,
        view: permuted
            ? {
                basis,
                permuted: true,
                rules,
                rowCount: options.rowCount ?? 1,
                hiddenEditedCellKeys: options.hiddenEditedCellKeys ?? [],
            }
            : { basis, permuted: false, rowCount: options.rowCount ?? 1 },
        rules: has_entries ? rules : undefined,
        // Empty by default: an install carries the sheet's display-keyed height
        // projection beside the record, and having no custom heights is the ordinary
        // case. A test about heights surviving a permutation names this explicitly.
        rowHeights: options.rowHeights ?? {},
        // Defaults to the view generation, which is what the host sends for every install
        // that actually permutes — the overwhelming majority, and what these tests are
        // about. A test about an install that moves no row passes the older mapping
        // generation explicitly.
        mappingGeneration: options.mappingGeneration ?? options.generation,
    };
}

async function acknowledge_transform(
    request: Extract<WebviewMessage, { type: 'setTransform' }>,
    generation: number,
    hiddenEditedCellKeys: readonly string[] = [],
) {
    await dispatch_host_message(
        transform_installed_message(request, { generation, hiddenEditedCellKeys }),
    );
}

async function flush_focus_restore() {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
}

async function load_acknowledged_transform(
    post_message: ReturnType<typeof vi.fn>,
    state: SheetTransformState,
) {
    await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
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

async function open_grid_filter(column_index = 0) {
    const open_filter = grid_shell_mock.latest_props?.on_open_filter as (
        source_column: number,
        anchor: { left: number; top: number },
        restore_focus: () => void,
    ) => void;
    await act(async () => open_filter(
        column_index,
        { left: 20, top: 20 },
        vi.fn(),
    ));
}

function latest_histogram_request(post_message: ReturnType<typeof vi.fn>) {
    const request = post_message.mock.calls
        .map((call) => call[0] as WebviewMessage)
        .filter((message): message is Extract<
            WebviewMessage,
            { type: 'requestFilterHistogram' }
        > => message.type === 'requestFilterHistogram')
        .at(-1);
    expect(request).toBeDefined();
    return request!;
}

async function enter_edit_mode(
    post_message: ReturnType<typeof vi.fn>,
    edit_session_id = 'test-edit-session',
) {
    await click_button('Edit');
    expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
        type: 'requestEditSession',
        requestId: expect.any(String),
    }));
    await dispatch_host_message({
        type: 'editSessionResult',
        granted: true,
        editSessionId: edit_session_id,
    });
}

function seed_mounted_store(
    edits: Record<string, { value: string; base: string; base_pending?: boolean }> = {
        '0:0': { value: 'dirty', base: 'base' },
    },
) {
    const props = grid_shell_mock.latest_props as {
        edit_session?: EditSessionStore;
        edit_session_id?: string;
    } | null;
    expect(props?.edit_session).toBeDefined();
    expect(props?.edit_session_id).toBeDefined();
    props!.edit_session!.replace(props!.edit_session_id, edits);
}

async function report_grid_editing(
    dirty: boolean,
    uncommitted = dirty,
    conflicted: string[] = [],
    edits: Record<string, { value: string; base: string }> = dirty
        ? { '0:0': { value: 'dirty', base: 'base' } }
        : {},
    save_in_flight = false,
) {
    // The overlay-attributable part of "uncommitted" is whatever is uncommitted
    // beyond the committed dirty map — i.e. an open overlay differing from base.
    const has_live_uncommitted = uncommitted && !dirty;
    grid_shell_mock.is_dirty = dirty;
    grid_shell_mock.has_live_uncommitted = has_live_uncommitted;
    grid_shell_mock.has_uncommitted_changes = uncommitted;
    grid_shell_mock.save_in_flight = save_in_flight;
    await act(async () => {
        grid_shell_mock.on_editing_change?.({
            is_dirty: dirty,
            has_live_uncommitted,
            save_in_flight,
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

function latest_store_edits(): Record<
    string,
    { value: string; base: string; base_pending?: boolean }
> {
    const store = grid_shell_mock.latest_props?.edit_session as
        | EditSessionStore
        | undefined;
    return store ? Object.fromEntries(store.snapshot()) : {};
}

type SnapshotExtra = Omit<Partial<WorkbookSnapshot>,
    'identity' | 'state' | 'configuration' | 'capabilities'> & {
        identity?: Partial<WorkbookSnapshot['identity']>;
        state?: Partial<WorkbookSnapshot['state']>;
        configuration?: Partial<WorkbookSnapshot['configuration']>;
        capabilities?: Partial<WorkbookSnapshot['capabilities']>;
    };

function initial_snapshot_message(
    meta: WorkbookMeta,
    extra: SnapshotExtra = {},
): Extract<HostMessage, { type: 'workbookSnapshot' }> {
    return workbook_snapshot_message(meta, extra);
}

function refresh_snapshot_message(
    meta: WorkbookMeta,
    extra: SnapshotExtra = {},
): Extract<HostMessage, { type: 'workbookSnapshot' }> {
    return workbook_snapshot_message(meta, {
        generation: 2,
        sourceGeneration: 2,
        presentation: 'refresh',
        reason: 'fileReload',
        ...extra,
    });
}

let snapshot_delivery_sequence = 0;

function workbook_snapshot_message(
    meta: WorkbookMeta,
    extra: SnapshotExtra = {},
): Extract<HostMessage, { type: 'workbookSnapshot' }> {
    const delivery_id = extra.identity?.deliveryId ?? ++snapshot_delivery_sequence;
    const { state, configuration, capabilities, identity, ...snapshot_extra } = extra;
    return {
        type: 'workbookSnapshot',
        snapshot: {
            generation: 1,
            sourceGeneration: 1,
            presentation: 'initial',
            reason: 'ready',
            meta,
            // One entry per sheet, empty by default: a delivery that says nothing is
            // out of sight is the ordinary case. Tests about a held record's hidden
            // cells surviving (or not surviving) a refresh must name this explicitly —
            // a default that guessed would decide the question they are asking.
            hiddenEditedCellKeys: meta.sheets.map(() => []),
            // Likewise one entry per sheet, `undefined` by default: that is what the host
            // sends for a sheet with no custom row heights.
            rowHeightProjection: meta.sheets.map(() => undefined),
            // No `rowHeights` in `state`, and that is not an omission: the field is
            // `Omit`ted from `NormalizedPerFileState`, so a delivery cannot carry the
            // durable source-keyed map at all. `rowHeightProjection` above is the only
            // height fact that crosses to the webview.
            state: {
                columnWidths: [],
                scrollPosition: [],
                activeSheetIndex: 0,
                tabOrientation: null,
                transforms: meta.sheets.map(() => undefined),
                columnVisibility: meta.sheets.map(() => undefined),
                cellHighlights: undefined,
                ...state,
            },
            configuration: {
                defaultTabOrientation: 'horizontal',
                previewMode: false,
                ...configuration,
            },
            capabilities: {
                csvEditable: false,
                csvEditingSupported: false,
                ...capabilities,
                csvSaveLifecycle: capabilities?.csvSaveLifecycle
                    ?? { revision: 0, state: 'idle' },
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
                ...identity,
            },
            ...snapshot_extra,
            // One entry per sheet, defaulting to *this delivery's own* generation, i.e.
            // "every sheet's mapping moved at this generation". Faithful rather than
            // convenient: the ordinary reason a delivery's generation has moved at all is
            // an adoption, and `adopt_source` raises the floor for every sheet, so that is
            // what the host really sends. It also keeps the interesting case — a generation
            // that moved because *another* sheet's mapping did — something a test has to
            // state outright instead of inheriting from a default that guessed.
            //
            // After the spread, so an explicit value still wins.
            mappingGenerations: snapshot_extra.mappingGenerations
                ?? meta.sheets.map(() => snapshot_extra.generation ?? 1),
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
    active_post_message = undefined;
    save_lifecycle_revision = 0;
    document.body.innerHTML = '';
    document.documentElement.style.removeProperty('--table-viewer-font-family');
    document.documentElement.style.removeProperty('--table-viewer-font-size');
    grid_shell_mock.is_dirty = false;
    grid_shell_mock.has_live_uncommitted = false;
    grid_shell_mock.save_in_flight = false;
    grid_shell_mock.has_uncommitted_changes = false;
    grid_shell_mock.mount_count = 0;
    snapshot_delivery_sequence = 0;
    grid_shell_mock.on_editing_change = null;
    grid_shell_mock.request_save.mockReset();
    grid_shell_mock.request_save.mockReturnValue(false);
    grid_shell_mock.clear_dirty.mockReset();
    grid_shell_mock.discard_conflicted.mockReset();
    grid_shell_mock.discard_keys.mockReset();
    grid_shell_mock.commit_live_edit.mockReset();
    grid_shell_mock.flush_live_edit.mockReset();
    grid_shell_mock.stop_edit_admission.mockReset();
    grid_shell_mock.focus_grid.mockReset();
    grid_shell_mock.select_all.mockReset();
    grid_shell_mock.copy_sheet.mockReset();
    grid_shell_mock.copy_selection.mockReset();
    grid_shell_mock.auto_fit_result = { 0: 120 };
    grid_shell_mock.emit_pending_edits_on_mount = false;
    grid_shell_mock.write_on_session_change = false;
    grid_shell_mock.listen_for_save_result = false;
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

    it('applies and clears live font updates', async () => {
        await render_app();
        await dispatch_host_message({
            type: 'fontChanged',
            fontFamily: 'Atkinson Hyperlegible',
            fontSize: 16,
        });
        expect(document.documentElement.style.getPropertyValue(
            '--table-viewer-font-family',
        )).toBe('Atkinson Hyperlegible');
        expect(document.documentElement.style.getPropertyValue(
            '--table-viewer-font-size',
        )).toBe('16px');

        await dispatch_host_message({
            type: 'fontChanged',
            fontFamily: null,
            fontSize: null,
        });
        expect(document.documentElement.style.getPropertyValue(
            '--table-viewer-font-family',
        )).toBe('');
        expect(document.documentElement.style.getPropertyValue(
            '--table-viewer-font-size',
        )).toBe('');
    });

    it('mounts the grid and toolbar after the initial snapshot', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
        expect(container!.querySelector('.grid-shell-stub')).not.toBeNull();
        expect(get_button('Auto-fit Columns')).toBeDefined();
    });

    it('threads sheet index and generation into the grid', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
        expect(grid_stub().getAttribute('data-generation')).toBe('1');
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');

        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1'])));
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
    });
});

describe('cell highlight clear-all wiring', () => {
    it('posts a selection-free command and resolves pending from its response', async () => {
        const { post_message } = await render_app();
        const snapshot = initial_snapshot_message(make_meta(['Sheet1']));
        await dispatch_host_message(snapshot);
        post_message.mockClear();

        await click_button('Highlight');
        const clear_all = get_button('Clear all highlights');
        expect(clear_all.disabled).toBe(false);
        await click_button('Clear all highlights');

        const request = post_message.mock.calls.map((call) => call[0]).at(-1);
        expect(request).toEqual({
            type: 'clearAllCellHighlights',
            requestId: expect.any(String),
            generation: snapshot.snapshot.generation,
            sourceGeneration: snapshot.snapshot.sourceGeneration,
            snapshotIdentity: snapshot.snapshot.identity,
        });
        expect(request).not.toHaveProperty('sheetIndex');
        expect(request).not.toHaveProperty('selection');

        await click_button('Highlight');
        expect(get_button('Clear all highlights').disabled).toBe(true);
        await dispatch_host_message({
            type: 'cellHighlightsChanged',
            requestId: request.requestId,
            stateRevision: snapshot.snapshot.identity.stateRevision + 1,
            physicalRevision: snapshot.snapshot.identity.sourceBasis.physicalRevision,
            state: undefined,
            sourceGeneration: snapshot.snapshot.sourceGeneration,
        });
        expect(get_button('Clear all highlights').disabled).toBe(false);
        const status_id = get_button('Highlight').getAttribute('aria-describedby');
        expect(status_id).not.toBeNull();
        expect(document.getElementById(status_id!)?.textContent)
            .toBe('Cell highlights updated.');
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
                scrollPosition: [],
                activeSheetIndex: 1,
                tabOrientation: 'vertical',
                // On the active sheet: editing is worksheet-scoped, so the grid only
                // shows a restored map while the tab holding it is the one on screen.
                pendingEdits: sheet_edits({ '0:0': { value: 'new', base: 'old' } }, 1),
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
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!))
            .toEqual({ '0:0': { value: 'new', base: 'old' } });
        // Orientation now lives on the tab strip: the rail is what shows it applied.
        expect(container!.querySelector('.sheet-tabs-vertical')).not.toBeNull();
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
        await click_orientation_toggle();
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
                scrollPosition: [],
                activeSheetIndex: 1,
                tabOrientation: 'horizontal',
                transforms: [],
                columnVisibility: [],
            },
        });
        await dispatch_host_message(refresh);

        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        // Orientation now lives on the tab strip: the rail is what shows it applied.
        expect(container!.querySelector('.sheet-tabs-vertical')).not.toBeNull();
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
                columnWidths: [], scrollPosition: [],
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
                csvEditSessionId: 'test-edit-session',
            },
            state: {
                columnWidths: [], scrollPosition: [],
                activeSheetIndex: 0, tabOrientation: null,
                pendingEdits: sheet_edits(authoritative),
                transforms: [undefined],
                columnVisibility: [undefined],
            },
        }));

        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!))
            .toEqual(authoritative);
        const pending_messages = post_message.mock.calls.map((call) => call[0])
            .filter((item) => item.type === 'pendingEditsChanged');
        expect(pending_messages).toContainEqual({
            type: 'pendingEditsChanged',
            editSessionId: 'test-edit-session',
            edits: authoritative,
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
        await click_button('Header Row');
        const request = post_message.mock.calls.map((call) => call[0] as WebviewMessage)
            .find((item): item is Extract<WebviewMessage, { type: 'setExcelFirstRowHeader' }> =>
                item.type === 'setExcelFirstRowHeader')!;
        expect(get_button('Header Row').getAttribute('aria-disabled')).toBe('true');
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
                columnWidths: [], scrollPosition: [],
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
        expect(get_button('Header Row').getAttribute('aria-disabled')).toBeNull();

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
        expect(get_button('Header Row').getAttribute('aria-disabled')).toBeNull();
        expect(document.querySelector('[role="status"]')?.textContent ?? '').toBe('');
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
    });

    it('settles only a matching retained header result and only once', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['People']);
        meta.sheets[0].excelFirstRowHeader = {
            mode: 'auto', detected: true, active: true, available: true,
        };
        await dispatch_host_message(workbook_snapshot_message(meta));
        await click_button('Header Row');
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
        expect(get_button('Header Row').getAttribute('aria-disabled')).toBe('true');

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
        expect(get_button('Header Row').getAttribute('aria-disabled')).toBeNull();
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
                columnWidths: [], scrollPosition: [],
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
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));

        // Defaults on.
        expect(grid_stub().getAttribute('data-show-formatting')).toBe('true');

        await click_button('Formatting');
        expect(grid_stub().getAttribute('data-show-formatting')).toBe('false');
    });

    it('keeps formatting per sheet, not per workbook', async () => {
        // Reading one sheet raw while another stays formatted is a real thing to
        // want, and it is what makes Formatting a sibling of the other view toggles
        // rather than the odd one out (#154).
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['First', 'Second'])));

        await click_button('Formatting');
        expect(grid_stub().getAttribute('data-show-formatting')).toBe('false');

        await click_sheet_tab('Second');
        expect(grid_stub().getAttribute('data-show-formatting')).toBe('true');

        await click_sheet_tab('First');
        expect(grid_stub().getAttribute('data-show-formatting')).toBe('false');
    });

    it('applies raw values to every sheet from the scope menu', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['First', 'Second'])));

        await open_scope_menu('Formatting scope');
        await click_menu_item('Show raw values on all 2 sheets');
        expect(grid_stub().getAttribute('data-show-formatting')).toBe('false');

        await click_sheet_tab('Second');
        expect(grid_stub().getAttribute('data-show-formatting')).toBe('false');
    });

    it('persists the per-sheet choice and restores it', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['First', 'Second'])));
        post_message.mockClear();

        await click_button('Formatting');
        const last = post_message.mock.calls.at(-1)![0];
        expect(last.type).toBe('stateChanged');
        expect(last.state.showFormatting[0]).toBe(false);
    });

    it('restores saved formatting from initial snapshot state', async () => {
        // Reloading the same file after an external edit keeps the choice, rather
        // than snapping every sheet back to formatted.
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['First', 'Second']), {
                state: { showFormatting: [false, true] },
            }),
        );

        expect(grid_stub().getAttribute('data-show-formatting')).toBe('false');
        await click_sheet_tab('Second');
        expect(grid_stub().getAttribute('data-show-formatting')).toBe('true');
    });

    it('takes the new file\'s setting when the panel opens a different file', async () => {
        // Not the outgoing file's, which an array nobody cleared would supply by
        // sheet index — a choice made in one workbook leaking into an unrelated one.
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['First', 'Second'])));
        await click_button('Formatting');
        expect(grid_stub().getAttribute('data-show-formatting')).toBe('false');

        const other = workbook_snapshot_message(make_meta(['Alpha', 'Beta']), {
            identity: {
                deliveryId: 2,
                authority: { fileId: 'file:other', revision: 1 },
                stateRevision: 1,
                sourceBasis: { physicalRevision: 1, projectionRevision: 0 },
            },
            presentation: 'initial',
        });
        await dispatch_host_message(other);

        expect(grid_stub().getAttribute('data-show-formatting')).toBe('true');
    });

    it('offers no scope menu for a single-sheet workbook', async () => {
        // The chevron could only restate the button.
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Only'])));

        expect(document.querySelector('.toolbar-split-caret')).toBeNull();
    });

    it('hides the Formatting button when the workbook has no formatting', async () => {
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false))
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

    function excel_meta_multi(active: boolean[]) {
        const meta = make_meta(active.map((_, i) => `S${i + 1}`), false);
        meta.sheets = meta.sheets.map((sheet, index) => ({
            ...sheet,
            rowCount: 3,
            columnCount: 2,
            excelFirstRowHeader: {
                mode: 'auto' as const,
                detected: true,
                active: active[index],
                available: true,
            },
        }));
        return meta;
    }

    it('queues one host request per sheet for the all-sheets action', async () => {
        // The host takes one of these at a time, so "all sheets" drains as a queue.
        // Sheets already in the target state never enter it — S2 is already on.
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(excel_meta_multi([false, true, false])),
        );

        await open_scope_menu('Header row scope');
        await click_menu_item('Use first row as header on all 3 sheets');

        const header_requests = () => post_message.mock.calls
            .map((call) => call[0] as { type: string; sheetIndex?: number })
            .filter((message) => message.type === 'setExcelFirstRowHeader');

        // One in flight, and only one: the second must wait for the first to land.
        expect(header_requests().map((request) => request.sheetIndex)).toEqual([0]);
    });

    it('drops the queue rather than draining it into a different workbook', async () => {
        // Queue entries are bare sheet indices, and the load clears the in-flight
        // request that was holding the drain back. Left standing, the rest of the
        // queue would promote header rows in a file nobody asked it of.
        const { post_message } = await render_app();
        await dispatch_host_message(
            workbook_snapshot_message(excel_meta_multi([false, false, false]), {
                identity: {
                    deliveryId: 1,
                    authority: { fileId: 'file:A', revision: 1 },
                    stateRevision: 1,
                    sourceBasis: { physicalRevision: 1, projectionRevision: 0 },
                },
            }),
        );

        await open_scope_menu('Header row scope');
        await click_menu_item('Use first row as header on all 3 sheets');

        const header_requests = () => post_message.mock.calls
            .map((call) => call[0] as { type: string })
            .filter((message) => message.type === 'setExcelFirstRowHeader');
        expect(header_requests()).toHaveLength(1);

        // A different file drops the in-flight request, which is the only thing that
        // was holding the rest of the queue back.
        await dispatch_host_message(
            workbook_snapshot_message(excel_meta_multi([false, false, false]), {
                identity: {
                    deliveryId: 2,
                    authority: { fileId: 'file:B', revision: 1 },
                    stateRevision: 1,
                    sourceBasis: { physicalRevision: 1, projectionRevision: 0 },
                },
            }),
        );
        expect(header_requests()).toHaveLength(1);
    });

    it('leaves the all-sheets items dead when every sheet is already there', async () => {
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(excel_meta_multi([true, true])),
        );

        await open_scope_menu('Header row scope');
        const items = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
        );
        expect(items.map((item) => [item.textContent, item.disabled])).toEqual([
            ['Use first row as header on all 2 sheets', true],
            ['Show first row as data on all 2 sheets', false],
        ]);
    });

    it('is shown only for Excel-capable sheet metadata', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'], false)));
        expect(Array.from(document.querySelectorAll('button')).some(
            (button) => button.textContent === 'Header Row',
        )).toBe(false);

        await dispatch_host_message(initial_snapshot_message(excel_meta(true)));
        const button = get_button('Header Row');
        expect(button.getAttribute('aria-pressed')).toBe('true');
    });

    it('keeps an active unavailable header override disable-able', async () => {
        const { post_message } = await render_app();
        const active_empty = excel_meta(true, 'on');
        active_empty.sheets[0].rowCount = 0;
        active_empty.sheets[0].sourceRowCount = 0;
        active_empty.sheets[0].excelFirstRowHeader = {
            mode: 'on',
            detected: false,
            active: true,
            available: false,
        };
        await dispatch_host_message(initial_snapshot_message(active_empty));
        post_message.mockClear();

        const button = get_button('Header Row');
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect(button.getAttribute('aria-disabled')).toBeNull();
        await click_button('Header Row');
        const request = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .find((message): message is Extract<
                WebviewMessage,
                { type: 'setExcelFirstRowHeader' }
            > => message.type === 'setExcelFirstRowHeader')!;
        expect(request.enabled).toBe(false);

        const inactive_empty = excel_meta(false, 'off');
        inactive_empty.sheets[0].rowCount = 0;
        inactive_empty.sheets[0].sourceRowCount = 0;
        inactive_empty.sheets[0].excelFirstRowHeader = {
            mode: 'off',
            detected: false,
            active: false,
            available: false,
        };
        await dispatch_host_message(refresh_snapshot_message(inactive_empty, {
            reason: 'excelHeader',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: request.requestId,
                outcome: 'applied',
            },
        }));
        expect(get_button('Header Row').getAttribute('aria-pressed')).toBe('false');
        expect(get_button('Header Row').getAttribute('aria-disabled')).toBe('true');
        const request_count = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'setExcelFirstRowHeader').length;
        await click_button('Header Row');
        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'setExcelFirstRowHeader')).toHaveLength(
                request_count,
            );
    });

    it('requests an authoritative toggle and waits for the result snapshot', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(excel_meta(true), {
            rowHeightProjection: [{ 0: 44 }],
            generation: 4,
            sourceGeneration: 7,
        }));
        expect(grid_stub().getAttribute('data-row-heights')).toBe('{"0":44}');
        post_message.mockClear();
        const old_mount = grid_stub().getAttribute('data-mount-id');

        const header_button = get_button('Header Row');
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
        expect(get_button('Header Row').getAttribute('aria-pressed')).toBe('true');
        expect(get_button('Header Row').disabled).toBe(false);
        expect(get_button('Header Row').getAttribute('aria-disabled')).toBe('true');
        expect(document.activeElement).toBe(get_button('Header Row'));
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

        await dispatch_host_message(refresh_snapshot_message(excel_meta(false, 'off'), {
            reason: 'excelHeader',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: request.requestId,
                outcome: 'applied',
            },
            generation: 5,
            sourceGeneration: 8,
        }));
        expect(get_button('Header Row').getAttribute('aria-pressed')).toBe('false');
        expect(get_button('Header Row').disabled).toBe(false);
        expect(document.activeElement).toBe(get_button('Header Row'));
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Column names updated.');
        expect(grid_stub().getAttribute('data-row-count')).toBe('3');
        // The projection is adopted whole from each delivery, so the promotion's own
        // (empty) one replaces the one above. It is not the webview clearing heights on a
        // header change: the durable map is source-keyed and survives — this delivery
        // simply names no display row with a custom height.
        expect(grid_stub().getAttribute('data-row-heights')).toBe('{}');
        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(old_mount);
    });

    it('blocks every header-row command path during Edit mode', async () => {
        const { post_message } = await render_app();
        const meta = excel_meta_multi([true, false]);
        meta.sheets[0].sourceRowCount = 4;
        meta.sheets[0].excelFirstRowHeader = {
            ...meta.sheets[0].excelFirstRowHeader!,
            mode: 'on',
            sourceRow: 2,
        };
        const transform: SheetTransformState = {
            sort: [],
            filters: [],
            hiddenRows: [0, 1],
            schema: '["S1",2,null]',
        };
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
            },
            state: { transforms: [transform] },
        }));
        await acknowledge_transform(latest_transform_request(post_message), 2);
        await enter_edit_mode(post_message);
        post_message.mockClear();

        const button = get_button('Header Row');
        expect(button.getAttribute('aria-disabled')).toBe('true');
        await click_button('Header Row');

        await open_scope_menu('Header row scope');
        const scope_items = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
        );
        expect(scope_items).toHaveLength(2);
        expect(scope_items.every((item) => item.disabled)).toBe(true);
        await click_menu_item('Show first row as data on all 2 sheets');

        const unhide = get_button('Unhide all');
        expect(unhide.disabled).toBe(true);
        await click_button('Unhide all');

        expect(grid_shell_mock.latest_props?.can_promote_row_to_header).toBe(false);
        await act(async () => {
            const promote = grid_shell_mock.latest_props?.on_promote_row_to_header as
                ((display_row: number) => void);
            promote(2);
        });

        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .some((message) => message.type === 'setExcelFirstRowHeader')).toBe(false);
    });

    it('requests row promotion from the row-header context action', async () => {
        const { post_message } = await render_app();
        const meta = excel_meta(false, 'off');
        meta.sheets[0].sourceRowCount = 4;
        await dispatch_host_message(initial_snapshot_message(meta, {
            generation: 6,
            sourceGeneration: 9,
        }));
        post_message.mockClear();

        expect(grid_shell_mock.latest_props?.can_promote_row_to_header).toBe(true);
        await act(async () => {
            const promote = grid_shell_mock.latest_props?.on_promote_row_to_header as
                ((display_row: number) => void);
            promote(2);
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
            enabled: true,
            headerRow: 2,
            generation: 6,
            sourceGeneration: 9,
        });
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Making row header…');
        expect(grid_shell_mock.latest_props?.transform_sections).toBe(false);

        const promoted = excel_meta(true, 'on');
        promoted.sheets[0].sourceRowCount = 4;
        promoted.sheets[0].excelFirstRowHeader = {
            ...promoted.sheets[0].excelFirstRowHeader!,
            sourceRow: 2,
        };
        await dispatch_host_message(refresh_snapshot_message(promoted, {
            reason: 'excelHeader',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: request.requestId,
                outcome: 'applied',
            },
        }));
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Header row updated.');
    });

    it('routes Unhide all through an atomic header command for a nonzero header', async () => {
        const { post_message } = await render_app();
        const meta = excel_meta(true, 'on');
        meta.sheets[0].sourceRowCount = 4;
        meta.sheets[0].excelFirstRowHeader = {
            ...meta.sheets[0].excelFirstRowHeader!,
            sourceRow: 2,
        };
        const transform: SheetTransformState = {
            sort: [],
            filters: [],
            hiddenRows: [0, 1],
            schema: '["People",2,["Name","Age"]]',
        };
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: { transforms: [transform] },
            generation: 3,
            sourceGeneration: 5,
        }));
        const restore = latest_transform_request(post_message);
        await acknowledge_transform(restore, 4);
        post_message.mockClear();

        await click_button('Unhide all');

        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            unhideAll: true,
            generation: 4,
            sourceGeneration: 5,
        }));
        expect(post_message.mock.calls.map((call) => call[0] as WebviewMessage)
            .some((message) => message.type === 'setTransform')).toBe(false);
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Restoring rows…');
    });

    it('keeps a row-zero header active when Unhide all clears other hidden rows', async () => {
        const { post_message } = await render_app();
        const meta = excel_meta(true, 'on');
        meta.sheets[0].sourceRowCount = 4;
        meta.sheets[0].excelFirstRowHeader = {
            ...meta.sheets[0].excelFirstRowHeader!,
            sourceRow: 0,
        };
        const transform: SheetTransformState = {
            sort: [],
            filters: [],
            hiddenRows: [2],
            schema: '["People",2,["Name","Age"]]',
        };
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: { transforms: [transform] },
        }));
        await acknowledge_transform(latest_transform_request(post_message), 2);
        post_message.mockClear();

        await click_button('Unhide all');

        expect(post_message.mock.calls.map((call) => call[0] as WebviewMessage)
            .some((message) => message.type === 'setExcelFirstRowHeader')).toBe(false);
        expect(latest_transform_request(post_message).state.hiddenRows).toBeUndefined();
    });

    it('can enable the header after restoring an initially all-hidden sheet', async () => {
        const { post_message } = await render_app();
        const meta = excel_meta(false, 'off');
        meta.sheets[0].sourceRowCount = 3;
        meta.sheets[0].excelFirstRowHeader!.available = false;
        const transform: SheetTransformState = {
            sort: [],
            filters: [],
            hiddenRows: [0, 1, 2],
            schema: '["People",2,null]',
        };
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: { transforms: [transform] },
        }));
        await acknowledge_transform(latest_transform_request(post_message), 2);
        post_message.mockClear();

        await click_button('Unhide all');
        const unhide = latest_transform_request(post_message);
        expect(unhide.state.hiddenRows).toBeUndefined();
        await acknowledge_transform(unhide, 3);
        post_message.mockClear();

        expect(get_button('Header Row').getAttribute('aria-disabled')).toBeNull();
        await click_button('Header Row');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'setExcelFirstRowHeader',
            enabled: true,
            generation: 3,
        }));
    });

    it('atomically disables an unavailable explicit header while unhiding all rows', async () => {
        const { post_message } = await render_app();
        const meta = excel_meta(false, 'on');
        meta.sheets[0].sourceRowCount = 3;
        meta.sheets[0].excelFirstRowHeader = {
            mode: 'on', detected: false, active: false, available: false,
        };
        const transform: SheetTransformState = {
            sort: [],
            filters: [],
            hiddenRows: [0, 1, 2],
            schema: '["People",2,null]',
        };
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: { transforms: [transform] },
        }));
        await acknowledge_transform(latest_transform_request(post_message), 2);
        post_message.mockClear();

        await click_button('Unhide all');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'setExcelFirstRowHeader',
            enabled: false,
            unhideAll: true,
        }));
        expect(post_message.mock.calls.map((call) => call[0] as WebviewMessage)
            .some((message) => message.type === 'setTransform')).toBe(false);
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
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: {
                transforms: [undefined, {
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Notes",1,["Name"]]',
                }],
            },
        }));
        await click_button('Header Row');
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
        await dispatch_host_message(initial_snapshot_message(meta));
        expect(get_button('Header Row').getAttribute('aria-pressed')).toBe('true');
        await click_button('Notes');
        expect(get_button('Header Row').getAttribute('aria-pressed')).toBe('false');
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
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: { transforms: [people_transform, notes_transform] },
        }));
        await acknowledge_transform(latest_transform_request(post_message), 2);

        expect(get_button('Header Row').disabled).toBe(false);

        await click_button('Notes');
        const button = get_button('Header Row');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        await act(async () => button.focus());
        expect(document.querySelector('[role="tooltip"]')?.textContent)
            .toBe('Wait for sorting and filtering to finish.');
    });

    it('restores a saved transform after a header-changing snapshot', async () => {
        const { post_message } = await render_app();
        const transform: SheetTransformState = {
            sort: [{ colIndex: 1, direction: 'asc' }],
            filters: [],
            schema: '["People",2,["Name","Age"]]',
        };
        await dispatch_host_message(initial_snapshot_message(excel_meta(true), {
            state: { transforms: [transform] },
            generation: 4,
            sourceGeneration: 7,
        }));
        await acknowledge_transform(latest_transform_request(post_message), 4);
        post_message.mockClear();

        await dispatch_host_message(refresh_snapshot_message(excel_meta(false, 'off'), {
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
            reason: 'excelHeader',
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
        await dispatch_host_message(initial_snapshot_message(initial, {
            state: {
                columnWidths: [undefined, { 0: 120 }],
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
        await dispatch_host_message(refresh_snapshot_message(reloaded, {
            // Heights reach the grid as the host's display-keyed projection, and *only*
            // as that: the durable source-keyed map is not on the wire at all, which the
            // echoed `stateChanged` below is asserted to confirm.
            rowHeightProjection: [undefined, { 2: 77 }],
            state: {
                columnWidths: [undefined, { 0: 222 }],
                scrollPosition: [undefined, { top: 300, left: 25 }],
                activeSheetIndex: 1,
                tabOrientation: 'vertical',
                transforms: [undefined, undefined],
                columnVisibility: [undefined, undefined],
            },
            reason: 'excelHeader',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: 'other-tab-header',
                outcome: 'applied',
            },
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
                    scrollPosition: [undefined, { top: 300, left: 25 }],
                },
            });
        // And no height leaf at all in what this panel echoes back. It was never sent
        // one, so there is nothing for it to carry — the strongest form of "the webview
        // cannot clobber a host-written height", one step past the missing patch leaf.
        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'stateChanged')
            .at(-1)!.state).not.toHaveProperty('rowHeights');
        await click_button('Other');
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!))
            .toEqual({ 0: 222 });
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!))
            .toEqual({ 2: 77 });
    });

    it('keeps custom row heights across a first-row-header promotion', async () => {
        // The end-to-end shape of the change to `header_changed`. Both halves are named
        // non-empty on purpose: an assertion that the grid shows `{}` after a promotion
        // is satisfied just as well by the old clearing as by a delivery that carries no
        // projection, so it distinguishes nothing. Here source row 2 keeps its height and
        // simply *moves*, from display row 2 to display row 1, because the promoted header
        // leaves the display space — which is the whole claim of a source-keyed map.
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(excel_meta(false), {
            state: {
                columnWidths: [{ 0: 140 }],
                scrollPosition: [{ top: 30, left: 5 }],
            },
            rowHeightProjection: [{ 2: 44 }],
            generation: 1,
            sourceGeneration: 1,
        }));
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!)).toEqual({ 2: 44 });
        post_message.mockClear();

        await dispatch_host_message(refresh_snapshot_message(excel_meta(true), {
            state: {
                columnWidths: [{ 0: 140 }],
                scrollPosition: [{ top: 30, left: 5 }],
            },
            // The durable map behind this is unchanged, because a promotion renumbers no
            // source row; only the display space it projects into moved.
            rowHeightProjection: [{ 1: 44 }],
            reason: 'excelHeader',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: 'promote',
                outcome: 'applied',
            },
            generation: 2,
            sourceGeneration: 2,
        }));

        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!)).toEqual({ 1: 44 });
        // And this panel carries no durable copy to erase: the next `stateChanged` it
        // posts for some other leaf has no height leaf in it, because none was delivered.
        // The scroll offset beside it *is* cleared, which is the asymmetry: pixels down a
        // row layout the promotion changed have no key space in which they survive.
        await act(async () => {
            (container!.querySelector('.stub-resize') as HTMLButtonElement).click();
        });
        const echoed = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'stateChanged')
            .at(-1)!;
        expect(echoed).toMatchObject({ state: { scrollPosition: [undefined] } });
        expect(echoed.state).not.toHaveProperty('rowHeights');
    });

    it('does not persist a clean reload that has no authoritative state', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['People']);
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: {
                columnWidths: [{ 0: 140 }],
                scrollPosition: [{ top: 30, left: 5 }],
                activeSheetIndex: 0,
                tabOrientation: 'horizontal',
            },
            generation: 4,
            sourceGeneration: 7,
        }));
        post_message.mockClear();

        await dispatch_host_message(refresh_snapshot_message(meta, {
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
        await dispatch_host_message(initial_snapshot_message(excel_meta(true), {
            state: {
                transforms: [transform],
                columnVisibility: [{ hiddenColumns: [1], schema: old_schema }],
            },
            generation: 4,
            sourceGeneration: 7,
        }));
        await acknowledge_transform(latest_transform_request(post_message), 4);
        post_message.mockClear();

        await dispatch_host_message(refresh_snapshot_message(excel_meta(false), {
            generation: 5,
            sourceGeneration: 8,
        }));

        const messages = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage);
        expect(messages.some((message) => message.type === 'setTransform')).toBe(false);
        expect(messages.some((message) => message.type === 'stateChanged')).toBe(false);
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!)).toEqual([0, 1]);
    });

    it('applies terminal header recovery before clearing the request', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(excel_meta(true), {
            state: {
                scrollPosition: [{ top: 100, left: 20 }],
            },
            generation: 1,
            sourceGeneration: 1,
        }));
        post_message.mockClear();
        await click_button('Header Row');
        const request = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .find((message): message is Extract<
                WebviewMessage,
                { type: 'setExcelFirstRowHeader' }
            > => message.type === 'setExcelFirstRowHeader')!;

        await dispatch_host_message(refresh_snapshot_message(excel_meta(false), {
            generation: 7,
            sourceGeneration: 5,
        }));
        expect(get_button('Header Row').getAttribute('aria-disabled')).toBe('true');

        await dispatch_host_message(refresh_snapshot_message(excel_meta(false), {
            state: {
                scrollPosition: [undefined],
                transforms: [undefined],
                columnVisibility: [undefined],
            },
            reason: 'recovery',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: request.requestId,
                outcome: 'recovered',
                error: 'The normal snapshot delivery retries were exhausted.',
            },
            generation: 8,
            sourceGeneration: 6,
        }));

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

        await click_button('Header Row');
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
        await dispatch_host_message(initial_snapshot_message(excel_meta(true), {
            generation: 1,
            sourceGeneration: 1,
        }));
        post_message.mockClear();
        await click_button('Header Row');
        const request = post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .find((message): message is Extract<
                WebviewMessage,
                { type: 'setExcelFirstRowHeader' }
            > => message.type === 'setExcelFirstRowHeader')!;

        await dispatch_host_message(refresh_snapshot_message(excel_meta(false), {
            generation: 8,
            sourceGeneration: 6,
        }));
        expect(get_button('Header Row').getAttribute('aria-disabled')).toBe('true');

        await dispatch_host_message(refresh_snapshot_message(excel_meta(false), {
            state: {
                scrollPosition: [undefined],
                transforms: [undefined],
                columnVisibility: [undefined],
            },
            reason: 'excelHeader',
            commandResult: {
                type: 'excelFirstRowHeader',
                requestId: request.requestId,
                outcome: 'applied',
            },
            generation: 9,
            sourceGeneration: 7,
        }));
        expect(get_button('Header Row').getAttribute('aria-disabled')).toBeNull();
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
        await click_button('Header Row');
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
        await click_button('Header Row');
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
        expect(get_button('Header Row').disabled).toBe(false);
        expect(get_button('Header Row').getAttribute('aria-disabled')).toBeNull();
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
        await click_button('Header Row');
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

        expect(get_button('Header Row').getAttribute('aria-disabled')).toBeNull();
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
    it('hides tabs and the orientation control for a single sheet', async () => {
        // The control lives on the tab strip, so it is gone under exactly the
        // condition the tabs are — it can never be a button with nothing to act on.
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Only'])));
        expect(container!.querySelectorAll('.sheet-tab')).toHaveLength(0);
        expect(container!.querySelector('.sheet-tabs-orientation')).toBeNull();
    });

    it('switches the active sheet and persists the selection', async () => {
        const { post_message } = await render_app();
        const initial = initial_snapshot_message(make_meta(['First', 'Second']));
        await dispatch_host_message(initial);
        post_message.mockClear();

        await click_button('Second');

        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(post_message).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'stateChanged',
                snapshotIdentity: initial.snapshot.identity,
                state: expect.objectContaining({ activeSheetIndex: 1 }),
            })
        );
    });

    function right_click_tab(name: string) {
        const tab = Array.from(container!.querySelectorAll<HTMLButtonElement>('.sheet-tab'))
            .find((button) => button.textContent === name);
        expect(tab).toBeDefined();
        act(() => tab!.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: 30, clientY: 40,
        })));
    }

    it('runs Select all immediately from the active sheet tab menu', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['First', 'Second'])));
        right_click_tab('First');
        expect(Array.from(document.querySelectorAll('[role="menuitem"]'), (item) => item.textContent))
            .toEqual([
                'Copy sheet',
                'Select all',
                // An accelerator for the control on the strip, never its only route in.
                'Move sheet tabs to the left of the table',
            ]);
        await act(async () => get_button('Select all').click());
        expect(grid_shell_mock.select_all).toHaveBeenCalledOnce();
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('defers Copy sheet from an inactive tab until its grid mounts', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['First', 'Second'])));
        post_message.mockClear();
        right_click_tab('Second');
        await act(async () => get_button('Copy sheet').click());
        // The action targets the not-yet-active sheet, so App switches sheets…
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'stateChanged',
            state: expect.objectContaining({ activeSheetIndex: 1 }),
        }));
        // …and fires copy_sheet once the target grid handle is mounted.
        expect(grid_shell_mock.copy_sheet).toHaveBeenCalledOnce();
        expect(grid_shell_mock.select_all).not.toHaveBeenCalled();
    });

    it('holds a deferred sheet action until the target sheet transform is applied', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['First', 'Second']);
        meta.sheets[1].columnNames = ['Name'];
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: {
                transforms: [undefined, {
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Second",1,["Name"]]',
                }],
            },
        }));
        post_message.mockClear();
        right_click_tab('Second');
        await act(async () => get_button('Copy sheet').click());
        // Switched to the target sheet, but its persisted sort is still applying,
        // so the copy must not serialize the untransformed rows yet.
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(grid_shell_mock.copy_sheet).not.toHaveBeenCalled();
        // Acknowledge the restore transform; only then does the copy run.
        const request = latest_transform_request(post_message);
        await acknowledge_transform(request, 3);
        expect(grid_shell_mock.copy_sheet).toHaveBeenCalledOnce();
    });

    it('dismissing the sheet tab menu runs no action', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['First', 'Second'])));
        right_click_tab('First');
        const menu = document.querySelector('[role="menu"]') as HTMLElement;
        expect(menu).not.toBeNull();
        await act(async () => {
            menu.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', bubbles: true,
            }));
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(grid_shell_mock.select_all).not.toHaveBeenCalled();
        expect(grid_shell_mock.copy_sheet).not.toHaveBeenCalled();
    });
});

describe('column width persistence', () => {
    it('stores a column resize per sheet and persists it', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
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

    it('restores saved column widths from initial snapshot state', async () => {
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1']), {
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
        await dispatch_host_message(initial_snapshot_message(meta, {
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
            .some((message) => message.type === 'stateChanged')).toBe(false);
    });

    it('sanitizes invalid columns and persists the corrected descriptor', async () => {
        const { post_message } = await render_app();
        post_message.mockClear();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 3;
        await dispatch_host_message(initial_snapshot_message(meta, {
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
        await dispatch_host_message(initial_snapshot_message(initial, {
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

        await dispatch_host_message(initial_snapshot_message(initial, {
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
        await dispatch_host_message(refresh_snapshot_message(reloaded));
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!))
            .toEqual([0, 1, 2]);
        const reload_messages = post_message.mock.calls.map((call) => call[0]);
        expect(reload_messages.some((message) => message.type === 'stateChanged'))
            .toBe(false);
        expect(reload_messages.some((message) => message.type === 'setColumnVisibility'))
            .toBe(false);
    });

    it('supports an all-hidden projection', async () => {
        await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 2;
        await dispatch_host_message(initial_snapshot_message(meta, {
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
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
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
        await dispatch_host_message(initial_snapshot_message(meta));

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
        const initial = initial_snapshot_message(meta, {
            state: {
                columnVisibility: [undefined, {
                    hiddenColumns: [1],
                    schema: '["Sheet2",2,null]',
                }],
            },
        });
        await dispatch_host_message(initial);
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
            snapshotIdentity: initial.snapshot.identity,
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
            snapshotIdentity: initial.snapshot.identity,
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
        await dispatch_host_message(initial_snapshot_message(meta, {
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
        await dispatch_host_message(initial_snapshot_message(make_meta(['Preview']), {
            configuration: { previewMode: true },
        }));
        expect(columns_trigger().disabled).toBe(false);

        await dispatch_host_message(initial_snapshot_message(make_meta(['Editable'], false), {
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
            },
            generation: 2,
        }));
        expect(columns_trigger().disabled).toBe(false);
        await click_button('Edit');
        expect(columns_trigger().disabled).toBe(false);
        await dispatch_host_message({ type: 'editSessionResult', granted: true });
        expect(columns_trigger().disabled).toBe(false);

        await dispatch_host_message(initial_snapshot_message(make_meta(['Pending']), {
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
    it('asks the host to persist a row resize and paints it at once', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
            generation: 4,
            sourceGeneration: 7,
        }));
        post_message.mockClear();

        await act(async () => {
            (container!.querySelector('.stub-row-resize') as HTMLButtonElement).click();
        });

        // The durable write is the host's, so all the webview posts is the request —
        // display intervals plus the pair of generations that make them meaningful. No
        // `stateChanged`: heights are not a layout patch leaf any more, and the webview
        // holds no copy of the durable map to send.
        expect(post_message).toHaveBeenCalledOnce();
        expect(post_message.mock.calls.at(-1)![0]).toEqual({
            type: 'setRowHeights',
            sheetIndex: 0,
            rows: [
                { start: 3, end: 3 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ],
            height: 50,
            generation: 4,
            sourceGeneration: 7,
        });
        // Meanwhile the resize is visible immediately, as an overlay over the delivered
        // projection rather than in it: nothing durable has come back yet.
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!)).toEqual({});
        expect(JSON.parse(grid_stub().getAttribute('data-row-height-overlay')!))
            .toEqual([{
                rows: [
                    { start: 3, end: 3 },
                    { start: 5, end: 5 },
                    { start: 8, end: 8 },
                ],
                height: 50,
            }]);
    });

    it('drops the optimistic overlay once the delivered projection agrees', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
            generation: 4,
            sourceGeneration: 7,
        }));
        post_message.mockClear();
        await act(async () => {
            (container!.querySelector('.stub-row-resize') as HTMLButtonElement).click();
        });

        // What the host does with the request: maps the display rows to source rows,
        // persists them, and delivers the re-projected result at the same generation.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1']), {
            generation: 4,
            sourceGeneration: 7,
            reason: 'other',
            rowHeightProjection: [{ 3: 50, 5: 50, 8: 50 }],
        }));

        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!))
            .toEqual({ 3: 50, 5: 50, 8: 50 });
        // Dropped rather than left to shadow the projection: kept, it would mask a later
        // height for those rows for the rest of the generation.
        expect(grid_stub().getAttribute('data-row-height-overlay')).toBe('null');
    });

    /**
     * A resize the overlay painted, with the delivery that answers it withheld. Every
     * test below then delivers something *other* than the answer and reads the overlay.
     */
    async function pending_resize(): Promise<{ post_message: ReturnType<typeof vi.fn> }> {
        const rendered = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 4,
            sourceGeneration: 7,
        }));
        await act(async () => {
            (container!.querySelector('.stub-row-resize') as HTMLButtonElement).click();
        });
        expect(grid_stub().getAttribute('data-row-height-overlay')).not.toBe('null');
        return rendered;
    }

    it('discards the overlay when a delivery moves its own sheet\'s mapping', async () => {
        await pending_resize();

        // A moved mapping *for this sheet* means a different arrangement of its rows, and
        // the overlay's keys are display rows read off the old one. Reconciling by value
        // cannot save it: the projection that arrives is about rows this layer never named,
        // so it would neither agree with the layer nor make it right — it would just keep
        // masking whatever row 3 is now.
        //
        // `mappingGenerations` says outright that sheet 0 is the sheet that moved, which is
        // the half of the rule the retention test below must not be allowed to swallow.
        //
        // Pinned by one line now, and it used to take two. This was a pair of gates held
        // jointly — the delivery dropped the overlay and the render site refused any
        // overlay whose generation was not current, each surviving its own removal because
        // the other held. Scoping the discard per sheet moved the decision into
        // `retained_row_height_overlay`, where inverting the comparison fails this test on
        // its own; the render-site generation gate is what is now unfalsifiable, and says so
        // at its call site.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 5,
            sourceGeneration: 7,
            reason: 'other',
            mappingGenerations: [5, 4],
            rowHeightProjection: [{ 1: 33 }, undefined],
        }));

        expect(grid_stub().getAttribute('data-row-height-overlay')).toBe('null');
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!)).toEqual({ 1: 33 });
    });

    it('keeps the overlay when a delivery moves another sheet\'s mapping', async () => {
        await pending_resize();

        // The case that made `mappingGenerations` necessary. A terminal transform
        // reconciliation — a background sort on sheet 1 finishing — bumps the core-wide
        // generation and forces a delivery, while `commit_transform_reconciliation` rewrites
        // only sheet 1's indices. Sheet 0's display rows have not moved, and the host, which
        // asks the scoped question through `mapping_generation`, still *accepts* the resize
        // this layer is waiting on. Discarding here — which the old `previous.generation !==
        // snapshot.generation` test did, because a snapshot names no sheet — sprang the row
        // back and then let the height silently reappear when the write was delivered.
        //
        // Deliberately not inferred from `sourceGeneration`: it is unchanged here, and it is
        // equally unchanged when the sheet that moved is sheet 0, so it cannot tell the two
        // apart. See `retained_row_height_overlay`.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 5,
            sourceGeneration: 7,
            reason: 'other',
            mappingGenerations: [4, 5],
            rowHeightProjection: [undefined, { 1: 33 }],
        }));

        expect(JSON.parse(grid_stub().getAttribute('data-row-height-overlay')!))
            .toEqual(PENDING_LAYER);
        // Rebased, not merely retained: the render site compares the overlay's generation
        // with the current one, so a layer left at 4 would be held in state and painted
        // nowhere — which is exactly what the assertion above would catch. Proved a second
        // way by the reconciliation still working at the new generation.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 5,
            sourceGeneration: 7,
            reason: 'other',
            mappingGenerations: [4, 5],
            rowHeightProjection: [{ 3: 50, 5: 50, 8: 50 }, { 1: 33 }],
        }));
        expect(grid_stub().getAttribute('data-row-height-overlay')).toBe('null');
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!))
            .toEqual({ 3: 50, 5: 50, 8: 50 });
    });

    it('discards the overlay when an adoption moves every sheet\'s mapping', async () => {
        await pending_resize();

        // Adoption needs no special case, and this is the test of that claim. A physical
        // refresh or an Excel header promotion replaces the rows themselves, so
        // `adopt_source` clears the per-sheet map and raises `mapping_generation_floor` to
        // the generation it installs — every sheet reports having moved, and the uniform
        // rule discards. Were adoption to leave any sheet's mapping generation behind, the
        // overlay would survive a source change, which is the one thing no per-sheet fact
        // can license.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 5,
            sourceGeneration: 8,
            reason: 'fileReload',
            mappingGenerations: [5, 5],
        }));

        expect(grid_stub().getAttribute('data-row-height-overlay')).toBe('null');
    });

    it('discards the overlay when a new document arrives', async () => {
        await pending_resize();

        // An `initial` presentation is a different document, or the same one reloaded
        // from scratch. Its generation may well repeat the one the layer was tagged
        // with — generations restart per source — so the presentation is the only thing
        // that catches this, and a layer surviving it would paint a height the user set
        // on a file they are no longer looking at.
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 4,
            sourceGeneration: 7,
        }));

        expect(grid_stub().getAttribute('data-row-height-overlay')).toBe('null');
    });

    const PENDING_LAYER = [{
        rows: [
            { start: 3, end: 3 },
            { start: 5, end: 5 },
            { start: 8, end: 8 },
        ],
        height: 50,
    }];

    it('does not paint one sheet\'s pending resize on another sheet', async () => {
        await pending_resize();

        // A tab switch moves no generation, so nothing about the overlay's own tags
        // changes — the sheet test has to be applied where it is *read*. Painted on the
        // other sheet it would show heights at display rows 3, 5 and 8 of a sheet nobody
        // resized, and the delivery that answers the real resize would not clear them.
        await click_button('Other');
        expect(grid_stub().getAttribute('data-row-height-overlay')).toBe('null');

        await click_button('Sheet1');
        expect(JSON.parse(grid_stub().getAttribute('data-row-height-overlay')!))
            .toEqual(PENDING_LAYER);
    });

    it('keeps one sheet\'s pending resize across a resize on another sheet', async () => {
        const { post_message } = await pending_resize();

        // Two sheets with a resize in flight at once. Reachable without a mid-drag tab
        // switch: the request for Sheet1 is still on its way to the host — or its answer
        // still on its way back — while the user opens Other and drags a boundary there.
        // Holding one overlay slot made the second resize *replace* the first, so coming
        // back to Sheet1 before its delivery landed showed a completed resize snapping back.
        post_message.mockClear();
        await click_button('Other');
        await act(async () => {
            (container!.querySelector('.stub-row-resize') as HTMLButtonElement).click();
        });
        expect(post_message.mock.calls.at(-1)![0]).toMatchObject({
            type: 'setRowHeights',
            sheetIndex: 1,
        });
        expect(JSON.parse(grid_stub().getAttribute('data-row-height-overlay')!))
            .toEqual(PENDING_LAYER);

        await click_button('Sheet1');
        expect(JSON.parse(grid_stub().getAttribute('data-row-height-overlay')!))
            .toEqual(PENDING_LAYER);

        // And the two are answered independently. This delivery agrees with Other's layer
        // and says nothing about Sheet1's, so exactly one retires — which is also what
        // stops the per-sheet split from being satisfied by one shared list of layers.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 4,
            sourceGeneration: 7,
            reason: 'other',
            rowHeightProjection: [undefined, { 3: 50, 5: 50, 8: 50 }],
        }));
        expect(JSON.parse(grid_stub().getAttribute('data-row-height-overlay')!))
            .toEqual(PENDING_LAYER);
        await click_button('Other');
        expect(grid_stub().getAttribute('data-row-height-overlay')).toBe('null');
    });

    it('leaves the overlay alone when an install lands on another sheet', async () => {
        const { post_message } = await pending_resize();

        // The other sheet's stored sort, restored when its tab is opened, so the ack below
        // is one the app is actually waiting for. Its projection is made to agree with
        // sheet 0's pending layer *exactly*, which is the only arrangement in which the
        // per-sheet gate on the install path is visible: value reconciliation would
        // otherwise read this ack as the answer to sheet 0's resize and drop the layer,
        // discarding a resize the user is still waiting on.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 4,
            sourceGeneration: 7,
            reason: 'other',
            state: {
                transforms: [undefined, {
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Other",1,null]',
                }],
            },
        }));
        await click_button('Other');
        const restore = latest_transform_request(post_message);
        expect(restore.sheetIndex).toBe(1);
        await dispatch_host_message(transform_installed_message(
            restore,
            { generation: 4, rowHeights: { 3: 50, 5: 50, 8: 50 } },
        ));

        await click_button('Sheet1');
        expect(JSON.parse(grid_stub().getAttribute('data-row-height-overlay')!))
            .toEqual(PENDING_LAYER);
    });

    /**
     * The other sheet's stored sort, restored on opening its tab, so an install ack for
     * sheet 1 is one the app is actually waiting for. Returns the request to answer.
     */
    async function restore_other_sheets_sort(
        post_message: ReturnType<typeof vi.fn>,
    ): Promise<Extract<WebviewMessage, { type: 'setTransform' }>> {
        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 4,
            sourceGeneration: 7,
            reason: 'other',
            state: {
                transforms: [undefined, {
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Other",1,null]',
                }],
            },
        }));
        await click_button('Other');
        const restore = latest_transform_request(post_message);
        expect(restore.sheetIndex).toBe(1);
        return restore;
    }

    it('rebases the overlay when an install on another sheet moves the generation', async () => {
        const { post_message } = await pending_resize();
        const restore = await restore_other_sheets_sort(post_message);

        // An install always bumps the generation, so the sheet gate has to be asked
        // *before* the generation gate or it is dead code — which it was: sheet 0's layer
        // was tagged with generation 4 and every install for sheet 1 dropped it. That is
        // the webview half of scoping resize currency per sheet, and the two halves have to
        // agree: the host, which asks the same question through `mapping_generation`,
        // *accepts* sheet 0's in-flight resize across this install, so a webview that
        // discarded the layer would spring the row back and then have the height silently
        // reappear on the next delivery.
        await dispatch_host_message(transform_installed_message(
            restore,
            { generation: 5, rowHeights: {} },
        ));

        await click_button('Sheet1');
        expect(JSON.parse(grid_stub().getAttribute('data-row-height-overlay')!))
            .toEqual(PENDING_LAYER);
        // Rebased, not merely retained: the render gate compares the overlay's generation
        // with the current one, so a layer left at 4 would be held in state and painted
        // nowhere. Proved by the reconciliation still working at the new generation — the
        // layer retires against a projection delivered at 5, which an un-rebased overlay
        // could not do either.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 5,
            sourceGeneration: 7,
            reason: 'other',
            rowHeightProjection: [{ 3: 50, 5: 50, 8: 50 }, undefined],
        }));
        expect(grid_stub().getAttribute('data-row-height-overlay')).toBe('null');
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!))
            .toEqual({ 3: 50, 5: 50, 8: 50 });
    });

    it('discards the overlay when an install on its own sheet moves the generation', async () => {
        const { post_message } = await pending_resize();
        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 4,
            sourceGeneration: 7,
            reason: 'other',
            state: {
                transforms: [{
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Sheet1",1,null]',
                }, undefined],
            },
        }));
        const restore = latest_transform_request(post_message);
        expect(restore.sheetIndex).toBe(0);

        // The side the sheet gate must not swallow. This install permuted the very sheet
        // the layer names, so its display rows now name other source rows and the host
        // refuses the in-flight resize for exactly that reason. Keeping the layer would
        // paint the user's height on whatever rows moved into positions 3, 5 and 8.
        await dispatch_host_message(transform_installed_message(
            restore,
            { generation: 5, rowHeights: { 1: 41 } },
        ));

        expect(grid_stub().getAttribute('data-row-height-overlay')).toBe('null');
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!)).toEqual({ 1: 41 });
    });

    it('keeps the overlay when an install on its own sheet permutes nothing', async () => {
        const { post_message } = await pending_resize();
        await act(async () => {
            (container!.querySelector('.stub-inactive-filter-transform') as HTMLButtonElement)
                .click();
        });
        const restore = latest_transform_request(post_message);
        expect(restore.sheetIndex).toBe(0);

        // The other side of the same gate. This install changed the rules — so the view
        // generation moves, and the ack carries it — but produced no permutation over a
        // sheet that had none, so display row `r` is still source row `r` and the host
        // *accepts* the in-flight resize on its old generation. Voiding the layer here
        // would snap the row back and then silently restore it when that write is
        // delivered. The host says which happened via `mappingGeneration`; reading
        // `view.basis.generation` instead is what got this wrong.
        await dispatch_host_message(transform_installed_message(
            restore,
            { generation: 5, mappingGeneration: 4, permuted: false, rowHeights: {} },
        ));

        expect(JSON.parse(grid_stub().getAttribute('data-row-height-overlay')!))
            .toEqual(PENDING_LAYER);
    });

    it('does not paint a resize the host is bound to refuse', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
            generation: 4,
            sourceGeneration: 7,
        }));
        post_message.mockClear();

        await act(async () => {
            (container!.querySelector('.stub-row-resize-over-cap') as HTMLButtonElement)
                .click();
        });

        // Posted anyway, because the warning naming the limit is the host's to raise and
        // the request is what asks for it.
        expect(post_message.mock.calls.at(-1)![0]).toMatchObject({
            type: 'setRowHeights',
            rows: [{ start: 0, end: MAX_PERSISTED_ROW_HEIGHTS }],
        });
        // But not painted: the host refuses the whole request and delivers nothing, so a
        // layer for it would have no delivery to reconcile against and would show a
        // height no file holds until the generation next moved. Springing back as the
        // drag ends is the truth.
        expect(grid_stub().getAttribute('data-row-height-overlay')).toBe('null');
    });

    it('keeps every other sheet\'s projection across an install', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1', 'Other']), {
            generation: 4,
            sourceGeneration: 7,
            rowHeightProjection: [{ 0: 31 }, { 2: 77 }],
            state: {
                transforms: [{
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Sheet1",1,null]',
                }, undefined],
            },
        }));
        const restore = latest_transform_request(post_message);
        expect(restore.sheetIndex).toBe(0);

        // An install carries the projection for the one sheet it permuted. Replacing the
        // whole array from it would blank every sibling until some unrelated delivery
        // came along — and an install posts no snapshot, so nothing is guaranteed to.
        await dispatch_host_message(transform_installed_message(
            restore,
            { generation: 5, rowHeights: { 1: 31 } },
        ));

        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!)).toEqual({ 1: 31 });
        await click_button('Other');
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!)).toEqual({ 2: 77 });
    });

    it('posts a resize against the generation an install moved to', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
            generation: 4,
            sourceGeneration: 7,
            state: {
                transforms: [{
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Sheet1",1,null]',
                }],
            },
        }));
        await dispatch_host_message(transform_installed_message(
            latest_transform_request(post_message),
            { generation: 9, rowHeights: {} },
        ));
        post_message.mockClear();

        await act(async () => {
            (container!.querySelector('.stub-row-resize') as HTMLButtonElement).click();
        });

        // The resize affordance is unconditional under a permutation now, and the request
        // it posts has to name the *installed* generation: the host refuses anything else,
        // and the display rows the drag named only mean anything in the arrangement the
        // install put on screen. Painted at once too, so a permuted view is no different
        // from a natural one.
        expect(post_message.mock.calls.at(-1)![0]).toMatchObject({
            type: 'setRowHeights',
            sheetIndex: 0,
            generation: 9,
            sourceGeneration: 7,
            height: 50,
        });
        expect(JSON.parse(grid_stub().getAttribute('data-row-height-overlay')!))
            .toHaveLength(1);
    });

    it('renders the delivered projection from an initial snapshot', async () => {
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1']), {
                // The projection is the only height carrier there is: the durable map is
                // keyed by canonical source row, the webview never renders from it, and
                // `NormalizedPerFileState` no longer even has a field for it. Display row
                // 1 here is source row 2 on the host's side of that join.
                rowHeightProjection: [{ 1: 44 }],
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
        await dispatch_host_message(initial_snapshot_message(meta));
        expect(grid_stub().getAttribute('data-merges')).toBe('1');
    });

    it('flattens every merge when any column is hidden but preserves row heights', async () => {
        await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 4;
        meta.sheets[0].merges = [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
        ];
        await dispatch_host_message(initial_snapshot_message(meta, {
            rowHeightProjection: [{ 0: 48 }],
            state: {
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
        await dispatch_host_message(initial_snapshot_message(meta));
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
        await dispatch_host_message(initial_snapshot_message(make_meta(['First'])));

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);

        await dispatch_host_message(initial_snapshot_message(make_meta(['Second'])));
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
    });

    it('fits the sheets it could not measure when each is opened', async () => {
        // Fitting reads the mounted grid's loaded rows, so a sheet nobody has opened
        // has nothing to measure; "all sheets" marks it and it fits on arrival.
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B'])));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 0: 120 });

        // A newly mounted sheet has not received its first row page yet. The initial
        // deferred pass therefore has nothing to measure and must remain queued.
        grid_shell_mock.auto_fit_result = null;
        await click_sheet_tab('B');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({});

        // Model rowData landing in the mounted GridShell: its loader version changes,
        // waking App to retry through the same imperative measurement ref.
        grid_shell_mock.auto_fit_result = { 0: 220 };
        await notify_auto_fit_sample_change();

        await vi.waitFor(() => {
            expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!))
                .toEqual({ 0: 220 });
            expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
        });
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeUndefined();
    });

    it('keeps an owed fit when hidden columns become visible', async () => {
        await render_app();
        const meta = make_meta(['A', 'B']);
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: {
                columnVisibility: [undefined, {
                    hiddenColumns: [0],
                    schema: '["B",1,null]',
                }],
            },
        }));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');

        grid_shell_mock.auto_fit_result = null;
        await click_sheet_tab('B');
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!)).toEqual([]);
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeDefined();

        await open_columns();
        await click_button('Show all');
        expect(JSON.parse(grid_stub().getAttribute('data-projection')!)).toEqual([0]);
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeDefined();

        grid_shell_mock.auto_fit_result = { 0: 220 };
        await notify_auto_fit_sample_change();
        await vi.waitFor(() => {
            expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!))
                .toEqual({ 0: 220 });
        });
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
    });

    it('cancels an owed fit when the user resizes before rows arrive', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B'])));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');

        grid_shell_mock.auto_fit_result = null;
        await click_sheet_tab('B');
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeDefined();

        await act(async () => {
            (container!.querySelector('.stub-resize') as HTMLButtonElement).click();
        });
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 2: 222 });
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeUndefined();

        // Returning after rows become measurable must preserve the direct resize,
        // rather than redeeming the now-cancelled fit over it.
        grid_shell_mock.auto_fit_result = { 2: 333 };
        await click_sheet_tab('A');
        await click_sheet_tab('B');
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 2: 222 });
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
    });

    it('does not queue empty sheets that can never provide a sample', async () => {
        grid_shell_mock.auto_fit_result = null;
        await render_app();
        const meta = make_meta(['A', 'B']);
        for (const sheet of meta.sheets) {
            sheet.rowCount = 0;
            sheet.sourceRowCount = 0;
        }
        await dispatch_host_message(initial_snapshot_message(meta));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');

        await open_scope_menu('Auto-fit scope');
        const restore = get_menu_item('Restore original widths on all 2 sheets');
        expect(restore.disabled).toBe(true);
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeUndefined();
    });

    it('offers to call off a fit that is only owed', async () => {
        // Nothing measurable on the active grid, so no sheet ends up fitted and every
        // sheet is merely queued. Judged on `auto_fit_active` alone the restore item
        // reads that as "nothing to undo" and greys out — leaving the queued fits with
        // no way to cancel them before each lands.
        grid_shell_mock.auto_fit_result = null;
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B'])));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);

        await open_scope_menu('Auto-fit scope');
        const restore = get_menu_item('Restore original widths on all 2 sheets');
        expect(restore.disabled).toBe(false);

        // And taking it drops the queue: arriving at B fits nothing.
        await click_menu_item('Restore original widths on all 2 sheets');
        grid_shell_mock.auto_fit_result = { 0: 120 };
        await click_sheet_tab('B');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
    });

    it('does not replace original widths when auto-fit-all is repeated', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B'])));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 0: 120 });

        // B is still owed, so the action remains available. Repeating it must not
        // treat A's fitted widths as the restore point for a second fit.
        grid_shell_mock.auto_fit_result = { 0: 180 };
        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 0: 120 });

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Restore original widths on all 2 sheets');
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({});
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
    });

    it('does not redeem a pending fit against a different workbook', async () => {
        // The queue holds bare sheet indices. Left standing across a load, sheet 1 of
        // the *new* file would be fitted on arrival without anyone asking.
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B'])));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');

        await dispatch_host_message(workbook_snapshot_message(make_meta(['C', 'D']), {
            identity: {
                deliveryId: 2,
                authority: { fileId: 'file:other', revision: 1 },
                stateRevision: 1,
                sourceBasis: { physicalRevision: 1, projectionRevision: 0 },
            },
        }));
        await click_sheet_tab('D');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
    });

    it('drops pending fits when a refresh changes the row basis', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B'])));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');

        // A same-file reload may reorder sheets. Bare queue indices from the old row
        // basis must not follow whatever worksheet now occupies that slot.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['B', 'A'])));
        grid_shell_mock.auto_fit_result = { 0: 220 };
        await click_sheet_tab('A');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeUndefined();
    });

    it('cancels an owed fit when authoritative widths change elsewhere', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B'])));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');

        grid_shell_mock.auto_fit_result = null;
        await click_sheet_tab('B');
        const stale_notify = grid_shell_mock.latest_props?.on_auto_fit_sample_change as
            (() => void) | undefined;
        expect(stale_notify).toBeDefined();

        // Another panel manually resized B while this panel still owed it a fit.
        // The authoritative width wins, even if a loader effect retained the callback
        // from the render immediately before invalidation.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['A', 'B']), {
            generation: 1,
            sourceGeneration: 1,
            mappingGenerations: [1, 1],
            reason: 'other',
            state: { columnWidths: [{ 0: 120 }, { 0: 180 }] },
        }));
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeUndefined();

        grid_shell_mock.auto_fit_result = { 0: 220 };
        await act(async () => stale_notify!());
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 0: 180 });
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
    });

    it('waits for a saved transform before fitting an unopened sheet', async () => {
        const { post_message } = await render_app();
        const saved_transform: SheetTransformState = {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: '["B",1,null]',
        };
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B']), {
            state: { transforms: [undefined, saved_transform] },
        }));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');
        grid_shell_mock.auto_fit_result = null;
        await click_sheet_tab('B');
        const restore = latest_transform_request(post_message);
        expect(restore.intent).toBe('restore');

        // Even if natural rows become measurable first, the queued fit waits for the
        // durable view rather than sampling a temporary row population.
        grid_shell_mock.auto_fit_result = { 0: 180 };
        await notify_auto_fit_sample_change();
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({});

        grid_shell_mock.auto_fit_result = null;
        await acknowledge_transform(restore, 2);
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeDefined();

        grid_shell_mock.auto_fit_result = { 0: 220 };
        await notify_auto_fit_sample_change();
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 0: 220 });
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
    });

    it('settles an owed fit when a saved transform produces no rows', async () => {
        const { post_message } = await render_app();
        const saved_transform: SheetTransformState = {
            sort: [],
            filters: [{
                id: 'none',
                colIndex: 0,
                operator: 'contains',
                value: 'no matches',
                caseSensitive: false,
                enabled: true,
            }],
            schema: '["B",1,null]',
        };
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B']), {
            state: { transforms: [undefined, saved_transform] },
        }));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');
        grid_shell_mock.auto_fit_result = null;
        await click_sheet_tab('B');
        const restore = latest_transform_request(post_message);
        await dispatch_host_message(transform_installed_message(restore, {
            generation: 2,
            rowCount: 0,
        }));

        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeUndefined();
    });

    it('cancels only the pending fit whose row mapping is transformed', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B'])));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');
        grid_shell_mock.auto_fit_result = null;
        await click_sheet_tab('B');
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeDefined();

        await act(async () => {
            (container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement).click();
        });
        await acknowledge_transform(latest_transform_request(post_message), 2);
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeUndefined();

        grid_shell_mock.auto_fit_result = { 0: 220 };
        await click_sheet_tab('A');
        await click_sheet_tab('B');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
    });

    it('keeps an owed fit when transform rules leave the row mapping unchanged', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B'])));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');
        grid_shell_mock.auto_fit_result = null;
        await click_sheet_tab('B');

        await act(async () => {
            (container!.querySelector(
                '.stub-inactive-filter-transform',
            ) as HTMLButtonElement).click();
        });
        const request = latest_transform_request(post_message);
        await dispatch_host_message(transform_installed_message(request, {
            generation: 2,
            mappingGeneration: 1,
            permuted: false,
        }));
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeDefined();

        grid_shell_mock.auto_fit_result = { 0: 220 };
        await notify_auto_fit_sample_change();
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 0: 220 });
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
    });

    it('preserves sibling fits owed across another sheet mapping change', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B', 'C'])));

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 3 sheets');

        // The core generation is workbook-wide, but only A's mapping changed. B and C
        // still name the same rows and must remain queued.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['A', 'B', 'C']), {
            generation: 2,
            sourceGeneration: 1,
            mappingGenerations: [2, 1, 1],
            reason: 'other',
            state: { columnWidths: [{ 0: 120 }] },
        }));
        grid_shell_mock.auto_fit_result = null;
        await click_sheet_tab('B');
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeDefined();

        grid_shell_mock.auto_fit_result = { 0: 220 };
        await notify_auto_fit_sample_change();
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 0: 220 });
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
    });

    it('does not queue a transformed view with no effective rows', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['A', 'B'])));
        await click_sheet_tab('B');

        await act(async () => {
            (container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement).click();
        });
        const request = latest_transform_request(post_message);
        await dispatch_host_message(transform_installed_message(request, {
            generation: 2,
            rowCount: 0,
        }));
        await click_sheet_tab('A');

        await open_scope_menu('Auto-fit scope');
        await click_menu_item('Auto-fit columns on all 2 sheets');
        grid_shell_mock.auto_fit_result = { 0: 220 };
        await click_sheet_tab('B');

        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
        expect(grid_shell_mock.latest_props?.on_auto_fit_sample_change).toBeUndefined();
    });

    it('clears auto-fit state on live reload', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Source'])));

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);

        await dispatch_host_message(refresh_snapshot_message(make_meta(['Reloaded'])));
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
    });

    it('keeps auto-fit active across a capability-only refresh (entering edit mode)', async () => {
        grid_shell_mock.auto_fit_result = { 0: 200 };
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                state: { columnWidths: [{ 0: 80 }] },
                capabilities: { csvEditable: true, csvEditingSupported: true },
            },
        ));

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);

        await enter_edit_mode(post_message);
        // Claiming the edit session makes the host redeliver the projection: same
        // source and generation, new capabilities, and the fitted widths this
        // panel already persisted.
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                generation: 1,
                sourceGeneration: 1,
                reason: 'other',
                state: { columnWidths: [{ 0: 200 }] },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'test-edit-session',
                },
            },
        ));

        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 0: 200 });
    });

    it('drops auto-fit when a refresh reinstalls widths that predate the fit', async () => {
        grid_shell_mock.auto_fit_result = { 0: 200 };
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                state: { columnWidths: [{ 0: 80 }] },
                capabilities: { csvEditable: true, csvEditingSupported: true },
            },
        ));

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);

        await enter_edit_mode(post_message);
        // The host read its state before the fitted-width write landed, so the
        // refresh reverts the columns. The toggle must not claim fitted columns
        // the grid no longer has.
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                generation: 1,
                sourceGeneration: 1,
                reason: 'other',
                state: { columnWidths: [{ 0: 80 }] },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'test-edit-session',
                },
            },
        ));

        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 0: 80 });
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);

        // A single click re-fits rather than restoring the widths already shown.
        await click_button('Auto-fit Columns');
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!)).toEqual({ 0: 200 });
    });

    it('clears auto-fit when a same-source refresh reports a new view generation', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);

        // Durable transform reconciliation bumps the view generation without the
        // source generation, and the reconciled rows are reported only here.
        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1']), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
        }));

        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
    });

    it('merges fitted visible widths without deleting hidden source widths', async () => {
        grid_shell_mock.auto_fit_result = { 0: 120, 2: 220 };
        await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0].columnCount = 3;
        await dispatch_host_message(initial_snapshot_message(meta, {
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
    it('shows editing-disabled text and recovery actions when truncated', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                truncationMessage: 'Showing 10,000 of 50,000 rows',
                capabilities: {
                    csvEditable: false,
                    csvEditingSupported: true,
                },
            })
        );

        const banner = container!.querySelector('.truncation-banner');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toContain('Showing 10,000 of 50,000 rows');
        expect(banner!.textContent).toContain(
            'Editing is disabled until all rows are loaded.'
        );
        expect(banner!.textContent).toContain('Change row limit');
        expect(banner!.textContent).toContain('Load all rows');
        const edit = get_button('Edit');
        expect(edit.disabled).toBe(true);
        expect(edit.getAttribute('aria-disabled')).toBe('true');

        post_message.mockClear();
        await click_button('Change row limit');
        await click_button('Load all rows');
        expect(post_message.mock.calls.map(([message]) => message)).toEqual([
            { type: 'openCsvRowLimitSetting' },
            { type: 'loadAllCsvRows' },
        ]);
    });

    it('omits editing-disabled text in preview mode (editing never available)', async () => {
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                truncationMessage: 'Showing 10,000 of 50,000 rows',
                configuration: { previewMode: true },
            })
        );

        const banner = container!.querySelector('.truncation-banner');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toContain('Showing 10,000 of 50,000 rows');
        expect(banner!.textContent).toContain('Additional rows were not loaded.');
    });

    it('does not render the banner when truncationMessage is absent', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
        expect(container!.querySelector('.truncation-banner')).toBeNull();
    });

    it('introduces the banner when a reload reports truncation', async () => {
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );
        expect(container!.querySelector('.truncation-banner')).toBeNull();

        await dispatch_host_message(
            refresh_snapshot_message(make_meta(['Sheet1'], false), {
                truncationMessage: 'Showing 10,000 of 50,000 rows',
                capabilities: {
                    csvEditable: false,
                    csvEditingSupported: true,
                },
            })
        );
        const banner = container!.querySelector('.truncation-banner');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toContain(
            'Editing is disabled until all rows are loaded.'
        );
    });
});

describe('edit mode save exit', () => {
    it('discarding from the save dialog clears persisted edits before releasing edit ownership', async () => {
        grid_shell_mock.is_dirty = true;
        grid_shell_mock.has_uncommitted_changes = true;

        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );
        await enter_edit_mode(post_message);
        seed_mounted_store();

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'showSaveDialog',
        }));

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'discard' });

        expect(grid_shell_mock.clear_dirty).toHaveBeenCalledTimes(1);
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'discardEditSession',
        }));
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('a discard empties every worksheet’s store, not just the mounted one', async () => {
        // The session covers the whole workbook and the host clears every live
        // durable slot; a store left full locally would repaint edits the user
        // just discarded the next time its sheet is opened.
        grid_shell_mock.has_uncommitted_changes = true;

        const { post_message } = await render_app();
        const people = { '0:0': { value: 'Bob', base: 'Alice' } };
        const inventory = { '0:0': { value: 'Gadget', base: 'Widget' } };
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: [
                        { sheetName: 'People', cells: people },
                        { sheetName: 'Inventory', cells: inventory },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );
        expect(grid_stub().getAttribute('data-store-edits')).toBe(
            JSON.stringify(people)
        );

        post_message.mockClear();
        await click_button('Edit');
        await dispatch_host_message({ type: 'saveDialogResult', choice: 'discard' });
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'discardEditSession',
        }));

        expect(grid_stub().getAttribute('data-store-edits')).toBe('{}');
        await click_sheet_tab('Inventory');
        expect(grid_stub().getAttribute('data-store-edits')).toBe('{}');
    });

    it('enters edit mode with pending edits returned by the host session grant', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );
        const first_mount_id = grid_stub().getAttribute('data-mount-id');

        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestEditSession',
        }));

        const pendingEdits = { '0:0': { value: 'restored', base: 'base' } };
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            pendingEdits,
        });

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(grid_stub().getAttribute('data-store-edits')).toBe(
            JSON.stringify(pendingEdits)
        );
        // No remount: the grant no longer bumps `load_epoch`. The store assertion
        // above is what keeps this non-vacuous — the granted projection has to reach
        // a subscriber of the *surviving* mount, which is the whole point of lifting
        // edit state above the grid generation.
        expect(grid_stub().getAttribute('data-mount-id')).toBe(first_mount_id);
    });

    it('continues the workbook session when Edit is pressed on another worksheet', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );
        // Edit the second worksheet, then walk back to the first one.
        await click_sheet_tab('Inventory');
        await click_button('Edit');
        const pendingEdits = { '0:0': { value: 'Gadget', base: 'Widget' } };
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'workbook-session',
            sheetIndex: 1,
            pendingEdits,
        });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        await click_sheet_tab('People');
        // The grant is workbook-scoped: every worksheet is editable immediately,
        // while each grid still projects only its own store.
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(grid_stub().getAttribute('data-store-edits')).toBe('{}');
        expect(get_button('Edit').getAttribute('aria-disabled')).not.toBe('true');
        expect(post_message.mock.calls.filter(([message]) => (
            message?.type === 'requestEditSession'
        ))).toHaveLength(1);

        // Returning to the first edited sheet finds its edits exactly as they
        // were — the pointer moved, the session and Inventory's store did not.
        await click_sheet_tab('Inventory');
        expect(grid_stub().getAttribute('data-store-edits')).toBe(
            JSON.stringify(pendingEdits)
        );
    });

    it('does not request another session when switching worksheets', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'workbook-session',
            sheetIndex: 0,
        });
        post_message.mockClear();
        await click_sheet_tab('Inventory');

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(grid_shell_mock.latest_props?.edit_session_id).toBe('workbook-session');
        expect(post_message).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'requestEditSession' })
        );
        expect(post_message).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'releaseEditSession' })
        );
    });

    it('moves every worksheet’s store to where its sheet went on a reorder', async () => {
        // An external reorder moves the sheets under all of the stores at once.
        // A store left at its old index would paint its edits onto whatever
        // worksheet now sits there — for every sheet holding edits, not just
        // the one the edit pointer names.
        await render_app();
        const people = { '0:0': { value: 'Bob', base: 'Alice' } };
        const inventory = { '0:0': { value: 'Gadget', base: 'Widget' } };
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: [
                        { sheetName: 'People', cells: people },
                        { sheetName: 'Inventory', cells: inventory },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );
        expect(grid_stub().getAttribute('data-store-edits')).toBe(
            JSON.stringify(people)
        );

        // The workbook reorders externally; the refresh advances the session id,
        // which is exactly the path where no install follows the move.
        await dispatch_host_message(
            refresh_snapshot_message(make_meta(['Inventory', 'People'], false), {
                state: {
                    pendingEdits: [
                        { sheetName: 'Inventory', cells: inventory },
                        { sheetName: 'People', cells: people },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'advanced-session',
                },
            })
        );

        // The active tab kept its index, so it now shows Inventory — and must
        // paint Inventory's edits, not People's.
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        expect(grid_stub().getAttribute('data-store-edits')).toBe(
            JSON.stringify(inventory)
        );
        await click_sheet_tab('People');
        expect(grid_stub().getAttribute('data-store-edits')).toBe(
            JSON.stringify(people)
        );
    });

    it('keeps and republishes an unacknowledged live store through a reorder', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );
        const people_store = grid_shell_mock.latest_props!
            .edit_session as EditSessionStore;
        await act(async () => people_store.commit('restored-session', '0:0', {
            value: 'Newest',
            base: 'Alice',
        }));
        await dispatch_host_message({
            type: 'requestPendingEditsFlush',
            requestId: 'before-reorder',
        });
        await vi.waitUntil(() => post_message.mock.calls.some(
            ([message]) => message?.type === 'pendingEditsFlush',
        ));
        post_message.mockClear();

        await dispatch_host_message(
            refresh_snapshot_message(make_meta(['Inventory', 'People'], false), {
                state: {
                    pendingEdits: [
                        undefined,
                        {
                            sheetName: 'People',
                            cells: { '0:0': { value: 'Older', base: 'Alice' } },
                        },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );

        await click_sheet_tab('People');
        expect(grid_shell_mock.latest_props!.edit_session).toBe(people_store);
        expect(grid_stub().getAttribute('data-store-edits')).toBe(JSON.stringify({
            '0:0': { value: 'Newest', base: 'Alice' },
        }));
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'pendingEditsChanged',
            editSessionId: 'restored-session',
            sheetIndex: 1,
            sheetName: 'People',
            edits: { '0:0': { value: 'Newest', base: 'Alice' } },
        }));
    });

    it('keeps and republishes an unacknowledged store through a same-layout refresh', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );
        const people_store = grid_shell_mock.latest_props!
            .edit_session as EditSessionStore;
        await act(async () => people_store.commit('restored-session', '0:0', {
            value: 'Newest',
            base: 'Alice',
        }));
        await dispatch_host_message({
            type: 'requestPendingEditsFlush',
            requestId: 'before-refresh',
        });
        await vi.waitUntil(() => post_message.mock.calls.some(
            ([message]) => message?.type === 'pendingEditsFlush',
        ));
        post_message.mockClear();

        await dispatch_host_message(
            refresh_snapshot_message(make_meta(['People'], false), {
                state: {
                    pendingEdits: [{
                        sheetName: 'People',
                        cells: { '0:0': { value: 'Older', base: 'Alice' } },
                    }],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );

        expect(grid_shell_mock.latest_props!.edit_session).toBe(people_store);
        expect(grid_stub().getAttribute('data-store-edits')).toBe(JSON.stringify({
            '0:0': { value: 'Newest', base: 'Alice' },
        }));
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'pendingEditsChanged',
            editSessionId: 'restored-session',
            sheetIndex: 0,
            sheetName: 'People',
            edits: { '0:0': { value: 'Newest', base: 'Alice' } },
        }));
    });

    it('folds the active editor before a deletion-shaped rename drops its store', async () => {
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'session-before',
                },
            })
        );
        const people_store = grid_shell_mock.latest_props!
            .edit_session as EditSessionStore;
        grid_shell_mock.flush_live_edit.mockImplementation(() => {
            people_store.commit('session-before', '0:0', {
                value: 'half-typed',
                base: 'Alice',
            });
        });

        await dispatch_host_message(
            refresh_snapshot_message(make_meta(['Renamed'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'session-after',
                },
            })
        );

        expect(grid_shell_mock.flush_live_edit).toHaveBeenCalledTimes(1);
        expect(Object.fromEntries(people_store.snapshot())).toEqual({
            '0:0': { value: 'half-typed', base: 'Alice' },
        });
        expect(grid_stub().getAttribute('data-store-edits')).toBe('{}');
    });

    it('flushes the active editor before a same-name replacement drops its ID store', async () => {
        await render_app();
        const before = make_meta(['Data'], false);
        before.sheets[0].worksheetId = 'old';
        await dispatch_host_message(
            initial_snapshot_message(before, {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'session-before',
                },
            }),
        );
        const old_store = grid_shell_mock.latest_props!.edit_session as EditSessionStore;
        grid_shell_mock.flush_live_edit.mockImplementation(() => {
            old_store.commit('session-before', '0:0', {
                value: 'half-typed',
                base: 'before',
            });
        });

        const replacement = make_meta(['Data'], false);
        replacement.sheets[0].worksheetId = 'new';
        await dispatch_host_message(
            refresh_snapshot_message(replacement, {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'session-after',
                },
            }),
        );

        expect(grid_shell_mock.flush_live_edit).toHaveBeenCalledTimes(1);
        expect(Object.fromEntries(old_store.snapshot())).toEqual({
            '0:0': { value: 'half-typed', base: 'before' },
        });
        expect(grid_stub().getAttribute('data-store-edits')).toBe('{}');
    });

    it('re-publishes a removed worksheet store against the refreshed authority', async () => {
        const { post_message } = await render_app();
        const before = make_meta(['People', 'Inventory'], false);
        before.sheets[0].worksheetId = '1';
        before.sheets[1].worksheetId = '2';
        await dispatch_host_message(initial_snapshot_message(before, {
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'workbook-session',
            },
        }));
        await click_sheet_tab('Inventory');
        const inventory_store = grid_shell_mock.latest_props!
            .edit_session as EditSessionStore;
        await act(async () => {
            inventory_store.commit('workbook-session', '0:0', {
                value: 'Gadget',
                base: 'Widget',
            });
        });
        await click_sheet_tab('People');
        post_message.mockClear();

        const after = make_meta(['People'], false);
        after.sheets[0].worksheetId = '1';
        await dispatch_host_message(refresh_snapshot_message(after, {
            state: { pendingEdits: [] },
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'workbook-session',
            },
        }));

        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'pendingEditsChanged',
            editSessionId: 'workbook-session',
            sheetIndex: 1,
            sheetName: 'Inventory',
            worksheetId: '2',
            edits: { '0:0': { value: 'Gadget', base: 'Widget' } },
        }));
    });

    it('reattaches a returned worksheet store instead of flushing a stale parked copy', async () => {
        const { post_message } = await render_app();
        const before = make_meta(['People', 'Inventory'], false);
        before.sheets[0].worksheetId = '1';
        before.sheets[1].worksheetId = '2';
        await dispatch_host_message(initial_snapshot_message(before, {
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'workbook-session',
            },
        }));
        await click_sheet_tab('Inventory');
        const inventory_store = grid_shell_mock.latest_props!
            .edit_session as EditSessionStore;
        await act(async () => inventory_store.commit('workbook-session', '0:0', {
            value: 'Gadget',
            base: 'Widget',
        }));

        const removed = make_meta(['People'], false);
        removed.sheets[0].worksheetId = '1';
        await dispatch_host_message(refresh_snapshot_message(removed, {
            state: { pendingEdits: [] },
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'workbook-session',
            },
        }));
        await dispatch_host_message(refresh_snapshot_message(before, {
            state: {
                pendingEdits: [
                    undefined,
                    {
                        sheetName: 'Inventory',
                        worksheetId: '2',
                        cells: { '0:0': { value: 'Gadget', base: 'Widget' } },
                    },
                ],
            },
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'workbook-session',
            },
        }));
        await click_sheet_tab('Inventory');
        expect(grid_shell_mock.latest_props!.edit_session).toBe(inventory_store);
        await act(async () => inventory_store.commit('workbook-session', '0:0', {
            value: 'Newest',
            base: 'Widget',
        }));

        post_message.mockClear();
        await dispatch_host_message({
            type: 'requestPendingEditsFlush',
            requestId: 'flush-returned',
        });
        await vi.waitUntil(() => post_message.mock.calls.some(
            ([message]) => message?.type === 'pendingEditsFlush',
        ));

        const inventory_publications = post_message.mock.calls
            .map(([message]) => message)
            .filter((message) => message?.type === 'pendingEditsChanged'
                && message.worksheetId === '2');
        expect(inventory_publications).toHaveLength(1);
        expect(inventory_publications[0].edits).toEqual({
            '0:0': { value: 'Newest', base: 'Widget' },
        });
    });

    it('re-publishes a removed worksheet store after its last edit was cleared', async () => {
        const { post_message } = await render_app();
        const before = make_meta(['People', 'Inventory'], false);
        before.sheets[0].worksheetId = '1';
        before.sheets[1].worksheetId = '2';
        await dispatch_host_message(initial_snapshot_message(before, {
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'workbook-session',
            },
        }));
        await click_sheet_tab('Inventory');
        const inventory_store = grid_shell_mock.latest_props!
            .edit_session as EditSessionStore;
        await act(async () => inventory_store.commit('workbook-session', '0:0', {
            value: 'Gadget',
            base: 'Widget',
        }));
        await dispatch_host_message({
            type: 'requestPendingEditsFlush',
            requestId: 'publish-before-clear',
        });
        await vi.waitUntil(() => post_message.mock.calls.some(
            ([message]) => message?.type === 'pendingEditsFlush',
        ));
        await act(async () => inventory_store.clear('workbook-session'));
        post_message.mockClear();

        const removed = make_meta(['People'], false);
        removed.sheets[0].worksheetId = '1';
        await dispatch_host_message(refresh_snapshot_message(removed, {
            state: {
                pendingEdits: [
                    undefined,
                    {
                        sheetName: 'Inventory',
                        worksheetId: '2',
                        cells: { '0:0': { value: 'Gadget', base: 'Widget' } },
                    },
                ],
            },
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'workbook-session',
            },
        }));

        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'pendingEditsChanged',
            editSessionId: 'workbook-session',
            sheetIndex: 1,
            sheetName: 'Inventory',
            worksheetId: '2',
            edits: null,
        }));
    });

    it('remounts an open editor across a same-generation reorder', async () => {
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'session-before',
                },
            })
        );
        const people_store = grid_shell_mock.latest_props!
            .edit_session as EditSessionStore;
        const people_mount = grid_stub().getAttribute('data-mount-id');
        grid_shell_mock.flush_live_edit.mockImplementation(() => {
            people_store.commit('session-before', '0:0', {
                value: 'half-typed',
                base: 'Alice',
            });
        });

        await dispatch_host_message(
            refresh_snapshot_message(make_meta(['Inventory', 'People'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'session-after',
                },
            })
        );

        expect(grid_shell_mock.flush_live_edit).toHaveBeenCalledTimes(1);
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        expect(grid_stub().getAttribute('data-store-edits')).toBe('{}');
        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(people_mount);
        await click_sheet_tab('People');
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(grid_stub().getAttribute('data-store-edits')).toBe(JSON.stringify({
            '0:0': { value: 'half-typed', base: 'Alice' },
        }));
    });

    it('hydrates every worksheet’s restored edits into its own store', async () => {
        // The session covers the whole workbook, so a reload can restore drafts
        // on several sheets at once. Each slot must land in its own sheet's
        // store — hydrating only the pointer sheet's left the others' edits
        // invisible until a save or discard surprised the user with them.
        await render_app();
        const people = { '0:0': { value: 'Bob', base: 'Alice' } };
        const inventory = { '0:0': { value: 'Gadget', base: 'Widget' } };
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: [
                        { sheetName: 'People', cells: people },
                        { sheetName: 'Inventory', cells: inventory },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );

        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        expect(grid_stub().getAttribute('data-store-edits')).toBe(
            JSON.stringify(people)
        );
        await click_sheet_tab('Inventory');
        expect(grid_stub().getAttribute('data-store-edits')).toBe(
            JSON.stringify(inventory)
        );
    });

    it('restores a sibling store when its parked draft returns on refresh', async () => {
        const people = { '0:0': { value: 'Bob', base: 'Alice' } };
        const inventory = { '0:0': { value: 'Gadget', base: 'Widget' } };
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: [
                        { sheetName: 'People', cells: people },
                        { sheetName: 'Inventory', cells: inventory },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );

        // Inventory disappears, so remapping drops its in-memory store while the
        // host keeps the named durable slot parked.
        await dispatch_host_message(
            refresh_snapshot_message(make_meta(['People'], false), {
                state: { pendingEdits: [{ sheetName: 'People', cells: people }] },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );
        // The worksheet returns and the authoritative projection carries its
        // parked draft again. Refresh hydration must recreate the sibling store.
        await dispatch_host_message(
            refresh_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: [
                        { sheetName: 'People', cells: people },
                        { sheetName: 'Inventory', cells: inventory },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );

        await click_sheet_tab('Inventory');
        expect(grid_stub().getAttribute('data-store-edits')).toBe(
            JSON.stringify(inventory)
        );
    });

    it('does not hydrate a sibling store from another worksheet\u2019s active save', async () => {
        const people = { '0:0': { value: 'Bob', base: 'Alice' } };
        const inventory = { '0:0': { value: 'Gadget', base: 'Widget' } };
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: [
                        { sheetName: 'People', cells: people },
                        { sheetName: 'Inventory', cells: inventory },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );

        await dispatch_host_message(
            refresh_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: [
                        { sheetName: 'People', cells: people },
                        { sheetName: 'Inventory', cells: inventory },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                    csvSaveLifecycle: {
                        revision: 1,
                        state: 'active',
                        operation: {
                            editSessionId: 'restored-session',
                            saveRequestId: 'people-save',
                            worksheets: [{
                                sheetIndex: 0,
                                sheetName: 'People',
                                edits: { '0:0': 'Bob' },
                                dirtyEdits: people,
                            }],
                        },
                    },
                },
            })
        );

        await click_sheet_tab('Inventory');
        expect(grid_stub().getAttribute('data-store-edits')).toBe(
            JSON.stringify(inventory)
        );
    });

    it('keeps the edit pointer on its sheet through a sibling slot\u2019s refresh', async () => {
        // A refresh of the session this panel already holds must not retarget
        // the pointer to whichever slot happens to be dirty first \u2014 the user
        // chose their sheet, and a sibling's durable write is not a reason to
        // yank the session off it.
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await click_sheet_tab('Inventory');
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'workbook-session',
            sheetIndex: 1,
        });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        // A sibling sheet's slot commits durably \u2014 slot 0 is now the first
        // dirty one \u2014 and the same session refreshes.
        await dispatch_host_message(
            refresh_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: [
                        {
                            sheetName: 'People',
                            cells: { '0:0': { value: 'Bob', base: 'Alice' } },
                        },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'workbook-session',
                },
            })
        );

        // Still editing Inventory: the pointer stayed put.
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
    });

    it('does not transfer a deleted clean pointer grant to its replacement index', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory', 'Archive'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await click_sheet_tab('Inventory');
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'workbook-session',
            sheetIndex: 1,
        });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        await dispatch_host_message(
            refresh_snapshot_message(make_meta(['People', 'Archive'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'workbook-session',
                },
            })
        );

        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledTimes(1);
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestEditSession',
            sheetIndex: 1,
        }));
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('shows the save dialog when only another worksheet\u2019s store is dirty', async () => {
        // Exiting ends the workbook-scoped session for every sheet, so unsaved
        // work on a sheet other than the one on screen must raise the same
        // Save/Discard/Cancel question \u2014 the mounted grid only answers for
        // the visible sheet.
        grid_shell_mock.has_uncommitted_changes = false;

        const { post_message } = await render_app();
        const inventory = { '0:0': { value: 'Gadget', base: 'Widget' } };
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: sheet_edits(inventory, 0, 'Inventory'),
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );
        // The restored workbook session is active while People is mounted clean;
        // Inventory's registry store still owns the unsaved work.
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(grid_stub().getAttribute('data-store-edits')).toBe('{}');
        expect(get_button('Edit').classList.contains('has-unsaved')).toBe(true);

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'showSaveDialog' })
        );
    });

    it('keeps the workbook session when a dirty sibling blocks save preflight', async () => {
        grid_shell_mock.has_uncommitted_changes = false;
        grid_shell_mock.request_save.mockReturnValue(false);
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );
        await click_sheet_tab('Inventory');
        seed_mounted_store({
            '0:0': {
                value: 'Gadget',
                base: '',
                base_pending: true,
            },
        });
        await click_sheet_tab('People');
        await click_button('Edit');
        const dialog = post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'showSaveDialog');
        post_message.mockClear();

        await dispatch_host_message({
            type: 'saveDialogResult',
            requestId: dialog.requestId,
            editSessionId: dialog.editSessionId,
            choice: 'save',
        });

        expect(grid_shell_mock.request_save).toHaveBeenCalledTimes(1);
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'showWarning',
        }));
        expect(post_message).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'saveCsv',
        }));
        expect(post_message).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'releaseEditSession',
        }));
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(get_button('Edit').classList.contains('has-unsaved')).toBe(true);
    });

    it('saves the dirty sibling chosen from a clean pointer sheet', async () => {
        grid_shell_mock.has_uncommitted_changes = false;
        grid_shell_mock.request_save.mockReturnValue(true);
        const { post_message } = await render_app();
        const inventory = { '0:0': { value: 'Gadget', base: 'Widget' } };
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: { pendingEdits: sheet_edits(inventory, 0, 'Inventory') },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );
        await click_button('Edit');
        const dialog = post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'showSaveDialog');
        post_message.mockClear();
        await dispatch_host_message({
            type: 'saveDialogResult',
            requestId: dialog.requestId,
            editSessionId: dialog.editSessionId,
            choice: 'save',
        });

        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        expect(grid_shell_mock.request_save).toHaveBeenCalledTimes(1);
        expect(grid_shell_mock.latest_props?.save_operation).toMatchObject({
            editSessionId: 'restored-session',
            worksheets: [{
                sheetIndex: 1,
                sheetName: 'Inventory',
                edits: { '0:0': 'Gadget' },
            }],
        });
        expect(post_message).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'stateChanged',
            state: expect.objectContaining({ activeSheetIndex: 1 }),
        }));
        expect(post_message).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'releaseEditSession' })
        );
    });

    it('follows the dirty worksheet identity while its save dialog is open', async () => {
        grid_shell_mock.has_uncommitted_changes = false;
        grid_shell_mock.request_save.mockReturnValue(true);
        const { post_message } = await render_app();
        const before = make_meta(['People', 'Inventory'], false);
        before.sheets[0].worksheetId = '1';
        before.sheets[1].worksheetId = '2';
        const inventory = { '0:0': { value: 'Gadget', base: 'Widget' } };
        await dispatch_host_message(initial_snapshot_message(before, {
            state: {
                pendingEdits: [undefined, {
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    cells: inventory,
                }],
            },
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'restored-session',
            },
        }));
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'restored-session',
            sheetIndex: 0,
        });
        await click_button('Edit');
        const dialog = post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'showSaveDialog');

        const after = make_meta(['Inventory', 'People'], false);
        after.sheets[0].worksheetId = '2';
        after.sheets[1].worksheetId = '1';
        await dispatch_host_message(refresh_snapshot_message(after, {
            state: {
                pendingEdits: [{
                    sheetName: 'Inventory',
                    worksheetId: '2',
                    cells: inventory,
                }],
            },
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'restored-session',
            },
        }));
        post_message.mockClear();
        await dispatch_host_message({
            type: 'saveDialogResult',
            requestId: dialog.requestId,
            editSessionId: dialog.editSessionId,
            choice: 'save',
        });

        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        expect(grid_shell_mock.latest_props?.save_operation).toMatchObject({
            editSessionId: 'restored-session',
            worksheets: [{
                sheetIndex: 0,
                sheetName: 'Inventory',
                worksheetId: '2',
            }],
        });
    });

    it('saves multiple dirty worksheets atomically', async () => {
        grid_shell_mock.has_uncommitted_changes = true;
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: [
                        {
                            sheetName: 'People',
                            cells: { '0:0': { value: 'Bob', base: 'Alice' } },
                        },
                        {
                            sheetName: 'Inventory',
                            cells: { '0:0': { value: 'Gadget', base: 'Widget' } },
                        },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );

        await click_button('Edit');
        const dialog = post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'showSaveDialog');
        post_message.mockClear();
        await dispatch_host_message({
            type: 'saveDialogResult',
            requestId: dialog.requestId,
            editSessionId: dialog.editSessionId,
            choice: 'save',
        });

        expect(grid_shell_mock.request_save).toHaveBeenCalledTimes(1);
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'saveCsv',
            operation: expect.objectContaining({
                editSessionId: 'restored-session',
                worksheets: [
                    expect.objectContaining({ sheetIndex: 0, sheetName: 'People' }),
                    expect.objectContaining({ sheetIndex: 1, sheetName: 'Inventory' }),
                ],
            }),
        }));
        expect(post_message).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'showWarning' })
        );
        expect(post_message).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'releaseEditSession' })
        );
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
    });

    it('publishes every worksheet\u2019s store at the close flush', async () => {
        // The close/reload boundary is the last chance for unacknowledged local
        // edits to reach the host. The session is workbook-scoped, so a store on
        // a sheet the pointer left behind is exactly as much unsaved work as the
        // pointer sheet's \u2014 flushing only the pointer's dropped the rest.
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: [
                        {
                            sheetName: 'People',
                            cells: { '0:0': { value: 'Bob', base: 'Alice' } },
                        },
                        {
                            sheetName: 'Inventory',
                            cells: { '0:0': { value: 'Gadget', base: 'Widget' } },
                        },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );

        post_message.mockClear();
        await dispatch_host_message({
            type: 'requestPendingEditsFlush',
            requestId: 'flush-all',
        });
        const posted_types = (type: string) => post_message.mock.calls
            .map(([message]) => message)
            .filter((message) => message?.type === type);
        // The reply itself is the observable result, so wait for *it* rather
        // than for a tick that happens to be long enough on this machine.
        await vi.waitUntil(() => posted_types('pendingEditsFlush').length > 0);
        expect(posted_types('pendingEditsFlush')).toHaveLength(1);
        const published = posted_types('pendingEditsChanged') as {
            sheetName?: string;
            edits: unknown;
        }[];
        expect(published.map((message) => message.sheetName).sort())
            .toEqual(['Inventory', 'People']);
        expect(published.every((message) => message.edits !== null)).toBe(true);
    });

    it('skips pristine worksheet stores at the close flush', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'clean-session',
                },
            })
        );
        await click_sheet_tab('Inventory');

        post_message.mockClear();
        await dispatch_host_message({
            type: 'requestPendingEditsFlush',
            requestId: 'flush-pristine',
        });
        const posted = (type: string) => post_message.mock.calls
            .map(([message]) => message)
            .filter((message) => message?.type === type);
        await vi.waitUntil(() => posted('pendingEditsFlush').length > 0);

        expect(posted('pendingEditsFlush')).toHaveLength(1);
        expect(posted('pendingEditsChanged')).toHaveLength(0);
    });

    it('forces only worksheet payloads whose latest post is unacknowledged', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                state: {
                    pendingEdits: [
                        {
                            sheetName: 'People',
                            cells: { '0:0': { value: 'Bob', base: 'Alice' } },
                        },
                        {
                            sheetName: 'Inventory',
                            cells: { '0:0': { value: 'Gadget', base: 'Widget' } },
                        },
                    ],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'restored-session',
                },
            })
        );

        post_message.mockClear();
        await dispatch_host_message({
            type: 'requestPendingEditsFlush',
            requestId: 'first-flush',
        });
        const posted = () => post_message.mock.calls
            .map(([message]) => message)
            .filter((message) => message?.type === 'pendingEditsChanged');
        await vi.waitUntil(() => posted().length >= 2);
        expect(posted()).toHaveLength(2);
        const people = posted().find((message) => message.sheetName === 'People');
        await dispatch_host_message({
            type: 'pendingEditsAcknowledged',
            editSessionId: 'restored-session',
            sequence: people.sequence,
        });

        post_message.mockClear();
        await dispatch_host_message({
            type: 'requestPendingEditsFlush',
            requestId: 'second-flush',
        });
        await vi.waitUntil(() => post_message.mock.calls.some(
            ([message]) => message?.type === 'pendingEditsFlush',
        ));
        expect(posted()).toHaveLength(1);
        expect(posted()[0]).toMatchObject({ sheetName: 'Inventory' });
    });

    it('does not retry an unacknowledged empty payload already present in a refresh', async () => {
        const meta = make_meta(['People'], false);
        const capabilities = {
            csvEditable: true,
            csvEditingSupported: true,
            csvEditSessionId: 'echo-session',
        };
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities,
        }));
        const { pending_edit_durability } = await import('../webview/host-bridge');

        post_message.mockClear();
        const pending_posts = () => post_message.mock.calls
            .map(([message]) => message)
            .filter((message) => message?.type === 'pendingEditsChanged');
        pending_edit_durability.publish('echo-session', null, 0, 'People');
        await vi.waitUntil(() => pending_posts().length === 1);

        post_message.mockClear();
        for (let delivery = 0; delivery < 3; delivery += 1) {
            await dispatch_host_message(refresh_snapshot_message(meta, {
                capabilities,
            }));
        }

        // The host delivers its committed snapshot before the explicit
        // pendingEditsAcknowledged message. Re-publishing the same map here makes
        // each snapshot generate the next write/snapshot pair forever.
        expect(pending_posts()).toHaveLength(0);
    });

    it('holds the worksheet tabs while a save dialog is open', async () => {
        // The dialog asks about one worksheet, and the answer is applied against the
        // *active* sheet's store. Switching tabs while it was open pointed the answer
        // at the wrong worksheet: the new sheet's store has no session, so it reports
        // nothing to save, and a "Save" choice took the exit path — releasing the
        // session without ever posting the save. The user asked to save and the edits
        // were dropped.
        grid_shell_mock.is_dirty = true;
        grid_shell_mock.has_uncommitted_changes = true;
        grid_shell_mock.request_save.mockReturnValue(true);

        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await click_sheet_tab('Inventory');
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'inventory-session',
            sheetIndex: 1,
            pendingEdits: { '0:0': { value: 'Gadget', base: 'Widget' } },
        });

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'showSaveDialog' })
        );

        // The tab click is refused while the question is on screen.
        await click_sheet_tab('People');
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');

        // So "Save" still reaches the worksheet the dialog was about.
        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        expect(grid_shell_mock.request_save).toHaveBeenCalledTimes(1);
        expect(post_message).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'releaseEditSession' })
        );
    });

    it('folds an open editor into the store before switching worksheets', async () => {
        // Worksheet editing made this reachable: the grid is keyed by the active
        // sheet, so clicking another tab unmounts the one holding the open overlay.
        // Glide's editor is portalled outside that tree and its cleanup only
        // releases the captured row — the typed text is gone unless it is folded
        // into App's store first, exactly as the transform and refresh remounts do.
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'people-session',
            sheetIndex: 0,
        });
        // Stand in for the real overlay fold, as the transform and refresh remount
        // tests do. Every sheet is handed its own store, so this writes into
        // People's on the way out and into Inventory's on the way back — distinct
        // maps, which is what the isolation test below pins.
        grid_shell_mock.commit_live_edit.mockImplementation(() => {
            (grid_shell_mock.latest_props?.edit_session as EditSessionStore | undefined)
                ?.commit('people-session', '0:0', { value: 'typed', base: 'Alice' });
        });

        await click_sheet_tab('Inventory');
        expect(grid_shell_mock.commit_live_edit).toHaveBeenCalledTimes(1);

        await click_sheet_tab('People');
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!))
            .toEqual({ '0:0': { value: 'typed', base: 'Alice' } });
    });

    it('keeps an identified worksheet mounted across a same-generation rename', async () => {
        await render_app();
        const before = make_meta(['Before'], false);
        before.sheets[0].worksheetId = '7';
        await dispatch_host_message(initial_snapshot_message(before, {
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'rename-session',
            },
        }));
        const before_mount = grid_stub().getAttribute('data-mount-id');
        grid_shell_mock.commit_live_edit.mockClear();
        grid_shell_mock.flush_live_edit.mockClear();

        const after = make_meta(['After'], false);
        after.sheets[0].worksheetId = '7';
        await dispatch_host_message(refresh_snapshot_message(after, {
            generation: 1,
            sourceGeneration: 1,
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'rename-session',
            },
        }));

        expect(grid_stub().getAttribute('data-mount-id')).toBe(before_mount);
        expect((grid_shell_mock.latest_props?.sheet_meta as { name: string }).name)
            .toBe('After');
        expect(grid_shell_mock.commit_live_edit).not.toHaveBeenCalled();
        expect(grid_shell_mock.flush_live_edit).not.toHaveBeenCalled();
    });

    it("keeps one worksheet's dirty cells out of another's store", async () => {
        // Every sheet gets its own store from the registry, so the isolation the
        // old "withhold the store from non-owning sheets" mechanism provided must
        // now come from the stores being distinct maps. If the registry ever
        // handed sheets a shared store, People's `0:0` would paint at Inventory's
        // `0:0` — the cross-sheet bleed #154's widening must not reintroduce.
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'people-session',
            sheetIndex: 0,
        });
        await act(async () => {
            (grid_shell_mock.latest_props?.edit_session as EditSessionStore)
                .commit('people-session', '0:0', { value: 'typed', base: 'Alice' });
        });
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!))
            .toEqual({ '0:0': { value: 'typed', base: 'Alice' } });

        await click_sheet_tab('Inventory');
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!)).toEqual({});

        await click_sheet_tab('People');
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!))
            .toEqual({ '0:0': { value: 'typed', base: 'Alice' } });
    });

    it("drops the old file's stores when an initial snapshot replaces the document", async () => {
        // The single store was replaced wholesale at every hydration boundary,
        // so nothing stale could outlive one. The registry keeps stores, which
        // let file A's dirty sheet-1 store survive an initial snapshot for
        // file B whose session lives on sheet 0 — and B's sheet 1 then painted
        // A's edited value and dirty tint at the same coordinates.
        await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['People', 'Inventory'], false),
            {
                state: {
                    columnWidths: [], scrollPosition: [],
                    activeSheetIndex: 1, tabOrientation: null,
                    pendingEdits: sheet_edits(
                        { '0:0': { value: 'Gadget', base: 'Widget' } },
                        1,
                    ),
                    transforms: [], columnVisibility: [],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'file-a-session',
                },
            },
        ));
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!))
            .toEqual({ '0:0': { value: 'Gadget', base: 'Widget' } });

        // The same webview is retargeted at another file: a fresh initial
        // snapshot whose restored session is on sheet 0, with no edits.
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Summary', 'Detail'], false),
            {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'file-b-session',
                },
            },
        ));

        await click_sheet_tab('Detail');
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!)).toEqual({});
    });

    it("drops a moved session sheet's store at its old index", async () => {
        // A workbook edit outside this viewer can reorder sheets; the host
        // re-grants with the session's new index and re-sends the complete
        // pending-edit projection. Hydration installs into the new index's
        // store, but the old index's store — same edits, wrong sheet — kept
        // its contents, so whatever sheet now occupies the old index painted
        // the session sheet's dirty cells as its own.
        await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['People', 'Inventory'], false),
            {
                state: {
                    columnWidths: [], scrollPosition: [],
                    activeSheetIndex: 1, tabOrientation: null,
                    pendingEdits: sheet_edits(
                        { '0:0': { value: 'Gadget', base: 'Widget' } },
                        1,
                    ),
                    transforms: [], columnVisibility: [],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'moving-session',
                },
            },
        ));

        // Inventory moved to index 0; its edits moved with it.
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Inventory', 'People'], false),
            {
                state: {
                    columnWidths: [], scrollPosition: [],
                    activeSheetIndex: 0, tabOrientation: null,
                    pendingEdits: sheet_edits(
                        { '0:0': { value: 'Gadget', base: 'Widget' } },
                        0,
                    ),
                    transforms: [], columnVisibility: [],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'moving-session',
                },
            },
        ));
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!))
            .toEqual({ '0:0': { value: 'Gadget', base: 'Widget' } });

        // People now sits at the session's old index and must not inherit the
        // store that was left there.
        await click_sheet_tab('People');
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!)).toEqual({});
    });

    it('carries the session store through a refresh that moves the sheet and the id', async () => {
        // A refresh can advance the session id and move the session's sheet in
        // the same delivery. The id change makes refresh_editing_current_session
        // false, so no install runs — the registry reconciliation has to happen
        // at the pointer move itself, or the edits are stranded at the old
        // index: the moved sheet comes up empty and the sheet now at the old
        // index paints them as its own.
        await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['People', 'Inventory'], false),
            {
                state: {
                    columnWidths: [], scrollPosition: [],
                    activeSheetIndex: 1, tabOrientation: null,
                    pendingEdits: sheet_edits(
                        { '0:0': { value: 'Gadget', base: 'Widget' } },
                        1,
                    ),
                    transforms: [], columnVisibility: [],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'session-before',
                },
            },
        ));
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!))
            .toEqual({ '0:0': { value: 'Gadget', base: 'Widget' } });

        // Inventory reordered to index 0; the host re-keys the session too.
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Inventory', 'People'], false),
            {
                state: {
                    columnWidths: [], scrollPosition: [],
                    activeSheetIndex: 0, tabOrientation: null,
                    pendingEdits: sheet_edits(
                        { '0:0': { value: 'Gadget', base: 'Widget' } },
                        0,
                    ),
                    transforms: [], columnVisibility: [],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'session-after',
                },
            },
        ));

        // A refresh keeps the webview's own active tab — index 1, which the
        // reorder makes People. The edits must not have stayed behind here...
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!)).toEqual({});
        // ...they followed Inventory to its new index.
        await click_sheet_tab('Inventory');
        expect(grid_stub().getAttribute('data-sheet-index')).toBe('0');
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!))
            .toEqual({ '0:0': { value: 'Gadget', base: 'Widget' } });
    });

    it('withholds an in-flight save from a grid mounted on another worksheet', async () => {
        // The session and its initial edits are already withheld from a sheet that
        // does not own them, but the save projection was not — and a grid with no
        // hoisted store builds its own from exactly that, so People's pending value
        // and dirty tint appeared on Inventory at the same coordinates, in a sheet
        // the user cannot even edit.
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'people-session',
            sheetIndex: 0,
        });
        await dispatch_host_message({
            type: 'saveOperationStarted',
            lifecycle: {
                revision: 1,
                state: 'active',
                operation: {
                    editSessionId: 'people-session',
                    saveRequestId: 'save-1',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '0:0': 'Alicia' },
                        dirtyEdits: { '0:0': { value: 'Alicia', base: 'Alice' } },
                    }],
                },
            },
        });

        await click_sheet_tab('Inventory');
        expect(grid_shell_mock.latest_props?.save_operation).toMatchObject({
            editSessionId: 'people-session',
            worksheets: [expect.objectContaining({ sheetIndex: 0 })],
        });
        expect(grid_shell_mock.latest_props?.save_lifecycle).toMatchObject({
            state: 'active',
            operation: expect.objectContaining({ editSessionId: 'people-session' }),
        });
    });

    it('keeps the save fence while a non-owning worksheet is on screen', async () => {
        // `save_in_flight_ref` is document-scoped, but a grid on a sheet that does
        // not own the session is deliberately handed no lifecycle and so reports
        // `save_in_flight: false`. Letting it write that through cleared the fence,
        // and the close/reload flush then published a pending-edit sequence the
        // host ignores while a save is active — advertised, never acknowledged,
        // and quitting waited on it until the barrier timed out.
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'people-session',
            sheetIndex: 0,
        });
        await dispatch_host_message({
            type: 'saveOperationStarted',
            lifecycle: {
                revision: 1,
                state: 'active',
                operation: {
                    editSessionId: 'people-session',
                    saveRequestId: 'save-1',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '0:0': 'Alicia' },
                        dirtyEdits: { '0:0': { value: 'Alicia', base: 'Alice' } },
                    }],
                },
            },
        });
        // The owning grid saw the save and reported it; the mock reports whatever
        // this flag says, as the real GridShell reports its own derived state.
        grid_shell_mock.save_in_flight = true;
        await act(async () => {
            grid_shell_mock.on_editing_change?.({
                is_dirty: true,
                has_live_uncommitted: false,
                save_in_flight: true,
                edits: { '0:0': { value: 'Alicia', base: 'Alice' } },
                conflicted: [],
            });
        });

        // Switching sheets mounts a grid that was handed no lifecycle, so it
        // reports `save_in_flight: false` — truthfully, about a save it cannot see.
        grid_shell_mock.save_in_flight = false;
        await click_sheet_tab('Inventory');
        expect(get_button('Edit').getAttribute('aria-disabled')).toBe('true');

        post_message.mockClear();
        await dispatch_host_message({
            type: 'requestPendingEditsFlush',
            requestId: 'flush-1',
        });
        // The reply itself is the observable result, so wait for *it* rather than
        // for a tick that happens to be long enough on this machine.
        await vi.waitUntil(() => post_message.mock.calls.some(
            ([message]) => message?.type === 'pendingEditsFlush',
        ));
        const flush = post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'pendingEditsFlush');
        // Every mounted worksheet participates in the workbook session. The flush
        // may publish its current store, but it must report the sequence it actually
        // produced rather than advertising an untracked future write.
        const pending = post_message.mock.calls.filter(
            ([message]) => message?.type === 'pendingEditsChanged',
        );
        expect(flush?.highestProducedSequence).toBeGreaterThanOrEqual(pending.length);
    });

    it('keeps the pointer sheet’s newer edits when a sibling grid reports clean', async () => {
        // The live-map ref belongs to the edit pointer, not whichever grid is
        // mounted. A read-only sibling reports an empty map on mount; if that
        // overwrites the ref, the succeeding save removes its own entries from
        // `undefined` and clears edits made on the pointer sheet after the save
        // began.
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'people-session',
            sheetIndex: 0,
        });
        const operation: CsvSaveOperation = {
            editSessionId: 'people-session',
            saveRequestId: 'save-1',
            worksheets: [{
                sheetIndex: 0,
                edits: { '0:0': 'Alicia' },
                dirtyEdits: { '0:0': { value: 'Alicia', base: 'Alice' } },
            }],
        };
        await dispatch_host_message({
            type: 'saveOperationStarted',
            lifecycle: { revision: 1, state: 'active', operation },
        });

        const store = grid_shell_mock.latest_props?.edit_session as EditSessionStore;
        await act(async () => {
            store.commit('people-session', '1:0', { value: 'newer', base: 'before' });
            grid_shell_mock.on_editing_change?.({
                is_dirty: true,
                has_live_uncommitted: false,
                save_in_flight: true,
                edits: {
                    ...operation.worksheets[0].dirtyEdits,
                    '1:0': { value: 'newer', base: 'before' },
                },
                conflicted: [],
            });
        });

        grid_shell_mock.is_dirty = false;
        grid_shell_mock.save_in_flight = false;
        await click_sheet_tab('Inventory');
        await dispatch_host_message({
            type: 'saveResult',
            success: true,
            lifecycle: { revision: 2, state: 'succeeded', operation },
        });

        expect(Object.fromEntries(store.snapshot())).toEqual({
            '1:0': { value: 'newer', base: 'before' },
        });
    });

    it('disables transform affordances on a non-owning sheet while a save runs', async () => {
        // The grid on a worksheet that does not own the session is handed no
        // lifecycle, so it truthfully reports `save_in_flight: false` about a save
        // it cannot see. Deriving the affordance from that report re-enabled sort
        // and filter while `transform_request_blocked` — reading the
        // document-scoped fence — went on refusing them: the click posted no
        // `setTransform` and gave no feedback.
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'people-session',
            sheetIndex: 0,
        });
        await dispatch_host_message({
            type: 'saveOperationStarted',
            lifecycle: {
                revision: 1,
                state: 'active',
                operation: {
                    editSessionId: 'people-session',
                    saveRequestId: 'save-1',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '0:0': 'Alicia' },
                        dirtyEdits: { '0:0': { value: 'Alicia', base: 'Alice' } },
                    }],
                },
            },
        });
        grid_shell_mock.save_in_flight = true;
        await act(async () => {
            grid_shell_mock.on_editing_change?.({
                is_dirty: true,
                has_live_uncommitted: false,
                save_in_flight: true,
                edits: { '0:0': { value: 'Alicia', base: 'Alice' } },
                conflicted: [],
            });
        });

        grid_shell_mock.save_in_flight = false;
        await click_sheet_tab('Inventory');

        expect(grid_shell_mock.latest_props?.transform_sections).toBe(false);
    });

    it('lifts the save fence when the save settles while another worksheet is on screen', async () => {
        // The other half of the fence above. Refusing the non-owning grid's report
        // is right while the save is running, but a *failed* save keeps the
        // worksheet session — so nothing changes `editing_another_sheet`, no owning
        // grid is mounted to report the terminal state, and the fence stayed up
        // until the user happened to visit the owning sheet again. Meanwhile every
        // transform was silently refused and the close flush published nothing.
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'people-session',
            sheetIndex: 0,
        });
        const operation = {
            editSessionId: 'people-session',
            saveRequestId: 'save-1',
            worksheets: [{
                sheetIndex: 0,
                edits: { '0:0': 'Alicia' },
                dirtyEdits: { '0:0': { value: 'Alicia', base: 'Alice' } },
            }],
        };
        await dispatch_host_message({
            type: 'saveOperationStarted',
            lifecycle: { revision: 1, state: 'active', operation },
        });
        grid_shell_mock.save_in_flight = true;
        await act(async () => {
            grid_shell_mock.on_editing_change?.({
                is_dirty: true,
                has_live_uncommitted: false,
                save_in_flight: true,
                edits: { '0:0': { value: 'Alicia', base: 'Alice' } },
                conflicted: [],
            });
        });

        grid_shell_mock.save_in_flight = false;
        await click_sheet_tab('Inventory');

        // The save fails while the user is still on Inventory.
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: { revision: 2, state: 'failed', operation },
        });

        post_message.mockClear();
        await dispatch_host_message({
            type: 'requestPendingEditsFlush',
            requestId: 'flush-2',
        });
        // The reply itself is the observable result, so wait for *it* rather than
        // for a tick that happens to be long enough on this machine.
        const posted = (type: string) => post_message.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === type);
        await vi.waitUntil(() => posted('pendingEditsFlush') !== undefined);
        const flush = posted('pendingEditsFlush');
        // No save is in flight any more, so the flush publishes the restored edits
        // instead of advertising a sequence the host will never acknowledge.
        expect(flush?.highestProducedSequence).toBeGreaterThan(0);
    });

    it('adopts the worksheet the host names for a session it did not request', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['People', 'Inventory'], false),
            {
                state: {
                    columnWidths: [], scrollPosition: [],
                    activeSheetIndex: 1, tabOrientation: null,
                    pendingEdits: sheet_edits(
                        { '0:0': { value: 'Gadget', base: 'Widget' } },
                        1,
                    ),
                    transforms: [], columnVisibility: [],
                },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'adopted-session',
                },
            },
        ));

        expect(grid_stub().getAttribute('data-sheet-index')).toBe('1');
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        await click_sheet_tab('People');
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
    });

    it('restores a clean owned edit session after receiver recreation', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'clean-owned-session',
                },
            },
        ));

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(grid_shell_mock.latest_props?.edit_session_id).toBe('clean-owned-session');
        expect(latest_store_edits()).toEqual({});
        expect(grid_stub().getAttribute('data-store-edits')).toBe('{}');
    });

    it('clears stale initial edits when a granted session has none', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            },
        ));

        await click_button('Edit');
        const stale = { '0:0': { value: 'stale', base: 'old-base' } };
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'old-session',
            pendingEdits: stale,
        });
        expect(latest_store_edits()).toEqual(stale);

        await click_button('Edit');
        await dispatch_host_message({ type: 'saveDialogResult', choice: 'discard' });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
        await click_button('Edit');
        const before_grant = grid_stub().getAttribute('data-mount-id');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'new-session',
        });

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        // Authoritative absence has to reach the live store: the stale entry must
        // be gone from what a mounted grid paints from, without a remount to wipe it.
        expect(latest_store_edits()).toEqual({});
        expect(grid_stub().getAttribute('data-store-edits')).toBe('{}');
        expect(grid_stub().getAttribute('data-mount-id')).toBe(before_grant);
        expect(post_message.mock.calls.filter(([message]) => (
            (message as { type?: string }).type === 'requestEditSession'
        ))).toHaveLength(2);
    });

    it('ignores an unsolicited session grant after a capability refresh', async () => {
        grid_shell_mock.emit_pending_edits_on_mount = true;
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(workbook_snapshot_message(meta, {
            capabilities: {
                csvEditable: false,
                csvEditingSupported: true,
            },
        }));
        post_message.mockClear();
        await dispatch_host_message(workbook_snapshot_message(meta, {
            presentation: 'refresh',
            reason: 'other',
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'session-new',
            },
            identity: {
                deliveryId: 2,
                authority: { fileId: 'file:test', revision: 1 },
                stateRevision: 1,
                sourceBasis: { physicalRevision: 1, projectionRevision: 0 },
            },
        }));
        expect(post_message.mock.calls.some(([message]) => (
            (message as { type?: string }).type === 'pendingEditsChanged'
        ))).toBe(false);

        const pendingEdits = { '0:0': { value: 'restored', base: 'a' } };
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'session-new',
            pendingEdits,
        });
        expect(post_message.mock.calls.some(([message]) => (
            (message as { type?: string }).type === 'pendingEditsChanged'
        ))).toBe(false);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('drops edit mode and pending restoration when the host revokes a saved session', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );
        await click_button('Edit');
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            pendingEdits: { '0:0': { value: 'draft', base: 'a' } },
        });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        post_message.mockClear();
        const operation: CsvSaveOperation = {
            editSessionId: 'test-edit-session',
            saveRequestId: 'save:matching',
            worksheets: [{
                sheetIndex: 0,
                edits: { '0:0': 'draft' },
                dirtyEdits: { '0:0': { value: 'draft', base: 'a' } },
            }],
        };
        await dispatch_host_message({
            type: 'saveOperationStarted',
            lifecycle: { revision: 1, state: 'active', operation },
        });
        await dispatch_host_message({
            type: 'editSessionRevoked',
            reason: 'saved',
            lifecycle: { revision: 2, state: 'succeeded', operation },
        });

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
        expect(post_message.mock.calls.some(([message]) => (
            (message as { type?: string }).type === 'releaseEditSession'
        ))).toBe(false);
        expect(post_message.mock.calls.some(([message]) => (
            (message as { type?: string }).type === 'pendingEditsChanged'
        ))).toBe(false);
    });

    it('ignores an unsolicited grant when cleanup recovery enables capability', async () => {
        await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(workbook_snapshot_message(meta, {
            capabilities: {
                csvEditable: false,
                csvEditingSupported: true,
            },
        }));
        await dispatch_host_message(workbook_snapshot_message(meta, {
            presentation: 'refresh',
            reason: 'other',
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
            },
            identity: {
                deliveryId: 2,
                authority: { fileId: 'file:test', revision: 1 },
                stateRevision: 1,
                sourceBasis: { physicalRevision: 1, projectionRevision: 0 },
            },
        }));
        await dispatch_host_message({ type: 'editSessionResult', granted: true });

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('disables the edit toolbar while GridShell is saving', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '0:0': { value: 'dirty', base: 'base' },
        }, true);

        expect(get_button('Edit').getAttribute('aria-disabled')).toBe('true');
    });

    it('retains the exact save guard across a generation remount', async () => {
        grid_shell_mock.is_dirty = true;
        grid_shell_mock.has_uncommitted_changes = true;
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: { csvEditable: true, csvEditingSupported: true },
        }));
        await enter_edit_mode(post_message);
        seed_mounted_store();
        const before_mount = grid_stub().getAttribute('data-mount-id');

        await click_button('Edit');
        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        const operation = grid_shell_mock.latest_props?.save_operation as CsvSaveOperation;
        expect(operation.saveRequestId).toEqual(expect.any(String));

        await dispatch_host_message(refresh_snapshot_message(meta, {
            generation: 2,
            sourceGeneration: 2,
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: operation.editSessionId,
            },
        }));
        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(before_mount);
        expect(grid_shell_mock.latest_props?.save_operation).toMatchObject(operation);

        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 1,
                state: 'failed',
                operation: { ...operation, saveRequestId: 'stale-save' },
            },
        });
        expect(grid_shell_mock.latest_props?.save_operation).toMatchObject(operation);

        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: { revision: 2, state: 'failed', operation },
        });
        expect(grid_shell_mock.latest_props?.save_operation).toBeUndefined();
    });

    it('keeps a local save locked through delayed idle before exact active acceptance', async () => {
        grid_shell_mock.is_dirty = true;
        grid_shell_mock.has_uncommitted_changes = true;
        const previous: CsvSaveOperation = {
            editSessionId: 'session-delayed-idle',
            saveRequestId: 'failed-r2',
            worksheets: [{
                sheetIndex: 0,
                edits: { '0:0': 'old' },
                dirtyEdits: { '0:0': { value: 'old', base: 'old-base' } },
            }],
        };
        await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: previous.editSessionId,
                csvSaveLifecycle: {
                    revision: 2,
                    state: 'failed',
                    operation: previous,
                },
            },
        }));
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        await click_button('Edit');
        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        const proposed = grid_shell_mock.latest_props?.save_operation as CsvSaveOperation;
        expect(proposed.saveRequestId).toEqual(expect.any(String));

        await dispatch_host_message(refresh_snapshot_message(meta, {
            state: { pendingEdits: sheet_edits(proposed.worksheets[0].dirtyEdits) },
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: proposed.editSessionId,
                csvSaveLifecycle: { revision: 3, state: 'idle' },
            },
        }));
        expect(grid_shell_mock.latest_props?.save_operation).toEqual(proposed);
        expect(latest_store_edits()).toEqual(proposed.worksheets[0].dirtyEdits);

        await dispatch_host_message({
            type: 'saveOperationStarted',
            lifecycle: { revision: 4, state: 'active', operation: proposed },
        });
        expect(grid_shell_mock.latest_props?.save_operation).toEqual(proposed);
        expect(latest_store_edits()).toEqual(proposed.worksheets[0].dirtyEdits);
    });

    it('applies a succeeded save lifecycle to a non-pointer worksheet on initial hydration', async () => {
        await render_app();
        const meta = make_meta(['People', 'Inventory'], false);
        meta.sheets[0].worksheetId = '1';
        meta.sheets[1].worksheetId = '2';
        const operation: CsvSaveOperation = {
            editSessionId: 'restored-session',
            saveRequestId: 'saved-inventory',
            worksheets: [{
                sheetIndex: 1,
                sheetName: 'Inventory',
                worksheetId: '2',
                edits: { '0:0': 'Gadget' },
                dirtyEdits: { '0:0': { value: 'Gadget', base: 'Widget' } },
            }],
        };
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: {
                pendingEdits: [
                    {
                        sheetName: 'People',
                        worksheetId: '1',
                        cells: { '0:0': { value: 'Bob', base: 'Alice' } },
                    },
                    {
                        sheetName: 'Inventory',
                        worksheetId: '2',
                        cells: operation.worksheets[0].dirtyEdits,
                    },
                ],
            },
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: operation.editSessionId,
                csvSaveLifecycle: {
                    revision: 1,
                    state: 'succeeded',
                    operation,
                },
            },
        }));

        expect(latest_store_edits()).toEqual({
            '0:0': { value: 'Bob', base: 'Alice' },
        });
        await click_sheet_tab('Inventory');
        expect(latest_store_edits()).toEqual({});
    });

    it('applies a newer save terminal carried by a stale same-file snapshot', async () => {
        grid_shell_mock.is_dirty = true;
        grid_shell_mock.has_uncommitted_changes = true;
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: { csvEditable: true, csvEditingSupported: true },
            identity: {
                deliveryId: 10,
                authority: { fileId: 'file:test', revision: 10 },
                stateRevision: 10,
                sourceBasis: { physicalRevision: 10, projectionRevision: 0 },
            },
        }));
        await enter_edit_mode(post_message);
        seed_mounted_store();
        await click_button('Edit');
        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        const operation = grid_shell_mock.latest_props?.save_operation as CsvSaveOperation;

        await dispatch_host_message(refresh_snapshot_message(meta, {
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: operation.editSessionId,
                csvSaveLifecycle: {
                    revision: 2,
                    state: 'failed',
                    operation,
                },
            },
            identity: {
                deliveryId: 9,
                authority: { fileId: 'file:test', revision: 9 },
                stateRevision: 9,
                sourceBasis: { physicalRevision: 9, projectionRevision: 0 },
            },
        }));

        expect(grid_shell_mock.latest_props?.save_operation).toBeUndefined();
        expect(latest_store_edits()).toEqual(
            operation.worksheets[0].dirtyEdits,
        );
        expect(grid_stub().getAttribute('data-generation')).toBe('1');
    });

    it('rehydrates an exact failed operation even when durable pending state is absent', async () => {
        const operation: CsvSaveOperation = {
            editSessionId: 'failed-session',
            saveRequestId: 'failed-before-acceptance',
            worksheets: [{
                sheetIndex: 0,
                edits: { '0:0': 'overlay' },
                dirtyEdits: {
                    '0:0': { value: 'overlay', base: 'exact-base' },
                },
            }],
        };
        await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: operation.editSessionId,
                    csvSaveLifecycle: {
                        revision: 2,
                        state: 'failed',
                        operation,
                    },
                },
            },
        ));

        expect(grid_shell_mock.latest_props?.save_operation).toBeUndefined();
        expect(latest_store_edits()).toEqual(
            operation.worksheets[0].dirtyEdits,
        );
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
    });

    it('does not hydrate a failed operation over a different current session', async () => {
        const newer = { '0:0': { value: 'newer', base: 'new-base' } };
        const failed: CsvSaveOperation = {
            editSessionId: 'old-session',
            saveRequestId: 'old-failure',
            worksheets: [{
                sheetIndex: 0,
                edits: { '0:0': 'old' },
                dirtyEdits: { '0:0': { value: 'old', base: 'old-base' } },
            }],
        };
        await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                state: { pendingEdits: sheet_edits(newer) },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'new-session',
                    csvSaveLifecycle: {
                        revision: 3,
                        state: 'failed',
                        operation: failed,
                    },
                },
            },
        ));

        expect(latest_store_edits()).toEqual(newer);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
    });

    it('tombstones stale pending edits for a succeeded current session', async () => {
        const succeeded: CsvSaveOperation = {
            editSessionId: 'saved-session',
            saveRequestId: 'saved-operation',
            worksheets: [{
                sheetIndex: 0,
                edits: { '0:0': 'saved' },
                dirtyEdits: { '0:0': { value: 'saved', base: 'base' } },
            }],
        };
        await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                state: { pendingEdits: sheet_edits(succeeded.worksheets[0].dirtyEdits) },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: succeeded.editSessionId,
                    csvSaveLifecycle: {
                        revision: 4,
                        state: 'succeeded',
                        operation: succeeded,
                    },
                },
            },
        ));

        expect(latest_store_edits()).toEqual({});
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('keeps saved entries cleared across reliable success, remount, and edit reacquisition', async () => {
        const operation: CsvSaveOperation = {
            editSessionId: 'saved-session',
            saveRequestId: 'saved-operation',
            worksheets: [{
                sheetIndex: 0,
                edits: { '0:0': 'saved' },
                dirtyEdits: { '0:0': { value: 'saved', base: 'base' } },
            }],
        };
        const lifecycle = {
            revision: 4,
            state: 'succeeded' as const,
            operation,
        };
        const { post_message } = await render_app();

        // Both direct terminal messages are absent. The reliable snapshot alone
        // must tombstone the accepted pending map.
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                state: { pendingEdits: sheet_edits(operation.worksheets[0].dirtyEdits) },
                capabilities: {
                    csvEditable: false,
                    csvEditingSupported: true,
                    csvSaveLifecycle: lifecycle,
                },
            },
        ));
        expect(latest_store_edits()).toEqual({});
        const initial_mount = grid_stub().getAttribute('data-mount-id');

        // Cleanup can arrive with the same lifecycle revision. A generation
        // remount must still consume the authoritative empty state.
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                state: { pendingEdits: undefined },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvSaveLifecycle: lifecycle,
                },
            },
        ));
        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(initial_mount);
        expect(latest_store_edits()).toEqual({});

        post_message.mockClear();
        await click_button('Edit');
        const request = post_message.mock.calls.find(
            ([message]) => (message as { type?: string }).type === 'requestEditSession',
        )?.[0] as { requestId: string };
        await dispatch_host_message({
            type: 'editSessionResult',
            requestId: request.requestId,
            granted: true,
            editSessionId: 'new-session',
        });

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(latest_store_edits()).toEqual({});
    });

    it('preserves pending edits for a newer session after an older success', async () => {
        const newer = { '0:0': { value: 'newer', base: 'new-base' } };
        const succeeded: CsvSaveOperation = {
            editSessionId: 'old-session',
            saveRequestId: 'old-success',
            worksheets: [{
                sheetIndex: 0,
                edits: { '0:0': 'old' },
                dirtyEdits: { '0:0': { value: 'old', base: 'old-base' } },
            }],
        };
        await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                state: { pendingEdits: sheet_edits(newer) },
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'new-session',
                    csvSaveLifecycle: {
                        revision: 4,
                        state: 'succeeded',
                        operation: succeeded,
                    },
                },
            },
        ));

        expect(latest_store_edits()).toEqual(newer);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
    });

    it('honors an authoritative success while local editing status is stale', async () => {
        grid_shell_mock.is_dirty = true;
        grid_shell_mock.has_uncommitted_changes = true;
        grid_shell_mock.request_save.mockReturnValue(false);

        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );

        await enter_edit_mode(post_message);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        seed_mounted_store();

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({ type: 'showSaveDialog' }));

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });

        expect(grid_shell_mock.request_save).toHaveBeenCalledTimes(1);
        await dispatch_host_message({ type: 'saveResult', success: true });
        await report_grid_editing(true);

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('exits edit mode after a busy save-on-exit succeeds with no remaining dirty work', async () => {
        grid_shell_mock.is_dirty = true;
        grid_shell_mock.has_uncommitted_changes = true;
        grid_shell_mock.request_save.mockReturnValue(false);

        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );

        await enter_edit_mode(post_message);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        seed_mounted_store();

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({ type: 'showSaveDialog' }));

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        expect(grid_shell_mock.request_save).toHaveBeenCalledTimes(1);

        await dispatch_host_message({ type: 'saveResult', success: true });
        await report_grid_editing(false);

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('discards an operation-owned live overlay after save success', async () => {
        grid_shell_mock.is_dirty = false;
        grid_shell_mock.has_uncommitted_changes = true;
        grid_shell_mock.request_save.mockReturnValue(false);

        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );

        await enter_edit_mode(post_message);
        await report_grid_editing(false, true);
        seed_mounted_store();
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({ type: 'showSaveDialog' }));

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        expect(grid_shell_mock.request_save).toHaveBeenCalledTimes(1);

        await dispatch_host_message({ type: 'saveResult', success: true });

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    it('exits after a successful save once a still-open overlay later resolves clean (no timer)', async () => {
        grid_shell_mock.is_dirty = false;
        grid_shell_mock.has_uncommitted_changes = true;
        grid_shell_mock.request_save.mockReturnValue(false);

        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );

        await enter_edit_mode(post_message);
        await report_grid_editing(false, true);
        seed_mounted_store();
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({ type: 'showSaveDialog' }));

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        await dispatch_host_message({ type: 'saveResult', success: true });
        // The accepted operation owns the overlay, so success is terminal even if
        // a stale editing-status report still says it is open.
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');

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
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );

        await enter_edit_mode(post_message);
        await report_grid_editing(false, true);
        seed_mounted_store();
        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({ type: 'showSaveDialog' }));

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        await dispatch_host_message({ type: 'saveResult', success: true });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');

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
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );

        await enter_edit_mode(post_message);
        await report_grid_editing(false, true);
        seed_mounted_store();
        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({ type: 'showSaveDialog' }));

        await dispatch_host_message({ type: 'saveDialogResult', choice: 'save' });
        await dispatch_host_message({ type: 'saveResult', success: true });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');

        // A fresh document arrives (resetting pending-exit bookkeeping) and brings
        // restored edits, so edit mode re-engages. The earlier pending exit must
        // not fire against this new document when its editing state goes clean.
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Fresh'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
                state: { pendingEdits: sheet_edits({ '0:0': { value: 'restored', base: 'base' } }) },
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
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, ['0:0']);

        post_message.mockClear();
        await click_button('Discard All');

        expect(grid_shell_mock.clear_dirty).toHaveBeenCalledTimes(1);
        expect(grid_shell_mock.stop_edit_admission).toHaveBeenCalledTimes(1);
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({ type: 'discardEditSession' }));
        const discard_call = post_message.mock.invocationCallOrder.find((_order, index) => (
            (post_message.mock.calls[index][0] as { type?: string }).type === 'discardEditSession'
        ));
        expect(grid_shell_mock.stop_edit_admission.mock.invocationCallOrder[0])
            .toBeLessThan(discard_call!);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
    });

    // Host-rejected saves. These are the deadlock case: the keys the host names are
    // exactly the ones the webview's residency-gated `is_entry_conflicted` cannot
    // flag, so every one of these tests reports NO webview-derived conflicts.
    it('does not replace newer edits for a host-generated rehydration rejection', async () => {
        await render_app();
        const restored = { '4:1': { value: 'edited', base: 'stale' } };
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'test-edit-session',
                },
                state: { pendingEdits: sheet_edits(restored) },
            }),
        );
        const store = grid_shell_mock.latest_props?.edit_session as EditSessionStore;
        await act(async () => {
            store.commit('test-edit-session', '9:0', {
                value: 'newer edit',
                base: 'current',
            });
        });

        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 900,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'rehydration:1',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited' },
                        dirtyEdits: restored,
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: ['4:1'] },
        });

        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!)).toEqual({
            ...restored,
            '9:0': { value: 'newer edit', base: 'current' },
        });
    });

    it('shows the conflict banner for a host base mismatch with no derived conflicts', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        expect(container!.querySelector('.conflict-banner')).toBeNull();

        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 900,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-1',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited' },
                        dirtyEdits: { '4:1': { value: 'edited', base: 'stale' } },
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: ['4:1'] },
        });

        // The real shell restores the submitted dirty map on a failed lifecycle and
        // then reports it; the stub's mount effect re-emits its default status
        // instead, so replay the report to model the post-rejection state.
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });

        const banner = container!.querySelector('.conflict-banner');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toContain('1 edit no longer matches');
        expect(banner!.textContent).toContain('save was cancelled');
        // The host keys reach the grid so the cell is tinted like a derived conflict.
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual(['4:1']);
    });

    it('names the affected row numbers when the file shrank under an edit', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '7:0': { value: 'orphan', base: 'gone' },
            '7:2': { value: 'orphan too', base: 'gone' },
        });

        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 901,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-2',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '7:0': 'orphan', '7:2': 'orphan too' },
                        dirtyEdits: {
                        '7:0': { value: 'orphan', base: 'gone' },
                        '7:2': { value: 'orphan too', base: 'gone' },
                    },
                    }],
                },
            },
            rejection: { reason: 'rowsRemoved', worksheetOperationIndex: 0, keys: ['7:0', '7:2'] },
        });

        // The real shell restores the submitted dirty map on a failed lifecycle and
        // then reports it; the stub's mount effect re-emits its default status
        // instead, so replay the report to model the post-rejection state.
        await report_grid_editing(true, true, [], {
            '7:0': { value: 'orphan', base: 'gone' },
            '7:2': { value: 'orphan too', base: 'gone' },
        });

        const banner = container!.querySelector('.conflict-banner');
        expect(banner).not.toBeNull();
        // Two edits on one removed row is one row to report, 1-based.
        expect(banner!.textContent).toContain('File shrank externally');
        expect(banner!.textContent).toContain('1 edited row no longer exists');
        expect(banner!.textContent).toContain('Affected row: 8');
    });

    it('discards exactly the host-named keys from the banner', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
            '0:0': { value: 'fine', base: 'a' },
        });
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 902,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-3',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited', '0:0': 'fine' },
                        dirtyEdits: {
                        '4:1': { value: 'edited', base: 'stale' },
                        '0:0': { value: 'fine', base: 'a' },
                    },
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: ['4:1'] },
        });

        // The real shell restores the submitted dirty map on a failed lifecycle and
        // then reports it; the stub's mount effect re-emits its default status
        // instead, so replay the report to model the post-rejection state. The
        // reported `conflicted` includes '4:1' because GridShell folds the host keys
        // into the set it reports — nothing here derived it, which is exactly why
        // discard_conflicted cannot clear it.
        await report_grid_editing(true, true, ['4:1'], {
            '4:1': { value: 'edited', base: 'stale' },
            '0:0': { value: 'fine', base: 'a' },
        });

        await click_button('Discard Conflicted');

        // Not discard_conflicted: that predicate is false for every host-named key,
        // so it would leave the entry that is blocking the save.
        expect(grid_shell_mock.discard_conflicted).not.toHaveBeenCalled();
        expect(grid_shell_mock.discard_keys).toHaveBeenCalledTimes(1);
        expect(grid_shell_mock.discard_keys).toHaveBeenCalledWith(['4:1']);
    });

    it('scopes same-key host save rejections by worksheet operation ordinal', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['People', 'Inventory'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        const people_edits = { '4:1': { value: 'Bob', base: 'Alice' } };
        const inventory_edits = { '4:1': { value: 'Gadget', base: 'stale' } };
        await report_grid_editing(true, true, [], people_edits);
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 904,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-sheet-scope',
                    worksheets: [
                        {
                            sheetIndex: 0,
                            sheetName: 'People',
                            edits: { '4:1': 'Bob' },
                            dirtyEdits: people_edits,
                        },
                        {
                            sheetIndex: 1,
                            sheetName: 'Inventory',
                            edits: { '4:1': 'Gadget' },
                            dirtyEdits: inventory_edits,
                        },
                    ],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 1, keys: ['4:1'] },
        });
        await report_grid_editing(true, true, [], people_edits);
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual([]);
        expect(document.querySelector('.conflict-banner')).toBeNull();

        await click_sheet_tab('Inventory');
        await report_grid_editing(true, true, ['4:1'], inventory_edits);
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual(['4:1']);
        expect(document.querySelector('.conflict-banner')).not.toBeNull();

        await click_sheet_tab('People');
        await report_grid_editing(true, true, [], people_edits);
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual([]);
    });

    it('ignores a rejection whose worksheet operation ordinal is out of bounds', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        const edits = { '4:1': { value: 'edited', base: 'stale' } };
        await report_grid_editing(true, true, [], edits);
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 905,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-invalid-ordinal',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited' },
                        dirtyEdits: edits,
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 1, keys: ['4:1'] },
        });
        await report_grid_editing(true, true, [], edits);

        expect(document.querySelector('.conflict-banner')).toBeNull();
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual([]);
    });

    it('clears host-named and derived conflicts in one press', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        // '4:1' is the host's verdict; '9:3' is one the webview derived on its own
        // (its page is resident, so is_entry_conflicted could see the drift). The
        // grid reports the union, which is what the banner tints.
        await report_grid_editing(true, true, ['4:1', '9:3'], {
            '4:1': { value: 'edited', base: 'stale' },
            '9:3': { value: 'local', base: 'drifted' },
        });
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 905,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-4',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited', '9:3': 'local' },
                        dirtyEdits: {
                        '4:1': { value: 'edited', base: 'stale' },
                        '9:3': { value: 'local', base: 'drifted' },
                    },
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: ['4:1'] },
        });
        await report_grid_editing(true, true, ['4:1', '9:3'], {
            '4:1': { value: 'edited', base: 'stale' },
            '9:3': { value: 'local', base: 'drifted' },
        });

        await click_button('Discard Conflicted');

        // Both mechanisms fire: discard_keys can only reach the host's key, and
        // discard_conflicted can only reach the derived one. Dropping either call
        // would leave half the tinted cells dirty and the banner still up.
        expect(grid_shell_mock.discard_keys).toHaveBeenCalledWith(['4:1']);
        expect(grid_shell_mock.discard_conflicted).toHaveBeenCalledTimes(1);
    });

    it('dismisses a host rejection once its edits leave the dirty map', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
            '0:0': { value: 'fine', base: 'a' },
        });
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 903,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-4',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited', '0:0': 'fine' },
                        dirtyEdits: {
                        '4:1': { value: 'edited', base: 'stale' },
                        '0:0': { value: 'fine', base: 'a' },
                    },
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: ['4:1'] },
        });

        // The real shell restores the submitted dirty map on a failed lifecycle and
        // then reports it; the stub's mount effect re-emits its default status
        // instead, so replay the report to model the post-rejection state.
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
            '0:0': { value: 'fine', base: 'a' },
        });

        expect(container!.querySelector('.conflict-banner')).not.toBeNull();

        // The rejected entry is gone (discarded here, but any route out of the map
        // counts) while an unrelated edit remains: the banner and the tint must both
        // clear, since the host is no longer refusing anything that still exists.
        await report_grid_editing(true, true, [], {
            '0:0': { value: 'fine', base: 'a' },
        });

        expect(container!.querySelector('.conflict-banner')).toBeNull();
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual([]);
    });

    it('does not re-raise a resolved rejection when the same cell is edited again', async () => {
        // Trigger A. Membership in the rejected-key list is not enough: the user
        // discards the rejected edit and types into the same cell again, and the
        // fresh entry's base was re-read from the file the host had just changed.
        // That edit has never been submitted, so a banner claiming "save was
        // cancelled" over it is describing an event that did not happen — and the
        // grid would tint a cell nothing is wrong with.
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 904,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-5',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited' },
                        dirtyEdits: { '4:1': { value: 'edited', base: 'stale' } },
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: ['4:1'] },
        });
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        expect(container!.querySelector('.conflict-banner')).not.toBeNull();

        // Discard Conflicted drops '4:1'…
        await report_grid_editing(false, false, [], {});
        expect(container!.querySelector('.conflict-banner')).toBeNull();

        // …and the user retypes into that very cell. Same key, new edit: a fresh
        // value over a base read from the current file.
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'retyped', base: 'their-text' },
        });

        expect(container!.querySelector('.conflict-banner')).toBeNull();
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual([]);
    });

    it('does not carry a rejection into a new edit session', async () => {
        // Trigger B. The adoption guard at the set site gates only *recording*, so
        // without a session stamp on the state itself a rejection outlives its
        // session and re-raises against whatever the next session's retained map
        // happens to hold under the same key.
        //
        // The rotation route is a refresh snapshot advancing csvEditSessionId, which
        // the host does on every applied snapshot. Deliberately *not* the install
        // path: the refresh does not install when the id is not our own current
        // session, so nothing here calls clear_save_verdict and the session stamp is
        // the only thing that can be doing the work.
        const meta = make_meta(['Sheet1'], false);
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(meta, {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 905,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-6',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited' },
                        dirtyEdits: { '4:1': { value: 'edited', base: 'stale' } },
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: ['4:1'] },
        });
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        expect(container!.querySelector('.conflict-banner')).not.toBeNull();

        await dispatch_host_message(refresh_snapshot_message(meta, {
            generation: 3,
            sourceGeneration: 3,
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'second-edit-session',
            },
        }));
        // Byte-identical to the map the host rejected, which is the point: only the
        // session differs.
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });

        expect(container!.querySelector('.conflict-banner')).toBeNull();
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual([]);
    });

    it('keeps a host rejection across a same-session refresh', async () => {
        // The mirror of the rotation case above, and the one the session stamp cannot
        // cover: a refresh whose csvEditSessionId is still ours reinstalls the very
        // map the host judged — same session, same values, same bases — so the
        // verdict is still true. Any capability/state recapture lands here (entering
        // the rejection's own aftermath is enough to trigger one), and the banner is
        // the only recovery affordance for a host-only rejection, so losing it here
        // reads as "the conflict resolved itself".
        const meta = make_meta(['Sheet1'], false);
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(meta, {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 909,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-10',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited' },
                        dirtyEdits: { '4:1': { value: 'edited', base: 'stale' } },
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: ['4:1'] },
        });
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        expect(container!.querySelector('.conflict-banner')).not.toBeNull();
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual(['4:1']);

        // A refresh for our *own* session, carrying back the rejected map: this is
        // the install path (refresh_editing_current_session is true), unlike the
        // rotation test above.
        await dispatch_host_message(refresh_snapshot_message(meta, {
            generation: 3,
            sourceGeneration: 3,
            state: {
                pendingEdits: sheet_edits({ '4:1': { value: 'edited', base: 'stale' } }),
            },
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'test-edit-session',
            },
        }));
        // The shell reports the restored map after the remount; the stub does not,
        // so replay it — byte-identical, because nothing about the edit changed.
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });

        expect(container!.querySelector('.conflict-banner')).not.toBeNull();
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual(['4:1']);
    });

    it('lets a later save result supersede an earlier rejection', async () => {
        // The adoption block only ever *sets*, so without a clear at the top of the
        // handler a rejection outlives every later verdict that does not name keys
        // of its own. Modelled with a second failed save reporting no `rejection`
        // (a write error rather than a base mismatch), because that is the only
        // terminal result that leaves edit mode and the session intact — a success
        // exits edit mode, which would hide the banner for an unrelated reason and
        // make the assertion vacuous.
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 906,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-7',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited' },
                        dirtyEdits: { '4:1': { value: 'edited', base: 'stale' } },
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: ['4:1'] },
        });
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        expect(container!.querySelector('.conflict-banner')).not.toBeNull();

        // A second save over the same map, refused for a reason that names no keys.
        // The absence of `rejection` has to speak: this verdict says nothing is
        // base-mismatched any more.
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 907,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-8',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited' },
                        dirtyEdits: { '4:1': { value: 'edited', base: 'stale' } },
                    }],
                },
            },
        });
        // Same map, unchanged — so only the cleared verdict can move the banner.
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });

        expect(container!.querySelector('.conflict-banner')).toBeNull();
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual([]);
    });

    it.each([
        ['without a rejection', undefined],
        ['with a different rejection', {
            reason: 'baseMismatch' as const,
            worksheetOperationIndex: 0,
            keys: ['0:0'],
        }],
    ])('ignores a stale save result %s', async (_label, stale_rejection) => {
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 910,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-current',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited' },
                        dirtyEdits: { '4:1': { value: 'edited', base: 'stale' } },
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: ['4:1'] },
        });
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        expect(container!.querySelector('.conflict-banner')).not.toBeNull();

        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 909,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-stale',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '0:0': 'other' },
                        dirtyEdits: { '0:0': { value: 'other', base: 'base' } },
                    }],
                },
            },
            ...(stale_rejection ? { rejection: stale_rejection } : {}),
        });

        expect(container!.querySelector('.conflict-banner')).not.toBeNull();
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual(['4:1']);
    });

    it('lets Keep All dismiss a host rejection', async () => {
        // Keep All was a no-op for a host rejection: `show_host_rejection`
        // short-circuited ahead of the dismissal check, so the button recorded a
        // signature nothing consulted and the banner stayed up with no way to put it
        // away short of discarding the edits.
        const { post_message } = await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1'], false), {
                capabilities: { csvEditable: true, csvEditingSupported: true },
            })
        );
        await enter_edit_mode(post_message);
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 908,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-9',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '4:1': 'edited' },
                        dirtyEdits: { '4:1': { value: 'edited', base: 'stale' } },
                    }],
                },
            },
            rejection: { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: ['4:1'] },
        });
        await report_grid_editing(true, true, [], {
            '4:1': { value: 'edited', base: 'stale' },
        });
        expect(container!.querySelector('.conflict-banner')).not.toBeNull();

        await click_button('Keep All');

        expect(container!.querySelector('.conflict-banner')).toBeNull();
        // Dismissed, not resolved: the tint stays so the cell is still identifiable,
        // and the edit is still there to save or discard.
        expect(JSON.parse(grid_stub().getAttribute('data-host-rejected-keys')!))
            .toEqual(['4:1']);
    });
});

describe('preview mode', () => {
    it('passes preview_mode through to the grid', async () => {
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1']), { configuration: { previewMode: true } })
        );
        expect(grid_stub().getAttribute('data-preview')).toBe('true');
    });

    it('retains the latest queued scroll across a snapshot refresh until GridShell acknowledges it', async () => {
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1']), { configuration: { previewMode: true } })
        );
        await dispatch_host_message({ type: 'scrollToRow', row: 40 });
        await dispatch_host_message({ type: 'scrollToRow', row: 80 });
        const pending_before = JSON.parse(
            grid_stub().getAttribute('data-pending-preview-scroll')!,
        );
        expect(pending_before).toMatchObject({ row: 80 });

        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1']), {
            configuration: { previewMode: true },
        }));
        expect(JSON.parse(grid_stub().getAttribute('data-pending-preview-scroll')!))
            .toEqual(pending_before);

        await act(async () => (
            container!.querySelector('.stub-ack-preview-scroll') as HTMLButtonElement
        ).click());
        expect(grid_stub().getAttribute('data-pending-preview-scroll')).toBe('null');
    });

    it('queues the last visible preview row across a snapshot refresh when no host scroll is pending', async () => {
        await render_app();
        await dispatch_host_message(
            initial_snapshot_message(make_meta(['Sheet1']), { configuration: { previewMode: true } })
        );
        const report_visible = grid_shell_mock.latest_props
            ?.on_preview_visible_row_change as ((row: number) => void) | undefined;
        await act(async () => report_visible?.(75));
        expect(grid_stub().getAttribute('data-pending-preview-scroll')).toBe('null');

        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1']), {
            configuration: { previewMode: true },
        }));
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
            initial_snapshot_message(make_meta(['Preview']), { configuration: { previewMode: true } })
        );
        await dispatch_host_message({ type: 'scrollToRow', row: 25 });
        expect(grid_stub().getAttribute('data-pending-preview-scroll')).not.toBe('null');

        await dispatch_host_message(initial_snapshot_message(make_meta(['Fresh']), {
            configuration: { previewMode: true },
            generation: 2,
        }));
        expect(grid_stub().getAttribute('data-pending-preview-scroll')).toBe('null');

        await dispatch_host_message({ type: 'scrollToRow', row: 30 });
        await dispatch_host_message(initial_snapshot_message(make_meta(['Editor']), {
            configuration: { previewMode: false },
            generation: 3,
        }));
        expect(grid_stub().getAttribute('data-pending-preview-scroll')).toBe('null');
    });
});

describe('sorting and filtering', () => {
    it('requests a histogram only when the editor opens and reuses a completed source-scoped result', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
        post_message.mockClear();
        expect(post_message.mock.calls.some(
            ([message]) => message.type === 'requestFilterHistogram',
        )).toBe(false);

        await open_grid_filter();
        const request = latest_histogram_request(post_message);
        expect(request).toMatchObject({
            sheetIndex: 0, columnIndex: 0, generation: 1, sourceGeneration: 1,
        });
        // Histogram UI is gated to range operators; request still fires on open.
        expect(document.body.textContent).not.toContain('Loading distribution…');
        await dispatch_host_message({
            type: 'filterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: request.requestId, generation: 1, sourceGeneration: 1,
            bins: [{ lo: 0, hi: 10, count: 3 }],
        });
        // Ready bins promote a pristine draft to Between and show the chart.
        expect((document.querySelector('#filter-condition') as HTMLSelectElement).value)
            .toBe('between');
        expect(document.querySelectorAll('.filter-histogram-bar')).toHaveLength(1);

        await click_button('Cancel');
        post_message.mockClear();
        await open_grid_filter();
        expect(post_message.mock.calls.some(
            ([message]) => message.type === 'requestFilterHistogram',
        )).toBe(false);
        expect((document.querySelector('#filter-condition') as HTMLSelectElement).value)
            .toBe('between');
        expect(document.querySelectorAll('.filter-histogram-bar')).toHaveLength(1);
    });

    it('accepts and reuses an in-flight source-valid histogram after a transform-only generation bump', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
        post_message.mockClear();
        await open_grid_filter();
        const histogram = latest_histogram_request(post_message);

        const change_transform = grid_shell_mock.latest_props?.on_transform_change as (
            state: SheetTransformState,
        ) => void;
        await act(async () => change_transform({
            sort: [{ colIndex: 0, direction: 'asc' }], filters: [],
        }));
        const transform = latest_transform_request(post_message);
        await acknowledge_transform(transform, 2);
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
        expect(document.body.textContent).not.toContain('Loading distribution…');

        await dispatch_host_message({
            type: 'filterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: histogram.requestId,
            generation: histogram.generation,
            sourceGeneration: histogram.sourceGeneration,
            bins: [{ lo: 0, hi: 1, count: 5 }],
        });
        expect((document.querySelector('#filter-condition') as HTMLSelectElement).value)
            .toBe('between');
        expect(document.querySelectorAll('.filter-histogram-bar')).toHaveLength(1);

        await click_button('Cancel');
        post_message.mockClear();
        await open_grid_filter();
        expect(post_message.mock.calls.some(
            ([message]) => message.type === 'requestFilterHistogram',
        )).toBe(false);
        expect(document.querySelectorAll('.filter-histogram-bar')).toHaveLength(1);
    });

    it('settles a delayed view-stale histogram terminal that echoes its request tuple', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
        post_message.mockClear();
        await open_grid_filter();
        const histogram = latest_histogram_request(post_message);

        const change_transform = grid_shell_mock.latest_props?.on_transform_change as (
            state: SheetTransformState,
        ) => void;
        await act(async () => change_transform({
            sort: [{ colIndex: 0, direction: 'asc' }], filters: [],
        }));
        await acknowledge_transform(latest_transform_request(post_message), 2);

        await dispatch_host_message({
            type: 'filterHistogram', sheetIndex: histogram.sheetIndex,
            columnIndex: histogram.columnIndex, requestId: histogram.requestId,
            generation: histogram.generation,
            sourceGeneration: histogram.sourceGeneration,
            bins: [],
            error: 'The view changed before this histogram request arrived.',
        });
        // Terminal errors only surface for range ops. Error kind stays unknown, so Between
        // remains selectable without seeding a prior filter.
        await click_button('Cancel');
        post_message.mockClear();
        await open_grid_filter();
        const reopen = latest_histogram_request(post_message);
        const select = document.querySelector('#filter-condition') as HTMLSelectElement;
        await act(async () => {
            select.value = 'between';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        // Errors are not cached; a new request fires and must be settled again.
        await dispatch_host_message({
            type: 'filterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: reopen.requestId,
            generation: reopen.generation,
            sourceGeneration: reopen.sourceGeneration,
            bins: [],
            error: 'The view changed before this histogram request arrived.',
        });
        expect(document.body.textContent).toContain(
            'Distribution unavailable: The view changed before this histogram request arrived.',
        );
        expect(document.body.textContent).not.toContain('Loading distribution…');
    });

    it('cancels when the editor target changes and ignores late mismatched results', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1']);
        meta.sheets[0] = { ...meta.sheets[0], columnCount: 2 };
        await dispatch_host_message(initial_snapshot_message(meta));
        post_message.mockClear();

        await open_grid_filter(0);
        const first = latest_histogram_request(post_message);
        await open_grid_filter(1);
        const second = latest_histogram_request(post_message);
        expect(second.columnIndex).toBe(1);
        expect(post_message).toHaveBeenCalledWith({
            type: 'cancelFilterHistogram', requestId: first.requestId,
        });

        await dispatch_host_message({
            type: 'filterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: first.requestId, generation: 1, sourceGeneration: 1,
            bins: [{ lo: 0, hi: 1, count: 99 }],
        });
        // Still waiting on column 1; no chart bars yet and loading is range-gated.
        expect(document.querySelectorAll('.filter-histogram-bar')).toHaveLength(0);
        expect(document.body.textContent).not.toContain('Loading distribution…');

        await dispatch_host_message({
            type: 'filterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: second.requestId, generation: 1, sourceGeneration: 1,
            bins: [{ lo: 0, hi: 1, count: 42 }],
        });
        expect(document.querySelectorAll('.filter-histogram-bar')).toHaveLength(0);

        await dispatch_host_message({
            type: 'filterHistogram', sheetIndex: 0, columnIndex: 1,
            requestId: second.requestId, generation: 1, sourceGeneration: 1,
            bins: [],
        });
        // Empty bins keep the draft on Contains / text operators. Reopen with a seeded
        // Between filter so the cached empty-chart status can render.
        await click_button('Cancel');
        const change_transform = grid_shell_mock.latest_props?.on_transform_change as (
            state: SheetTransformState,
        ) => void;
        await act(async () => change_transform({
            sort: [],
            filters: [{
                id: 'seed-between', colIndex: 1, operator: 'between',
                value: '1', secondValue: '2', caseSensitive: false, enabled: true,
            }],
        }));
        await acknowledge_transform(latest_transform_request(post_message), 2);
        post_message.mockClear();
        await open_grid_filter(1);
        expect(post_message.mock.calls.some(
            ([message]) => message.type === 'requestFilterHistogram',
        )).toBe(false);
        expect(document.body.textContent).toContain('No numeric values to chart.');
    });

    it('invalidates cached histograms on source generation change and fences the old response', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
        post_message.mockClear();
        await open_grid_filter();
        const old_request = latest_histogram_request(post_message);

        await dispatch_host_message(refresh_snapshot_message(make_meta(['Sheet1']), {
            generation: 2,
            sourceGeneration: 2,
        }));
        await dispatch_host_message({
            type: 'filterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: old_request.requestId, generation: 1, sourceGeneration: 1,
            bins: [{ lo: 0, hi: 1, count: 7 }],
        });
        expect(document.querySelector('.filter-popover')).toBeNull();

        post_message.mockClear();
        await open_grid_filter();
        const new_request = latest_histogram_request(post_message);
        expect(new_request).toMatchObject({ generation: 2, sourceGeneration: 2 });
        expect(new_request.requestId).not.toBe(old_request.requestId);
    });

    it('disables transform controls while an edit-session request is pending', async () => {
        const { post_message } = await render_app();
        const identified_meta = make_meta(['Sheet1'], false);
        identified_meta.sheets[0].worksheetId = '7';
        await dispatch_host_message(
            initial_snapshot_message(identified_meta, {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                },
            }),
        );

        post_message.mockClear();
        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestEditSession',
            sheetIndex: 0,
            sheetName: 'Sheet1',
            worksheetId: '7',
        }));
        expect(grid_shell_mock.latest_props?.transform_sections).toBe(false);

        await dispatch_host_message({ type: 'editSessionResult', granted: true });
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        // Specifically the pending window, not edit mode: once the session is
        // granted the controls come back, because the host admits a transform from
        // the panel that owns the session.
        expect(grid_shell_mock.latest_props?.transform_sections).toBe(true);
    });

    it('drops and persists invalid saved transforms on initial load', async () => {
        const { post_message } = await render_app();
        post_message.mockClear();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
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
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
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

    it('keeps a new transform pending when an old receiver terminal arrives', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1']);
        await dispatch_host_message(initial_snapshot_message(meta));
        post_message.mockClear();
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        const old_request = latest_transform_request(post_message);

        await dispatch_host_message(initial_snapshot_message(meta, {
            generation: 1,
            sourceGeneration: 1,
        }));
        post_message.mockClear();
        await act(async () => (
            container!.querySelector('.stub-header-transform') as HTMLButtonElement
        ).click());
        const current_request = latest_transform_request(post_message);
        expect(current_request.requestId).not.toBe(old_request.requestId);

        await acknowledge_transform(old_request, 99);
        expect(grid_stub().getAttribute('data-generation')).toBe('1');
        expect(grid_shell_mock.latest_props?.transform_pending).toBe(true);

        await acknowledge_transform(current_request, 2);
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
        expect(grid_shell_mock.latest_props?.transform_pending).toBe(false);
    });

    it('suppresses semantically unchanged transform requests without remounting', async () => {
        const { post_message } = await render_app();
        const schema = '["Sheet1",1,null]';
        const filter = {
            id: 'f', colIndex: 0, operator: 'contains' as const,
            value: 'x', caseSensitive: false, enabled: true,
        };
        const filter_state = { sort: [], filters: [filter], schema };
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
            state: { transforms: [filter_state] },
        }));
        const restore = post_message.mock.calls.map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        await dispatch_host_message(
            transform_installed_message(restore, { generation: 2 }),
        );
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

        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
            state: { transforms: [{
                sort: [{ colIndex: 0, direction: 'asc' }], filters: [], schema,
            }] },
        }));
        const sort_restore = post_message.mock.calls.map((call) => call[0])
            .filter((message) => message.type === 'setTransform').at(-1);
        await dispatch_host_message(
            transform_installed_message(sort_restore, { generation: 2 }),
        );
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

        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
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

    it('does not warn or retry after the host recovers an invalid saved restore', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1']);
        const invalid = {
            sort: [], filters: [{
                id: 'invalid', colIndex: 0, operator: 'greaterThan' as const,
                value: 'bad', caseSensitive: false, enabled: true,
            }], schema: '["Sheet1",1,null]',
        };
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: { transforms: [invalid] },
        }));
        const restore = latest_transform_request(post_message);
        // Recovery arrives as an install of the view that stands, not a refusal.
        await dispatch_host_message(transform_installed_message(restore, {
            generation: 1,
            state: { sort: [], filters: [] },
        }));
        expect(post_message.mock.calls.map((call) => call[0])
            .filter((message) => message.type === 'showWarning')).toHaveLength(0);

        post_message.mockClear();
        await dispatch_host_message(initial_snapshot_message(meta, {
            generation: 1,
            sourceGeneration: restore.sourceGeneration,
            state: { transforms: [undefined] },
        }));
        expect(post_message.mock.calls.map((call) => call[0])
            .filter((message) => message.type === 'setTransform')).toHaveLength(0);
        expect(post_message.mock.calls.map((call) => call[0])
            .filter((message) => message.type === 'showWarning')).toHaveLength(0);
    });

    it.each([
        ['grid shortcut', '.stub-shortcut-transform'],
        ['header menu', '.stub-header-transform'],
    ])('restores grid focus after a %s transform acknowledgement remount', async (_label, selector) => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
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

        await dispatch_host_message(
            transform_installed_message(request, { generation: 2 }),
        );
        await vi.waitUntil(() => grid_shell_mock.focus_grid.mock.calls.length > 0);

        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(previous_mount);
        expect(grid_shell_mock.focus_grid).toHaveBeenCalledOnce();
        expect(toolbar_focus).not.toHaveBeenCalled();
    });

    it('does not restore grid focus after the webview loses focus before acknowledgement', async () => {
        const has_focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
        post_message.mockClear();

        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        const request = latest_transform_request(post_message);
        const focus_checks_before = has_focus.mock.calls.length;
        await acknowledge_transform(request, 2);
        await vi.waitUntil(() => has_focus.mock.calls.length > focus_checks_before);

        expect(grid_shell_mock.focus_grid).not.toHaveBeenCalled();
        has_focus.mockReturnValue(true);
        await act(async () => Promise.resolve());
        expect(grid_shell_mock.focus_grid).not.toHaveBeenCalled();
    });

    it('restores grid focus after a grid-opened filter applies and remounts', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
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

        await dispatch_host_message(
            transform_installed_message(request, { generation: 2 }),
        );
        await vi.waitUntil(() => grid_shell_mock.focus_grid.mock.calls.length > 0);
        expect(grid_shell_mock.focus_grid).toHaveBeenCalledOnce();
    });

    it('restores grid focus when a grid transform fails without a generation bump', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
        post_message.mockClear();
        const previous_mount = grid_stub().getAttribute('data-mount-id');
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        const request = post_message.mock.calls.map((call) => call[0])
            .find((message) => message.type === 'setTransform');

        await dispatch_host_message({
            type: 'transformRefused',
            sheetIndex: 0,
            requestId: request.requestId,
            intent: request.intent,
            reason: 'failed',
            terminal: true,
        });
        await vi.waitUntil(() => grid_shell_mock.focus_grid.mock.calls.length > 0);

        expect(grid_stub().getAttribute('data-mount-id')).toBe(previous_mount);
        expect(grid_shell_mock.focus_grid).toHaveBeenCalledOnce();
    });

    it('restores filter focus only for Escape and explicit Cancel', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
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
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
            state: { transforms: [{ sort: [], filters: [filter], schema }] },
        }));
        const restore = post_message.mock.calls.map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        await dispatch_host_message(
            transform_installed_message(restore, { generation: 2 }),
        );
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

        await dispatch_host_message(
            transform_installed_message(request, { generation: 3 }),
        );
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

    it('removes an applied filter from the popover Remove button', async () => {
        const { post_message } = await render_app();
        const schema = '["Sheet1",1,null]';
        await load_acknowledged_transform(post_message, {
            sort: [],
            filters: [{
                id: 'drop-me', colIndex: 0, operator: 'equals', value: 'x',
                caseSensitive: false, enabled: true,
            }],
            schema,
        });
        // Open the editor for the already-applied filter via its chip.
        await act(async () => (
            document.querySelector('.filter-chip-body') as HTMLButtonElement
        ).click());
        expect(document.querySelector('.filter-popover')).not.toBeNull();

        post_message.mockClear();
        await act(async () => get_button('Remove').click());
        const request = latest_transform_request(post_message);
        expect(request.state.filters).toEqual([]);
        await acknowledge_transform(request, 3);
        expect(document.querySelector('.filter-popover')).toBeNull();
        expect(document.querySelector('.filter-strip')).toBeNull();
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
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
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
        await dispatch_host_message(initial_snapshot_message(meta, {
            state: {
                transforms: [{
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    schema: '["Sheet1",1,null]',
                }],
            },
        }));

        // The merges standing unflattened *are* "nothing is applied yet": flattening is
        // the one thing an installed permutation still changes about the rendered grid.
        expect(grid_stub().getAttribute('data-merges')).toBe('1');
        expect(JSON.parse(grid_stub().getAttribute('data-merges-json')!)).toEqual(
            meta.sheets[0].merges,
        );
        const request = post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        expect(request).toBeDefined();

        post_message.mockClear();
        await dispatch_host_message(
            transform_installed_message(request, { generation: 2, rowCount: 2 }),
        );
        expect(grid_stub().getAttribute('data-merges')).toBe('0');
        expect(post_message.mock.calls
            .map((call) => call[0])
            .some((message) => message.type === 'stateChanged')).toBe(false);
    });

    it('lets the user cancel a pending saved transform and forgets it', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
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

        await dispatch_host_message(
            transform_installed_message(cancel_request, { generation: 2 }),
        );
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
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
            },
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

        await dispatch_host_message(
            transform_installed_message(request, { generation: 2, rowCount: 2 }),
        );
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
        await dispatch_host_message(transform_installed_message(
            disable_request,
            { generation: 3, rowCount: 3 },
        ));
        expect(document.body.textContent).toContain('✗');
        expect(grid_stub().getAttribute('data-merges')).toBe('1');

        post_message.mockClear();
        await act(async () => (
            document.querySelector('.filter-chip-kebab') as HTMLButtonElement
        ).click());
        await click_button('Enable');
        const enable_request = post_message.mock.calls
            .map((call) => call[0])
            .find((message) => message.type === 'setTransform');
        await dispatch_host_message(transform_installed_message(
            enable_request,
            { generation: 4, rowCount: 2 },
        ));
        expect(grid_stub().getAttribute('data-merges')).toBe('0');

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

        await dispatch_host_message(transform_installed_message(
            clear_request,
            { generation: 5, rowCount: 3 },
        ));
        expect(grid_stub().getAttribute('data-merges')).toBe('1');
        expect(JSON.parse(grid_stub().getAttribute('data-merges-json')!)).toEqual(
            meta.sheets[0].merges,
        );
        expect(get_button('Edit').disabled).toBe(false);
    });

    it('does not restore an old filter opener when outside-clicking into another popover', async () => {
        await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'])));
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
            initial_snapshot_message(make_meta(['Sheet1']), { configuration: { previewMode: true } }),
        );
        expect(grid_shell_mock.latest_props?.transform_sections).toBe(false);
    });
});

// The dirty map now lives in a store App owns, so an install reaches the grid
// without a remount and survives one. `data-store-edits` is the mounted grid's
// subscribed view of that store, which is what the real hook reads.
describe('edit session store hydration', () => {
    function store_edits() {
        return JSON.parse(grid_stub().getAttribute('data-store-edits')!);
    }

    it('installs a changed map into the mounted grid without remounting it', async () => {
        // Entering edit mode redelivers the projection at the same generation, so
        // nothing about the key moves. Before the store this install could only
        // reach the grid as a prop that a mounted hook ignored.
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: { csvEditable: true, csvEditingSupported: true },
        }));
        await enter_edit_mode(post_message);
        const mount_id = grid_stub().getAttribute('data-mount-id');
        const generation = grid_stub().getAttribute('data-generation');

        const pendingEdits = { '0:0': { value: 'refreshed', base: 'base' } };
        await dispatch_host_message(refresh_snapshot_message(meta, {
            generation: 1,
            sourceGeneration: 1,
            state: { pendingEdits: sheet_edits(pendingEdits) },
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'test-edit-session',
            },
        }));

        expect(store_edits()).toEqual(pendingEdits);
        expect(grid_stub().getAttribute('data-mount-id')).toBe(mount_id);
        expect(grid_stub().getAttribute('data-generation')).toBe(generation);
    });

    it('does not fold the open editor for a refresh that remounts nothing', async () => {
        // The same rule round 4 applied to the transform ack, on the path that
        // delivers far more of these: the fold exists because a remount destroys the
        // grid that owns the overlay, so the discriminator is whether this snapshot
        // actually remounts. GridShell is keyed on the generation, and a same-basis
        // refresh leaves it exactly where it was — every edit commit during an owned
        // session provokes one, as does any sibling panel touching durable state. The
        // user has a cell open and half-typed when it lands; folding would commit that
        // value into the dirty store, where Escape can no longer take it back.
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: { csvEditable: true, csvEditingSupported: true },
        }));
        await enter_edit_mode(post_message);
        grid_shell_mock.commit_live_edit.mockImplementation(() => {
            (grid_shell_mock.latest_props?.edit_session as EditSessionStore)
                .commit('test-edit-session', '0:0', { value: 'half-typed', base: 'base' });
        });
        const mount_id = grid_stub().getAttribute('data-mount-id');

        await dispatch_host_message(refresh_snapshot_message(meta, {
            generation: 1,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'test-edit-session',
            },
        }));

        // Nothing remounted, so the overlay is still on screen and still the user's to
        // confirm or abandon.
        expect(grid_stub().getAttribute('data-mount-id')).toBe(mount_id);
        expect(grid_shell_mock.commit_live_edit).not.toHaveBeenCalled();
        expect(store_edits()).toEqual({});
    });

    it('keeps a committed edit across a refresh that bumps the generation', async () => {
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: { csvEditable: true, csvEditingSupported: true },
        }));
        await enter_edit_mode(post_message);
        // A committed edit, the way the grid's own hook writes one. It exists only
        // in the registry store that the remounted grid receives.
        await act(async () => {
            (grid_shell_mock.latest_props?.edit_session as EditSessionStore)
                .commit('test-edit-session', '0:0', { value: 'committed', base: 'base' });
        });
        const mount_id = grid_stub().getAttribute('data-mount-id');

        // A refresh for a session App does not consider current, so nothing
        // installs and the generation bump remounts the grid.
        await dispatch_host_message(refresh_snapshot_message(meta, {
            generation: 3,
            sourceGeneration: 3,
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'other-session',
            },
        }));

        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(mount_id);
        expect(store_edits()).toEqual({ '0:0': { value: 'committed', base: 'base' } });
        expect(JSON.parse(grid_stub().getAttribute('data-store-edits')!)).toEqual({
            '0:0': { value: 'committed', base: 'base' },
        });
    });

    it('accepts a commit after a refresh re-stamps the session without installing', async () => {
        // set_csv_edit_session_id runs on every applied snapshot, but the install is
        // gated on refresh_editing_current_session. When the id moves and nothing
        // installs, the store keeps the old stamp while the hook now passes the new
        // id — every later write would be dropped by the ownership guard. App's
        // adopt_session effect closes that gap.
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: { csvEditable: true, csvEditingSupported: true },
        }));
        await enter_edit_mode(post_message);
        await dispatch_host_message(refresh_snapshot_message(meta, {
            generation: 3,
            sourceGeneration: 3,
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'rotated-session',
            },
        }));

        const store = grid_shell_mock.latest_props?.edit_session as EditSessionStore;
        expect(store.identity()).toEqual({ session_id: 'rotated-session' });
        await act(async () => {
            store.commit('rotated-session', '0:0', { value: 'typed after rotation', base: 'base' });
        });

        expect(store_edits()).toEqual({
            '0:0': { value: 'typed after rotation', base: 'base' },
        });
    });

    it('re-stamps the session before the grid effects that write under it', async () => {
        // React runs child passive effects before the parent's, so if App adopted
        // the rotated session in a passive effect, GridShell's own session-keyed
        // effects would already have written under the new id against a store
        // still stamped with the old one — and the ownership guard would drop them
        // silently. The host ships csvEditSessionId and csvSaveLifecycle in a
        // single snapshot, so that window is reachable. Adopting in a layout
        // effect closes it: a parent layout effect precedes every child passive
        // effect.
        grid_shell_mock.write_on_session_change = true;
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: { csvEditable: true, csvEditingSupported: true },
        }));
        await enter_edit_mode(post_message);

        await dispatch_host_message(refresh_snapshot_message(meta, {
            generation: 3,
            sourceGeneration: 3,
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'rotated-session',
            },
        }));

        // Both writes must be present: the first proves the harness writes at all,
        // the second is the one a lagging stamp would have fenced off.
        expect(Object.keys(store_edits()).sort()).toEqual([
            'session:rotated-session',
            'session:test-edit-session',
        ]);
    });

    it('keeps the shell save-lifecycle restore effective after a remount flips listener order', async () => {
        // GridShell registers its own `message` listener in a passive effect, so on
        // the first mount it sits ahead of App's and fires first. A generation bump
        // remounts it, re-registering it *after* App's — from then on App installs
        // and re-stamps first, and the shell's replace_dirty arrives at an
        // already-restamped store carrying the session id from its own render.
        // Pre-refactor there was no fence and that write always landed, so this
        // pins that the fence did not turn an order flip into a dropped restore.
        grid_shell_mock.listen_for_save_result = true;
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: { csvEditable: true, csvEditingSupported: true },
        }));
        await enter_edit_mode(post_message);

        // Bump the generation so the shell's listener is re-registered last.
        // No requestId, matching the undefined pending id, so the guard admits it:
        // what this needs is the generation bump, not a particular request.
        await dispatch_host_message({
            type: 'transformInstalled',
            sheetIndex: 0,
            intent: 'user',
            view: {
                basis: { generation: 5, sourceGeneration: 1, schema: '["Sheet1",1,null]' },
                rules: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
                rowCount: 1,
                permuted: true,
                hiddenEditedCellKeys: [],
            },
            rules: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        });

        await dispatch_host_message({ type: 'saveResult', success: true });

        // The shell's restore must not have been silently fenced off.
        expect(Object.keys(store_edits())).toContain('restored:by:shell');
    });

    it('folds the open editor into the store before a refresh remount', async () => {
        // The refresh branch has its own fold, and this is the case that needs it:
        // the session moved, so nothing installs, and the open overlay's value has
        // no other way across the generation bump.
        const { post_message } = await render_app();
        const meta = make_meta(['Sheet1'], false);
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: { csvEditable: true, csvEditingSupported: true },
        }));
        await enter_edit_mode(post_message);
        grid_shell_mock.commit_live_edit.mockImplementation(() => {
            (grid_shell_mock.latest_props?.edit_session as EditSessionStore)
                .commit('test-edit-session', '0:0', { value: 'live', base: 'base' });
        });
        const mount_id = grid_stub().getAttribute('data-mount-id');

        await dispatch_host_message(refresh_snapshot_message(meta, {
            generation: 3,
            sourceGeneration: 3,
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'other-session',
            },
        }));

        expect(grid_shell_mock.commit_live_edit).toHaveBeenCalledTimes(1);
        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(mount_id);
        expect(store_edits()).toEqual({ '0:0': { value: 'live', base: 'base' } });
    });

    it('folds the open editor into the store before a transform remount', async () => {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1'], false), {
            capabilities: { csvEditable: true, csvEditingSupported: true },
        }));
        await enter_edit_mode(post_message);
        // Stand in for the real overlay fold: the value only reaches the next mount
        // if the write happens before the generation bump destroys this one.
        grid_shell_mock.commit_live_edit.mockImplementation(() => {
            (grid_shell_mock.latest_props?.edit_session as EditSessionStore)
                .commit('test-edit-session', '0:0', { value: 'live', base: 'base' });
        });
        const mount_id = grid_stub().getAttribute('data-mount-id');

        // No requestId, matching the undefined pending id, so the guard admits it:
        // what this needs is the generation bump, not a particular request.
        await dispatch_host_message({
            type: 'transformInstalled',
            sheetIndex: 0,
            intent: 'user',
            view: {
                basis: { generation: 5, sourceGeneration: 1, schema: '["Sheet1",1,null]' },
                rules: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
                rowCount: 1,
                permuted: true,
                hiddenEditedCellKeys: [],
            },
            rules: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [] },
        });

        expect(grid_shell_mock.commit_live_edit).toHaveBeenCalledTimes(1);
        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(mount_id);
        expect(store_edits()).toEqual({ '0:0': { value: 'live', base: 'base' } });
    });
});

// Sorting and filtering stay available while the user edits; the displayed order
// simply does not recompute, which is the feature. What still blocks a transform is
// a window in which the host would refuse it anyway.
describe('transforms during an edit session', () => {
    const CSV_CAPABILITIES = {
        csvEditable: true,
        csvEditingSupported: true,
    };

    async function editable_csv() {
        const rendered = await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            { capabilities: CSV_CAPABILITIES },
        ));
        return rendered;
    }

    function sort_chip_disabled(): string | null {
        const chip = document.querySelector('.sort-chip');
        expect(chip).not.toBeNull();
        return chip!.getAttribute('aria-disabled');
    }

    /** Enter edit mode, then install a sort on column 0 from inside it. */
    async function edit_mode_with_sort(post_message: ReturnType<typeof vi.fn>) {
        await enter_edit_mode(post_message);
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        const request = latest_transform_request(post_message);
        await acknowledge_transform(request, 2);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        // The ack landed rather than being dropped by the requestId guard: only an
        // install moves the generation, and the rules it carried describe a permutation.
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
    }

    it('keeps transform controls enabled in edit mode and lets a sort through', async () => {
        const { post_message } = await editable_csv();
        await enter_edit_mode(post_message);
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(grid_shell_mock.latest_props?.transform_sections).toBe(true);

        post_message.mockClear();
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        // Not merely offered — the request actually leaves the webview.
        const request = latest_transform_request(post_message);
        expect(request.state.sort).toEqual([{ colIndex: 0, direction: 'asc' }]);
        // And it lands: the toolbar's own copy of the gate agrees, showing the
        // installed sort's chip live rather than greyed out.
        await acknowledge_transform(request, 2);
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(sort_chip_disabled()).toBeNull();
    });

    it('disables transform controls only while a save is in flight', async () => {
        const { post_message } = await editable_csv();
        await edit_mode_with_sort(post_message);
        expect(grid_shell_mock.latest_props?.transform_sections).toBe(true);
        expect(sort_chip_disabled()).toBeNull();

        await report_grid_editing(true, true, [], undefined, true);
        expect(grid_shell_mock.latest_props?.transform_sections).toBe(false);
        expect(sort_chip_disabled()).toBe('true');

        // The re-enable is the half that stops this passing for the wrong reason:
        // without it, a permanently disabled control would satisfy the assertion
        // above just as well.
        await report_grid_editing(true, true, [], undefined, false);
        expect(grid_shell_mock.latest_props?.transform_sections).toBe(true);
        expect(sort_chip_disabled()).toBeNull();
    });

    it('does not reset column visibility when an edit session is granted', async () => {
        // The grant used to bump `load_epoch`, which feeds `visibility_reset_key`
        // and closes the popover. An open popover is the observable form of that.
        const { post_message } = await editable_csv();
        await open_columns();

        await click_button('Edit');
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestEditSession',
        }));
        await dispatch_host_message({
            type: 'editSessionResult',
            granted: true,
            editSessionId: 'granted-session',
        });

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(document.querySelector(
            '[role="dialog"][aria-label="Choose visible columns"]',
        )).not.toBeNull();
    });

    it('restores a stored transform during an edit session', async () => {
        // `edit_mode` is no longer a dep of the restore effect, so a refresh that
        // ships a persisted transform has to reinstall it even mid-session.
        const { post_message } = await editable_csv();
        await enter_edit_mode(post_message);
        post_message.mockClear();

        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                capabilities: {
                    ...CSV_CAPABILITIES,
                    csvEditSessionId: 'test-edit-session',
                },
                state: {
                    transforms: [{
                        sort: [{ colIndex: 0, direction: 'desc' }],
                        filters: [],
                        schema: '["Sheet1",1,null]',
                    }],
                },
            },
        ));

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(latest_transform_request(post_message).state.sort)
            .toEqual([{ colIndex: 0, direction: 'desc' }]);
    });
});

// A transform admitted during an owned edit session can be in flight for seconds
// while the host keeps redelivering the projection — every committed edit provokes
// one. Those redeliveries change nothing about the rows, so they must not discard
// the request whose requestId is the only thing the eventual ack can match on.
describe('snapshots arriving during an in-flight transform', () => {
    const CSV_CAPABILITIES = {
        csvEditable: true,
        csvEditingSupported: true,
        csvEditSessionId: 'test-edit-session',
    };

    /** Edit mode over an editable CSV with a user-initiated grid sort outstanding. */
    async function sorting_while_editing() {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            { capabilities: { csvEditable: true, csvEditingSupported: true } },
        ));
        await enter_edit_mode(post_message);
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        const request = latest_transform_request(post_message);
        expect(grid_shell_mock.latest_props?.transform_pending).toBe(true);
        expect(grid_stub().getAttribute('data-generation')).toBe('1');
        return { post_message, request };
    }

    it('still honours the ack after a same-generation refresh', async () => {
        const { request } = await sorting_while_editing();

        // What committing an edit provokes: the host writes the pending edits and
        // re-projects capabilities, so a 'refresh' arrives on the same source and the
        // same view generation. The transform is still running behind it.
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                generation: 1,
                sourceGeneration: 1,
                reason: 'other',
                capabilities: CSV_CAPABILITIES,
            },
        ));
        expect(grid_stub().getAttribute('data-generation')).toBe('1');
        // The work is still outstanding, so the progress affordance must not clear.
        expect(grid_shell_mock.latest_props?.transform_pending).toBe(true);

        await acknowledge_transform(request, 7);

        // The ack is matched, not dropped: the generation advances to the host's and
        // the sort installs. Were the requestId discarded above, the webview would
        // sit on generation 1 and the host would refuse every row request after.
        expect(grid_stub().getAttribute('data-generation')).toBe('7');
        expect(grid_shell_mock.latest_props?.transform_pending).toBe(false);
    });

    it('loses no edit across commits interleaved with a compute that lands last', async () => {
        // The whole sequence the feature makes reachable: type and commit, keep
        // typing while the sort is still computing, then let it land. Each commit
        // provokes a same-basis refresh, and the landing bumps the generation and
        // remounts the grid that owns the open overlay — three separate ways an edit
        // could be dropped, exercised in one order.
        const { request } = await sorting_while_editing();
        const store = () => grid_shell_mock.latest_props?.edit_session as EditSessionStore;
        const store_edits = () => JSON.parse(grid_stub().getAttribute('data-store-edits')!);

        await act(async () => {
            store().commit('test-edit-session', '0:0', { value: 'first', base: 'a' });
        });
        // The refresh that commit provokes: same rows, same generation, and the
        // host's authoritative projection of what it has just written.
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                generation: 1,
                sourceGeneration: 1,
                reason: 'other',
                capabilities: CSV_CAPABILITIES,
                state: { pendingEdits: sheet_edits({ '0:0': { value: 'first', base: 'a' } }) },
            },
        ));
        // A second confirmed edit, typed while the compute is still outstanding.
        await act(async () => {
            store().commit('test-edit-session', '2:0', { value: 'second', base: 'c' });
        });
        // And a third cell still open in the editor when the ack arrives, which only
        // the fold can carry across the remount.
        grid_shell_mock.commit_live_edit.mockImplementation(() => {
            store().commit('test-edit-session', '1:0', { value: 'live', base: 'b' });
        });
        const mount_id = grid_stub().getAttribute('data-mount-id');

        await acknowledge_transform(request, 7);

        // The remount really happened, so the survival below is not vacuous.
        expect(grid_stub().getAttribute('data-mount-id')).not.toBe(mount_id);
        expect(grid_shell_mock.commit_live_edit).toHaveBeenCalledTimes(1);
        // All three, under the source-row keys they were typed against. Display row 0
        // under this sort is not source row 0, so a display-keyed map would name
        // different cells here.
        expect(store_edits()).toEqual({
            '0:0': { value: 'first', base: 'a' },
            '1:0': { value: 'live', base: 'b' },
            '2:0': { value: 'second', base: 'c' },
        });
    });

    it('discards the in-flight transform when the source moves', async () => {
        const { request } = await sorting_while_editing();

        // A reload replaces the rows the transform was being computed over, so the
        // request is genuinely void and its ack must not be allowed to land.
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            { capabilities: CSV_CAPABILITIES },
        ));
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
        expect(grid_shell_mock.latest_props?.transform_pending).toBe(false);

        await acknowledge_transform(request, 7);

        // Still on the reload's generation, so the ack never landed. That is the whole
        // of it: nothing else the install carries could have been adopted either.
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
    });
});

// The rows a same-basis refresh delivers are the rows already on screen: the host
// installed nothing and dropped nothing, so an *applied* transform is still applied
// behind it. Every edit commit during an owned session provokes one of these, and
// dropping the record while the loader is still permuted would give the grid a natural
// row count over permuted rows, and un-flatten merges the permutation has flattened.
describe('an applied transform across a refresh', () => {
    const STORED_SORT: SheetTransformState = {
        sort: [{ colIndex: 0, direction: 'desc' }],
        filters: [],
        schema: '["Sheet1",1,null]',
    };
    // The same sheet sorted the other way, as a sibling panel would leave it.
    const SIBLING_SORT: SheetTransformState = {
        sort: [{ colIndex: 0, direction: 'asc' }],
        filters: [],
        schema: '["Sheet1",1,null]',
    };
    const CSV_CAPABILITIES = {
        csvEditable: true,
        csvEditingSupported: true,
        csvEditSessionId: 'test-edit-session',
    };
    // Inactive but not empty: `transform_is_active` is false, yet the definition is
    // still the user's and must survive the uninstall.
    const DISABLED_FILTER_ONLY: SheetTransformState = {
        sort: [],
        filters: [{
            id: 'f1',
            colIndex: 0,
            operator: 'contains',
            value: 'x',
            caseSensitive: false,
            enabled: false,
        }],
        schema: '["Sheet1",1,null]',
    };
    // The other durable shape `transform_is_active` counts, hidden by a sibling.
    const STORED_HIDDEN_ROWS: SheetTransformState = {
        sort: [],
        filters: [],
        hiddenRows: [1, 3],
        schema: '["Sheet1",1,null]',
    };
    // A row height the user set, and a natural count the transformed count can be
    // told apart from — with make_meta's rowCount of 1 the reset is invisible. The
    // durable entry is keyed by canonical *source* row 2; what the grid renders is the
    // host's projection of it, which under the sort below lands at display row 1.
    //
    // Which is why the durable map is *not* in `STORED_STATE`: `rowHeights` is `Omit`ted
    // from `NormalizedPerFileState`, so no delivery can carry it, and a leaf here would
    // reach nothing while implying the opposite. The heights in this suite arrive the two
    // ways they really do — an install's `rowHeights` and a snapshot's
    // `rowHeightProjection`, both display-keyed and both `PROJECTED_HEIGHTS`.
    const STORED_STATE = { transforms: [STORED_SORT] };
    const PROJECTED_HEIGHTS = { 1: 44 };
    const FILTERED_ROW_COUNT = 3;

    function transform_requests(post_message: ReturnType<typeof vi.fn>) {
        return post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'setTransform');
    }

    /**
     * A sheet with a merge in it, because merge flattening is what an installed
     * permutation still *does* to the rendered grid. Nothing else about the view records
     * below is visible in the shell's own props: heights arrive already projected into
     * display space and the row count is carried on both arms of the record, so
     * `data-merges` is the observable that distinguishes a permuted record from a natural
     * one. One merge is enough — the assertions read its count, not its geometry.
     */
    function sized_meta(row_count: number): WorkbookMeta {
        const meta = make_meta(['Sheet1'], false);
        return {
            ...meta,
            sheets: meta.sheets.map((sheet) => ({
                ...sheet,
                rowCount: row_count,
                sourceRowCount: row_count,
                merges: [{ startRow: 0, startCol: 0, endRow: 1, endCol: 0 }],
            })),
        };
    }

    function five_row_meta(): WorkbookMeta {
        return sized_meta(5);
    }

    /** An owned edit session over a CSV whose stored sort is installed and applied. */
    async function editing_with_an_applied_sort() {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(five_row_meta(), {
            capabilities: CSV_CAPABILITIES,
            state: STORED_STATE,
        }));
        const restore = latest_transform_request(post_message);
        expect(restore.intent).toBe('restore');
        await dispatch_host_message(transform_installed_message(
            restore,
            {
                generation: 2,
                rowCount: FILTERED_ROW_COUNT,
                // An install carries the projection for the permutation it installs, and
                // has to: it bumps the generation and posts no snapshot.
                rowHeights: PROJECTED_HEIGHTS,
            },
        ));
        // The snapshot already names a session this panel owns, so it opens in edit
        // mode — the state in which every commit provokes a same-basis refresh.
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        expect(grid_stub().getAttribute('data-merges')).toBe('0');
        expect(grid_stub().getAttribute('data-row-count'))
            .toBe(String(FILTERED_ROW_COUNT));
        return { post_message };
    }

    it('keeps it applied across a same-basis refresh', async () => {
        await editing_with_an_applied_sort();

        // What committing an edit provokes: pending edits written, capabilities
        // re-projected, a 'refresh' on the same source and the same view generation.
        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: STORED_STATE,
        }));

        // Asserted here, before any restore echo: the window this closes is exactly
        // the one between the refresh and the echo. A filtered view must not flash
        // its natural row count, and the sort must not read as uninstalled — which on
        // screen means its merges must not spring back unflattened.
        expect(grid_stub().getAttribute('data-merges')).toBe('0');
        expect(grid_stub().getAttribute('data-row-count'))
            .toBe(String(FILTERED_ROW_COUNT));
    });

    it('keeps custom row heights across a same-basis refresh', async () => {
        await editing_with_an_applied_sort();
        // Heights are no longer suppressed under a transform. What the grid gets is the
        // install's own projection — display row 1, from durable source row 2 — so the
        // resize overlay stays mounted and hover stays armed over permuted rows.
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!))
            .toEqual(PROJECTED_HEIGHTS);

        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: STORED_STATE,
            // The permutation is unchanged, so the host re-projects onto the same display
            // rows. Named explicitly because the projection is adopted from every
            // delivery: a refresh that carried none would (correctly) mean no heights.
            rowHeightProjection: [PROJECTED_HEIGHTS],
        }));

        // Still the permuted record, so the heights below are the projection *of that
        // permutation* rather than of a natural view that happens to agree.
        expect(grid_stub().getAttribute('data-merges')).toBe('0');
        expect(JSON.parse(grid_stub().getAttribute('data-row-heights')!))
            .toEqual(PROJECTED_HEIGHTS);
    });

    it('still asks for a durable transform a sibling panel changed', async () => {
        const { post_message } = await editing_with_an_applied_sort();
        post_message.mockClear();
        // Settle first, on the state this panel already has: a refresh that changes
        // no durable rule asks for nothing at all (see 'does not ask to uninstall
        // rules that are still active'), so the ask below can only have come from
        // the sibling's change, not from the refresh itself.
        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: STORED_STATE,
        }));
        expect(transform_requests(post_message)).toHaveLength(0);

        // Durable transform state is shared between panels, and a sibling changing it
        // arrives here as a refresh on an unchanged row basis and nothing else. So
        // "preserve the applied transform across a same-basis refresh" must not extend
        // to treating the source as handled: the ask has to still go out.
        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: { ...STORED_STATE, transforms: [SIBLING_SORT] },
        }));

        await vi.waitUntil(() => post_message.mock.calls
            .some((call) => (call[0] as WebviewMessage).type === 'setTransform'));
        expect(latest_transform_request(post_message).state.sort)
            .toEqual(SIBLING_SORT.sort);
    });

    it('does not ask to uninstall rules that are still active', async () => {
        const { post_message } = await editing_with_an_applied_sort();
        post_message.mockClear();

        // Unchanged durable state, unchanged row basis: round 3's retention holds, so
        // the durable rules and the installed permutation already agree.
        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: STORED_STATE,
        }));

        // No ask in either direction. The uninstall is the failure this test was
        // written for — it would un-sort a view nobody asked to un-sort, which is what
        // a reconciliation reading "inactive" from anything but the durable rules would
        // produce — and an install is no better: every edit commit lands one of these
        // refreshes, and re-asking for the transform already installed spends a host
        // round-trip per keystroke whose acknowledgement discards this panel's auto-fit
        // (see 'keeps auto-fit across a commit that changes no durable rule').
        // A request would be posted synchronously inside the dispatch above, so its
        // absence is already observable here.
        expect(transform_requests(post_message)).toHaveLength(0);
        expect(grid_stub().getAttribute('data-merges')).toBe('0');
        expect(grid_stub().getAttribute('data-row-count'))
            .toBe(String(FILTERED_ROW_COUNT));
    });

    /**
     * The same owned session with Auto-fit on over the applied sort. Column widths are
     * part of the fixture because the toggle's snapshot is only observable through
     * them: deactivating restores the pre-fit widths instead of re-measuring.
     */
    async function editing_with_auto_fit_over_a_sort() {
        grid_shell_mock.auto_fit_result = { 0: 200 };
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(five_row_meta(), {
            capabilities: CSV_CAPABILITIES,
            state: { ...STORED_STATE, columnWidths: [{ 0: 80 }] },
        }));
        const restore = latest_transform_request(post_message);
        await dispatch_host_message(transform_installed_message(
            restore,
            { generation: 2, rowCount: FILTERED_ROW_COUNT },
        ));
        expect(grid_stub().getAttribute('data-merges')).toBe('0');

        await click_button('Auto-fit Columns');
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!))
            .toEqual({ 0: 200 });
        post_message.mockClear();
        return { post_message };
    }

    it('keeps auto-fit across a commit that changes no durable rule', async () => {
        const { post_message } = await editing_with_auto_fit_over_a_sort();

        // What committing a cell during an owned session provokes: pending edits
        // written, capabilities re-projected, a refresh on the same source and view
        // generation, carrying the fitted widths this panel already persisted.
        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: { ...STORED_STATE, columnWidths: [{ 0: 200 }] },
        }));

        // The host answers whatever it is asked, and that is the whole hazard: an equal
        // restore intent is short-circuited at the same generation and row count, yet
        // the acknowledgement alone discards auto-fit. So answer anything asked here
        // rather than presupposing that nothing was.
        for (const request of transform_requests(post_message)) {
            await dispatch_host_message(transform_installed_message(
                request,
                { generation: 2, rowCount: FILTERED_ROW_COUNT },
            ));
        }

        // Nothing about the rows moved, so nothing justifies dropping the fit.
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);
        // And the snapshot survived with it: deactivating restores the pre-fit widths,
        // which is only possible while the snapshot is still held.
        await click_button('Auto-fit Columns');
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!))
            .toEqual({ 0: 80 });
        // The assertion that pins the fix rather than its symptom: the commit asked the
        // host for nothing, so no acknowledgement could have harmed anything at all.
        expect(transform_requests(post_message)).toHaveLength(0);
    });

    it('still clears auto-fit when a sibling transform installs', async () => {
        const { post_message } = await editing_with_auto_fit_over_a_sort();

        // A sibling changed the durable sort, so this reconciliation is real work and
        // the ask has to go out.
        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: {
                ...STORED_STATE,
                transforms: [SIBLING_SORT],
                columnWidths: [{ 0: 200 }],
            },
        }));
        const install = latest_transform_request(post_message);
        expect(install.state.sort).toEqual(SIBLING_SORT.sort);
        // The refresh itself keeps the fit — the widths it reinstalls are the fitted
        // ones — so whatever clears it below is the acknowledgement's doing.
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(true);

        await dispatch_host_message(
            transform_installed_message(install, { generation: 3, rowCount: 4 }),
        );

        // A different sort re-populates the rows auto-fit sampled, so the measurement
        // behind the toggle is stale: the toggle goes off and the snapshot with it.
        expect(get_button('Auto-fit Columns').classList.contains('active')).toBe(false);
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!))
            .toEqual({ 0: 200 });
        // Proof the snapshot went too: one click measures afresh instead of restoring
        // the pre-fit 80.
        grid_shell_mock.auto_fit_result = { 0: 300 };
        await click_button('Auto-fit Columns');
        expect(JSON.parse(grid_stub().getAttribute('data-col-widths')!))
            .toEqual({ 0: 300 });
    });

    it('uninstalls it when a sibling clears the durable sort', async () => {
        const { post_message } = await editing_with_an_applied_sort();
        post_message.mockClear();

        // A sibling panel cleared the shared sort. That never un-installs *our*
        // permutation, and it arrives as a same-basis refresh — the one shape that
        // deliberately keeps `applied_transforms`. Without an uninstall the rows stay
        // sorted behind a toolbar that shows no rules.
        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: { ...STORED_STATE, transforms: [undefined] },
        }));

        // The ask itself, not merely a state change: only the host can un-permute the
        // loader, so nothing is fixed unless the empty view is actually requested.
        await vi.waitUntil(() => transform_requests(post_message).length > 0);
        const uninstall = latest_transform_request(post_message);
        expect(uninstall.state.sort).toEqual([]);
        expect(uninstall.state.filters).toEqual([]);
        expect(uninstall.state.hiddenRows ?? []).toEqual([]);

        await dispatch_host_message(
            transform_installed_message(uninstall, { generation: 3, rowCount: 5 }),
        );

        // And the grid agrees with the toolbar again: natural order, natural count, and
        // the sheet's merges back the way the file has them.
        expect(grid_stub().getAttribute('data-merges')).toBe('1');
        expect(grid_stub().getAttribute('data-row-count')).toBe('5');
    });

    it('keeps a disabled filter while uninstalling the sort around it', async () => {
        const { post_message } = await editing_with_an_applied_sort();
        post_message.mockClear();

        // A sibling dropped the sort and switched its filter off. The rules are now
        // inactive, so the permutation has to go — but the filter definition is still
        // the user's, one click from being re-enabled. Asking with a bare empty state
        // would make the host record "no transform" and delete it.
        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: { ...STORED_STATE, transforms: [DISABLED_FILTER_ONLY] },
        }));

        await vi.waitUntil(() => transform_requests(post_message).length > 0);
        const uninstall = latest_transform_request(post_message);
        expect(uninstall.state.sort).toEqual([]);
        expect(uninstall.state.filters).toEqual(DISABLED_FILTER_ONLY.filters);
    });

    it('uninstalls hidden rows a sibling unhid', async () => {
        // Hidden rows travel the same durable path but are a different shape, so the
        // empty view has to clear them too rather than only sorts and filters.
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(five_row_meta(), {
            capabilities: CSV_CAPABILITIES,
            state: { transforms: [STORED_HIDDEN_ROWS] },
        }));
        const restore = latest_transform_request(post_message);
        expect(restore.state.hiddenRows).toEqual(STORED_HIDDEN_ROWS.hiddenRows);
        await dispatch_host_message(
            transform_installed_message(restore, { generation: 2, rowCount: 3 }),
        );
        expect(grid_stub().getAttribute('data-merges')).toBe('0');
        expect(grid_stub().getAttribute('data-row-count')).toBe('3');
        post_message.mockClear();

        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: { transforms: [undefined] },
        }));

        await vi.waitUntil(() => transform_requests(post_message).length > 0);
        const uninstall = latest_transform_request(post_message);
        expect(uninstall.state.hiddenRows ?? []).toEqual([]);
        await dispatch_host_message(
            transform_installed_message(uninstall, { generation: 3, rowCount: 5 }),
        );

        expect(grid_stub().getAttribute('data-merges')).toBe('1');
        expect(grid_stub().getAttribute('data-row-count')).toBe('5');
    });

    it('drops it when the refresh changes the row basis', async () => {
        await editing_with_an_applied_sort();

        // A reload: the host drops permutations because matching schema does not
        // imply matching values, so the applied transform and the transformed count
        // both have to revert until a fresh restore lands.
        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            capabilities: CSV_CAPABILITIES,
            state: STORED_STATE,
            // No permutation left to project through, so the host's projection of durable
            // source row 2 is display row 2.
            rowHeightProjection: [{ 2: 44 }],
        }));

        expect(grid_stub().getAttribute('data-merges')).toBe('1');
        expect(grid_stub().getAttribute('data-row-count')).toBe('5');
        // And the height follows the rows: same durable entry, a display key that moved
        // with the permutation being dropped.
        expect(grid_stub().getAttribute('data-row-heights')).toBe('{"2":44}');
    });

    /**
     * Everything a snapshot can invalidate about the installed view, read together.
     * Three separately-stored atoms used to hold these, and three review findings on
     * this PR were a snapshot moving some and not the others; asserted as one object
     * so no future change can move one of them past this test. `asks_again` is the
     * third: it stands for the fact that an install has landed against these rows,
     * which the restore effect answers by comparing the durable rules against the
     * record's own.
     *
     * `merges` is how the *permutation* half is read. `SheetViewRecord.permuted` reaches
     * the rendered grid through exactly one thing now — merge flattening — so that is
     * what a test about it asserts; the shell is no longer told whether its rows are
     * permuted, because nothing in it needs to know (see `GridShellProps.row_count`).
     * `'0'` is the permuted reading, `'1'` the natural one.
     */
    function view_state(post_message: ReturnType<typeof vi.fn>) {
        return {
            merges: grid_stub().getAttribute('data-merges'),
            row_count: grid_stub().getAttribute('data-row-count'),
            asks_again: transform_requests(post_message).length > 0,
        };
    }

    it('keeps every part of the record across a same-basis refresh', async () => {
        const { post_message } = await editing_with_an_applied_sort();
        post_message.mockClear();

        // What committing an edit provokes: same source, same view generation, the
        // rows already on screen.
        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            generation: 2,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: STORED_STATE,
        }));

        // The permutation, the row count and the landed install stand or fall
        // together, because they are one value with one basis. Any partial
        // invalidation shows up here as a mismatched field.
        expect(view_state(post_message)).toEqual({
            merges: '0',
            row_count: String(FILTERED_ROW_COUNT),
            asks_again: false,
        });
    });

    it('drops every part of the record when the basis changes', async () => {
        const { post_message } = await editing_with_an_applied_sort();
        post_message.mockClear();

        // A reload. The host re-read the rows and installed no permutation over them,
        // so nothing the record said is true any more.
        await dispatch_host_message(refresh_snapshot_message(five_row_meta(), {
            capabilities: CSV_CAPABILITIES,
            state: STORED_STATE,
        }));

        // The same three, all the other way — including the ask, which is what makes
        // the stored sort come back rather than being silently forgotten.
        expect(view_state(post_message)).toEqual({
            merges: '1',
            row_count: '5',
            asks_again: true,
        });
        expect(latest_transform_request(post_message).state.sort)
            .toEqual(STORED_SORT.sort);
    });

    it('does not carry a record into a newly loaded document', async () => {
        // The basis is built from the host's own counters, and a new document restarts
        // them: an 'initial' snapshot can arrive on the very generation and source
        // generation the outgoing file's record was computed against, over a sheet of
        // the same name and shape. Equal numbers are a coincidence there rather than
        // evidence about the rows, so identity of the basis alone cannot be what
        // retains a record — the second file would be shown the first one's row count.
        await render_app();
        await dispatch_host_message(initial_snapshot_message(five_row_meta(), {
            capabilities: CSV_CAPABILITIES,
        }));
        expect(grid_stub().getAttribute('data-row-count')).toBe('5');

        await dispatch_host_message(initial_snapshot_message(sized_meta(9), {
            capabilities: CSV_CAPABILITIES,
        }));

        expect(grid_stub().getAttribute('data-row-count')).toBe('9');
    });

    // One comparison — the durable rules against the record's — decides both
    // directions and the two ways of doing nothing. Walked in one test from one
    // fixture, because the failure the shape prevents is a reader adding a case to
    // the install side and not to the uninstall side.
    it('reconciles in either direction from the same comparison', async () => {
        const { post_message } = await editing_with_an_applied_sort();
        // The same disabled filter, retyped. The last phase below needs durable rules
        // that differ from the installed ones without either describing a
        // permutation, and an edited value is the way to get there on this fixture:
        // the sheet has one column, and `sanitize_transform_state` keeps only one
        // filter per column, so a *second* disabled filter would be dropped before
        // the comparison ever saw it.
        const retyped_disabled_filter: SheetTransformState = {
            ...DISABLED_FILTER_ONLY,
            filters: DISABLED_FILTER_ONLY.filters.map((filter) => ({
                ...filter,
                value: 'z',
            })),
        };
        const same_basis = (
            generation: number,
            transforms: (SheetTransformState | undefined)[],
        ) => refresh_snapshot_message(five_row_meta(), {
            generation,
            sourceGeneration: 1,
            reason: 'other',
            capabilities: CSV_CAPABILITIES,
            state: { ...STORED_STATE, transforms },
        });

        // Agreeing: neither direction.
        post_message.mockClear();
        await dispatch_host_message(same_basis(2, [STORED_SORT]));
        expect(transform_requests(post_message)).toHaveLength(0);

        // Durable rules active and differing — a sibling re-sorted — so install them.
        post_message.mockClear();
        await dispatch_host_message(same_basis(2, [SIBLING_SORT]));
        expect(transform_requests(post_message)).toHaveLength(1);
        const install = latest_transform_request(post_message);
        expect(install.state.sort).toEqual(SIBLING_SORT.sort);
        await dispatch_host_message(
            transform_installed_message(install, { generation: 3, rowCount: 4 }),
        );

        // Durable rules inactive while a permutation is still installed, so ask for
        // the rule-free view — carrying the disabled definition, which is still the
        // user's. Only the host can un-permute the loader, so nothing else can fix it.
        post_message.mockClear();
        await dispatch_host_message(same_basis(3, [DISABLED_FILTER_ONLY]));
        expect(transform_requests(post_message)).toHaveLength(1);
        const uninstall = latest_transform_request(post_message);
        expect(uninstall.state.sort).toEqual([]);
        expect(uninstall.state.filters).toEqual(DISABLED_FILTER_ONLY.filters);
        await dispatch_host_message(
            transform_installed_message(uninstall, { generation: 4, rowCount: 5 }),
        );
        expect(grid_stub().getAttribute('data-merges')).toBe('1');
        expect(grid_stub().getAttribute('data-row-count')).toBe('5');

        // Differing rules with nothing to reconcile: a sibling retyped a filter it had
        // already switched off, so neither side describes a permutation and the
        // toolbar reads the definition from durable state anyway. Asking would bump
        // the generation, remount the grid and fold whatever is being typed, all for a
        // view identical to the one on screen.
        post_message.mockClear();
        await dispatch_host_message(same_basis(4, [retyped_disabled_filter]));
        expect(transform_requests(post_message)).toHaveLength(0);
    });
});

// Cancel rolls a *pending* request back to the view that was already on screen. It is
// not a "re-apply now" affordance — the design has none — so which view that is
// depends on what is installed, and when nothing is permuted the answer is the durable
// intent, read live. See `transform_rollback_baseline`.
describe('the transform rollback baseline', () => {
    const SCHEMA = '["Sheet1",1,null]';
    /**
     * Inactive but not empty. The sheet has one column and
     * `sanitize_transform_state` keeps one filter per column, so a *changed* definition
     * has to be the same filter retyped rather than a second one added.
     */
    const disabled_only = (value: string): SheetTransformState => ({
        sort: [],
        filters: [{
            id: 'f1',
            colIndex: 0,
            operator: 'contains',
            value,
            caseSensitive: false,
            enabled: false,
        }],
        schema: SCHEMA,
    });
    const STORED_SORT: SheetTransformState = {
        sort: [{ colIndex: 0, direction: 'desc' }],
        filters: [],
        schema: SCHEMA,
    };

    function transform_requests(post_message: ReturnType<typeof vi.fn>) {
        return post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'setTransform');
    }

    /** A sibling panel's durable state, arriving the only way it can: same rows. */
    const same_basis = (
        generation: number,
        transforms: (SheetTransformState | undefined)[],
    ) => refresh_snapshot_message(make_meta(['Sheet1']), {
        generation,
        sourceGeneration: 1,
        reason: 'other',
        state: { transforms },
    });

    /** Something to cancel: a sort the grid asked for and no ack for it. */
    async function start_a_transform(post_message: ReturnType<typeof vi.fn>) {
        post_message.mockClear();
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        expect(transform_requests(post_message)).toHaveLength(1);
        post_message.mockClear();
    }

    it('cancels to the disabled filter a sibling left, not the one it replaced',
        async () => {
            const { post_message } = await render_app();
            await dispatch_host_message(
                initial_snapshot_message(make_meta(['Sheet1']), {
                    state: { transforms: [disabled_only('old')] },
                }),
            );
            // Inactive rules install nothing, so this panel holds the natural view and
            // there is no record of any rules for a rollback to read.
            expect(transform_requests(post_message)).toHaveLength(0);

            await dispatch_host_message(same_basis(1, [disabled_only('new')]));
            // The heart of it: changing a *disabled* filter moves no row, so there is
            // nothing to install and no generation to bump. This silence is exactly why
            // nothing can refresh a copy of the durable rules held on the record — the
            // rollback baseline has to come from durable state itself.
            expect(transform_requests(post_message)).toHaveLength(0);

            await start_a_transform(post_message);
            await click_button('Cancel');

            // Cancel persists what it sends, so reading a stale copy would not merely
            // roll back wrongly — it would resurrect a definition the sibling replaced,
            // overwriting the sibling's update in shared durable state.
            expect(latest_transform_request(post_message).state.filters)
                .toEqual(disabled_only('new').filters);
        });

    it('cancels to no filter at all once a sibling has removed the definition',
        async () => {
            // The same staleness one shape over: rules the host *acknowledged* while
            // installing nothing. `permuted` is false, so they are no more a description
            // of these rows than the natural view's would be, and the retention holds
            // them just as indefinitely.
            const { post_message } = await render_app();
            await dispatch_host_message(
                initial_snapshot_message(make_meta(['Sheet1']), {
                    state: { transforms: [STORED_SORT] },
                }),
            );
            const restore = latest_transform_request(post_message);
            await dispatch_host_message(
                transform_installed_message(restore, { generation: 2 }),
            );
            // A sibling switches the sort off and leaves a filter disabled: the
            // permutation goes, and the ack carries the definition onto the record.
            await dispatch_host_message(same_basis(2, [disabled_only('old')]));
            await vi.waitUntil(() => transform_requests(post_message).length > 0);
            const uninstall = latest_transform_request(post_message);
            expect(uninstall.state.filters).toEqual(disabled_only('old').filters);
            await dispatch_host_message(
                transform_installed_message(uninstall, { generation: 3 }),
            );
            // The ack landed — only an install moves the generation — and the rules it
            // carried were rule-free, so the record standing here is the non-permuted
            // arm. That is the state the rollback below has to read a baseline from.
            expect(grid_stub().getAttribute('data-generation')).toBe('3');

            post_message.mockClear();
            await dispatch_host_message(same_basis(3, [undefined]));
            // Nothing to reconcile again — neither side permutes anything — so the
            // record keeps the definition the sibling has just deleted.
            expect(transform_requests(post_message)).toHaveLength(0);

            await start_a_transform(post_message);
            await click_button('Cancel');

            const cancel = latest_transform_request(post_message);
            expect(cancel.state.filters).toEqual([]);
            expect(cancel.state.sort).toEqual([]);
        });

    it('cancels to the installed rules while a permutation is in place', async () => {
        // The other side of the rule: a permuted record's rules *are* basis-derived —
        // they are the set the host built the permutation from — so they, and not
        // durable state's notion of inactivity, are what Cancel puts back.
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(make_meta(['Sheet1']), {
            state: { transforms: [STORED_SORT] },
        }));
        const restore = latest_transform_request(post_message);
        await dispatch_host_message(
            transform_installed_message(restore, { generation: 2 }),
        );
        // The ack landed, and the rules it carried are an active sort, so the record
        // standing here is the permuted arm — the precondition this test contrasts with
        // 'cancels to no filter at all once a sibling has removed the definition'.
        expect(grid_stub().getAttribute('data-generation')).toBe('2');

        await start_a_transform(post_message);
        await click_button('Cancel');

        const cancel = latest_transform_request(post_message);
        expect(cancel.state.sort).toEqual(STORED_SORT.sort);
        expect(cancel.intent).toBe('cancel');
    });
});

// A refusal always means the host changed nothing, and `transformRefused` carries
// nothing about the view for that reason — there is no state, generation or row count
// on the message to adopt by accident. `terminal` says only whether the reason will
// clear on its own, which decides whether the webview stops asking (terminal
// validation) or keeps its own copy and retries (the admission matrix).
//
// The first guarantee below is enforced by the compiler, not by any test: six review
// rounds of this feature were each a consumer adopting a refusal's echo of the host's
// unchanged view, so the fields are gone from the arm rather than merely
// unread. `Extract` of them from the refusal's keys must be `never`, or this alias
// resolves to `never` and the assignment stops compiling.
type _RefusalCarriesNoView = Extract<
    keyof Extract<HostMessage, { type: 'transformRefused' }>,
    'view' | 'state' | 'rowCount' | 'generation' | 'sourceGeneration'
> extends never ? true : never;
const _refusal_carries_no_view: _RefusalCarriesNoView = true;
void _refusal_carries_no_view;

describe('refused transforms', () => {
    const STORED_SORT: SheetTransformState = {
        sort: [{ colIndex: 0, direction: 'desc' }],
        filters: [],
        schema: '["Sheet1",1,null]',
    };
    const CSV_CAPABILITIES = {
        csvEditable: true,
        csvEditingSupported: true,
        csvEditSessionId: 'test-edit-session',
    };

    /** Edit mode over an editable CSV whose persisted state carries STORED_SORT. */
    async function refresh_with_stored_sort(
        post_message: ReturnType<typeof vi.fn>,
    ) {
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            { capabilities: CSV_CAPABILITIES, state: { transforms: [STORED_SORT] } },
        ));
        return latest_transform_request(post_message);
    }

    async function editing_csv() {
        const rendered = await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            { capabilities: { csvEditable: true, csvEditingSupported: true } },
        ));
        await enter_edit_mode(rendered.post_message);
        return rendered;
    }

    /**
     * The whole refusal, exhaustively. There is no `state`, `rowCount` or
     * `generation` to pass: the arm does not have them, which is a type-level
     * guarantee that no handler can adopt one.
     */
    async function refuse_transform(
        request: Extract<WebviewMessage, { type: 'setTransform' }>,
        options: { terminal: boolean },
    ) {
        await dispatch_host_message({
            type: 'transformRefused',
            sheetIndex: request.sheetIndex,
            requestId: request.requestId,
            intent: request.intent,
            reason: 'A save is in progress.',
            terminal: options.terminal,
        });
    }

    function transform_requests(post_message: ReturnType<typeof vi.fn>) {
        return post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'setTransform');
    }

    function store_edits() {
        return JSON.parse(grid_stub().getAttribute('data-store-edits')!);
    }

    /** Move the save in and back out of flight, the one dep the restore effect
     *  gained, so a retriable source gets its second chance. */
    async function settle_a_save() {
        await report_grid_editing(true, true, [], undefined, true);
        await report_grid_editing(true, true, [], undefined, false);
    }

    it('keeps a transiently refused transform retriable', async () => {
        const { post_message } = await editing_csv();
        post_message.mockClear();
        const request = await refresh_with_stored_sort(post_message);
        const generation_before = grid_stub().getAttribute('data-generation');
        const row_count_before = grid_stub().getAttribute('data-row-count');
        grid_shell_mock.commit_live_edit.mockClear();
        post_message.mockClear();

        await refuse_transform(request, { terminal: false });

        // Nothing adopted, and now nothing adoptable: the refusal has no generation,
        // rules or row count on it at all. Both of the fields it could have carried are
        // read back unchanged, rather than only the one.
        expect(grid_stub().getAttribute('data-generation')).toBe(generation_before);
        expect(grid_stub().getAttribute('data-row-count')).toBe(row_count_before);
        // A refusal cannot reach the fold: only an install can move the generation,
        // and only a moved generation unmounts the grid that owns the overlay.
        expect(grid_shell_mock.commit_live_edit).not.toHaveBeenCalled();
        // The spinner and its label must not stick.
        expect(grid_shell_mock.latest_props?.transform_pending).toBe(false);
        expect(document.querySelector('.toolbar-progress')).toBeNull();
        // Silently, because this is a restore: nobody asked for it, the effect below
        // asks again by itself, and there is nothing for the user to do meanwhile.
        // The warning for a refusal the user did provoke is asserted in 'drops a
        // transiently refused user request instead of queueing it'.
        expect(post_message).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'showWarning',
        }));

        // The webview still holds the saved transform and has not marked the source
        // handled, so the effect asks again once the refusing condition settles.
        post_message.mockClear();
        await settle_a_save();
        await vi.waitUntil(() => transform_requests(post_message).length > 0);
        expect(latest_transform_request(post_message).state.sort)
            .toEqual(STORED_SORT.sort);
    });

    it('drops a transiently refused user request instead of queueing it', async () => {
        const { post_message } = await editing_csv();
        // No stored transform anywhere, so anything asked for later could only be a
        // replay of what the user just did.
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        const request = latest_transform_request(post_message);
        expect(request.intent).toBe('user');
        const generation_before = grid_stub().getAttribute('data-generation');
        post_message.mockClear();

        await refuse_transform(request, { terminal: false });

        // Visible failure, and that is the whole of it: the user is told, and the view
        // they were looking at is the view they are still looking at. Only an install
        // moves the generation, so an unmoved one is "no view was adopted".
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'showWarning',
        }));
        expect(grid_stub().getAttribute('data-generation')).toBe(generation_before);

        // The counterpart of 'keeps a transiently refused transform retriable': there
        // the *stored* transform is asked for again, because the sheet would otherwise
        // sit unsorted for the session. A request the user made has no such standing.
        // Replaying it once the refusing condition lifts would reorder rows under
        // someone mid-edit who has moved on — the deferred "Resort" this design
        // forbids — so it must stay dropped.
        post_message.mockClear();
        await settle_a_save();
        expect(transform_requests(post_message)).toEqual([]);
        expect(grid_stub().getAttribute('data-generation')).toBe(generation_before);
    });

    it('adopts the natural state for a terminal refusal', async () => {
        const { post_message } = await editing_csv();
        post_message.mockClear();
        const request = await refresh_with_stored_sort(post_message);
        const generation_before = grid_stub().getAttribute('data-generation');
        const row_count_before = grid_stub().getAttribute('data-row-count');
        grid_shell_mock.commit_live_edit.mockClear();
        post_message.mockClear();

        await refuse_transform(request, { terminal: true });

        // "Adopts the natural state" needs nothing from the wire, which is why the
        // refusal can carry nothing: the stored sort never installed, so the natural
        // view is already what this webview shows, and the generation the host holds
        // is already the one it is on. Both are asserted as *unchanged* rather than
        // as echoes that landed.
        expect(grid_stub().getAttribute('data-generation')).toBe(generation_before);
        expect(grid_stub().getAttribute('data-row-count')).toBe(row_count_before);
        expect(grid_shell_mock.latest_props?.transform_pending).toBe(false);
        // And it warns, even though this is a restore nobody asked for. The transient
        // case above is silent because the effect will ask again; here nothing will,
        // so the saved view is being abandoned and the user is entitled to know that
        // the sheet they open next will not look the way their file remembers.
        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'showWarning',
        }));

        // The load-bearing half, and the whole of what `terminal` buys: the source
        // counts as handled, which is how a saved transform the sheet can no longer
        // support stays dropped instead of being asked for — with its global warning —
        // every time a blocker moves.
        post_message.mockClear();
        await settle_a_save();
        expect(transform_requests(post_message)).toEqual([]);
    });

    it('asks again for a terminally refused transform once the source reloads', async () => {
        // The other half of `terminal`, and the half that keeps it from being a
        // one-way door. "Stop asking" is bookkeeping about a request the host refused
        // over *these* rows: a reload replaces them, and a sheet that could not support
        // the saved sort a moment ago — wrong columns, a promoted header row — may well
        // support it now. Latching past that would drop the user's sort for the rest of
        // the session, with nothing to show they still have one.
        const { post_message } = await editing_csv();
        post_message.mockClear();
        const request = await refresh_with_stored_sort(post_message);
        await refuse_transform(request, { terminal: true });
        post_message.mockClear();

        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                generation: 3,
                sourceGeneration: 3,
                capabilities: CSV_CAPABILITIES,
                state: { transforms: [STORED_SORT] },
            },
        ));

        await vi.waitUntil(() => transform_requests(post_message).length > 0);
        expect(latest_transform_request(post_message).state.sort)
            .toEqual(STORED_SORT.sort);
    });

    it('keeps the applied view and its row count across a terminal refusal', async () => {
        // The counterpart of the test above, where there *is* something to lose. A
        // refusal has no state, generation or rowCount field to adopt — the type
        // guarantees it — so an installed sort survives one by construction rather
        // than because the handler remembered not to overwrite it.
        const { post_message } = await editing_csv();
        post_message.mockClear();
        const install = await refresh_with_stored_sort(post_message);
        await dispatch_host_message(
            transform_installed_message(install, { generation: 7, rowCount: 4 }),
        );
        expect(grid_stub().getAttribute('data-generation')).toBe('7');
        expect(grid_stub().getAttribute('data-row-count')).toBe('4');

        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        await refuse_transform(latest_transform_request(post_message), {
            terminal: true,
        });

        expect(grid_stub().getAttribute('data-generation')).toBe('7');
        expect(grid_stub().getAttribute('data-row-count')).toBe('4');
    });

    it('does not fold the live editor for a terminal refusal', async () => {
        // Nothing installed, so nothing remounts. Editing is permitted while a
        // transform computes, so the user can be mid-cell when the refusal arrives —
        // and folding then puts a half-typed value in the dirty store, where Escape
        // can no longer take it back.
        const { post_message } = await editing_csv();
        post_message.mockClear();
        const request = await refresh_with_stored_sort(post_message);
        const generation_before = Number(grid_stub().getAttribute('data-generation'));
        grid_shell_mock.commit_live_edit.mockImplementation(() => {
            (grid_shell_mock.latest_props?.edit_session as EditSessionStore)
                .commit('test-edit-session', '0:0', { value: 'half', base: 'base' });
        });
        grid_shell_mock.commit_live_edit.mockClear();

        await refuse_transform(request, { terminal: true });

        // Stated as the user experiences it: the partial value never reached the
        // dirty store, so the cell is still cancellable.
        expect(store_edits()).toEqual({});
        expect(grid_shell_mock.commit_live_edit).not.toHaveBeenCalled();
        // And the view the webview already had is what it still shows: only an install
        // moves the generation, and this refusal moved nothing.
        expect(Number(grid_stub().getAttribute('data-generation')))
            .toBe(generation_before);

        // The paired direction, here rather than elsewhere so this test cannot pass by
        // never folding at all: an ack that does move the generation remounts the grid,
        // and the overlay has to be folded ahead of that or the value is lost. Cleared
        // first so the count below is attributable to this ack and cannot be satisfied
        // by a fold that already happened above.
        grid_shell_mock.commit_live_edit.mockClear();
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        await acknowledge_transform(
            latest_transform_request(post_message),
            generation_before + 1,
        );
        expect(grid_shell_mock.commit_live_edit).toHaveBeenCalledTimes(1);
        expect(store_edits()).toEqual({ '0:0': { value: 'half', base: 'base' } });
    });

    it('does not fold the live editor for an install that moves no generation', async () => {
        // The other half of the fold condition, and the one the split does *not*
        // make structural. Reaching `transformInstalled` is necessary but not
        // sufficient: the host answers a restore or cancel whose rules it already
        // holds with a no-op ack, which is a truthful install on an unmoved
        // generation. Nothing remounts, so folding puts a half-typed value in the
        // dirty store where Escape can no longer take it back — the same harm the
        // refusal case does, arriving on the arm that can fold.
        const { post_message } = await editing_csv();
        post_message.mockClear();
        const request = await refresh_with_stored_sort(post_message);
        const generation_before = Number(grid_stub().getAttribute('data-generation'));
        grid_shell_mock.commit_live_edit.mockImplementation(() => {
            (grid_shell_mock.latest_props?.edit_session as EditSessionStore)
                .commit('test-edit-session', '0:0', { value: 'half', base: 'base' });
        });
        grid_shell_mock.commit_live_edit.mockClear();

        await dispatch_host_message(transform_installed_message(request, {
            generation: generation_before,
        }));

        expect(store_edits()).toEqual({});
        expect(grid_shell_mock.commit_live_edit).not.toHaveBeenCalled();
        // Not vacuous: the install landed, so this is the ack being processed and
        // choosing not to fold, not the requestId guard dropping it. The generation is
        // no evidence here — the whole point of this case is that it did not move — so
        // the spinner clearing is what says the ack was matched to its request.
        expect(grid_shell_mock.latest_props?.transform_pending).toBe(false);

        // Paired direction, so this cannot pass by never folding: the same install
        // one generation on does remount, and the overlay has to be folded first.
        grid_shell_mock.commit_live_edit.mockClear();
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        await acknowledge_transform(
            latest_transform_request(post_message),
            generation_before + 1,
        );
        expect(grid_shell_mock.commit_live_edit).toHaveBeenCalledTimes(1);
        expect(store_edits()).toEqual({ '0:0': { value: 'half', base: 'base' } });
    });

    it('holds the stored transform back until a save settles', async () => {
        const { post_message } = await editing_csv();
        await report_grid_editing(true, true, [], undefined, true);
        post_message.mockClear();

        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            { capabilities: CSV_CAPABILITIES, state: { transforms: [STORED_SORT] } },
        ));
        // The host would refuse this one, and a refusal changes no other dep of the
        // restore effect, so asking now is asking never.
        expect(transform_requests(post_message)).toEqual([]);

        await report_grid_editing(true, true, [], undefined, false);
        await vi.waitUntil(() => transform_requests(post_message).length > 0);
        expect(latest_transform_request(post_message).state.sort)
            .toEqual(STORED_SORT.sort);
    });

    it('blocks Cancel while a save is in flight', async () => {
        const { post_message } = await editing_csv();
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        latest_transform_request(post_message);
        expect(get_button('Cancel').disabled).toBe(false);

        // Second layer, because the button is only the affordance and it lags by a
        // render: the save starts and the click lands before React has repainted the
        // toolbar, which is the actual race. A cancel the host would refuse must not
        // displace the request it is cancelling, whose requestId it would overwrite.
        post_message.mockClear();
        grid_shell_mock.save_in_flight = true;
        await act(async () => {
            grid_shell_mock.on_editing_change?.({
                is_dirty: true,
                has_live_uncommitted: false,
                save_in_flight: true,
                edits: { '0:0': { value: 'dirty', base: 'base' } },
                conflicted: [],
            });
            get_button('Cancel').click();
        });
        expect(transform_requests(post_message)).toEqual([]);
        // And once React catches up the affordance agrees.
        expect(get_button('Cancel').disabled).toBe(true);

        // The other half: nothing here permanently disables cancelling.
        await report_grid_editing(true, true, [], undefined, false);
        expect(get_button('Cancel').disabled).toBe(false);
        post_message.mockClear();
        await click_button('Cancel');
        expect(transform_requests(post_message)).toHaveLength(1);
    });
});

// The panel that is *not* editing. Its persisted sort is refused for as long as
// another panel owns the session, and every edit that owner commits redelivers a
// same-basis snapshot here. Asking again each time buys nothing and costs a global
// VS Code warning per keystroke-batch. Latching the ask is safe precisely because
// this request is restore-origin in a panel with no editor to disturb.
describe('a refused restore in a sibling panel', () => {
    const STORED_SORT: SheetTransformState = {
        sort: [{ colIndex: 0, direction: 'desc' }],
        filters: [],
        schema: '["Sheet1",1,null]',
    };
    // What the host projects to a panel while another one holds the session.
    const NOT_EDITABLE = { csvEditable: false, csvEditingSupported: true };
    const EDITABLE = { csvEditable: true, csvEditingSupported: true };

    function transform_requests(post_message: ReturnType<typeof vi.fn>) {
        return post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'setTransform');
    }

    function warnings(post_message: ReturnType<typeof vi.fn>) {
        return post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'showWarning');
    }

    /** The owner commits an edit: same source, same view generation, new state. */
    async function owner_commits_an_edit(
        capabilities: { csvEditable: boolean; csvEditingSupported: boolean },
    ) {
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                generation: 1,
                sourceGeneration: 1,
                reason: 'other',
                capabilities,
                state: { transforms: [STORED_SORT] },
            },
        ));
    }

    async function refuse(
        request: Extract<WebviewMessage, { type: 'setTransform' }>,
    ) {
        await dispatch_host_message({
            type: 'transformRefused',
            sheetIndex: request.sheetIndex,
            requestId: request.requestId,
            intent: request.intent,
            reason: 'Another editor is holding this file.',
            terminal: false,
        });
    }

    async function restore_refused_by_the_owner() {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            { capabilities: NOT_EDITABLE, state: { transforms: [STORED_SORT] } },
        ));
        const request = latest_transform_request(post_message);
        expect(request.intent).toBe('restore');
        await refuse(request);
        return { post_message, request };
    }

    it('is not repeated while the blocker is unchanged', async () => {
        const { post_message, request } = await restore_refused_by_the_owner();
        // One ask, and no warning at all: a transiently refused restore is nothing
        // the user did and nothing they can act on. The latch is about the *ask*.
        expect(transform_requests(post_message)).toHaveLength(1);
        expect(warnings(post_message)).toHaveLength(0);

        for (let commit = 0; commit < 2; commit += 1) {
            await owner_commits_an_edit(NOT_EDITABLE);
            // The host would refuse a repeat too, so answer one the same way it
            // would, exactly as in the real thing.
            const latest = transform_requests(post_message).at(-1)!;
            if (latest.requestId !== request.requestId) await refuse(latest);
        }

        // Nothing about the refusal changed, so the ask is not repeated — and the
        // user still hears nothing about any of it.
        expect(warnings(post_message)).toHaveLength(0);
        expect(transform_requests(post_message)).toHaveLength(1);
    });

    it('is asked again once the owner releases the session', async () => {
        const { post_message, request } = await restore_refused_by_the_owner();
        await owner_commits_an_edit(NOT_EDITABLE);
        // Leave nothing in flight, so what the release has to overcome is the latch
        // and not the pending-request guard that sits above it.
        const latest = transform_requests(post_message).at(-1)!;
        if (latest.requestId !== request.requestId) await refuse(latest);
        post_message.mockClear();

        // Release: the host projects this panel editable again, which is the only
        // observable this webview has for "the refusing condition cleared".
        await owner_commits_an_edit(EDITABLE);

        await vi.waitUntil(() => transform_requests(post_message).length > 0);
        expect(latest_transform_request(post_message).state.sort)
            .toEqual(STORED_SORT.sort);
    });

    it('is asked again when the source reloads under the same blocker', async () => {
        const { post_message } = await restore_refused_by_the_owner();
        post_message.mockClear();

        // A reload, with the owner still holding the session. The host dropped the
        // permutation over rows that no longer exist, so the earlier refusal has
        // nothing to say about this one and the latch must not suppress it.
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            { capabilities: NOT_EDITABLE, state: { transforms: [STORED_SORT] } },
        ));

        await vi.waitUntil(() => transform_requests(post_message).length > 0);
        expect(latest_transform_request(post_message).state.sort)
            .toEqual(STORED_SORT.sort);
    });
});

describe('the Edit button and an installed transform', () => {
    const EDITABLE = { csvEditable: true, csvEditingSupported: true };
    // Descending, so the grid stub's ascending shortcut is a real change and
    // actually leaves a request in flight.
    const SORT: SheetTransformState = {
        sort: [{ colIndex: 0, direction: 'desc' }],
        filters: [],
        schema: '["Sheet1",1,null]',
    };

    function warnings(post_message: ReturnType<typeof vi.fn>) {
        return post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'showWarning');
    }

    async function sorted_sheet_not_yet_editing() {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            { capabilities: EDITABLE, state: { transforms: [SORT] } },
        ));
        await acknowledge_transform(latest_transform_request(post_message), 2);
        // The restore landed and installed an active sort, so what follows is judged
        // against a permuted view rather than an unsorted one.
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
        post_message.mockClear();
        return post_message;
    }

    it('leaves Edit enabled while a sort is installed', async () => {
        // An *installed* transform is just a view. Edits are source-keyed and the
        // permutation never recomputes mid-session, so there is nothing to clear.
        const post_message = await sorted_sheet_not_yet_editing();
        expect(get_button('Edit').disabled).toBe(false);
        expect(warnings(post_message)).toEqual([]);
    });

    it('requests a session from a sorted sheet instead of warning', async () => {
        const post_message = await sorted_sheet_not_yet_editing();

        await click_button('Edit');

        expect(post_message).toHaveBeenCalledWith(expect.objectContaining({
            type: 'requestEditSession',
            requestId: expect.any(String),
        }));
        expect(warnings(post_message)).toEqual([]);
    });

    it('disables Edit while transform work is in flight', async () => {
        // The half that still blocks: work in flight is file-level concurrency and
        // the host refuses an edit claim during it, so the button must agree.
        const post_message = await sorted_sheet_not_yet_editing();
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        // Deliberately unacknowledged: the request is in flight.
        expect(latest_transform_request(post_message)).toBeDefined();

        expect(get_button('Edit').disabled).toBe(true);
        // The retired copy: nothing in this build tells the user to clear sorting
        // before editing, in a tooltip or anywhere else.
        expect(document.body.textContent ?? '').not.toContain('Clear sorting');
    });
});

describe('stale-view banner', () => {
    const BANNER_TEXT = 'Sorting and filters don\'t update while you\'re editing.';
    // A future contributor must not be able to reintroduce a "Resort"/"Refresh"
    // action here. Rows staying put is the feature, so there is nothing to apply.
    const CTA = /re-?sort|re-?filter|refresh|apply|update/i;

    function banner(): HTMLElement | null {
        return document.querySelector('.stale-view-banner');
    }

    function expect_no_call_to_action() {
        const present = banner();
        if (present) {
            const labels = Array.from(present.querySelectorAll('button'))
                .map((button) => button.textContent ?? '');
            expect(labels).toEqual(['Dismiss']);
        }
        // Nowhere on the page, so a CTA cannot sneak in beside the banner either.
        const offenders = Array.from(document.querySelectorAll('button'))
            .map((button) => button.textContent ?? '')
            .filter((label) => CTA.test(label));
        expect(offenders).toEqual([]);
    }

    async function edit_mode_sorted_on_column_0() {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            { capabilities: { csvEditable: true, csvEditingSupported: true } },
        ));
        await enter_edit_mode(post_message);
        await act(async () => (
            container!.querySelector('.stub-shortcut-transform') as HTMLButtonElement
        ).click());
        await acknowledge_transform(latest_transform_request(post_message), 2);
        // The sort installed — only an install moves the generation — so the banner's
        // silence below is a choice about a permuted view, not the absence of one.
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
        expect(banner()).toBeNull();
        return post_message;
    }

    const dirty = (...keys: string[]) => Object.fromEntries(
        keys.map((key) => [key, { value: `dirty-${key}`, base: 'base' }]),
    );

    /**
     * Re-answer with the same rules on the same generation and a new set of hidden
     * cells — the no-op-ack shape, and the smallest change that isolates them: an
     * unmoved generation remounts nothing and the rules half of the signature is
     * untouched, so only the keys can be doing the work.
     *
     * `hiddenRows` deliberately not named on the rules here: hiding is what puts
     * these keys out of sight in the real host, but the rules half must stay fixed
     * for these tests to be about the keys, and the record is the host's word either
     * way.
     */
    async function reinstall_with_hidden_cells(hidden: readonly string[]) {
        await dispatch_host_message({
            type: 'transformInstalled',
            sheetIndex: 0,
            intent: 'restore',
            view: {
                basis: { generation: 2, sourceGeneration: 1, schema: '["Sheet1",1,null]' },
                rules: {
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [],
                    // The schema the restore effect matches on: without it the record
                    // disagrees with durable state and the effect asks for a fresh
                    // transform, whose pending requestId would then swallow the next
                    // install here.
                    schema: '["Sheet1",1,null]',
                },
                rowCount: 1,
                permuted: true,
                hiddenEditedCellKeys: hidden,
            },
            rules: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,null]',
            },
        });
    }

    it('names hidden edited cells with no edit in a column the order reads', async () => {
        // The count is an independent reason to speak, and this is why it has to be:
        // hidden-ness is a property of the *row*, so the edited column has nothing to
        // do with it. Here no dirty cell is in the sorted column — the column test
        // alone says nothing — and there is still unsaved work the user cannot see.
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:1'));
        expect(banner()).toBeNull();

        await reinstall_with_hidden_cells(['0:1']);

        // And the hidden sentence stands alone. No edit here can change where the sort
        // puts a row, so there is no order disagreeing with any value and the first
        // sentence would be saying something about nothing.
        expect(banner()?.textContent).not.toContain(BANNER_TEXT);
        expect(banner()?.textContent)
            .toContain('1 edited cell is in a row this view doesn\'t show.');
        // Informational, like the sentence before it: no exit, no affordance.
        expect_no_call_to_action();
    });

    it('pluralizes the hidden-cell sentence as one phrase', async () => {
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:1', '1:1'));

        await reinstall_with_hidden_cells(['0:1', '1:1']);

        expect(banner()?.textContent)
            .toContain('2 edited cells are in rows this view doesn\'t show.');
        // Noun and verb agree, as in the conflict banner: never "2 edited cell is".
        expect(banner()?.textContent).not.toContain('edited cell is');
        expect_no_call_to_action();
    });

    it('names only the hidden cells the dirty map still holds', async () => {
        // The count is a function of two things — which rows the view contains and
        // which cells are edited — and only the first is the host's to observe. The
        // second moves with every discard, and none of them install a transform, so a
        // number sent from the host would sit here claiming forever that work the user
        // has already thrown away is out of sight. Narrowing to the live map is what
        // makes the sentence answerable at all times rather than only just after an
        // install.
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:1', '1:1'));
        await reinstall_with_hidden_cells(['0:1', '1:1']);
        expect(banner()?.textContent)
            .toContain('2 edited cells are in rows this view doesn\'t show.');

        // The discard: one of the two hidden edits leaves the map. No install follows
        // — the view did not change, only the work in it.
        await report_grid_editing(true, true, [], dirty('1:1'));

        expect(banner()?.textContent)
            .toContain('1 edited cell is in a row this view doesn\'t show.');
        expect(banner()?.textContent).not.toContain('2 edited cells');
        expect_no_call_to_action();
    });

    /**
     * The refresh a `pendingEditsChanged` produces: same generation, same source
     * generation, same schema — so the record stands — carrying the host's fresh answer
     * about which edited rows the permutation it already holds does not show.
     */
    async function same_basis_refresh(hidden: readonly string[]) {
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                generation: 2,
                sourceGeneration: 1,
                hiddenEditedCellKeys: [hidden],
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'test-edit-session',
                },
                state: {
                    transforms: [{
                        sort: [{ colIndex: 0, direction: 'asc' }],
                        filters: [],
                        schema: '["Sheet1",1,null]',
                    }],
                },
            },
        ));
    }

    it('names a hidden cell only a refresh could have told it about', async () => {
        // The additive direction, which the live intersection cannot reach: an edit
        // typed while a hiding transform was still computing is in no durable map when
        // the install reads one, so the install's record omits it and no later install
        // is ever asked. Here the install says nothing is hidden, the dirty map never
        // changes, and the only new information is the host's re-answer on the refresh
        // the durable write triggers.
        await edit_mode_sorted_on_column_0();
        // Column 1, which the installed sort does not read, so the column half of the
        // signature is silent throughout and only the hidden cells can speak.
        await report_grid_editing(true, true, [], dirty('0:1'));
        expect(banner()).toBeNull();

        await same_basis_refresh(['0:1']);

        // Hidden cells alone again: the sorted column holds no unsaved edit.
        expect(banner()?.textContent).not.toContain(BANNER_TEXT);
        expect(banner()?.textContent)
            .toContain('1 edited cell is in a row this view doesn\'t show.');
        // Still the installed view, and the sentence above is itself the evidence:
        // `hiddenEditedCellKeys` exists only on the record's `permuted` arm, so a record
        // replaced by a natural one could not have produced that count at all.
        expect_no_call_to_action();

        // Withdrawn the same way it arrived. The host is the authority on membership,
        // so a refresh naming nothing is news too — taking the fresh answer only when
        // it is non-empty would leave the claim standing forever.
        await same_basis_refresh([]);

        expect(banner()).toBeNull();
        expect_no_call_to_action();
    });

    it('reads consistently beside the shrink conflict banner over the same row', async () => {
        // The two notices can stand together, and they are about the same vanished row:
        // this one says unsaved work is in a row the view does not show, the conflict
        // banner says the save was cancelled because that row is gone. Checked rather
        // than assumed, because they are the same fact at two moments — before Save this
        // is the only notice there is, and after a rejection the conflict banner adds
        // what the stale-view notice deliberately never says: which row, and that
        // something was cancelled.
        //
        // No contradiction to fix: "this view doesn't show" was chosen over "hides"
        // precisely so it stays true of a removed row, and the counts differ by design
        // and by unit — cells out of sight here, rows lost there, each stated in its own
        // sentence with its own noun.
        await edit_mode_sorted_on_column_0();
        const removed = { '7:1': { value: 'orphan', base: 'gone' } };
        await report_grid_editing(true, true, [], removed);
        await same_basis_refresh(['7:1']);
        expect(banner()?.textContent)
            .toContain('1 edited cell is in a row this view doesn\'t show.');

        await dispatch_host_message({
            type: 'saveResult',
            success: false,
            lifecycle: {
                revision: 901,
                state: 'failed',
                operation: {
                    editSessionId: 'test-edit-session',
                    saveRequestId: 'save-shrunk',
                    worksheets: [{
                        sheetIndex: 0,
                        edits: { '7:1': 'orphan' },
                        dirtyEdits: removed,
                    }],
                },
            },
            rejection: { reason: 'rowsRemoved', worksheetOperationIndex: 0, keys: ['7:1'] },
        });
        await report_grid_editing(true, true, [], removed);

        // Both up, neither restated as the other, and only the conflict banner offers a
        // way out — the stale-view notice is still informational.
        expect(container!.querySelector('.conflict-banner')?.textContent)
            .toContain('1 edited row no longer exists');
        expect(container!.querySelector('.conflict-banner')?.textContent)
            .toContain('Affected row: 8');
        expect(banner()?.textContent)
            .toContain('1 edited cell is in a row this view doesn\'t show.');
        expect(banner()?.textContent).not.toContain('cancelled');
        expect_no_call_to_action();
    });

    it('does not claim a refreshed key the dirty map never held', async () => {
        // The paired direction, so the fresh answer cannot pass by naming everything:
        // the host reads the *durable* map, which can name an entry the user has
        // already discarded, and the intersection still has to run over what a refresh
        // brings in exactly as it does over what an install brings in.
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:1'));

        await same_basis_refresh(['2:1']);

        expect(banner()).toBeNull();
        expect_no_call_to_action();
    });

    it('drops the claim entirely when the last hidden edit is discarded', async () => {
        // The end of the same road, and the shape codex named: with nothing else to
        // say, the whole notice goes rather than standing there over an empty claim.
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:1'));
        await reinstall_with_hidden_cells(['0:1']);
        expect(banner()).not.toBeNull();

        await report_grid_editing(false, false, [], {});

        expect(banner()).toBeNull();
        expect_no_call_to_action();
    });

    it('says nothing about hidden cells when the count is zero', async () => {
        // The pre-existing reason on its own: an edit in a sorted column, nothing
        // hidden. The sentence must not appear with a count of 0 in it.
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:0'));

        expect(banner()?.textContent).toContain(BANNER_TEXT);
        expect(banner()?.textContent).not.toContain('doesn\'t show');
        expect(banner()?.textContent).not.toContain('edited cell');
        expect_no_call_to_action();
    });

    it('reappears after Dismiss when the hidden-cell count changes', async () => {
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:1', '1:1'));
        await reinstall_with_hidden_cells(['0:1']);
        expect(banner()).not.toBeNull();
        await click_button('Dismiss');
        expect(banner()).toBeNull();

        // Same rules, same generation, same dirty map — a different set of cells out
        // of sight, which the acknowledgement did not cover.
        await reinstall_with_hidden_cells(['0:1', '1:1']);

        expect(banner()?.textContent)
            .toContain('2 edited cells are in rows this view doesn\'t show.');
        expect_no_call_to_action();
    });

    it('keeps a dismissal that the same hidden cells re-assert', async () => {
        // The other direction: folding the keys in must not make every echo of the
        // same view a new fact, or Dismiss would never stick under a hiding filter.
        // Including an echo that names them in another order, which is all
        // `Object.keys` on the host's durable map promises.
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:1', '1:1'));
        await reinstall_with_hidden_cells(['0:1', '1:1']);
        await click_button('Dismiss');

        await reinstall_with_hidden_cells(['1:1', '0:1']);

        expect(banner()).toBeNull();
        expect_no_call_to_action();
    });

    it('goes silent when edit mode ends with the dirty map still reported', async () => {
        // Probing for holes rather than only mutating the new code found this one: the
        // `edit_mode` term on the signature was holding up the whole notice and no test
        // was holding it to account — deleting it failed nothing across the suite.
        //
        // Reachable without a discard: the file becoming uneditable (a truncating
        // reload, a sibling taking the session) leaves edit mode through
        // `leave_edit_mode`, which releases the session but keeps the dirty map, so
        // GridShell goes on reporting the same edits. The statement is about editing;
        // outside it the order recomputes as normal and there is nothing to say.
        //
        // Same-basis refresh deliberately — a moved basis would replace the record
        // with a natural view and the hidden half would fall silent for that reason
        // instead, which is what makes this pin the gate rather than the record.
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:0', '0:1'));
        await reinstall_with_hidden_cells(['0:1']);
        expect(banner()).not.toBeNull();

        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                generation: 2,
                sourceGeneration: 1,
                // Re-asserted, not dropped: a same-basis refresh now hands the record
                // a fresh answer, and letting this default to empty would silence the
                // notice through the record and leave the `edit_mode` gate untested
                // again — the exact hole this test was written to hold.
                hiddenEditedCellKeys: [['0:1']],
                capabilities: { csvEditable: false, csvEditingSupported: true },
                state: {
                    transforms: [{
                        sort: [{ colIndex: 0, direction: 'asc' }],
                        filters: [],
                        schema: '["Sheet1",1,null]',
                    }],
                },
            },
        ));
        await report_grid_editing(true, true, [], dirty('0:0', '0:1'));

        expect(grid_stub().getAttribute('data-edit-mode')).toBe('false');
        // Not vacuous: the record the count came from is still the installed one. The
        // refresh above was same-basis and stayed on generation 2, which is the record
        // written by the install in `edit_mode_sorted_on_column_0` — a dropped record
        // would have taken the natural view with it and there would be no count to gate.
        expect(grid_stub().getAttribute('data-generation')).toBe('2');
        expect(banner()).toBeNull();
        expect_no_call_to_action();
    });

    it('re-shows the notice when a different dirty row is the hidden one', async () => {
        // Hide the first of two dirty rows, dismiss, unhide it, hide the second. The
        // count, the dirty map, the sorts and the enabled filters are all identical
        // across the two hiding views, so nothing but the *identity* of what is out of
        // sight distinguishes them — and different unsaved work has disappeared, which
        // the user has not been told. `hiddenRows` is deliberately not in the rules
        // half of the signature; making the keys the acknowledged fact is what closes
        // this without anyone having to remember to serialize another rule field.
        //
        // Driven the way the app drives it: durable rules arrive on a snapshot (a
        // sibling panel's hide, or the user's own restored on reload), the restore
        // effect asks the host for them, and the host answers with the record.
        const meta: WorkbookMeta = {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: 3,
                sourceRowCount: 3,
                columnCount: 2,
                merges: [],
                hasFormatting: false,
            }],
        };
        const schema = '["Sheet1",2,null]';
        // Both edits are in column 1, which no rule reads, so the column half of the
        // signature says nothing throughout and only the hidden cells can speak.
        const edits = dirty('1:1', '2:1');
        const hiding = (rows: number[]): SheetTransformState => (
            { sort: [], filters: [], hiddenRows: rows, schema }
        );
        const { post_message } = await render_app();
        const capabilities = {
            csvEditable: true,
            csvEditingSupported: true,
            // One session throughout: a new session id would expire the dismissal for
            // an unrelated reason and make this pass without the keys.
            csvEditSessionId: 'hidden-row-identity',
        };
        // Each step delivers the durable rules, lets the restore effect ask, and
        // answers with the record the host would build for them.
        const install_durable = async (
            snapshot: Extract<HostMessage, { type: 'workbookSnapshot' }>,
            rules: SheetTransformState | undefined,
            installed_generation: number,
            hidden: readonly string[],
        ) => {
            await dispatch_host_message(snapshot);
            if (rules) {
                await dispatch_host_message(transform_installed_message(
                    latest_transform_request(post_message),
                    {
                        generation: installed_generation,
                        rowCount: 2,
                        hiddenEditedCellKeys: hidden,
                    },
                ));
            }
            // Last, because an install that moves the generation remounts the grid and
            // the stub reports a fresh (empty) status on mount, exactly as the real
            // shell does. The dirty map the user is holding is what this reports.
            await report_grid_editing(true, true, [], edits);
        };
        const durable = (rules: SheetTransformState | undefined) => ({
            capabilities,
            state: { transforms: [rules], pendingEdits: sheet_edits(edits) },
        });

        await install_durable(
            initial_snapshot_message(meta, durable(hiding([1]))),
            hiding([1]),
            2,
            ['1:1'],
        );
        expect(banner()?.textContent)
            .toContain('1 edited cell is in a row this view doesn\'t show.');
        await click_button('Dismiss');
        expect(banner()).toBeNull();

        // Unhidden: every row is back, so the notice has nothing left to say and goes
        // on its own. Nothing here clears the acknowledgement — a signature of
        // `undefined` is silence, not a dismissal expiring.
        await install_durable(
            refresh_snapshot_message(meta, {
                generation: 3,
                sourceGeneration: 3,
                ...durable(undefined),
            }),
            undefined,
            0,
            [],
        );
        expect(banner()).toBeNull();

        await install_durable(
            refresh_snapshot_message(meta, {
                generation: 4,
                sourceGeneration: 4,
                ...durable(hiding([2])),
            }),
            hiding([2]),
            5,
            ['2:1'],
        );

        expect(banner()?.textContent)
            .toContain('1 edited cell is in a row this view doesn\'t show.');
        expect_no_call_to_action();
    });

    it('claims nothing hidden for the natural view a snapshot describes', async () => {
        // Probing for holes rather than only mutating the new code found this one: the
        // snapshot handler *fabricates* a record when the basis moves, and its count is
        // a constant nobody was holding to account. Setting it to any other number
        // failed no test, and the copy would then name cells over rows the host has
        // just re-read and not filtered yet.
        //
        // Inactive-but-non-empty durable rules are the shape that reaches the banner:
        // they are kept on the record (a disabled filter is still a definition), and
        // they read no column, so the fabricated count would be the only thing
        // speaking.
        //
        // The delivery deliberately *does* name a hidden cell, which is the second
        // probe: now that a same-basis refresh takes the host's fresh keys, letting this
        // branch take them too fails nothing unless the snapshot carries some — and it
        // must not take them, because the record being built here says no permutation is
        // in place, so the keys would name cells as out of sight of a view claiming to
        // show every row.
        await render_app();
        await dispatch_host_message(initial_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                hiddenEditedCellKeys: [['0:0']],
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'natural-view-session',
                },
                state: {
                    transforms: [{
                        sort: [],
                        filters: [{
                            id: 'off',
                            colIndex: 0,
                            operator: 'contains',
                            value: 'x',
                            caseSensitive: false,
                            enabled: false,
                        }],
                        schema: '["Sheet1",1,null]',
                    }],
                    pendingEdits: sheet_edits(dirty('0:0')),
                },
            },
        ));
        await report_grid_editing(true, true, [], dirty('0:0'));
        // Deliberately unacknowledged: the record standing here is the snapshot's own,
        // which is the one under test.
        expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
        // The fabricated record's row count, which is the constant this test exists to
        // hold to account: the sheet's own count, because a record built here says no
        // permutation is in place and therefore shows every row.
        expect(grid_stub().getAttribute('data-row-count')).toBe('1');

        expect(banner()).toBeNull();
        expect_no_call_to_action();
    });

    it('appears when an edit lands in a sorted column', async () => {
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:0'));

        expect(banner()?.textContent).toContain(BANNER_TEXT);
        expect_no_call_to_action();
    });

    it('disappears when that edit is reverted', async () => {
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:0'));
        expect(banner()).not.toBeNull();

        // Derived from the *current* dirty map, not latched: the last relevant edit
        // leaving takes the banner with it, with nothing to clear explicitly.
        await report_grid_editing(false, false, [], {});
        expect(banner()).toBeNull();
        expect_no_call_to_action();
    });

    it('stays away for an edit in a column the order does not read', async () => {
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:1'));

        expect(banner()).toBeNull();
        expect_no_call_to_action();
    });

    it('reappears after Dismiss when a second edit lands in the sorted column', async () => {
        const post_message = await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:0'));
        post_message.mockClear();
        await click_button('Dismiss');
        expect(banner()).toBeNull();
        // Dismiss acknowledges; it must not touch the view.
        expect(post_message.mock.calls
            .map((call) => (call[0] as WebviewMessage).type)
            .filter((type) => type === 'setTransform')).toEqual([]);

        // A dismissal covers the edits it was pressed over, not later ones.
        await report_grid_editing(true, true, [], dirty('0:0', '1:0'));
        expect(banner()?.textContent).toContain(BANNER_TEXT);
        expect_no_call_to_action();
    });

    it('survives an identical same-session hydration', async () => {
        const post_message = await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:0'));
        await click_button('Dismiss');
        expect(banner()).toBeNull();

        // The host echo after pendingEditsChanged: same session, same dirty map,
        // same installed order. A delayed echo of what the user is already looking
        // at must not resurrect the banner they just dismissed.
        await dispatch_host_message(refresh_snapshot_message(
            make_meta(['Sheet1'], false),
            {
                capabilities: {
                    csvEditable: true,
                    csvEditingSupported: true,
                    csvEditSessionId: 'test-edit-session',
                },
                state: {
                    transforms: [{
                        sort: [{ colIndex: 0, direction: 'asc' }],
                        filters: [],
                        schema: '["Sheet1",1,null]',
                    }],
                    pendingEdits: sheet_edits(dirty('0:0')),
                },
            },
        ));
        await acknowledge_transform(latest_transform_request(post_message), 3);
        await report_grid_editing(true, true, [], dirty('0:0'));

        // The restore echo's own install landed, so the dismissal below is being held
        // against a live permuted record rather than surviving because nothing arrived.
        expect(grid_stub().getAttribute('data-generation')).toBe('3');
        expect(banner()).toBeNull();
        expect_no_call_to_action();
    });

    it('expires with the session it was pressed in', async () => {
        // Restored-session route rather than a re-grant: entering edit mode refuses
        // while a sort is installed, so a *second* session that already has both can
        // only arrive with a document load.
        const { post_message } = await render_app();
        const restored_session = async (session_id: string) => {
            await dispatch_host_message(initial_snapshot_message(
                make_meta(['Sheet1'], false),
                {
                    capabilities: {
                        csvEditable: true,
                        csvEditingSupported: true,
                        csvEditSessionId: session_id,
                    },
                    state: {
                        transforms: [{
                            sort: [{ colIndex: 0, direction: 'asc' }],
                            filters: [],
                            schema: '["Sheet1",1,null]',
                        }],
                        pendingEdits: sheet_edits(dirty('0:0')),
                    },
                },
            ));
            await acknowledge_transform(latest_transform_request(post_message), 2);
            await report_grid_editing(true, true, [], dirty('0:0'));
            expect(grid_stub().getAttribute('data-edit-mode')).toBe('true');
            // The restore installed the stored sort, so each session opens over a
            // permuted view — which is what the banner has something to say about.
            expect(grid_stub().getAttribute('data-generation')).toBe('2');
        };

        await restored_session('first-session');
        expect(banner()).not.toBeNull();
        await click_button('Dismiss');
        expect(banner()).toBeNull();

        await restored_session('second-session');

        // A different session's map is not the one that was acknowledged, even when
        // the cells happen to coincide.
        expect(banner()?.textContent).toContain(BANNER_TEXT);
        expect_no_call_to_action();
    });

    /**
     * A view permuted by `hiddenRows` alone: rows are dropped, nothing is sorted and no
     * filter is enabled, so the installed order reads no column at all. Restored the way
     * the app restores one — durable rules on a snapshot, the restore effect's request,
     * the host's record in answer — because the record has to be the host's word for the
     * `permuted` arm to be the real one.
     */
    async function edit_mode_hiding_row_1(
        hidden: readonly string[],
        edits: Record<string, { value: string; base: string }>,
    ) {
        const meta: WorkbookMeta = {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: 3,
                sourceRowCount: 3,
                columnCount: 2,
                merges: [],
                hasFormatting: false,
            }],
        };
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(meta, {
            capabilities: {
                csvEditable: true,
                csvEditingSupported: true,
                csvEditSessionId: 'hiding-only-session',
            },
            state: {
                transforms: [{
                    sort: [],
                    filters: [],
                    hiddenRows: [1],
                    schema: '["Sheet1",2,null]',
                }],
                pendingEdits: sheet_edits(edits),
            },
        }));
        await dispatch_host_message(transform_installed_message(
            latest_transform_request(post_message),
            { generation: 2, rowCount: 2, hiddenEditedCellKeys: hidden },
        ));
        await report_grid_editing(true, true, [], edits);
        // Two of the sheet's three rows: the hiding record really installed, which is
        // what makes the `permuted` arm below the host's word and not a default.
        expect(grid_stub().getAttribute('data-row-count')).toBe('2');
        return post_message;
    }

    it('says nothing about sorting for a view that only hides rows', async () => {
        // The sentence was unconditional and was simply false here: this view drops a
        // row and orders nothing, so there is no sort and no enabled filter for the
        // statement to be about. The hidden sentence has to carry the notice alone, and
        // read as a complete statement doing it.
        await edit_mode_hiding_row_1(['1:1'], dirty('1:1'));

        expect(banner()?.textContent)
            .toContain('1 edited cell is in a row this view doesn\'t show.');
        expect(banner()?.textContent).not.toContain(BANNER_TEXT);
        expect(banner()?.textContent).not.toContain('Sorting');
        expect(banner()?.textContent).not.toContain('filters');
        expect_no_call_to_action();
    });

    it('says nothing at all when a hiding-only view hides no edit', async () => {
        // The other half of the same gate: with the first sentence conditional, a view
        // that reads no column and hides no unsaved work has nothing to say. Before the
        // change this rendered the sorting sentence over a view with no sort in it.
        await edit_mode_hiding_row_1([], dirty('0:0', '0:1'));

        expect(banner()).toBeNull();
        expect_no_call_to_action();
    });

    it('says both when the order is stale and a cell is out of sight', async () => {
        // Two independent facts, two sentences, one notice — and still nothing to press.
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:0', '1:1'));

        await reinstall_with_hidden_cells(['1:1']);

        expect(banner()?.textContent).toContain(
            'Sorting and filters don\'t update while you\'re editing.'
            + ' 1 edited cell is in a row this view doesn\'t show.',
        );
        expect_no_call_to_action();
    });

    it('does not let a dismissed hidden cell silence a later stale order', async () => {
        // The two reasons occupy their own fields of the signature, so an
        // acknowledgement of one is not an acknowledgement of the other. Dismissed while
        // only the hidden half was speaking; the order half then starts.
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:1'));
        await reinstall_with_hidden_cells(['0:1']);
        expect(banner()?.textContent).not.toContain(BANNER_TEXT);
        await click_button('Dismiss');
        expect(banner()).toBeNull();

        // A second edit, this one in the sorted column. Same rules, same generation,
        // same hidden cell — a reason the dismissal never covered.
        await report_grid_editing(true, true, [], dirty('0:1', '0:0'));

        expect(banner()?.textContent).toContain(BANNER_TEXT);
        expect_no_call_to_action();
    });

    it('does not let a dismissed stale order silence a later hidden cell', async () => {
        // And the other direction, which is the one a single summed signature would
        // break: the count of things said would be unchanged.
        await edit_mode_sorted_on_column_0();
        await report_grid_editing(true, true, [], dirty('0:0'));
        expect(banner()?.textContent).toContain(BANNER_TEXT);
        expect(banner()?.textContent).not.toContain('doesn\'t show');
        await click_button('Dismiss');
        expect(banner()).toBeNull();

        // The same edit, now in a row the view has stopped showing.
        await reinstall_with_hidden_cells(['0:0']);

        expect(banner()?.textContent)
            .toContain('1 edited cell is in a row this view doesn\'t show.');
        expect_no_call_to_action();
    });
});

// The invariant `SheetViewRecord` now carries as a shape, enforced by the compiler and
// by no test: a record the webview retained across a same-basis refresh must have no
// `rules` and no `hiddenEditedCellKeys` on it unless it describes a permutation, because
// neither is a fact about the rows a non-permuted view contains and basis equality is
// evidence about nothing else. Three review rounds of this PR were each a reader taking
// one of those fields off a record that had gone stale in exactly that way, and the last
// of them shipped a paragraph naming which reader was entitled to read what. `Extract` of
// the fields from the non-permuted arm's keys must be `never`, or this alias resolves to
// `never` and the assignment stops compiling.
type _NonPermutedViewDescribesNoRows = Extract<
    keyof Extract<SheetViewRecord, { permuted: false }>,
    'rules' | 'hiddenEditedCellKeys'
> extends never ? true : never;
const _non_permuted_view_describes_no_rows: _NonPermutedViewDescribesNoRows = true;
void _non_permuted_view_describes_no_rows;

// One `SheetViewRecord` per sheet, one generation for the whole core: an install
// bumps the core's counter, so every *other* sheet's record is left quoting a
// generation the core has moved past even though its own rows never moved. What a
// long compute plus a sheet switch reaches, and what the next refresh then decides.
describe('per-sheet view records', () => {
    function two_sheet_meta(row_count = 5): WorkbookMeta {
        const meta = make_meta(['First', 'Second'], false);
        return {
            ...meta,
            sheets: meta.sheets.map((sheet) => ({
                ...sheet,
                rowCount: row_count,
                sourceRowCount: row_count,
            })),
        };
    }

    const FIRST_SORT: SheetTransformState = {
        sort: [{ colIndex: 0, direction: 'asc' }],
        filters: [],
        schema: '["First",1,null]',
    };
    const SECOND_SORT: SheetTransformState = {
        sort: [{ colIndex: 0, direction: 'desc' }],
        filters: [],
        schema: '["Second",1,null]',
    };
    const DURABLE = { transforms: [FIRST_SORT, SECOND_SORT] };

    /**
     * Which sheet is on screen and how many rows its record claims. The row count is the
     * whole discriminant here and is meant to be: the fixture below gives the two sheets
     * different counts, both different from the natural 5, so a record swapped for
     * another sheet's or for the natural view shows up as a wrong number.
     */
    function view(): { sheet: string | null; rows: string | null } {
        return {
            sheet: grid_stub().getAttribute('data-sheet-index'),
            rows: grid_stub().getAttribute('data-row-count'),
        };
    }

    /**
     * Both sheets permuted, each by its own install, so the two records carry
     * different generations — 2 for First, 3 for Second — while the core's counter
     * ends at 3. Row counts differ from each other and from the natural 5, so a
     * record swapped for another sheet's or for the natural view is distinguishable
     * from a record that stood.
     */
    async function both_sheets_installed() {
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(two_sheet_meta(), {
            state: DURABLE,
        }));
        const first = latest_transform_request(post_message);
        expect(first.sheetIndex).toBe(0);
        await dispatch_host_message(transform_installed_message(
            first,
            { generation: 2, rowCount: 3 },
        ));
        await click_button('Second');
        const second = latest_transform_request(post_message);
        expect(second.sheetIndex).toBe(1);
        await dispatch_host_message(transform_installed_message(
            second,
            { generation: 3, rowCount: 4 },
        ));
        expect(view()).toEqual({ sheet: '1', rows: '4' });
        return { post_message };
    }

    it('does not disturb another sheet\'s record when an install lands', async () => {
        await both_sheets_installed();

        await click_button('First');

        // Each record is the one its own install wrote: the second install bumped
        // the shared generation but moved no row on this sheet.
        expect(view()).toEqual({ sheet: '0', rows: '3' });
    });

    it('keeps a record whose rows an install on another sheet never moved', async () => {
        const { post_message } = await both_sheets_installed();
        post_message.mockClear();

        // The refresh every capability re-projection delivers, on the core's current
        // generation. First's record was written at generation 2 and Second's install
        // moved the counter to 3 without touching First's rows, so a basis comparison
        // that reads the generation alone calls First's record stale and replaces it
        // with the natural view — while the host's loader is still permuting those
        // rows and still reporting three of them.
        await dispatch_host_message(refresh_snapshot_message(two_sheet_meta(), {
            generation: 3,
            sourceGeneration: 1,
            reason: 'other',
            state: DURABLE,
        }));

        expect(view()).toEqual({ sheet: '1', rows: '4' });
        await click_button('First');
        expect(view()).toEqual({ sheet: '0', rows: '3' });
        // And nothing had to be re-asked to get back there: a dropped record shows up
        // as a restore request for rules the host already holds.
        expect(post_message.mock.calls
            .map((call) => call[0] as WebviewMessage)
            .filter((message) => message.type === 'setTransform')).toEqual([]);
    });

    it('lands a compute for the sheet the user has since left without corrupting either record', async () => {
        // The sequence: a slow install is in flight on First, the user switches to
        // Second, and the ack then arrives for a sheet that is no longer active.
        const { post_message } = await render_app();
        await dispatch_host_message(initial_snapshot_message(two_sheet_meta(), {
            state: DURABLE,
        }));
        const first = latest_transform_request(post_message);
        expect(first.sheetIndex).toBe(0);

        await click_button('Second');
        const second = latest_transform_request(post_message);
        expect(second.sheetIndex).toBe(1);
        await dispatch_host_message(transform_installed_message(
            second,
            { generation: 2, rowCount: 4 },
        ));
        expect(view()).toEqual({ sheet: '1', rows: '4' });

        // First's compute lands last, on the generation the core reached after both.
        await dispatch_host_message(transform_installed_message(
            first,
            { generation: 3, rowCount: 3 },
        ));

        // The active sheet is Second, and its record must be untouched by an ack
        // addressed to another sheet.
        expect(view()).toEqual({ sheet: '1', rows: '4' });
        await click_button('First');
        expect(view()).toEqual({ sheet: '0', rows: '3' });
    });
});
