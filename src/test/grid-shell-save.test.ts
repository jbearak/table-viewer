// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsvSaveLifecycle, CsvSaveOperation } from '../types';
import type { EditingHandle } from '../webview/grid-shell';
import {
    create_edit_session_store,
    type EditSessionStore,
} from '../webview/edit-session-store';

const grid_mock = vi.hoisted(() => ({
    props: null as null | {
        onCellsEdited?: (
            items: readonly { location: [number, number]; value: { kind: string; data: string } }[],
            source: string,
        ) => boolean | void;
        onGridSelectionChange?: (selection: unknown) => void;
        getCellContent?: (cell: [number, number]) => {
            data?: string;
            allowOverlay?: boolean;
            readonly?: boolean;
        };
        onPaste?: boolean | ((target: [number, number], values: readonly (readonly string[])[]) => boolean);
        fillHandle?: boolean;
    },
    // Display row → canonical source row, and source row → that row's raw text.
    //
    // Both default to the identity/one-row fixture below, which is what a CSV
    // with no transform installed actually reports. They are overridable because
    // under an identity mapping a display-keyed and a source-keyed implementation
    // are indistinguishable: any assertion about *which* row space a durable edit
    // key is in is vacuous unless the two spaces are made to diverge. Keying the
    // text fixture by source row (not display row) keeps the cell contents
    // attached to the right row however the mapping is permuted.
    source_row_for_display: null as null | ((display_row: number) => number | undefined),
    text_for_source_row: null as null | ((source_row: number) => readonly string[]),
}));

vi.mock('../webview/glide-data-grid', () => {
    const React = require('react') as typeof import('react');
    return {
        CompactSelection: { empty: () => ({}) },
        DataEditor: React.forwardRef((props: unknown, ref: React.ForwardedRef<unknown>) => {
            grid_mock.props = props as typeof grid_mock.props;
            React.useImperativeHandle(ref, () => ({
                updateCells: vi.fn(),
                scrollTo: vi.fn(),
                dismissOverlay: vi.fn(),
            }));
            return React.createElement('div', { className: 'data-editor-stub' });
        }),
        GridCellKind: { Text: 'text' },
    };
});

// Text a source row carries, honouring the overridable fixture.
const source_row_text = vi.hoisted(() => (source_row: number): readonly string[] => (
    grid_mock.text_for_source_row
        ? grid_mock.text_for_source_row(source_row)
        : (source_row === 0 ? ['base', 'middle', 'source-two'] : ['', '', ''])
));

// Residency, modelled the way the real loader's source→page index defines it: a
// source row is readable exactly when some *display* row in the window claims it.
// Scanning a bounded display window stands in for the index; the harness only ever
// renders a handful of rows.
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
    use_row_loader: () => ({
        ensure_rows: vi.fn(),
        // Rows are looked up by display row but their *contents* are addressed by
        // source row, exactly as the real loader does: the host ships each page's
        // sourceRows alongside its rows, and a permuted view reorders the rows
        // without renaming their canonical identities.
        get_row: (display_row: number) => {
            const source_row = grid_mock.source_row_for_display
                ? grid_mock.source_row_for_display(display_row)
                : display_row;
            // Page not resident: the real loader returns undefined, which
            // get_cell_raw must forward as "unknown", never as a blank cell.
            if (source_row === undefined) return undefined;
            return source_row_text(source_row).map((raw) => ({
                raw,
                formatted: raw,
                bold: false,
                italic: false,
            }));
        },
        get_source_row: (display_row: number) => (
            grid_mock.source_row_for_display
                ? grid_mock.source_row_for_display(display_row)
                : display_row
        ),
        get_cell_raw_for_source: (source_row: number, col: number) => {
            if (resident_display_row(source_row) === undefined) return undefined;
            const raw = source_row_text(source_row)[col];
            return raw === undefined ? '' : String(raw);
        },
        has_source_row: (source_row: number) => resident_display_row(source_row) !== undefined,
        sample_loaded_rows: () => [],
        version: 0,
    }),
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
    RowResizeOverlay: React.forwardRef((_props: unknown, ref: React.ForwardedRef<unknown>) => {
        React.useImperativeHandle(ref, () => ({ set_target: vi.fn() }));
        return null;
    }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let active_post_message: ReturnType<typeof vi.fn> | null = null;
let save_request_sequence = 0;
let save_lifecycle_revision = 0;

function posted_save(
    post_message: ReturnType<typeof vi.fn>,
): CsvSaveOperation | undefined {
    return [...post_message.mock.calls]
        .reverse()
        .map(([message]) => message)
        .find((message) => message?.type === 'saveCsv')?.operation;
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render_grid(
    column_projection = {
        visible_to_source: [0],
        source_to_visible: [0, undefined, undefined],
        hidden_count: 2,
    },
    save_props: {
        save_operation?: CsvSaveOperation;
        save_lifecycle?: CsvSaveLifecycle;
        initial_edits?: Record<string, string | { value: string; base: string }>;
        edit_session?: EditSessionStore;
        use_fallback_store?: boolean;
        host_rejected_keys?: readonly string[];
        on_editing_change?: (status: {
            is_dirty: boolean;
            has_live_uncommitted: boolean;
            save_in_flight: boolean;
            edits: Record<string, { value: string; base: string }>;
            conflicted: readonly string[];
        }) => void;
        generation?: number;
        highlight_in_flight?: boolean;
        on_save_request?: () => CsvSaveOperation | undefined;
    } = {},
) {
    vi.resetModules();
    const post_message = vi.fn();
    active_post_message = post_message;
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

    const {
        use_fallback_store = false,
        ...grid_save_props
    } = save_props;
    const test_edit_session = Object.prototype.hasOwnProperty.call(save_props, 'edit_session')
        ? save_props.edit_session
        : use_fallback_store
            ? undefined
            : create_edit_session_store(
                { session_id: 'session-1' },
                save_props.initial_edits,
            );
    const props = {
        sheet_meta: {
            name: 'Sheet1',
            rowCount: 1,
            sourceRowCount: 1,
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
        edit_session_id: 'session-1',
        ...(test_edit_session ? { edit_session: test_edit_session } : {}),
        on_save_request: () => {
            if (!test_edit_session) return undefined;
            const snapshot = test_edit_session.snapshot();
            const edits = Object.fromEntries([...snapshot].map(([key, entry]) => [
                key,
                entry.value,
            ]));
            const dirtyEdits = Object.fromEntries(snapshot);
            if (Object.keys(edits).length === 0) return undefined;
            const operation: CsvSaveOperation = {
                editSessionId: 'session-1',
                saveRequestId: `save-${++save_request_sequence}`,
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'Sheet1',
                    edits,
                    dirtyEdits,
                }],
            };
            post_message({ type: 'saveCsv', operation });
            return operation;
        },
        editing_ref,
        ...grid_save_props,
    };
    const rerender_save_lifecycle = async (save_lifecycle: CsvSaveLifecycle) => {
        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...props,
                save_lifecycle,
            }));
        });
    };
    const rerender_highlight_in_flight = async (highlight_in_flight: boolean) => {
        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...props,
                highlight_in_flight,
            }));
        });
    };
    // Model what App does on a transform/refresh ack: the generation bump moves
    // GridShell's key, so the mount is destroyed and rebuilt. The key lives in
    // App, so the test has to supply one to force the unmount.
    const remount_at_generation = async (generation: number) => {
        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...props,
                key: `gen-${generation}`,
                generation,
            }));
        });
    };

    await act(async () => {
        root!.render(React.createElement(GridShell, props));
    });

    return {
        post_message,
        editing_ref,
        rerender_save_lifecycle,
        rerender_highlight_in_flight,
        remount_at_generation,
    };
}

async function edit_cell(value: string) {
    await act(async () => {
        grid_mock.props!.onCellsEdited!(
            [{ location: [0, 0], value: { kind: 'text', data: value } }],
            'edit',
        );
    });
}

async function request_save(editing_ref: React.RefObject<EditingHandle | null>) {
    let result = false;
    await act(async () => {
        result = editing_ref.current!.request_save();
    });
    return result;
}

async function save_result(success: boolean) {
    const save = [...(active_post_message?.mock.calls ?? [])]
        .reverse()
        .map(([message]) => message)
        .find((message) => message?.type === 'saveCsv');
    await save_result_for(save, success);
}

async function save_result_for(
    save: { operation?: {
        editSessionId: string;
        saveRequestId: string;
        edits: Record<string, string>;
        dirtyEdits: Record<string, { value: string; base: string }>;
    } } | undefined,
    success: boolean,
) {
    if (!save?.operation) throw new Error('No save operation was posted.');
    await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'saveResult',
            success,
            lifecycle: {
                revision: ++save_lifecycle_revision,
                state: success ? 'succeeded' : 'failed',
                operation: save.operation,
            },
        } }));
    });
}

function save_messages(post_message: ReturnType<typeof vi.fn>) {
    return post_message.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg && typeof msg === 'object' && 'type' in msg && msg.type === 'saveCsv')
        .map((msg) => ({ type: msg.type, edits: msg.operation.worksheets[0].edits }));
}

function pending_edit_messages(post_message: ReturnType<typeof vi.fn>) {
    return post_message.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => (
            msg && typeof msg === 'object' && 'type' in msg
            && msg.type === 'pendingEditsChanged'
        ))
        .map((msg) => ({ edits: msg.edits }));
}

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    active_post_message = null;
    save_request_sequence = 0;
    save_lifecycle_revision = 0;
    document.body.innerHTML = '';
    grid_mock.props = null;
    // Back to the identity mapping: a leaked permutation would silently change
    // which source row every later test's edits land on.
    grid_mock.source_row_for_display = null;
    grid_mock.text_for_source_row = null;
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

        expect(await request_save(editing_ref)).toBe(true);
        expect(save_messages(post_message)).toEqual([{
            type: 'saveCsv',
            edits: { '0:2': 'projected' },
        }]);
    });

    it('leaves document-lifetime flush ownership outside GridShell', async () => {
        const { post_message } = await render_grid();
        await edit_cell('draft');
        const produced = post_message.mock.calls
            .map(([message]) => message)
            .filter((message) => message?.type === 'pendingEditsChanged')
            .at(-1);
        expect(produced).toMatchObject({
            editSessionId: 'session-1',
            edits: { '0:0': { value: 'draft', base: 'base' } },
        });

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'pendingEditsAcknowledged',
                editSessionId: 'session-1',
                sequence: produced.sequence,
            } }));
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'requestPendingEditsFlush',
                requestId: 'close-1',
            } }));
            await Promise.resolve();
        });

        const flush = post_message.mock.calls
            .map(([message]) => message)
            .find((message) => (
                message?.type === 'pendingEditsFlush'
                && message.requestId === 'close-1'
            ));
        expect(flush).toEqual({
            type: 'pendingEditsFlush',
            requestId: 'close-1',
            editSessionId: undefined,
            highestProducedSequence: 0,
        });
    });

    it('blocks edits and overlapping saves while a save is in flight', async () => {
        const { post_message, editing_ref } = await render_grid();

        await edit_cell('first');
        post_message.mockClear();

        expect(await request_save(editing_ref)).toBe(true);
        expect(save_messages(post_message)).toEqual([{ type: 'saveCsv', edits: { '0:0': 'first' } }]);

        await edit_cell('second');
        expect(await request_save(editing_ref)).toBe(false);
        expect(save_messages(post_message)).toEqual([{ type: 'saveCsv', edits: { '0:0': 'first' } }]);

        await save_result(true);
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(false);

        post_message.mockClear();
        expect(await request_save(editing_ref)).toBe(false);
        expect(save_messages(post_message)).toEqual([]);
    });

    it('stops offering an editor while a highlight gesture awaits the host', async () => {
        const store = create_edit_session_store({ session_id: 'session-1' });
        const { rerender_highlight_in_flight } = await render_grid(undefined, {
            edit_session: store,
        });

        // The affordance, not the barrier: a cell must not OPEN across the
        // highlight round trip, so nothing the user types is silently swallowed.
        // Keeping such an edit out of the history is App's `gestures_admitted`
        // (see use-editing.test.ts) — which also covers the hyperlink dialog,
        // reaching the store with no editability flag here to consult.
        await rerender_highlight_in_flight(true);
        expect(grid_mock.props!.getCellContent!([0, 0]).allowOverlay).toBe(false);
        expect(grid_mock.props!.onPaste).toBe(false);
        expect(grid_mock.props!.fillHandle).toBe(false);

        // The window is one host round trip. The ack reopens editing.
        await rerender_highlight_in_flight(false);
        expect(grid_mock.props!.getCellContent!([0, 0]).allowOverlay).toBe(true);
        expect(grid_mock.props!.onPaste).toBe(true);
        await edit_cell('after ack');
        expect(Object.fromEntries(store.snapshot())).toHaveProperty('0:0');
    });

    it('blocks edit and clear mutations until a failed save re-enables editing', async () => {
        const { post_message, editing_ref } = await render_grid();
        await edit_cell('first');
        post_message.mockClear();
        expect(await request_save(editing_ref)).toBe(true);

        await edit_cell('too late');
        editing_ref.current!.clear_dirty();
        await save_result(false);
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);

        post_message.mockClear();
        expect(await request_save(editing_ref)).toBe(true);
        expect(save_messages(post_message)).toEqual([{
            type: 'saveCsv', edits: { '0:0': 'first' },
        }]);
    });

    // The host reads any pendingEditsChanged as "the user moved on from the failed
    // save" and retires the failed lifecycle, so an echo of the failed operation's
    // own map would strand the durable edits it wrote before the disk write.
    //
    // The echo needs App's half of the flow to appear: on a failed saveResult App
    // re-installs the session store with resolve_csv_save_hydration's restore, and
    // install force-notifies across that hydration boundary (edit-session-store.ts
    // set_entries(..., true)), so the persistence effect re-runs with a fresh map
    // identity carrying the failed operation's own edits. There is no App here, so
    // the install is driven directly on a store passed in as `edit_session` —
    // exactly what app.tsx's failed branch does, same arguments.
    it('posts pendingEditsChanged at most once across a failed save', async () => {
        const edit_session = create_edit_session_store({ session_id: 'session-1' });
        const { post_message, editing_ref } = await render_grid(undefined, { edit_session });
        await edit_cell('first');

        post_message.mockClear();
        expect(await request_save(editing_ref)).toBe(true);
        // Capture the saveCsv before clearing: save_result searches the mock calls
        // for it, so a clear here would destroy what settles the save.
        const save = post_message.mock.calls.map(([msg]) => msg)
            .find((msg) => msg?.type === 'saveCsv');
        post_message.mockClear();
        await save_result_for(save, false);

        // App's install at the hydration boundary, with the restore the real failed
        // branch computes: the failed operation's own dirtyEdits.
        await act(async () => {
            edit_session.install(
                { session_id: 'session-1' },
                save!.operation!.worksheets[0].dirtyEdits,
            );
        });

        expect(pending_edit_messages(post_message)).toEqual([]);
    });

    it('still posts a genuinely new edit after a failed save', async () => {
        const edit_session = create_edit_session_store({ session_id: 'session-1' });
        const { post_message, editing_ref } = await render_grid(undefined, { edit_session });
        await edit_cell('first');
        expect(await request_save(editing_ref)).toBe(true);
        await save_result(false);
        // Same hydration-boundary install as above, so the dedupe ref is primed with
        // the failed map before the new keystroke.
        await act(async () => {
            edit_session.install(
                { session_id: 'session-1' },
                { '0:0': { value: 'first', base: 'base' } },
            );
        });

        // A real keystroke after the failure must still reach the host: the dedupe
        // suppresses the echo, never a genuine change.
        post_message.mockClear();
        await edit_cell('second');
        expect(pending_edit_messages(post_message)).toEqual([
            { edits: { '0:0': { value: 'second', base: 'base' } } },
        ]);
    });

    it('does not clear dirty edits on a duplicate success after a failed save', async () => {
        const { post_message, editing_ref } = await render_grid();

        await edit_cell('first');
        post_message.mockClear();

        expect(await request_save(editing_ref)).toBe(true);
        expect(save_messages(post_message)).toEqual([{ type: 'saveCsv', edits: { '0:0': 'first' } }]);

        await save_result(false);
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);
        await edit_cell('second');
        post_message.mockClear();
        expect(await request_save(editing_ref)).toBe(true);
        expect(save_messages(post_message)).toEqual([{
            type: 'saveCsv', edits: { '0:0': 'second' },
        }]);

        await save_result(false);
        await save_result(true);

        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);
    });

    it('does not let an old save result settle a newer in-flight request', async () => {
        const { post_message, editing_ref } = await render_grid();
        await edit_cell('first');
        post_message.mockClear();
        expect(await request_save(editing_ref)).toBe(true);
        const save_a = post_message.mock.calls[0][0];
        await save_result_for(save_a, false);

        await edit_cell('second');
        expect(await request_save(editing_ref)).toBe(true);
        const saves = post_message.mock.calls
            .map(([message]) => message)
            .filter((message) => message?.type === 'saveCsv');
        const save_b = saves.at(-1);

        await save_result_for(save_a, true);
        expect(await request_save(editing_ref)).toBe(false);
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);

        await save_result_for(save_b, false);
        expect(await request_save(editing_ref)).toBe(true);
        expect(save_messages(post_message).at(-1)).toEqual({
            type: 'saveCsv',
            edits: { '0:0': 'second' },
        });
    });

    it('includes an open editor value before closing the save boundary', async () => {
        const { post_message, editing_ref } = await render_grid();
        await act(async () => {
            grid_mock.props!.onGridSelectionChange!({
                current: {
                    cell: [0, 0],
                    range: { x: 0, y: 0, width: 1, height: 1 },
                    rangeStack: [],
                },
                columns: {},
                rows: {},
            });
        });
        const clip = document.createElement('div');
        clip.className = 'gdg-clip-region';
        const input = document.createElement('input');
        input.value = 'open editor value';
        clip.appendChild(input);
        document.body.appendChild(clip);
        post_message.mockClear();

        expect(await request_save(editing_ref)).toBe(true);
        expect(save_messages(post_message)).toEqual([{
            type: 'saveCsv', edits: { '0:0': 'open editor value' },
        }]);
        expect(post_message.mock.calls.at(-1)?.[0].operation.worksheets[0].dirtyEdits).toEqual({
            '0:0': { value: 'open editor value', base: 'base' },
        });
        await edit_cell('too late');
        expect(save_messages(post_message)).toHaveLength(1);
    });

    it('hydrates an active operation across remount and restores its exact map on failure', async () => {
        const operation: CsvSaveOperation = {
            editSessionId: 'session-1',
            saveRequestId: 'accepted-overlay',
            worksheets: [{
                sheetIndex: 0,
                edits: { '0:0': 'overlay' },
                dirtyEdits: {
                    '0:0': { value: 'overlay', base: 'exact-conflict-base' },
                },
            }],
        };
        const edit_session = create_edit_session_store(
            { session_id: 'session-1' },
            operation.worksheets[0].dirtyEdits,
        );
        const { post_message, editing_ref } = await render_grid(undefined, {
            save_lifecycle: { revision: 4, state: 'active', operation },
            edit_session,
        });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('overlay');
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);
        expect(await request_save(editing_ref)).toBe(false);

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'saveResult',
                success: false,
                lifecycle: { revision: 5, state: 'failed', operation },
            } }));
        });
        expect(await request_save(editing_ref)).toBe(true);
        expect(post_message.mock.calls.at(-1)?.[0].operation.worksheets[0].dirtyEdits).toEqual({
            '0:0': { value: 'overlay', base: 'exact-conflict-base' },
        });
    });

    it('unlocks and restores its proposal after a correlated malformed-request failure', async () => {
        const { post_message, editing_ref } = await render_grid();
        await edit_cell('first');
        post_message.mockClear();
        expect(await request_save(editing_ref)).toBe(true);
        const first = posted_save(post_message)!;

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'saveResult',
                success: false,
                lifecycle: {
                    revision: 1,
                    state: 'failed',
                    failure: 'malformedRequest',
                    correlation: {
                        editSessionId: first.editSessionId,
                        saveRequestId: first.saveRequestId,
                    },
                },
            } }));
        });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('first');
        expect(await request_save(editing_ref)).toBe(true);
        const saves = post_message.mock.calls
            .map(([message]) => message)
            .filter((message) => message?.type === 'saveCsv');
        expect(saves).toHaveLength(2);
        expect(saves[1].operation.worksheets[0].dirtyEdits).toEqual(
            first.worksheets[0].dirtyEdits,
        );
    });

    it('unlocks without replacing valid state from a malformed local proposal', async () => {
        const dirty = { '0:0': { value: 'first', base: 'base' } };
        const edit_session = create_edit_session_store(
            { session_id: 'session-1' },
            dirty,
        );
        const malformed = {
            editSessionId: 'session-1',
            saveRequestId: 'malformed-local',
            worksheets: [{
                sheetIndex: 0,
                sheetName: 'Sheet1',
                edits: { '0:0': 'first' },
                dirtyEdits: { '0:0': null },
            }],
        } as unknown as CsvSaveOperation;
        const { post_message, editing_ref } = await render_grid(undefined, {
            save_operation: malformed,
            edit_session,
        });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('first');
        expect(await request_save(editing_ref)).toBe(false);

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'saveResult',
                success: false,
                lifecycle: {
                    revision: 1,
                    state: 'failed',
                    failure: 'malformedRequest',
                    correlation: {
                        editSessionId: malformed.editSessionId,
                        saveRequestId: malformed.saveRequestId,
                    },
                },
            } }));
        });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('first');
        expect(Object.fromEntries(edit_session.snapshot())).toEqual(dirty);
        expect(await request_save(editing_ref)).toBe(true);
        const retry = posted_save(post_message)!;
        expect(retry.saveRequestId).not.toBe(malformed.saveRequestId);
        expect(retry.worksheets[0].dirtyEdits).toEqual(dirty);
        expect(retry.worksheets[0].edits).toEqual({ '0:0': 'first' });
    });

    it('ignores a raw active lifecycle with an empty worksheet list', async () => {
        const dirty = { '0:0': { value: 'safe', base: 'base' } };
        const { post_message, editing_ref } = await render_grid(undefined, {
            initial_edits: dirty,
        });

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'saveOperationStarted',
                lifecycle: {
                    revision: 1,
                    state: 'active',
                    operation: {
                        editSessionId: 'session-1',
                        saveRequestId: 'empty-workbook',
                        worksheets: [],
                    },
                },
            } }));
        });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('safe');
        expect(await request_save(editing_ref)).toBe(true);
        expect(posted_save(post_message)?.worksheets[0].dirtyEdits).toEqual(dirty);
    });

    it('does not hydrate either of two targets that alias its live worksheet', async () => {
        const dirty = { '0:0': { value: 'safe', base: 'base' } };
        const aliased: CsvSaveOperation = {
            editSessionId: 'session-1',
            saveRequestId: 'aliased-targets',
            worksheets: [
                {
                    sheetIndex: 1,
                    sheetName: 'Sheet1',
                    edits: { '0:0': 'by-name' },
                    dirtyEdits: { '0:0': { value: 'by-name', base: 'name-base' } },
                },
                {
                    sheetIndex: 0,
                    edits: { '0:0': 'by-index' },
                    dirtyEdits: { '0:0': { value: 'by-index', base: 'index-base' } },
                },
            ],
        };
        const { post_message, editing_ref } = await render_grid(undefined, {
            save_lifecycle: { revision: 8, state: 'failed', operation: aliased },
            initial_edits: dirty,
        });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('safe');
        expect(await request_save(editing_ref)).toBe(true);
        expect(posted_save(post_message)?.worksheets[0].dirtyEdits).toEqual(dirty);
    });

    it('keeps the exact dirty map locked through delayed idle before active acceptance', async () => {
        const failed: CsvSaveOperation = {
            editSessionId: 'older-session',
        saveRequestId: 'failed-r2',
        worksheets: [{
            sheetIndex: 0,
            edits: { '0:0': 'older' },
            dirtyEdits: { '0:0': { value: 'older', base: 'older-base' } },
        }],
        };
        const { post_message, editing_ref, rerender_save_lifecycle } = await render_grid(undefined, {
            save_lifecycle: { revision: 2, state: 'failed', operation: failed },
        });
        await edit_cell('proposed');
        post_message.mockClear();
        expect(await request_save(editing_ref)).toBe(true);
        const save = post_message.mock.calls.find(([message]) => (
            message?.type === 'saveCsv'
        ))?.[0];
        const operation = save.operation as CsvSaveOperation;

        await rerender_save_lifecycle({ revision: 3, state: 'idle' });
        await rerender_save_lifecycle({ revision: 4, state: 'active', operation });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('proposed');
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);
        expect(await request_save(editing_ref)).toBe(false);
    });

    it('does not rehydrate operation-owned edits from a succeeded snapshot', async () => {
        const operation: CsvSaveOperation = {
            editSessionId: 'session-1',
        saveRequestId: 'already-written',
        worksheets: [{
            sheetIndex: 0,
            edits: { '0:0': 'saved' },
            dirtyEdits: { '0:0': { value: 'saved', base: 'base' } },
        }],
        };
        const { editing_ref } = await render_grid(undefined, {
            save_lifecycle: { revision: 8, state: 'succeeded', operation },
            initial_edits: operation.worksheets[0].dirtyEdits,
            use_fallback_store: true,
        });

        expect(editing_ref.current!.has_uncommitted_changes()).toBe(false);
        expect(await request_save(editing_ref)).toBe(false);
    });

    it('does not hydrate a failed operation into a different current session', async () => {
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
        const { post_message, editing_ref } = await render_grid(undefined, {
            save_lifecycle: { revision: 8, state: 'failed', operation: failed },
            initial_edits: newer,
        });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('newer');
        expect(await request_save(editing_ref)).toBe(true);
        expect(post_message.mock.calls.at(-1)?.[0].operation.worksheets[0].dirtyEdits).toEqual(newer);
    });

    it('preserves a newer session across an older succeeded lifecycle', async () => {
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
        const { post_message, editing_ref } = await render_grid(undefined, {
            save_lifecycle: { revision: 8, state: 'succeeded', operation: succeeded },
            initial_edits: newer,
        });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('newer');
        expect(await request_save(editing_ref)).toBe(true);
        expect(post_message.mock.calls.at(-1)?.[0].operation.worksheets[0].dirtyEdits).toEqual(newer);
    });

    it('ignores a live failed lifecycle from a different session', async () => {
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
        const { post_message, editing_ref } = await render_grid(undefined, {
            initial_edits: newer,
        });

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'saveResult',
                success: false,
                lifecycle: { revision: 1, state: 'failed', operation: failed },
            } }));
        });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('newer');
        expect(await request_save(editing_ref)).toBe(true);
        expect(post_message.mock.calls.at(-1)?.[0].operation.worksheets[0].dirtyEdits).toEqual(newer);
    });

    it('fences an active lifecycle for another sheet in the workbook session', async () => {
        const own = { '0:0': { value: 'own draft', base: 'base' } };
        const other: CsvSaveOperation = {
            editSessionId: 'session-1',
        saveRequestId: 'other-sheet-save',
        worksheets: [{
            sheetIndex: 1,
            sheetName: 'Sheet2',
            edits: { '0:0': 'other draft' },
            dirtyEdits: { '0:0': { value: 'other draft', base: 'other base' } },
        }],
        };
        const store = create_edit_session_store({ session_id: 'session-1' }, own);
        const { editing_ref } = await render_grid(undefined, { edit_session: store });

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'saveOperationStarted',
                lifecycle: { revision: 1, state: 'active', operation: other },
            } }));
        });

        expect(Object.fromEntries(store.snapshot())).toEqual(own);
        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('own draft');
        expect(await request_save(editing_ref)).toBe(false);
    });

    it('accepts a valid workbook save that contains only a sibling worksheet', async () => {
        const operation: CsvSaveOperation = {
            editSessionId: 'session-1',
            saveRequestId: 'sibling-only-save',
            worksheets: [{
                sheetIndex: 1,
                sheetName: 'Sheet2',
                edits: { '0:0': 'sibling draft' },
                dirtyEdits: { '0:0': { value: 'sibling draft', base: 'sibling base' } },
            }],
        };
        const on_save_request = vi.fn(() => operation);
        const { editing_ref } = await render_grid(undefined, { on_save_request });

        expect(await request_save(editing_ref)).toBe(true);
        expect(on_save_request).toHaveBeenCalledOnce();
    });

    it('installs a workbook save lock for a sibling-only operation', async () => {
        let request = 0;
        const on_save_request = vi.fn((): CsvSaveOperation => ({
            editSessionId: 'session-1',
            saveRequestId: `sibling-only-save-${++request}`,
            worksheets: [{
                sheetIndex: 1,
                sheetName: 'Sheet2',
                edits: { '0:0': 'sibling draft' },
                dirtyEdits: { '0:0': { value: 'sibling draft', base: 'sibling base' } },
            }],
        }));
        const store = create_edit_session_store({ session_id: 'session-1' }, {
            '0:0': { value: 'own draft', base: 'base' },
        });
        const { editing_ref } = await render_grid(undefined, {
            edit_session: store,
            on_save_request,
        });

        expect(await request_save(editing_ref)).toBe(true);
        await edit_cell('newer own draft');
        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('own draft');
        expect(await request_save(editing_ref)).toBe(false);
        expect(on_save_request).toHaveBeenCalledOnce();
    });

    it('blocks a revert while the save is in flight', async () => {
        const { post_message, editing_ref } = await render_grid();

        await edit_cell('first');
        post_message.mockClear();

        expect(await request_save(editing_ref)).toBe(true);
        expect(save_messages(post_message)).toEqual([{ type: 'saveCsv', edits: { '0:0': 'first' } }]);

        await edit_cell('base');
        await save_result(true);

        expect(editing_ref.current!.has_uncommitted_changes()).toBe(false);

        post_message.mockClear();
        expect(await request_save(editing_ref)).toBe(false);
        expect(save_messages(post_message)).toEqual([]);
    });
});

// The dirty map used to live inside the generation-keyed mount, so a transform
// or refresh ack destroyed it. With an App-owned session store the mount is a
// view over state that outlives it.
describe('GridShell edits across a generation bump', () => {
    it('keeps committed edits when the generation remounts the shell', async () => {
        const store = create_edit_session_store({ session_id: 'session-1' });
        const { editing_ref, remount_at_generation } = await render_grid(undefined, {
            edit_session: store,
            generation: 1,
        });

        await edit_cell('survivor');
        await remount_at_generation(2);

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('survivor');
        expect(editing_ref.current!.has_uncommitted_changes()).toBe(true);
    });

    it('loses committed edits across the same remount without a store', async () => {
        // The negative control for the test above: with the mount-scoped fallback
        // store the remount re-seeds from initial_edits and the edit is gone. If
        // this ever starts reporting 'survivor', the test above proves nothing.
        const { remount_at_generation } = await render_grid(undefined, {
            generation: 1,
            use_fallback_store: true,
        });

        await edit_cell('survivor');
        await remount_at_generation(2);

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('base');
    });

    it('commit_live_edit writes through to the store synchronously', async () => {
        const store = create_edit_session_store({ session_id: 'session-1' });
        const { editing_ref } = await render_grid(undefined, {
            edit_session: store,
            generation: 1,
        });

        const clip = document.createElement('div');
        clip.className = 'gdg-clip-region';
        const input = document.createElement('input');
        input.value = 'typed but not closed';
        clip.appendChild(input);
        document.body.appendChild(clip);
        await act(async () => {
            grid_mock.props!.onGridSelectionChange!({
                columns: {},
                rows: {},
                current: {
                    cell: [0, 0],
                    range: { x: 0, y: 0, width: 1, height: 1 },
                    rangeStack: [],
                },
            });
        });

        editing_ref.current!.commit_live_edit();

        // Asserted outside act on purpose: the fold before a generation bump only
        // works because this write lands before React flushes anything, so an
        // assertion inside act would not distinguish it from a state update.
        expect(store.snapshot().get('0:0')).toEqual({
            value: 'typed but not closed',
            base: 'base',
        });
    });

    it('flushes an open editor to pending-edit durability before returning', async () => {
        const store = create_edit_session_store({ session_id: 'session-1' });
        const { post_message, editing_ref } = await render_grid(undefined, {
            edit_session: store,
            generation: 1,
        });
        const clip = document.createElement('div');
        clip.className = 'gdg-clip-region';
        const input = document.createElement('input');
        input.value = 'typed but not closed';
        clip.appendChild(input);
        document.body.appendChild(clip);
        await act(async () => {
            grid_mock.props!.onGridSelectionChange!({
                columns: {},
                rows: {},
                current: {
                    cell: [0, 0],
                    range: { x: 0, y: 0, width: 1, height: 1 },
                    rangeStack: [],
                },
            });
        });
        post_message.mockClear();

        editing_ref.current!.flush_live_edit();

        expect(store.snapshot().get('0:0')).toEqual({
            value: 'typed but not closed',
            base: 'base',
        });
        expect(post_message).toHaveBeenCalledWith({
            type: 'pendingEditsChanged',
            editSessionId: 'session-1',
            edits: {
                '0:0': { value: 'typed but not closed', base: 'base' },
            },
            sequence: expect.any(Number),
            sheetIndex: 0,
            sheetName: 'Sheet1',
        });
    });

    it('leaves a pre-installed store alone when mounting at a settled revision', async () => {
        // applied_save_lifecycle_revision_ref is per-mount and initialized to the
        // revision it mounted with, so apply_save_lifecycle never runs for the
        // mount-time lifecycle: hydrating it was the job of the deleted seeding of
        // editing_initial_edits. That is not a hole, because App runs the same
        // resolve_csv_save_hydration at the same boundary and installs the result,
        // so a hoisted store already holds what the seeding would have recomputed.
        // Re-seeding here would instead overwrite whatever App decided not to
        // install — including a session the host has since replaced.
        const failed: CsvSaveOperation = {
            editSessionId: 'session-1',
        saveRequestId: 'failed-save',
        worksheets: [{
            sheetIndex: 0,
            edits: { '0:0': 'from-failed' },
            dirtyEdits: { '0:0': { value: 'from-failed', base: 'base' } },
        }],
        };
        const store = create_edit_session_store({ session_id: 'session-1' }, {
            '0:1': { value: 'store-only', base: 'middle' },
        });
        await render_grid(undefined, {
            edit_session: store,
            save_lifecycle: { revision: 9, state: 'failed', operation: failed },
        });

        expect(Object.fromEntries(store.snapshot())).toEqual({
            '0:1': { value: 'store-only', base: 'middle' },
        });
    });
});

// Every test here installs a NON-IDENTITY display→source mapping, because under
// identity a display-keyed and a source-keyed save payload are byte-identical and
// the assertions would prove nothing.
describe('GridShell source-keyed save payloads', () => {
    // Display row 0 shows source row 5 — what a sort or a filter produces.
    function permute_display_0_to_source_5() {
        grid_mock.source_row_for_display = (display_row: number) => (
            display_row === 0 ? 5 : display_row + 100
        );
        grid_mock.text_for_source_row = (source_row: number) => (
            source_row === 5 ? ['five-a', 'five-b', 'five-c'] : ['', '', '']
        );
    }

    // Mount the Glide overlay editor Glide portals into `.gdg-clip-region`, and
    // select the cell it belongs to, so read_live_edit sees an open editor.
    async function open_overlay(value: string, cell: [number, number]) {
        const clip = document.createElement('div');
        clip.className = 'gdg-clip-region';
        const input = document.createElement('input');
        input.value = value;
        clip.appendChild(input);
        document.body.appendChild(clip);
        await act(async () => {
            grid_mock.props!.onGridSelectionChange!({
                columns: {},
                rows: {},
                current: {
                    cell,
                    range: { x: cell[0], y: cell[1], width: 1, height: 1 },
                    rangeStack: [],
                },
            });
        });
    }

    it('posts a committed edit under its source-row key with that row\'s base', async () => {
        permute_display_0_to_source_5();
        const { post_message, editing_ref } = await render_grid();

        await edit_cell('typed');
        expect(await request_save(editing_ref)).toBe(true);

        // Display-keyed, this would post '0:0' — and its base would be whatever
        // source row 0 holds, which is not the text the user was looking at.
        const operation = posted_save(post_message)!;
        expect(operation.worksheets[0].edits).toEqual({ '5:0': 'typed' });
        expect(operation.worksheets[0].dirtyEdits).toEqual({
            '5:0': { value: 'typed', base: 'five-a' },
        });
    });

    it('folds an open overlay into the save under its source-row key', async () => {
        permute_display_0_to_source_5();
        const { post_message, editing_ref } = await render_grid();

        await open_overlay('overlay-text', [0, 0]);
        expect(await request_save(editing_ref)).toBe(true);

        // read_live_edit builds the key, so a display-keyed LiveEdit would poison
        // the collectors even though nothing was ever committed through commit_edit.
        const operation = posted_save(post_message)!;
        expect(operation.worksheets[0].edits).toEqual({ '5:0': 'overlay-text' });
        expect(operation.worksheets[0].dirtyEdits).toEqual({
            '5:0': { value: 'overlay-text', base: 'five-a' },
        });
    });

    it('drops an open overlay that reverts to the source row\'s own text', async () => {
        // The fold rule reads `original` from the same source-keyed reader. Typing
        // the display row's text back is a revert and must not save; a display-keyed
        // `original` would read some other row and save a spurious edit.
        permute_display_0_to_source_5();
        const { post_message, editing_ref } = await render_grid();

        await open_overlay('five-a', [0, 0]);
        expect(await request_save(editing_ref)).toBe(false);
        expect(posted_save(post_message)).toBeUndefined();
    });

    it('commit_live_edit writes the open overlay under its source-row key', async () => {
        permute_display_0_to_source_5();
        const store = create_edit_session_store({ session_id: 'session-1' });
        const { editing_ref } = await render_grid(undefined, {
            edit_session: store,
            generation: 1,
        });

        await open_overlay('typed but not closed', [0, 0]);
        editing_ref.current!.commit_live_edit();

        // Outside act on purpose, as in the identity-mapped test above: the
        // write-through is synchronous.
        expect(Object.fromEntries(store.snapshot())).toEqual({
            '5:0': { value: 'typed but not closed', base: 'five-a' },
        });
    });
});

describe('GridShell host-rejected save keys', () => {
    it('discard_keys drops a host-named edit that discard_conflicted retains', async () => {
        // Display row 0 shows source row 5, and source row 5's text still matches
        // the edit's base, so is_entry_conflicted is false for it — the residency /
        // agreement gate that makes discard_conflicted a no-op here.
        grid_mock.source_row_for_display = (display_row: number) => (
            display_row === 0 ? 5 : display_row + 100
        );
        grid_mock.text_for_source_row = (source_row: number) => (
            source_row === 5 ? ['five-a', 'five-b', 'five-c'] : ['', '', '']
        );
        const store = create_edit_session_store({ session_id: 'session-1' });
        const { editing_ref } = await render_grid(undefined, {
            edit_session: store,
            generation: 1,
        });

        await edit_cell('typed');
        expect(Object.keys(Object.fromEntries(store.snapshot()))).toEqual(['5:0']);

        await act(async () => { editing_ref.current!.discard_conflicted(); });
        expect(Object.fromEntries(store.snapshot())).toHaveProperty('5:0');

        await act(async () => { editing_ref.current!.discard_keys(['5:0']); });
        expect(Object.fromEntries(store.snapshot())).toEqual({});
    });

    it('reports a host-named key as conflicted only while the store holds it', async () => {
        const statuses: { conflicted: readonly string[] }[] = [];
        const store = create_edit_session_store({ session_id: 'session-1' });
        const { editing_ref } = await render_grid(undefined, {
            edit_session: store,
            generation: 1,
            host_rejected_keys: ['0:0'],
            on_editing_change: (status) => { statuses.push(status); },
        });

        // Before any edit exists there is nothing to mark: a stale rejection must
        // not tint a cell the store does not hold.
        expect(statuses.at(-1)!.conflicted).toEqual([]);

        // The edit's base agrees with the source, so the webview derives no
        // conflict of its own — the union is the only thing that can report it.
        await edit_cell('typed');
        expect(statuses.at(-1)!.conflicted).toEqual(['0:0']);

        await act(async () => { editing_ref.current!.discard_keys(['0:0']); });
        expect(statuses.at(-1)!.conflicted).toEqual([]);
    });
});
