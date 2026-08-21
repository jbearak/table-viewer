import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import CFB from 'cfb';
import { register_table_viewer } from '../custom-editor';
import {
    TABLE_DIFF_SCHEME,
    table_diff_document_uri,
} from '../table-diff-uris';
import type { AuthorityFileStateStore } from '../state';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import { messages_of } from './helpers/panel-messages';
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
            .find((candidate) => candidate.viewType === 'tableViewer.editor');
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

    async function receive_ready_and_get_snapshot(
        panel: ReturnType<typeof vscode_mock.__getPanels>[number],
    ): Promise<{
        configuration: { gitCompare?: unknown };
        capabilities: { csvEditingSupported: boolean };
    }> {
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot').length)
            .toBeGreaterThan(0));
        return messages_of(panel, 'workbookSnapshot')[0].snapshot as {
            configuration: { gitCompare?: unknown };
            capabilities: { csvEditingSupported: boolean };
        };
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
            'tableViewer.editor',
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
            'tableViewer.editor',
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
            'tableViewer.editor',
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
            'tableViewer.editor',
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
            expect(view_type).toBe('tableViewer.editor');
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.editor',
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
                'tableViewer.editor',
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
            'tableViewer.editor',
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
                'tableViewer.editor',
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

    it('keeps multi-viewer support for the unified custom editor', () => {
        register_table_viewer(context(), state_store());

        const registrations = vscode_mock.__getCustomEditorRegistrations();
        expect(registrations).toHaveLength(1);
        expect(registrations[0]).toMatchObject({
            viewType: 'tableViewer.editor',
            options: { supportsMultipleEditorsPerDocument: true },
        });
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

    it('opens a compare panel via openTableDiff and keeps later plain opens uncompared', async () => {
        const csv = Buffer.from('a\n1\n');
        vscode_mock.__setStatImplementation(async () => ({ size: csv.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => csv);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const uri = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const original = vscode_mock.Uri.file('/repo/data.csv')
            .with({ scheme: 'git', query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }) },
            ) as unknown as vscode.Uri;
        vscode_mock.__setCommand('vscode.openWith', async (
            target: unknown,
            view_type: unknown,
            view_column: unknown,
        ) => {
            expect(view_type).toBe('tableViewer.editor');
            expect(view_column).toBe(vscode_mock.ViewColumn.Active);
            expect((target as vscode.Uri).scheme).toBe(TABLE_DIFF_SCHEME);
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.editor',
                'data.csv',
            ) as unknown as vscode.WebviewPanel;
            const document = await provider.openCustomDocument(target as vscode.Uri);
            await provider.resolveCustomEditor(document, panel);
        });

        await registration.openTableDiff({ modified: uri, original });
        const compare_panel = vscode_mock.__getPanels()[0];
        const compare_snapshot = await receive_ready_and_get_snapshot(compare_panel);
        expect(compare_snapshot.configuration.gitCompare).toBeDefined();

        // A later plain open of the same file must not inherit the compare.
        const plain_panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor',
            'data.csv',
        ) as unknown as vscode.WebviewPanel;
        const document = await provider.openCustomDocument(uri);
        await provider.resolveCustomEditor(document, plain_panel);
        const plain_mock = vscode_mock.__getPanels()[1];
        const plain_snapshot = await receive_ready_and_get_snapshot(plain_mock);
        expect(plain_snapshot.configuration.gitCompare).toBeUndefined();
        await dispose_registration(registration, plain_mock);
    });

    it('restores a comparison directly from its synthetic document URI', async () => {
        const csv = Buffer.from('a\n1\n');
        vscode_mock.__setStatImplementation(async () => ({ size: csv.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => csv);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const original = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
        }) as unknown as vscode.Uri;
        const document_uri = table_diff_document_uri({ original, modified });
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor',
            'data.csv',
        ) as unknown as vscode.WebviewPanel;

        await provider.resolveCustomEditor(
            await provider.openCustomDocument(document_uri),
            panel,
        );

        const mock_panel = vscode_mock.__getPanels()[0];
        const snapshot = await receive_ready_and_get_snapshot(mock_panel);
        expect(snapshot.configuration.gitCompare).toBeDefined();
        expect(mock_panel.title).toBe('data.csv (Changes)');
        registration.dispose();
        await registration.drain();
    });

    it('reveals a retained comparison instead of resolving it again', async () => {
        const csv = Buffer.from('a\n1\n');
        vscode_mock.__setStatImplementation(async () => ({ size: csv.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => csv);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const original = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
        }) as unknown as vscode.Uri;
        const open_with = vi.fn(async (target: unknown) => {
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.editor',
                'data.csv',
            ) as unknown as vscode.WebviewPanel;
            await provider.resolveCustomEditor(
                await provider.openCustomDocument(target as vscode.Uri),
                panel,
            );
        });
        vscode_mock.__setCommand('vscode.openWith', open_with);

        await registration.openTableDiff({ modified, original });
        await registration.openTableDiff({ modified, original });

        expect(open_with).toHaveBeenCalledOnce();
        expect(vscode_mock.__getPanels()[0].__reveals).toBe(1);
        registration.dispose();
        await registration.drain();
    });

    it('coalesces concurrent opens for the same comparison', async () => {
        const registration = register_table_viewer(context(), state_store());
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const original = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
        }) as unknown as vscode.Uri;
        let release_open!: () => void;
        const open_gate = new Promise<void>((resolve) => { release_open = resolve; });
        const open_with = vi.fn(async () => open_gate);
        vscode_mock.__setCommand('vscode.openWith', open_with);

        const first = registration.openTableDiff({ modified, original });
        const second = registration.openTableDiff({ modified, original });

        expect(open_with).toHaveBeenCalledOnce();
        release_open();
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        registration.dispose();
        await registration.drain();
    });

    it('allows a comparison open to retry after a shared failure', async () => {
        const registration = register_table_viewer(context(), state_store());
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const original = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
        }) as unknown as vscode.Uri;
        const failure = new Error('open failed');
        const open_with = vi.fn()
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce(undefined);
        vscode_mock.__setCommand('vscode.openWith', (...args) => open_with(...args));

        const results = await Promise.allSettled([
            registration.openTableDiff({ modified, original }),
            registration.openTableDiff({ modified, original }),
        ]);

        expect(open_with).toHaveBeenCalledOnce();
        expect(results).toEqual([
            { status: 'rejected', reason: failure },
            { status: 'rejected', reason: failure },
        ]);
        await expect(registration.openTableDiff({ modified, original })).resolves.toBeUndefined();
        expect(open_with).toHaveBeenCalledTimes(2);
        registration.dispose();
        await registration.drain();
    });

    it('refreshes a retained comparison only when either side changed', async () => {
        const modified_bytes = Buffer.from('a\n2\n');
        let original_bytes = Buffer.from('a\n1\n');
        let original_mtime = 1;
        vscode_mock.__setStatImplementation(async (uri) => ({
            size: uri.scheme === 'git' ? original_bytes.length : modified_bytes.length,
            mtime: uri.scheme === 'git' ? original_mtime : 1,
        }));
        vscode_mock.__setReadFileImplementation(async (uri) => (
            uri.scheme === 'git' ? original_bytes : modified_bytes
        ));
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const original = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
        }) as unknown as vscode.Uri;
        vscode_mock.__setCommand('vscode.openWith', async (target: unknown) => {
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.editor',
                'data.csv',
            ) as unknown as vscode.WebviewPanel;
            await provider.resolveCustomEditor(
                await provider.openCustomDocument(target as vscode.Uri),
                panel,
            );
        });

        await registration.openTableDiff({ modified, original });
        const panel = vscode_mock.__getPanels()[0];
        panel.__autoAckSnapshots = false;
        await panel.__receive({ type: 'ready' });
        await acknowledge_latest_snapshot(panel);
        const initial_snapshots = messages_of(panel, 'workbookSnapshot').length;

        await registration.openTableDiff({ modified, original });
        expect(messages_of(panel, 'workbookSnapshot')).toHaveLength(initial_snapshots);
        expect(panel.__reveals).toBe(1);
        await registration.openTableDiff({ modified, original });
        expect(messages_of(panel, 'workbookSnapshot')).toHaveLength(initial_snapshots);
        expect(panel.__reveals).toBe(1);

        original_bytes = Buffer.from('a\n0\n');
        original_mtime = 2;
        panel.__autoAckSnapshots = true;
        await registration.openTableDiff({ modified, original });
        await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot'))
            .toHaveLength(initial_snapshots + 1));

        registration.dispose();
        await registration.drain();
    });

    it('opens File by revealing only the normal viewer for the comparison resource', async () => {
        const csv = Buffer.from('a\n1\n');
        vscode_mock.__setStatImplementation(async () => ({ size: csv.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => csv);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const original = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
        }) as unknown as vscode.Uri;
        for (const document_uri of [
            table_diff_document_uri({ original, modified }),
            modified,
        ]) {
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.editor',
                'data.csv',
            ) as unknown as vscode.WebviewPanel;
            await provider.resolveCustomEditor(
                await provider.openCustomDocument(document_uri),
                panel,
            );
        }

        await registration.openWorkingTreeFile(modified);

        const [compare_panel, plain_panel] = vscode_mock.__getPanels();
        expect(compare_panel.__reveals).toBe(0);
        expect(plain_panel.__reveals).toBe(1);
        registration.dispose();
        await registration.drain();
    });

    it('reports an older VS Code native custom-editor pair as one top-level diff', async () => {
        const csv = Buffer.from('a\n1\n');
        vscode_mock.__setStatImplementation(async () => ({ size: csv.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => csv);
        const tab: vscode_mock.MockTab = { label: 'data.csv', input: undefined };
        await vscode_mock.__fireTabChange({ opened: [tab] });
        const replace_native_diff = vi.fn();
        const registration = register_table_viewer(context(), state_store(), {
            replaceNativeDiff: replace_native_diff,
        });
        const provider = excel_provider();
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const original = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
        }) as unknown as vscode.Uri;

        for (const uri of [original, modified]) {
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.editor',
                'data.csv',
            ) as unknown as vscode.WebviewPanel;
            await provider.resolveCustomEditor(
                await provider.openCustomDocument(uri),
                panel,
            );
        }

        expect(replace_native_diff).toHaveBeenCalledOnce();
        expect(replace_native_diff).toHaveBeenCalledWith(tab, { original, modified });
        // The provider reports the top-level tab; it never disposes either side
        // of the DiffEditorInput independently.
        const panels = vscode_mock.__getPanels();
        expect(panels).toHaveLength(2);
        registration.dispose();
        await registration.drain();
        expect(vscode_mock.__getClosedTabs()).toEqual([tab]);
        expect(panels.map((panel) => panel.__disposeCount)).toEqual([1, 1]);
    });

    it('closes the owning native diff when one side declines its initial load', async () => {
        vscode_mock.__setConfigurationValue('tableViewer.maxFileSizeMiB', 1);
        vscode_mock.__setStatImplementation(async () => ({
            size: 2 * 1024 * 1024,
            mtime: 1,
        }));
        const tab: vscode_mock.MockTab = { label: 'data.csv', input: undefined };
        await vscode_mock.__fireTabChange({ opened: [tab] });
        const registration = register_table_viewer(context(), state_store(), {
            replaceNativeDiff() {},
        });
        const provider = excel_provider();
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const original = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
        }) as unknown as vscode.Uri;

        for (const uri of [original, modified]) {
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.editor',
                'data.csv',
            ) as unknown as vscode.WebviewPanel;
            await provider.resolveCustomEditor(
                await provider.openCustomDocument(uri),
                panel,
            );
        }
        const panels = vscode_mock.__getPanels();

        await panels[0].__receive({ type: 'ready' });
        await vi.waitFor(() => expect(vscode_mock.__getClosedTabs()).toEqual([tab]));
        expect(panels.map((panel) => panel.__disposeCount)).toEqual([1, 1]);
        registration.dispose();
        await registration.drain();
    });

    it('pairs older native-diff sides only within their owning editor group', async () => {
        const csv = Buffer.from('a\n1\n');
        vscode_mock.__setStatImplementation(async () => ({ size: csv.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => csv);
        const unrelated: vscode_mock.MockTab = { label: 'notes.txt', input: undefined };
        const diff_tab: vscode_mock.MockTab = { label: 'data.csv', input: undefined };
        vscode_mock.__setTabGroups([
            { viewColumn: vscode_mock.ViewColumn.Two, tabs: [diff_tab] },
            { viewColumn: vscode_mock.ViewColumn.One, tabs: [unrelated] },
        ], vscode_mock.ViewColumn.One);
        const replace_native_diff = vi.fn();
        const registration = register_table_viewer(context(), state_store(), {
            replaceNativeDiff: replace_native_diff,
        });
        const provider = excel_provider();
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const original = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
        }) as unknown as vscode.Uri;

        for (const uri of [original, modified]) {
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.editor',
                'data.csv',
                vscode_mock.ViewColumn.Beside,
            ) as unknown as vscode.WebviewPanel;
            await provider.resolveCustomEditor(
                await provider.openCustomDocument(uri),
                panel,
            );
        }

        expect(vscode_mock.__getPanels().map((panel) => panel.viewColumn)).toEqual([
            vscode_mock.ViewColumn.Two,
            vscode_mock.ViewColumn.Two,
        ]);
        expect(replace_native_diff).toHaveBeenCalledOnce();
        expect(replace_native_diff).toHaveBeenCalledWith(diff_tab, { original, modified });
        registration.dispose();
        await registration.drain();
        expect(vscode_mock.__getClosedTabs()).toEqual([diff_tab]);
        expect(vscode_mock.window.tabGroups.activeTabGroup.activeTab).toBe(unrelated);
    });

    it('does not pair a revision panel after that panel has closed', async () => {
        const csv = Buffer.from('a\n1\n');
        vscode_mock.__setStatImplementation(async () => ({ size: csv.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => csv);
        const tab: vscode_mock.MockTab = { label: 'data.csv', input: undefined };
        await vscode_mock.__fireTabChange({ opened: [tab] });
        const replace_native_diff = vi.fn();
        const registration = register_table_viewer(context(), state_store(), {
            replaceNativeDiff: replace_native_diff,
        });
        const provider = excel_provider();
        const original = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
        }) as unknown as vscode.Uri;
        const original_panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor',
            'data.csv',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(
            await provider.openCustomDocument(original),
            original_panel,
        );
        vscode_mock.__getPanels()[0].dispose();

        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const modified_panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor',
            'data.csv',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(
            await provider.openCustomDocument(modified),
            modified_panel,
        );

        expect(replace_native_diff).not.toHaveBeenCalled();
        const modified_mock = vscode_mock.__getPanels()[1];
        await receive_ready_and_get_snapshot(modified_mock);
        await dispose_registration(registration, modified_mock);
    });

    it('opens a staged index revision as a read-only compare against HEAD', async () => {
        const csv = Buffer.from('a\n2\n');
        vscode_mock.__setStatImplementation(async () => ({ size: csv.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => csv);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const modified = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '' }),
        }) as unknown as vscode.Uri;
        const original = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: 'HEAD' }),
        }) as unknown as vscode.Uri;
        vscode_mock.__setCommand('vscode.openWith', async (target: unknown) => {
            const panel = vscode_mock.window.createWebviewPanel(
                'tableViewer.editor',
                'data.csv',
            ) as unknown as vscode.WebviewPanel;
            const document = await provider.openCustomDocument(target as vscode.Uri);
            await provider.resolveCustomEditor(document, panel);
        });

        await registration.openTableDiff({ modified, original });

        const panel = vscode_mock.__getPanels()[0];
        const snapshot = await receive_ready_and_get_snapshot(panel);
        expect(snapshot.configuration.gitCompare).toBeDefined();
        expect(snapshot.capabilities.csvEditingSupported).toBe(false);
        registration.dispose();
        await registration.drain();
    });

    it('renders a bare git: URI read-only and leaves later plain opens uncompared', async () => {
        const csv = Buffer.from('a\n1\n');
        vscode_mock.__setStatImplementation(async () => ({ size: csv.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => csv);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const bare_git = vscode_mock.Uri.file('/repo/data.csv')
            .with({ scheme: 'git' }) as unknown as vscode.Uri;

        const git_panel_handle = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor',
            'data.csv',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(
            await provider.openCustomDocument(bare_git),
            git_panel_handle,
        );
        const git_panel = vscode_mock.__getPanels()[0];
        const snapshot = await receive_ready_and_get_snapshot(git_panel);
        expect(snapshot.configuration.gitCompare).toBeUndefined();
        expect(snapshot.capabilities.csvEditingSupported).toBe(false);

        // A plain open of the working-tree file afterwards is a normal editor.
        const file_uri = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const plain_handle = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor',
            'data.csv',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(
            await provider.openCustomDocument(file_uri),
            plain_handle,
        );
        const plain_panel = vscode_mock.__getPanels()[1];
        const plain_snapshot = await receive_ready_and_get_snapshot(plain_panel);
        expect(plain_snapshot.configuration.gitCompare).toBeUndefined();
        await dispose_registration(registration, plain_panel);
    });

    it('leaves a plain open uncompared after a standalone git revision closes', async () => {
        const csv = Buffer.from('a\n1\n');
        vscode_mock.__setStatImplementation(async () => ({ size: csv.length, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => csv);
        const registration = register_table_viewer(context(), state_store());
        const provider = excel_provider();
        const git_uri = vscode_mock.Uri.file('/repo/data.csv').with({
            scheme: 'git',
            query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
        }) as unknown as vscode.Uri;

        const git_handle = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor',
            'data.csv',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(
            await provider.openCustomDocument(git_uri),
            git_handle,
        );
        // Opening a revision directly is not a diff and must not leave state
        // that changes how the working-tree file opens later.
        vscode_mock.__getPanels()[0].dispose();

        const file_uri = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const plain_handle = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor',
            'data.csv',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(
            await provider.openCustomDocument(file_uri),
            plain_handle,
        );
        const plain_panel = vscode_mock.__getPanels().at(-1)!;
        const snapshot = await receive_ready_and_get_snapshot(plain_panel);
        expect(snapshot.configuration.gitCompare).toBeUndefined();
        await dispose_registration(registration, plain_panel);
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
