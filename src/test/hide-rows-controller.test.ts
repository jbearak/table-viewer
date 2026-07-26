import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile, type ViewerProfile } from '../viewer-controller';
import type { FileStateStore } from '../state';
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

type TransformAnswer = Extract<
    HostMessage,
    { type: 'transformInstalled' | 'transformRefused' }
>;

async function send_hide_rows(
    panel: ReturnType<typeof open_csv_table>,
    basis: Pick<WorkbookSnapshot, 'generation' | 'sourceGeneration'>,
    requestId: string,
    displayRows: Array<{ start: number; end: number }>,
): Promise<TransformAnswer> {
    await panel.__receive({
        type: 'hideRows',
        sheetIndex: 0,
        displayRows,
        requestId,
        generation: basis.generation,
        sourceGeneration: basis.sourceGeneration,
    } satisfies Extract<WebviewMessage, { type: 'hideRows' }>);
    const answers = (): TransformAnswer[] => [
        ...messages_of(panel, 'transformInstalled'),
        ...messages_of(panel, 'transformRefused'),
    ].filter((message) => message.requestId === requestId);
    await vi.waitFor(() => expect(answers()).toHaveLength(1));
    return answers()[0];
}

/** A hide request that installed a view. Refusals cannot describe one. */
async function hide_rows_installed(
    panel: ReturnType<typeof open_csv_table>,
    basis: Pick<WorkbookSnapshot, 'generation' | 'sourceGeneration'>,
    requestId: string,
    displayRows: Array<{ start: number; end: number }>,
): Promise<Extract<HostMessage, { type: 'transformInstalled' }>> {
    const answer = await send_hide_rows(panel, basis, requestId, displayRows);
    expect(answer.type).toBe('transformInstalled');
    return answer as Extract<HostMessage, { type: 'transformInstalled' }>;
}

/** The basis a following request should quote, read off an install. */
function basis_of(
    installed: Extract<HostMessage, { type: 'transformInstalled' }>,
): Pick<WorkbookSnapshot, 'generation' | 'sourceGeneration'> {
    return {
        generation: installed.view.basis.generation,
        sourceGeneration: installed.view.basis.sourceGeneration,
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

    it('maps, deduplicates, sorts, and persists hidden source rows', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);

        const applied = await hide_rows_installed(panel, initial, 'hide-natural', [
            { start: 2, end: 2 },
            { start: 0, end: 1 },
            { start: 1, end: 2 },
        ]);

        expect(applied).toMatchObject({
            requestId: 'hide-natural',
            view: {
                basis: {
                    generation: initial.generation + 1,
                    sourceGeneration: initial.sourceGeneration,
                },
                rules: { hiddenRows: [0, 1, 2] },
            },
        });
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
        const sorted = messages_of(panel, 'transformInstalled').find(
            (message) => message.requestId === 'sort-ascending',
        )!;

        const applied = await hide_rows_installed(
            panel,
            basis_of(sorted),
            'hide-sorted',
            [{ start: 0, end: 1 }],
        );

        // The rules the host now holds, read from the ack message beside the record:
        // the record carries rules only for a view it permuted, and this assertion is
        // about the durable set the next line matches against the persisted copy.
        expect(applied.rules?.hiddenRows).toEqual([1, 2]);
        expect(state.get_state(file_path).transforms?.[0]?.hiddenRows).toEqual([1, 2]);
    });

    it('unions consecutive requests without duplicates', async () => {
        const state = versioned_state_store();
        const panel = open_csv_table(state.store);
        const initial = await ready(panel);
        const first = await hide_rows_installed(panel, initial, 'hide-first', [
            { start: 0, end: 0 },
        ]);

        const second = await hide_rows_installed(
            panel,
            basis_of(first),
            'hide-second',
            [{ start: 0, end: 0 }],
        );

        expect(second.rules?.hiddenRows).toEqual([0, 1]);
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

        // A refusal names the reason and nothing else — no state, no generation, no
        // row count to be mistaken for an install. That the installed and persisted
        // view are untouched is proven by the durable store below.
        expect(rejected).toEqual({
            type: 'transformRefused',
            sheetIndex: 0,
            requestId: 'stale-generation',
            intent: 'user',
            reason: 'The view changed before this table view request arrived.',
            terminal: true,
        });
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
            type: 'transformRefused',
            requestId: 'stale-source-generation',
            reason: 'The source changed before this table view request arrived.',
            terminal: true,
        });
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
            type: 'transformRefused',
            requestId: 'out-of-range',
            reason: 'display row interval 1-3 out of range (3 rows)',
            terminal: true,
        });
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
            type: 'transformRefused',
            requestId: 'preview-hide',
            reason: 'Row hiding is unavailable in preview mode.',
            terminal: true,
        });
        expect(state.revision(file_path)).toBe(revision);
        expect(state.get_state(file_path)).toEqual({});
    });
});
