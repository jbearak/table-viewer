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
        onCellEdited?: (cell: [number, number], value: { kind: string; data: string }) => void;
        onGridSelectionChange?: (selection: unknown) => void;
        getCellContent?: (cell: [number, number]) => { data?: string };
    },
}));

vi.mock('@glideapps/glide-data-grid', () => {
    const React = require('react') as typeof import('react');
    return {
        CompactSelection: { empty: () => ({}) },
        DataEditor: React.forwardRef((props: unknown, ref: React.ForwardedRef<unknown>) => {
            grid_mock.props = props as typeof grid_mock.props;
            React.useImperativeHandle(ref, () => ({
                updateCells: vi.fn(),
                scrollTo: vi.fn(),
            }));
            return React.createElement('div', { className: 'data-editor-stub' });
        }),
        GridCellKind: { Text: 'text' },
    };
});

vi.mock('../webview/use-row-loader', () => ({
    use_row_loader: () => ({
        ensure_rows: vi.fn(),
        get_row: (row: number) => [
            { raw: row === 0 ? 'base' : '', formatted: row === 0 ? 'base' : '', bold: false, italic: false },
            { raw: row === 0 ? 'middle' : '', formatted: row === 0 ? 'middle' : '', bold: false, italic: false },
            { raw: row === 0 ? 'source-two' : '', formatted: row === 0 ? 'source-two' : '', bold: false, italic: false },
        ],
        get_source_row: (row: number) => row,
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

vi.mock('../webview/merge-overlay', () => ({
    MergeOverlay: React.forwardRef((_props: unknown, ref: React.ForwardedRef<unknown>) => {
        React.useImperativeHandle(ref, () => ({ repaint: vi.fn() }));
        return null;
    }),
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
        generation?: number;
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
        on_save_request: (edits: Record<string, string>, dirtyEdits: Record<string, {
            value: string;
            base: string;
        }>) => ({
            editSessionId: 'session-1',
            saveRequestId: `save-${++save_request_sequence}`,
            edits,
            dirtyEdits,
        }),
        editing_ref,
        ...save_props,
    };
    const rerender_save_lifecycle = async (save_lifecycle: CsvSaveLifecycle) => {
        await act(async () => {
            root!.render(React.createElement(GridShell, {
                ...props,
                save_lifecycle,
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

    return { post_message, editing_ref, rerender_save_lifecycle, remount_at_generation };
}

async function edit_cell(value: string) {
    await act(async () => {
        grid_mock.props!.onCellEdited!([0, 0], { kind: 'text', data: value });
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
        .map((msg) => ({ type: msg.type, edits: msg.operation.edits }));
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
        expect(post_message.mock.calls.at(-1)?.[0].operation.dirtyEdits).toEqual({
            '0:0': { value: 'open editor value', base: 'base' },
        });
        await edit_cell('too late');
        expect(save_messages(post_message)).toHaveLength(1);
    });

    it('hydrates an active operation across remount and restores its exact map on failure', async () => {
        const operation: CsvSaveOperation = {
            editSessionId: 'session-1',
            saveRequestId: 'accepted-overlay',
            edits: { '0:0': 'overlay' },
            dirtyEdits: {
                '0:0': { value: 'overlay', base: 'exact-conflict-base' },
            },
        };
        const { post_message, editing_ref } = await render_grid(undefined, {
            save_lifecycle: { revision: 4, state: 'active', operation },
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
        expect(post_message.mock.calls.at(-1)?.[0].operation.dirtyEdits).toEqual({
            '0:0': { value: 'overlay', base: 'exact-conflict-base' },
        });
    });

    it('keeps the exact dirty map locked through delayed idle before active acceptance', async () => {
        const failed: CsvSaveOperation = {
            editSessionId: 'older-session',
            saveRequestId: 'failed-r2',
            edits: { '0:0': 'older' },
            dirtyEdits: { '0:0': { value: 'older', base: 'older-base' } },
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
            edits: { '0:0': 'saved' },
            dirtyEdits: { '0:0': { value: 'saved', base: 'base' } },
        };
        const { editing_ref } = await render_grid(undefined, {
            save_lifecycle: { revision: 8, state: 'succeeded', operation },
            initial_edits: operation.dirtyEdits,
        });

        expect(editing_ref.current!.has_uncommitted_changes()).toBe(false);
        expect(await request_save(editing_ref)).toBe(false);
    });

    it('does not hydrate a failed operation into a different current session', async () => {
        const newer = { '0:0': { value: 'newer', base: 'new-base' } };
        const failed: CsvSaveOperation = {
            editSessionId: 'old-session',
            saveRequestId: 'old-failure',
            edits: { '0:0': 'old' },
            dirtyEdits: { '0:0': { value: 'old', base: 'old-base' } },
        };
        const { post_message, editing_ref } = await render_grid(undefined, {
            save_lifecycle: { revision: 8, state: 'failed', operation: failed },
            initial_edits: newer,
        });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('newer');
        expect(await request_save(editing_ref)).toBe(true);
        expect(post_message.mock.calls.at(-1)?.[0].operation.dirtyEdits).toEqual(newer);
    });

    it('preserves a newer session across an older succeeded lifecycle', async () => {
        const newer = { '0:0': { value: 'newer', base: 'new-base' } };
        const succeeded: CsvSaveOperation = {
            editSessionId: 'old-session',
            saveRequestId: 'old-success',
            edits: { '0:0': 'old' },
            dirtyEdits: { '0:0': { value: 'old', base: 'old-base' } },
        };
        const { post_message, editing_ref } = await render_grid(undefined, {
            save_lifecycle: { revision: 8, state: 'succeeded', operation: succeeded },
            initial_edits: newer,
        });

        expect(grid_mock.props!.getCellContent!([0, 0]).data).toBe('newer');
        expect(await request_save(editing_ref)).toBe(true);
        expect(post_message.mock.calls.at(-1)?.[0].operation.dirtyEdits).toEqual(newer);
    });

    it('ignores a live failed lifecycle from a different session', async () => {
        const newer = { '0:0': { value: 'newer', base: 'new-base' } };
        const failed: CsvSaveOperation = {
            editSessionId: 'old-session',
            saveRequestId: 'old-failure',
            edits: { '0:0': 'old' },
            dirtyEdits: { '0:0': { value: 'old', base: 'old-base' } },
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
        expect(post_message.mock.calls.at(-1)?.[0].operation.dirtyEdits).toEqual(newer);
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
            edits: { '0:0': 'from-failed' },
            dirtyEdits: { '0:0': { value: 'from-failed', base: 'base' } },
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
