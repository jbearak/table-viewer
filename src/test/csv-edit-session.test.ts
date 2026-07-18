import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile, type ViewerProfile } from '../viewer-controller';
import type { FileStateStore } from '../state';
import type { PerFileState } from '../types';
import type { DataSource, RowWindow, WorkbookMeta } from '../data-source/interface';
import * as vscode_mock from './mocks/vscode';

const enc = new TextEncoder();

function state_store(initial: PerFileState = {}) {
    const states: Record<string, PerFileState> = {};
    return {
        store: {
            get: (file_path: string) => states[file_path] ?? initial,
            set: async (file_path: string, state: PerFileState) => {
                states[file_path] = state;
            },
        } satisfies FileStateStore,
        get_state(file_path: string) {
            return states[file_path] ?? initial;
        },
    };
}

function uri(path: string): vscode.Uri {
    return vscode_mock.Uri.file(path) as unknown as vscode.Uri;
}

class StubSource implements DataSource {
    constructor(public readonly truncationMessage?: string) {}
    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: 1,
                columnCount: 1,
                merges: [],
                hasFormatting: false,
            }],
        };
    }
    read_rows(): RowWindow {
        return { startRow: 0, rows: [[{ raw: 'a', formatted: 'a', bold: false, italic: false }]] };
    }
    close(): void {}
}

function open_csv_table(
    file_uri: vscode.Uri,
    store: FileStateStore,
    profile: ViewerProfile = csv_table_profile(),
) {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        file_uri,
        store,
        profile,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

function edit_session_results(panel: { __messages: unknown[] }) {
    return panel.__messages.filter(
        (message): message is {
            type: string;
            granted: boolean;
            pendingEdits?: PerFileState['pendingEdits'];
        } => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'editSessionResult'
        )
    );
}

function sheet_meta_count(panel: { __messages: unknown[] }) {
    return panel.__messages.filter(
        (message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'sheetMeta'
        )
    ).length;
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));
});

describe('CSV edit sessions', () => {
    it('rejects transforms while an edit session is owned', async () => {
        const panel = open_csv_table(uri('/tmp/session.csv'), state_store().store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' } as never);

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'during-edit',
            generation: 1,
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        } as never);

        const response = panel.__messages.find((message) =>
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'transformApplied',
        ) as { error?: string } | undefined;
        expect(response?.error).toContain('Exit edit mode');
    });

    it('does not grant edit mode while a transform is computing', async () => {
        const panel = open_csv_table(uri('/tmp/session.csv'), state_store().store);
        await panel.__receive({ type: 'ready' });

        const transform = panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'pending',
            generation: 1,
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        } as never);
        await panel.__receive({ type: 'requestEditSession' } as never);
        await transform;

        expect(edit_session_results(panel)).toEqual([
            { type: 'editSessionResult', granted: false },
        ]);
    });

    it('allows multiple viewers for one CSV file but grants edit mode to only one', async () => {
        const file_uri = uri('/tmp/session.csv');
        const state = state_store();
        const first = open_csv_table(file_uri, state.store);
        const second = open_csv_table(file_uri, state.store);

        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });

        expect(sheet_meta_count(first)).toBe(1);
        expect(sheet_meta_count(second)).toBe(1);

        await first.__receive({ type: 'requestEditSession' } as never);
        await second.__receive({ type: 'requestEditSession' } as never);

        expect(edit_session_results(first)).toEqual([
            { type: 'editSessionResult', granted: true },
        ]);
        expect(edit_session_results(second)).toEqual([
            { type: 'editSessionResult', granted: false },
        ]);
    });

    it('ignores pending-edit writes from a viewer that does not own the edit session', async () => {
        const file_path = '/tmp/session.csv';
        const file_uri = uri(file_path);
        const state = state_store();
        const first = open_csv_table(file_uri, state.store);
        const second = open_csv_table(file_uri, state.store);

        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        await first.__receive({ type: 'requestEditSession' } as never);
        await second.__receive({ type: 'requestEditSession' } as never);

        await first.__receive({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'owner', base: 'a' } },
        });
        await second.__receive({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'non-owner', base: 'a' } },
        });

        expect(state.get_state(file_path).pendingEdits).toEqual({
            '0:0': { value: 'owner', base: 'a' },
        });
    });

    it('passes existing pending edits to an already-open viewer that later gets edit mode', async () => {
        const file_path = '/tmp/session.csv';
        const file_uri = uri(file_path);
        const pendingEdits = { '0:0': { value: 'owner', base: 'a' } };
        const state = state_store({ pendingEdits });
        const first = open_csv_table(file_uri, state.store);
        const second = open_csv_table(file_uri, state.store);

        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        first.dispose();

        await second.__receive({ type: 'requestEditSession' } as never);

        expect(edit_session_results(second)).toContainEqual({
            type: 'editSessionResult',
            granted: true,
            pendingEdits,
        });
    });

    it('clears pending edits and releases ownership atomically on discard', async () => {
        const file_path = '/tmp/session.csv';
        const file_uri = uri(file_path);
        const state = state_store();
        const first = open_csv_table(file_uri, state.store);
        const second = open_csv_table(file_uri, state.store);

        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        await first.__receive({ type: 'requestEditSession' });
        await first.__receive({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'owner', base: 'a' } },
        });

        await first.__receive({ type: 'discardEditSession' } as never);
        await second.__receive({ type: 'requestEditSession' });

        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
        expect(edit_session_results(second)).toContainEqual({
            type: 'editSessionResult',
            granted: true,
        });
    });

    it('does not warn about another editor when edit mode is denied by truncation', async () => {
        const warning_spy = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const state = state_store();
        const panel = open_csv_table(uri('/tmp/truncated.csv'), state.store, {
            editing: true,
            build_source: async () => new StubSource('Showing 1 of 2 rows'),
        });

        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });

        expect(edit_session_results(panel)).toEqual([
            { type: 'editSessionResult', granted: false },
        ]);
        expect(warning_spy).not.toHaveBeenCalledWith(
            'This file is already being edited in another Table Viewer tab.'
        );
    });
});
