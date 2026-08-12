import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import CFB from 'cfb';
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
    function xlsx_fixture(): { uri: vscode.Uri; bytes: Buffer } {
        const fixture = path.join(__dirname, 'fixtures', 'basic.xlsx');
        return {
            uri: vscode_mock.Uri.file('/workbooks/basic.xlsx') as unknown as vscode.Uri,
            bytes: fs.readFileSync(fixture),
        };
    }

    function rename_sheet(bytes: Uint8Array, from: string, to: string): Uint8Array {
        const file = CFB.read(bytes, { type: 'buffer' });
        const entry = CFB.find(file, '/xl/workbook.xml')!;
        const xml = Buffer.from(entry.content as Uint8Array).toString('utf8');
        const renamed = Buffer.from(xml.replace(`name="${from}"`, `name="${to}"`), 'utf8');
        entry.content = renamed;
        entry.size = renamed.length;
        const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
        return written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBufferLike);
    }

    function excel_provider() {
        const registered = vscode_mock.__getCustomEditorRegistrations()
            .find((candidate) => candidate.viewType === 'tableViewer.excelViewer');
        return registered?.provider as {
            openCustomDocument(candidate: vscode.Uri): Promise<vscode.CustomDocument>;
            resolveCustomEditor(
                document: vscode.CustomDocument,
                panel: vscode.WebviewPanel,
            ): Promise<void>;
        };
    }

    async function dispose_registration(
        registration: ReturnType<typeof register_table_viewer>,
        panel: ReturnType<typeof vscode_mock.__getPanels>[number],
    ): Promise<void> {
        registration.dispose();
        await vi.waitFor(() => expect(panel.__messages.some((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'requestPendingEditsFlush'
        ))).toBe(true));
        const request = [...panel.__messages].reverse().find((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'requestPendingEditsFlush'
        )) as { requestId: string };
        await panel.__receive({
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            highestProducedSequence: 0,
        });
        await registration.drain();
    }

    async function acknowledge_latest_snapshot(
        panel: ReturnType<typeof vscode_mock.__getPanels>[number],
    ): Promise<void> {
        await vi.waitFor(() => expect(panel.__messages.some((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'workbookSnapshot'
        ))).toBe(true));
        const delivery = [...panel.__messages].reverse().find((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'workbookSnapshot'
        )) as { snapshot: { identity: unknown } };
        await panel.__receive({
            type: 'snapshotApplied',
            identity: delivery.snapshot.identity,
            disposition: 'applied',
        });
    }

    it('reveals an existing workbook and selects a named worksheet after its snapshot', async () => {
        const { uri, bytes } = xlsx_fixture();
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.excelViewer',
            'basic.xlsx',
        ) as unknown as vscode.WebviewPanel;
        const reveal = vi.spyOn(panel, 'reveal');
        const document = await provider.openCustomDocument(uri);
        await provider.resolveCustomEditor(document, panel);
        const mock_panel = vscode_mock.__getPanels()[0];
        mock_panel.__autoAckSnapshots = false;
        await mock_panel.__receive({ type: 'ready' });
        await acknowledge_latest_snapshot(mock_panel);

        await expect(registration.openWorkbookAtSheet(uri, 'Inventory')).resolves.toBe(true);

        expect(reveal).toHaveBeenCalledOnce();
        expect(mock_panel.__messages).toContainEqual({ type: 'selectSheet', sheetIndex: 1 });
        await expect(registration.openWorkbookAtSheet(uri, '2')).resolves.toBe(true);
        expect(mock_panel.__messages).toContainEqual({ type: 'selectSheet', sheetIndex: 1 });
        await expect(registration.openWorkbookAtSheet(uri, 'Not Here')).resolves.toBe(false);
        await dispose_registration(registration, mock_panel);
    });

    it('prefers an exact numeric worksheet name to an ordinal selector', async () => {
        const fixture = xlsx_fixture();
        const bytes = rename_sheet(fixture.bytes, 'Inventory', '1');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.excelViewer',
            'basic.xlsx',
        ) as unknown as vscode.WebviewPanel;
        const document = await provider.openCustomDocument(fixture.uri);
        await provider.resolveCustomEditor(document, panel);
        const mock_panel = vscode_mock.__getPanels()[0];
        mock_panel.__autoAckSnapshots = false;
        await mock_panel.__receive({ type: 'ready' });
        await acknowledge_latest_snapshot(mock_panel);

        await expect(registration.openWorkbookAtSheet(fixture.uri, '1')).resolves.toBe(true);
        expect(mock_panel.__messages).toContainEqual({ type: 'selectSheet', sheetIndex: 1 });
        await expect(registration.openWorkbookAtSheet(fixture.uri, '02')).resolves.toBe(false);
        await dispose_registration(registration, mock_panel);
    });

    it('waits for the replacement renderer snapshot before selecting a worksheet', async () => {
        const { uri, bytes } = xlsx_fixture();
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.excelViewer',
            'basic.xlsx',
        ) as unknown as vscode.WebviewPanel;
        const document = await provider.openCustomDocument(uri);
        await provider.resolveCustomEditor(document, panel);
        const mock_panel = vscode_mock.__getPanels()[0];
        mock_panel.__autoAckSnapshots = false;
        await mock_panel.__receive({ type: 'ready' });
        await acknowledge_latest_snapshot(mock_panel);

        await mock_panel.__receive({ type: 'ready' });
        const messages_before_selection = mock_panel.__messages.length;
        const selection = registration.openWorkbookAtSheet(uri, 'Inventory');
        expect(mock_panel.__messages.slice(messages_before_selection)).not.toContainEqual({
            type: 'selectSheet',
            sheetIndex: 1,
        });

        await vi.waitFor(() => expect(mock_panel.__messages.filter((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'workbookSnapshot'
        ))).toHaveLength(2));
        const delivery = [...mock_panel.__messages].reverse().find((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'workbookSnapshot'
        )) as { snapshot: { identity: unknown } };
        await mock_panel.__receive({
            type: 'snapshotApplied',
            identity: delivery.snapshot.identity,
            disposition: 'duplicate',
        });

        await expect(selection).resolves.toBe(true);
        expect(mock_panel.__messages.slice(messages_before_selection)).toContainEqual({
            type: 'selectSheet',
            sheetIndex: 1,
        });
        await dispose_registration(registration, mock_panel);
    });

    it('reuses an existing controller for an equivalent workbook URI', async () => {
        const { uri, bytes } = xlsx_fixture();
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.excelViewer',
            'basic.xlsx',
        ) as unknown as vscode.WebviewPanel;
        const reveal = vi.spyOn(panel, 'reveal');
        const document = await provider.openCustomDocument(uri);
        await provider.resolveCustomEditor(document, panel);
        const mock_panel = vscode_mock.__getPanels()[0];
        await mock_panel.__receive({ type: 'ready' });
        const open_with = vi.fn();
        vscode_mock.__setCommand('vscode.openWith', open_with);
        const equivalent = vscode_mock.Uri.file('/workbooks/sub/../basic.xlsx') as unknown as vscode.Uri;

        await expect(registration.openWorkbookAtSheet(equivalent, 'Inventory')).resolves.toBe(true);

        expect(open_with).not.toHaveBeenCalled();
        expect(reveal).toHaveBeenCalledOnce();
        expect(mock_panel.__messages).toContainEqual({ type: 'selectSheet', sheetIndex: 1 });
        await dispose_registration(registration, mock_panel);
    });

    it('opens cold before selecting and reports a missing worksheet without closing it', async () => {
        const { uri, bytes } = xlsx_fixture();
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        vscode_mock.__setCommand('vscode.openWith', async (target: unknown, view_type: unknown) => {
            expect(target).toBe(uri);
            expect(view_type).toBe('tableViewer.excelViewer');
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.excelViewer',
                'basic.xlsx',
            ) as unknown as vscode.WebviewPanel;
            const document = await provider.openCustomDocument(uri);
            await provider.resolveCustomEditor(document, panel);
            const mock_panel = vscode_mock.__getPanels()[0];
            mock_panel.__autoAckSnapshots = false;
            await mock_panel.__receive({ type: 'ready' });
            await acknowledge_latest_snapshot(mock_panel);
        });

        await expect(registration.openWorkbookAtSheet(uri, 'Not Here')).resolves.toBe(false);
        expect(vscode_mock.__getPanels()).toHaveLength(1);
        await expect(registration.openWorkbookAtSheet(uri, 'Inventory')).resolves.toBe(true);
        expect(vscode_mock.__getPanels()[0].__messages).toContainEqual({
            type: 'selectSheet',
            sheetIndex: 1,
        });
        await dispose_registration(registration, vscode_mock.__getPanels()[0]);
    });

    it('coalesces concurrent cold opens for the same workbook', async () => {
        const { uri, bytes } = xlsx_fixture();
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        let release_open!: () => void;
        const open_gate = new Promise<void>((resolve) => { release_open = resolve; });
        const open_with = vi.fn(async () => {
            await open_gate;
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.excelViewer',
                'basic.xlsx',
            ) as unknown as vscode.WebviewPanel;
            const document = await provider.openCustomDocument(uri);
            await provider.resolveCustomEditor(document, panel);
            await vscode_mock.__getPanels()[0].__receive({ type: 'ready' });
        });
        vscode_mock.__setCommand('vscode.openWith', open_with);

        const first = registration.openWorkbookAtSheet(uri, 'Inventory');
        const second = registration.openWorkbookAtSheet(uri, 'Inventory');
        await vi.waitFor(() => expect(open_with).toHaveBeenCalledOnce());
        release_open();

        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        expect(vscode_mock.__getPanels()[0].__messages.filter((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'selectSheet'
        ))).toEqual([
            { type: 'selectSheet', sheetIndex: 1 },
            { type: 'selectSheet', sheetIndex: 1 },
        ]);
        await dispose_registration(registration, vscode_mock.__getPanels()[0]);
    });

    it('routes worksheet selection to the active workbook panel', async () => {
        const { uri, bytes } = xlsx_fixture();
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const panels = [0, 1].map(() => vscode_mock.window.createWebviewPanel(
            'tableViewer.excelViewer',
            'basic.xlsx',
        ) as unknown as vscode.WebviewPanel);
        for (const panel of panels) {
            const document = await provider.openCustomDocument(uri);
            await provider.resolveCustomEditor(document, panel);
        }
        const [first, second] = vscode_mock.__getPanels();
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        second.active = true;
        const first_reveal = vi.spyOn(panels[0], 'reveal');
        const second_reveal = vi.spyOn(panels[1], 'reveal');

        await expect(registration.openWorkbookAtSheet(uri, 'Inventory')).resolves.toBe(true);

        expect(first_reveal).not.toHaveBeenCalled();
        expect(second_reveal).toHaveBeenCalledOnce();
        expect(first.__messages).not.toContainEqual({ type: 'selectSheet', sheetIndex: 1 });
        expect(second.__messages).toContainEqual({ type: 'selectSheet', sheetIndex: 1 });
        first.dispose();
        second.dispose();
        registration.dispose();
        await registration.drain();
    });

    it('clears a failed cold open so a later attempt can retry', async () => {
        const { uri, bytes } = xlsx_fixture();
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        vscode_mock.__setCommand('vscode.openWith', async () => {
            throw new Error('open failed');
        });

        await expect(registration.openWorkbookAtSheet(uri, 'Inventory')).rejects.toThrow(
            'open failed',
        );

        const retry = vi.fn(async () => {
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.excelViewer',
                'basic.xlsx',
            ) as unknown as vscode.WebviewPanel;
            const document = await provider.openCustomDocument(uri);
            await provider.resolveCustomEditor(document, panel);
            await vscode_mock.__getPanels()[0].__receive({ type: 'ready' });
        });
        vscode_mock.__setCommand('vscode.openWith', retry);
        await expect(registration.openWorkbookAtSheet(uri, 'Inventory')).resolves.toBe(true);
        expect(retry).toHaveBeenCalledOnce();
        await dispose_registration(registration, vscode_mock.__getPanels()[0]);
    });

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
