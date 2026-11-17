import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile, type ViewerProfile } from '../viewer-controller';
import type { FileStateStore } from '../state';
import { MAX_PERSISTED_HIDDEN_ROWS, TOO_MANY_HIDDEN_ROWS_MESSAGE } from '../types';
import type { HostMessage, WebviewMessage } from '../types';
import type { WorkbookSnapshot } from '../viewer-snapshot';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

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
        fake_viewer_host,
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

type Resolution = Extract<HostMessage, { type: 'hiddenRowsResolved' }>;

/** Ask the host which source rows `displayRows` are, and wait for its answer. */
async function resolve_hidden_rows(
    panel: ReturnType<typeof open_csv_table>,
    basis: { mappingGeneration: number; sourceGeneration: number },
    requestId: string,
    displayRows: Array<{ start: number; end: number }>,
): Promise<Resolution> {
    await panel.__receive({
        type: 'resolveHiddenRows',
        sheetIndex: 0,
        displayRows,
        requestId,
        mappingGeneration: basis.mappingGeneration,
        sourceGeneration: basis.sourceGeneration,
    } satisfies Extract<WebviewMessage, { type: 'resolveHiddenRows' }>);
    const answers = () => messages_of(panel, 'hiddenRowsResolved')
        .filter((message) => message.requestId === requestId);
    await vi.waitFor(() => expect(answers()).toHaveLength(1));
    return answers()[0];
}

/** A snapshot's basis for a resolution of sheet 0. */
function basis_of(snapshot: WorkbookSnapshot): { mappingGeneration: number; sourceGeneration: number } {
    return {
        mappingGeneration: snapshot.mappingGenerations[0],
        sourceGeneration: snapshot.sourceGeneration,
    };
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
        vscode_mock.__setConfigurationValue('tableViewer.fontSize', 15);
        const panel = open_csv_table(versioned_state_store().store);

        await ready(panel);
        expect(messages_of(panel, 'fontChanged').at(0)).toEqual({
            type: 'fontChanged',
            fontFamily: 'Hack',
            fontSize: 15,
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
        expect(messages_of(panel, 'fontChanged')).toEqual([{
            type: 'fontChanged',
            fontFamily: 'Google Sans Code',
            fontSize: 15,
        }]);
    });

    it('forwards font size changes on their own', async () => {
        const panel = open_csv_table(versioned_state_store().store);
        await ready(panel);
        panel.__messages.length = 0;

        vscode_mock.__setConfigurationValue('tableViewer.fontSize', 18);
        await vscode_mock.__fireConfigurationChange({
            affectsConfiguration: (section) => section === 'tableViewer.fontSize',
        });

        expect(messages_of(panel, 'fontChanged')).toEqual([{
            type: 'fontChanged',
            fontFamily: null,
            fontSize: 18,
        }]);
    });

    it('resolves display rows to sorted, distinct source rows, and computes and saves nothing', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        const resolved = await resolve_hidden_rows(panel, basis_of(initial), 'hide-natural', [
            { start: 2, end: 2 },
            { start: 0, end: 1 },
            { start: 1, end: 2 },
        ]);

        expect(resolved).toEqual({
            type: 'hiddenRowsResolved',
            sheetIndex: 0,
            requestId: 'hide-natural',
            sourceRows: [0, 1, 2],
        });
        expect(messages_of(panel, 'transformInstalled')).toEqual([]);
        expect(messages_of(panel, 'transformSettled')).toEqual([]);
        expect(state.revision(file_path)).toBe(revision);
    });

    it('resolves display rows through the installed sort', async () => {
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
        const sorted = messages_of(panel, 'transformInstalled').find(
            (message) => message.requestId === 'sort-ascending',
        )!;

        const resolved = await resolve_hidden_rows(panel, {
            mappingGeneration: sorted.mappingGeneration,
            sourceGeneration: initial.sourceGeneration,
        }, 'hide-sorted', [{ start: 0, end: 1 }]);

        // Sorted ascending, c a b shows a b c: display rows 0 and 1 are source rows 1 and 2.
        expect(resolved).toMatchObject({ sourceRows: [1, 2] });
    });

    it('refuses a mapping generation the sheet has moved past, since its rows moved', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const basis = basis_of(initial);
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-moves-rows',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        } satisfies Extract<WebviewMessage, { type: 'setTransform' }>);

        const refused = await resolve_hidden_rows(panel, basis, 'stale-mapping', [
            { start: 0, end: 0 },
        ]);

        expect(refused).toEqual({
            type: 'hiddenRowsResolved',
            sheetIndex: 0,
            requestId: 'stale-mapping',
            refusal: 'The view changed before this table view request arrived.',
        });
    });

    it('resolves against a generation that moved no rows of the sheet', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const basis = basis_of(initial);
        // A disabled filter changes the rules, and the core-wide generation, but
        // not the sheet's mapping.
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'disabled-filter',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            intent: 'user',
            state: {
                sort: [],
                filters: [{
                    id: 'off', colIndex: 0, operator: 'contains', value: 'a',
                    caseSensitive: false, enabled: false,
                }],
                schema: '["Sheet1",1,["h"]]',
            },
        } satisfies Extract<WebviewMessage, { type: 'setTransform' }>);
        await vi.waitFor(() => expect(messages_of(panel, 'transformInstalled')
            .some((message) => message.requestId === 'disabled-filter')).toBe(true));

        const resolved = await resolve_hidden_rows(panel, basis, 'unmoved-mapping', [
            { start: 0, end: 0 },
        ]);

        expect(resolved).toMatchObject({ sourceRows: [0] });
    });

    it('refuses a stale source generation', async () => {
        const panel = open_csv_table(versioned_state_store().store);
        const initial = await ready(panel);

        const refused = await resolve_hidden_rows(
            panel,
            { ...basis_of(initial), sourceGeneration: initial.sourceGeneration + 1 },
            'stale-source-generation',
            [{ start: 0, end: 0 }],
        );

        expect(refused).toMatchObject({
            refusal: 'The source changed before this table view request arrived.',
        });
    });

    it('refuses an out-of-range display interval', async () => {
        const panel = open_csv_table(versioned_state_store().store);
        const initial = await ready(panel);

        const refused = await resolve_hidden_rows(panel, basis_of(initial), 'out-of-range', [
            { start: 1, end: 3 },
        ]);

        expect(refused).toMatchObject({ refusal: 'display row interval 1-3 out of range (3 rows)' });
    });

    it('refuses row hiding in preview mode', async () => {
        const panel = open_csv_table(versioned_state_store().store, {
            ...csv_table_profile(),
            previewMode: true,
        });
        const initial = await ready(panel);

        const refused = await resolve_hidden_rows(panel, basis_of(initial), 'preview-hide', [
            { start: 0, end: 0 },
        ]);

        expect(refused).toMatchObject({ refusal: 'Row hiding is unavailable in preview mode.' });
    });

    it('refuses, terminally and before saving, a transform hiding more rows than can be saved', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'too-many',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            intent: 'user',
            state: {
                sort: [],
                filters: [],
                hiddenRows: Array.from({ length: MAX_PERSISTED_HIDDEN_ROWS + 1 }, (_row, index) => index),
                schema: '["Sheet1",1,["h"]]',
            },
        } satisfies Extract<WebviewMessage, { type: 'setTransform' }>);

        await vi.waitFor(() => expect(messages_of(panel, 'transformRefused')).toEqual([{
            type: 'transformRefused',
            sheetIndex: 0,
            requestId: 'too-many',
            intent: 'user',
            reason: TOO_MANY_HIDDEN_ROWS_MESSAGE,
            terminal: true,
        }]));
        expect(messages_of(panel, 'transformInstalled')).toEqual([]);
        expect(state.revision(file_path)).toBe(revision);
    });
});
