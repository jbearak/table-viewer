import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { register_table_viewer } from '../custom-editor';
import type { AuthorityFileStateStore } from '../state';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';

function state_store(): AuthorityFileStateStore {
    return with_in_memory_authority_transactions(versioned_state_store().store);
}

function context(): vscode.ExtensionContext {
    return {
        extensionUri: vscode_mock.Uri.file('/ext'),
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

let temporary_directory: string | undefined;

beforeEach(() => {
    vscode_mock.__reset();
    vscode_mock.env.remoteName = undefined;
});

afterEach(() => {
    if (temporary_directory) fs.rmSync(temporary_directory, { recursive: true, force: true });
    temporary_directory = undefined;
});

describe('register_table_viewer', () => {
    it('keeps multi-viewer support for both Excel and CSV custom editors', () => {
        register_table_viewer(context(), state_store());

        const registrations = vscode_mock.__getCustomEditorRegistrations();
        const excel = registrations.find((r) => r.viewType === 'tableViewer.excelViewer');
        const csv = registrations.find((r) => r.viewType === 'tableViewer.editor');

        expect(excel?.options).toMatchObject({ supportsMultipleEditorsPerDocument: true });
        expect(csv?.options).toMatchObject({ supportsMultipleEditorsPerDocument: true });
    });

    async function csv_capabilities(
        uri: vscode.Uri,
    ): Promise<{ csvEditingSupported?: boolean; csvEditable?: boolean }> {
        const bytes = Buffer.from('a,b\n1,2\n');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);

        const registration = register_table_viewer(context(), state_store());
        const registered = vscode_mock.__getCustomEditorRegistrations()
            .find((candidate) => candidate.viewType === 'tableViewer.editor');
        const provider = registered?.provider as {
            openCustomDocument(candidate: vscode.Uri): Promise<vscode.CustomDocument>;
            resolveCustomEditor(
                document: vscode.CustomDocument,
                panel: vscode.WebviewPanel,
            ): Promise<void>;
        };
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor',
            'data',
        ) as unknown as vscode.WebviewPanel;
        const document = await provider.openCustomDocument(uri);
        await provider.resolveCustomEditor(document, panel);
        const mock_panel = vscode_mock.__getPanels()[0];
        await mock_panel.__receive({ type: 'ready' });
        let snapshot: { snapshot?: { capabilities?: {
            csvEditingSupported?: boolean;
            csvEditable?: boolean;
        } } } | undefined;
        for (let attempt = 0; attempt < 100 && !snapshot; attempt += 1) {
            snapshot = mock_panel.__messages.find((message) => (
                typeof message === 'object' && message !== null
                && 'type' in message && message.type === 'workbookSnapshot'
            )) as typeof snapshot;
            if (!snapshot) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(snapshot).toBeDefined();
        registration.dispose();
        if (snapshot?.snapshot?.capabilities?.csvEditingSupported) {
            let request: { requestId: string } | undefined;
            for (let attempt = 0; attempt < 100 && !request; attempt += 1) {
                request = mock_panel.__messages.find((message) => (
                    typeof message === 'object' && message !== null
                    && 'type' in message && message.type === 'requestPendingEditsFlush'
                    && 'requestId' in message && typeof message.requestId === 'string'
                )) as typeof request;
                if (!request) await new Promise<void>((resolve) => setImmediate(resolve));
            }
            expect(request).toBeDefined();
            await mock_panel.__receive({
                type: 'pendingEditsFlush',
                requestId: request!.requestId,
                highestProducedSequence: 0,
            });
        }
        await registration.drain();
        return snapshot?.snapshot?.capabilities ?? {};
    }

    function native_csv_uri(): vscode.Uri {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-custom-editor-'));
        const file_path = path.join(temporary_directory, 'data.csv');
        fs.writeFileSync(file_path, 'a,b\n1,2\n');
        return vscode_mock.Uri.file(file_path) as unknown as vscode.Uri;
    }

    it('keeps a timed-out panel fenced and retries its renderer flush later', async () => {
        vi.useFakeTimers();
        const bytes = Buffer.from('a,b\n1,2\n');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const registration = register_table_viewer(context(), state_store());
        const registered = vscode_mock.__getCustomEditorRegistrations()
            .find((candidate) => candidate.viewType === 'tableViewer.editor');
        const provider = registered?.provider as {
            openCustomDocument(candidate: vscode.Uri): Promise<vscode.CustomDocument>;
            resolveCustomEditor(
                document: vscode.CustomDocument,
                panel: vscode.WebviewPanel,
            ): Promise<void>;
        };
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor',
            'data',
        ) as unknown as vscode.WebviewPanel;
        const document = await provider.openCustomDocument(native_csv_uri());
        await provider.resolveCustomEditor(document, panel);
        const mock_panel = vscode_mock.__getPanels()[0];
        await mock_panel.__receive({ type: 'ready' });

        registration.dispose();
        const first_drain = registration.drain();
        const first_failure = expect(first_drain).rejects.toThrow('did not flush pending edits');
        await vi.advanceTimersByTimeAsync(2_000);
        await first_failure;
        const first_request_count = mock_panel.__messages.filter((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'requestPendingEditsFlush'
        )).length;
        expect(first_request_count).toBe(1);

        registration.dispose();
        await vi.waitFor(() => expect(mock_panel.__messages.filter((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'requestPendingEditsFlush'
        )).length).toBe(2));
        const retry_request = mock_panel.__messages.filter((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'requestPendingEditsFlush'
        )).at(-1) as { requestId: string };
        await mock_panel.__receive({
            type: 'pendingEditsFlush',
            requestId: retry_request.requestId,
            highestProducedSequence: 0,
        });
        await expect(registration.drain()).resolves.toBeUndefined();
        vi.useRealTimers();
    });

    it('edits native-local CSV resources', async () => {
        expect(await csv_capabilities(native_csv_uri())).toMatchObject({
            csvEditingSupported: true,
            csvEditable: true,
        });
    });

    it('edits CSV resources reached through a remote extension host', async () => {
        // Editing goes through vscode.workspace.fs, which the host resolves for
        // remote authorities too. Nothing about the resource's locality gates it.
        vscode_mock.env.remoteName = 'ssh-remote';
        expect(await csv_capabilities(native_csv_uri())).toMatchObject({
            csvEditingSupported: true,
            csvEditable: true,
        });
    });

    it('edits CSV resources on a non-file scheme', async () => {
        const native_uri = native_csv_uri();
        const remote_uri = native_uri.with({ scheme: 'vscode-remote' }) as vscode.Uri;
        expect(await csv_capabilities(remote_uri)).toMatchObject({
            csvEditingSupported: true,
            csvEditable: true,
        });
    });
});
