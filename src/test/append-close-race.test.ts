import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    attach_viewer,
    csv_table_profile,
} from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

afterEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
});

describe('append admission at the close boundary', () => {
    it('keeps the close drain behind an admitted append request', async () => {
        vscode_mock.__reset();
        const bytes = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);

        const store = versioned_state_store().store;
        const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
        const drain_reached_append_wait = deferred<readonly string[]>();
        const controller = attach_viewer(
            panel as unknown as Parameters<typeof attach_viewer>[0],
            vscode_mock.Uri.file('/tmp/composer-close-race.csv') as unknown as vscode.Uri,
            with_in_memory_authority_transactions(store),
            csv_table_profile(),
            fake_viewer_host,
            {
                integrationTestPort: {
                    on_host_message() {},
                    on_webview_message() {},
                    register_webview_message_receiver() {},
                    on_controller_drain_wait(work) {
                        if (work.includes('appendAdmission')) {
                            drain_reached_append_wait.resolve(work);
                        }
                    },
                },
            },
        );
        panel.onDidDispose(() => controller.dispose());

        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
        const session = [...panel.__messages].reverse().find((message): message is {
            type: 'editSessionResult';
            granted: boolean;
            editSessionId: string;
        } => typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'editSessionResult');
        const snapshot = panel.__messages.find((message): message is {
            type: 'workbookSnapshot';
            snapshot: { sourceGeneration: number };
        } => typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'workbookSnapshot');
        expect(session).toMatchObject({ granted: true, editSessionId: expect.any(String) });
        expect(snapshot).toBeDefined();
        await controller.drain();

        const delivery_started = deferred();
        const delivery_gate = deferred();
        const original_post = panel.webview.postMessage.bind(panel.webview);
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(async (message: unknown) => {
            if (typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'appendRowsResult') {
                delivery_started.resolve();
                await delivery_gate.promise;
            }
            return original_post(message);
        });
        const append = panel.__receive({
            type: 'requestAppendRows',
            requestId: 'composer-stage',
            editSessionId: session!.editSessionId,
            worksheet: { sheetIndex: 0, sheetName: 'Sheet1' },
            sourceGeneration: snapshot!.snapshot.sourceGeneration,
            count: 1,
        });
        await delivery_started.promise;

        let drained = false;
        const close_drain = controller.drain().then(() => { drained = true; });
        expect(await drain_reached_append_wait.promise).toContain('appendAdmission');
        const drained_while_append_was_blocked = drained;

        delivery_gate.resolve();
        await append;
        await close_drain;
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'appendRowsResult',
            requestId: 'composer-stage',
        }));
        expect(drained_while_append_was_blocked).toBe(false);

        panel.dispose();
        await controller.drain();
    });

    it('acknowledges a composed row published with its seeded value', async () => {
        vscode_mock.__reset();
        const bytes = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
        const controller = attach_viewer(
            panel as unknown as Parameters<typeof attach_viewer>[0],
            vscode_mock.Uri.file('/tmp/composer-seeded-publication.csv') as unknown as vscode.Uri,
            with_in_memory_authority_transactions(versioned_state_store().store),
            csv_table_profile(),
            fake_viewer_host,
        );
        panel.onDidDispose(() => controller.dispose());

        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
        const session = [...panel.__messages].reverse().find((message): message is {
            type: 'editSessionResult';
            editSessionId: string;
        } => typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'editSessionResult');
        const snapshot = panel.__messages.find((message): message is {
            type: 'workbookSnapshot';
            snapshot: { sourceGeneration: number };
        } => typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'workbookSnapshot');
        await panel.__receive({
            type: 'requestAppendRows',
            requestId: 'composer-stage',
            editSessionId: session!.editSessionId,
            worksheet: { sheetIndex: 0, sheetName: 'Sheet1' },
            sourceGeneration: snapshot!.snapshot.sourceGeneration,
            count: 1,
        });
        const admission = [...panel.__messages].reverse().find((message): message is {
            type: 'appendRowsResult';
            requestId: string;
            rowIds: readonly string[];
            formatTemplate: { id: string; format: { kind: 'none' } };
            appendBasis: {
                sourceRowCount: number;
                provisionalStartRow: number;
                columnCount: number;
                schemaFingerprint: string;
            };
        } => typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'appendRowsResult'
            && 'requestId' in message
            && message.requestId === 'composer-stage');
        expect(admission).toBeDefined();
        await panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'composer-stage',
            editSessionId: session!.editSessionId,
            accepted: true,
        });
        await panel.__receive({
            type: 'pendingChangesChanged',
            editSessionId: session!.editSessionId,
            sequence: 1,
            sourceGeneration: snapshot!.snapshot.sourceGeneration,
            changes: {
                sheetIndex: 0,
                sheetName: 'Sheet1',
                cells: {},
                formatTemplates: [admission!.formatTemplate],
                appendedRows: [{
                    id: admission!.rowIds[0],
                    cells: { 0: { value: 'composed', valueEditOrder: 2 } },
                    formatTemplateId: admission!.formatTemplate.id,
                    createdOrder: 1,
                }],
                tailRemovals: [],
                appendBasis: admission!.appendBasis,
                conflicts: [],
            },
        });

        expect(panel.__messages).toContainEqual({
            type: 'pendingChangesAcknowledged',
            editSessionId: session!.editSessionId,
            sequence: 1,
        });
        panel.dispose();
        await controller.drain();
    });
});
