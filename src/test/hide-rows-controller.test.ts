import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile, type ViewerProfile } from '../viewer-controller';
import type { FileStateStore } from '../state';
import type { HostMessage, WebviewMessage } from '../types';
import type { WorkbookSnapshot } from '../viewer-snapshot';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';

const enc = new TextEncoder();
const file_path = '/tmp/hide-rows-controller.csv';

function open_csv_table(
    store: FileStateStore,
    profile: ViewerProfile = csv_table_profile(),
) {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(file_path) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(store),
        profile,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

function messages_of<T extends HostMessage['type']>(
    panel: { __messages: unknown[] },
    type: T,
): Array<Extract<HostMessage, { type: T }>> {
    return panel.__messages.filter((message): message is Extract<HostMessage, { type: T }> => (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === type
    ));
}

async function ready(panel: ReturnType<typeof open_csv_table>): Promise<WorkbookSnapshot> {
    await panel.__receive({ type: 'ready' });
    await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot').length)
        .toBeGreaterThan(0));
    return messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot;
}

async function send_hide_rows(
    panel: ReturnType<typeof open_csv_table>,
    basis: Pick<WorkbookSnapshot, 'generation' | 'sourceGeneration'>,
    requestId: string,
    displayRows: Array<{ start: number; end: number }>,
): Promise<Extract<HostMessage, { type: 'transformApplied' }>> {
    await panel.__receive({
        type: 'hideRows',
        sheetIndex: 0,
        displayRows,
        requestId,
        generation: basis.generation,
        sourceGeneration: basis.sourceGeneration,
    } satisfies Extract<WebviewMessage, { type: 'hideRows' }>);
    await vi.waitFor(() => expect(messages_of(panel, 'transformApplied').some(
        (message) => message.requestId === requestId,
    )).toBe(true));
    return messages_of(panel, 'transformApplied').find(
        (message) => message.requestId === requestId,
    )!;
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    vscode_mock.__setStatImplementation(async () => ({ size: 8, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async () => enc.encode('h\nc\na\nb\n'));
});

describe('hide rows controller', () => {
    it('replays the current font on ready and forwards later changes', async () => {
        vscode_mock.__setConfigurationValue('tableViewer.fontFamily', 'Hack');
        const panel = open_csv_table(versioned_state_store().store);

        await ready(panel);
        expect(messages_of(panel, 'fontFamilyChanged').at(0)).toEqual({
            type: 'fontFamilyChanged',
            fontFamily: 'Hack',
        });

        panel.__messages.length = 0;
        vscode_mock.__setConfigurationValue(
            'tableViewer.fontFamily',
            'Google Sans Code',
        );
        await vscode_mock.__fireConfigurationChange({
            affectsConfiguration: (section) => (
                section === 'tableViewer.fontFamily'
            ),
        });
        expect(messages_of(panel, 'fontFamilyChanged')).toEqual([{
            type: 'fontFamilyChanged',
            fontFamily: 'Google Sans Code',
        }]);
    });

    it('maps, deduplicates, sorts, and persists hidden source rows', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);

        const applied = await send_hide_rows(panel, initial, 'hide-natural', [
            { start: 2, end: 2 },
            { start: 0, end: 1 },
            { start: 1, end: 2 },
        ]);

        expect(applied).toMatchObject({
            requestId: 'hide-natural',
            generation: initial.generation + 1,
            sourceGeneration: initial.sourceGeneration,
            state: { hiddenRows: [0, 1, 2] },
        });
        expect(applied.error).toBeUndefined();
        expect(state.get_state(file_path).transforms?.[0]?.hiddenRows).toEqual([0, 1, 2]);
    });

    it('maps display rows through the installed sort', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-ascending',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        } satisfies Extract<WebviewMessage, { type: 'setTransform' }>);
        const sorted = messages_of(panel, 'transformApplied').find(
            (message) => message.requestId === 'sort-ascending',
        )!;

        const applied = await send_hide_rows(panel, sorted, 'hide-sorted', [
            { start: 0, end: 1 },
        ]);

        expect(applied.error).toBeUndefined();
        expect(applied.state.hiddenRows).toEqual([1, 2]);
        expect(state.get_state(file_path).transforms?.[0]?.hiddenRows).toEqual([1, 2]);
    });

    it('unions consecutive requests without duplicates', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const first = await send_hide_rows(panel, initial, 'hide-first', [
            { start: 0, end: 0 },
        ]);

        const second = await send_hide_rows(panel, first, 'hide-second', [
            { start: 0, end: 0 },
        ]);

        expect(second.error).toBeUndefined();
        expect(second.state.hiddenRows).toEqual([0, 1]);
        expect(state.get_state(file_path).transforms?.[0]?.hiddenRows).toEqual([0, 1]);
    });

    it('rejects a stale generation without changing installed or persisted state', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        const rejected = await send_hide_rows(
            panel,
            { ...initial, generation: initial.generation + 1 },
            'stale-generation',
            [{ start: 0, end: 0 }],
        );

        expect(rejected).toMatchObject({
            requestId: 'stale-generation',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            error: 'The view changed before this table view request arrived.',
            state: { sort: [], filters: [] },
        });
        expect(rejected.state.hiddenRows).toBeUndefined();
        expect(state.revision(file_path)).toBe(revision);
        expect(state.get_state(file_path)).toEqual({});
    });

    it('rejects a stale source generation without changing installed or persisted state', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        const rejected = await send_hide_rows(
            panel,
            { ...initial, sourceGeneration: initial.sourceGeneration + 1 },
            'stale-source-generation',
            [{ start: 0, end: 0 }],
        );

        expect(rejected).toMatchObject({
            requestId: 'stale-source-generation',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            error: 'The source changed before this table view request arrived.',
            state: { sort: [], filters: [] },
        });
        expect(rejected.state.hiddenRows).toBeUndefined();
        expect(state.revision(file_path)).toBe(revision);
        expect(state.get_state(file_path)).toEqual({});
    });

    it('rejects an out-of-range display interval without changing state', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        const rejected = await send_hide_rows(panel, initial, 'out-of-range', [
            { start: 1, end: 3 },
        ]);

        expect(rejected).toMatchObject({
            requestId: 'out-of-range',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            error: 'display row interval 1-3 out of range (3 rows)',
            state: { sort: [], filters: [] },
        });
        expect(rejected.state.hiddenRows).toBeUndefined();
        expect(state.revision(file_path)).toBe(revision);
        expect(state.get_state(file_path)).toEqual({});
    });

    it('rejects row hiding in preview mode', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store, {
            ...csv_table_profile(),
            previewMode: true,
        });
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        const rejected = await send_hide_rows(panel, initial, 'preview-hide', [
            { start: 0, end: 0 },
        ]);

        expect(rejected).toMatchObject({
            requestId: 'preview-hide',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            error: 'Row hiding is unavailable in preview mode.',
            state: { sort: [], filters: [] },
        });
        expect(state.revision(file_path)).toBe(revision);
        expect(state.get_state(file_path)).toEqual({});
    });
});
