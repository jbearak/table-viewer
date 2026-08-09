import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    CsvTableEditorProvider,
    ExcelTableViewerProvider,
    register_table_viewer,
} from '../custom-editor';
import type { CsvCustomDocument } from '../csv-custom-document';
import {
    CSV_DOCUMENT_BACKUP_V2_MAX_BACKUP_BYTES,
    CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES,
} from '../csv-document-backup';
import { file_coordinator_registry_size } from '../file-coordinator';
import { get_max_file_size_mib } from '../viewer-config';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';

type CsvProviderDocument = CsvCustomDocument & vscode.CustomDocument;
type CsvProvider = vscode.CustomEditorProvider<CsvProviderDocument>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const cancellation = { isCancellationRequested: false } as vscode.CancellationToken;

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function context(): vscode.ExtensionContext {
    return {
        extensionUri: vscode_mock.Uri.file('/extension'),
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

function state_store() {
    return versioned_state_store().store;
}

interface MemoryFile {
    bytes: Uint8Array;
    mtime: number;
}

function install_memory_file_system(initial: Record<string, string>) {
    const files = new Map<string, MemoryFile>(Object.entries(initial).map(
        ([key, value], index) => [key, { bytes: encoder.encode(value), mtime: index + 1 }],
    ));
    const directories: string[] = [];
    const deleted: string[] = [];
    const reads: string[] = [];
    const writes: string[] = [];
    vscode_mock.__setStatImplementation(async (uri) => {
        const file = files.get(uri.toString());
        if (!file) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        return { size: file.bytes.byteLength, mtime: file.mtime };
    });
    vscode_mock.__setReadFileImplementation(async (uri) => {
        const key = uri.toString();
        reads.push(key);
        const file = files.get(key);
        if (!file) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        return file.bytes.slice();
    });
    vscode_mock.__setWriteFileImplementation(async (uri, bytes) => {
        const key = uri.toString();
        writes.push(key);
        const previous = files.get(key);
        files.set(key, {
            bytes: bytes.slice(),
            mtime: (previous?.mtime ?? files.size + 1) + 1,
        });
    });
    vscode_mock.__setCreateDirectoryImplementation(async (uri) => {
        directories.push(uri.toString());
    });
    vscode_mock.__setDeleteImplementation(async (uri) => {
        const key = uri.toString();
        deleted.push(key);
        files.delete(key);
    });
    return {
        files,
        directories,
        deleted,
        reads,
        writes,
        text(uri: vscode_mock.UriLike): string | undefined {
            const bytes = files.get(uri.toString())?.bytes;
            return bytes ? decoder.decode(bytes) : undefined;
        },
        replace(uri: vscode_mock.UriLike, value: string) {
            const previous = files.get(uri.toString());
            files.set(uri.toString(), {
                bytes: encoder.encode(value),
                mtime: (previous?.mtime ?? 0) + 1,
            });
        },
    };
}

function open_context(backupId?: string): vscode.CustomDocumentOpenContext {
    return { backupId } as vscode.CustomDocumentOpenContext;
}

async function open_document(
    provider: CsvProvider,
    uri: vscode.Uri,
    backupId?: string,
): Promise<CsvProviderDocument> {
    return provider.openCustomDocument(uri, open_context(backupId), cancellation);
}

const direct_view_epochs = new WeakMap<CsvCustomDocument, Map<string, number>>();
const direct_view_epoch_subscriptions = new WeakSet<CsvCustomDocument>();

function tracked_direct_view_epochs(
    document: CsvCustomDocument,
): Map<string, number> {
    let epochs = direct_view_epochs.get(document);
    if (!epochs) {
        epochs = new Map();
        direct_view_epochs.set(document, epochs);
    }
    if (!direct_view_epoch_subscriptions.has(document)) {
        direct_view_epoch_subscriptions.add(document);
        document.on_did_request_resync((event) => {
            tracked_direct_view_epochs(document).set(
                event.viewId,
                event.viewMutationEpoch,
            );
        });
    }
    return epochs;
}

async function attach_test_view(
    document: CsvCustomDocument,
    view_id: string,
) {
    const result = await document.attach_view(view_id);
    tracked_direct_view_epochs(document).set(view_id, result.viewMutationEpoch);
    return result;
}

function direct_view_authority(document: CsvCustomDocument, view_id: string) {
    const viewMutationEpoch = tracked_direct_view_epochs(document).get(view_id);
    if (viewMutationEpoch === undefined) throw new Error(`untracked view ${view_id}`);
    return { viewId: view_id, viewMutationEpoch };
}

function registered_csv_provider(): CsvProvider {
    const registered = vscode_mock.__getCustomEditorRegistrations()
        .find((candidate) => candidate.viewType === 'tableViewer.editor');
    expect(registered).toBeDefined();
    return registered!.provider as CsvProvider;
}

async function wait_for_message<T extends { type: string }>(
    panel: ReturnType<typeof vscode_mock.__getPanels>[number],
    type: T['type'],
    after = 0,
): Promise<T> {
    let found: T | undefined;
    await vi.waitFor(() => {
        found = panel.__messages.slice(after).find((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === type
        )) as T | undefined;
        expect(found).toBeDefined();
    });
    return found!;
}

beforeEach(() => {
    vscode_mock.__reset();
});

describe('custom editor provider split', () => {
    it('keeps Excel read-only and enables shared multi-view CSV documents', () => {
        register_table_viewer(context(), state_store());

        const registrations = vscode_mock.__getCustomEditorRegistrations();
        const excel = registrations.find((entry) => (
            entry.viewType === 'tableViewer.excelViewer'
        ));
        const csv = registrations.find((entry) => entry.viewType === 'tableViewer.editor');

        expect(excel?.options).toMatchObject({
            supportsMultipleEditorsPerDocument: true,
        });
        expect(csv?.options).toMatchObject({
            supportsMultipleEditorsPerDocument: true,
        });
        expect(excel?.provider).toBeInstanceOf(ExcelTableViewerProvider);
        expect(csv?.provider).toBeInstanceOf(CsvTableEditorProvider);
        expect(excel?.provider).not.toHaveProperty('saveCustomDocument');
        expect(csv?.provider).toHaveProperty('saveCustomDocument');
    });

    it('resolves Excel through the read-only provider with editing disabled', async () => {
        const uri = vscode_mock.Uri.file('/book.xlsx') as vscode.Uri;
        const bytes = readFileSync(join(__dirname, 'fixtures', 'basic.xlsx'));
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength,
            mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const registration = register_table_viewer(context(), state_store());
        const registered = vscode_mock.__getCustomEditorRegistrations().find((entry) => (
            entry.viewType === 'tableViewer.excelViewer'
        ));
        const provider = registered!.provider as vscode.CustomReadonlyEditorProvider;
        const document = await provider.openCustomDocument(
            uri,
            open_context(),
            cancellation,
        );
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.excelViewer',
            'book',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(document, panel, cancellation);
        const mock_panel = vscode_mock.__getPanels()[0];
        await mock_panel.__receive({ type: 'ready' });
        const snapshot = await wait_for_message<{
            type: 'workbookSnapshot';
            snapshot: { capabilities: {
                csvEditable: boolean;
                csvEditingSupported: boolean;
                csvEditingMode: string;
            } };
        }>(mock_panel, 'workbookSnapshot');

        expect(snapshot.snapshot.capabilities).toMatchObject({
            csvEditable: false,
            csvEditingSupported: false,
            csvEditingMode: 'selfManaged',
        });
        expect(registered!.provider).not.toHaveProperty('saveCustomDocument');
        registration.dispose();
        await registration.drain();
        document.dispose();
    });

    it('publishes an immutable VS Code edit event for every distinct input', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        const events: vscode.CustomDocumentEditEvent<CsvProviderDocument>[] = [];
        provider.onDidChangeCustomDocument((event) => events.push(event));
        expect(await attach_test_view(document, 'view:direct')).toMatchObject({
            type: 'attached',
            viewMutationEpoch: expect.any(Number),
        });

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:direct'), key: '0:1', value: '3', revision: 0,
        });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:direct'), key: '0:1', value: '34', revision: 1,
        });
        await document.complete_gesture({ mutationEpoch: document.mutationEpoch, ...direct_view_authority(document, 'view:direct'), revision: 2 });

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ document, label: 'Edit CSV cell' });
        expect(events[1]).toMatchObject({ document, label: 'Edit CSV cell' });
        expect(document.cell_value('0:1')).toBe('34');
        await events[1].undo();
        expect(document.cell_value('0:1')).toBe('3');
        expect(document.isDirty).toBe(true);
        await events[0].undo();
        expect(document.cell_value('0:1')).toBe('2');
        expect(document.isDirty).toBe(false);
        await events[0].redo();
        await events[1].redo();
        expect(document.cell_value('0:1')).toBe('34');
        expect(document.isDirty).toBe(true);

        await document.dispose();
        provider.dispose();
    });
});

describe('provider shutdown admissions', () => {
    it('rolls back the coordinator when pre-read watcher setup fails', async () => {
        const uri = vscode_mock.Uri.file('/watcher-setup-failure.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const registry_before = file_coordinator_registry_size();
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        vscode_mock.__setWatcherRegistrationFailure('create');

        await expect(open_document(provider, uri))
            .rejects.toThrow('watch create registration failed');

        expect(vscode_mock.__getWatcherHistory()).toHaveLength(1);
        expect(vscode_mock.__getActiveWatchers()).toEqual([]);
        expect(file_coordinator_registry_size()).toBe(registry_before);
        provider.dispose();
    });

    it('waits for an in-progress open and disposes the document when shutdown wins', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        const read_started = deferred();
        const release_read = deferred();
        const bytes = encoder.encode('a,b\n1,2\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength,
            mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => {
            read_started.resolve();
            await release_read.promise;
            return bytes;
        });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );

        const opening = open_document(provider, uri);
        await read_started.promise;
        provider.stop_admissions();
        const drain = provider.drain_documents_and_controllers();
        release_read.resolve();

        await expect(opening).rejects.toThrow('Table Viewer is deactivating.');
        await drain;
        expect(vscode_mock.__getActiveWatchers()).toEqual([]);
        provider.dispose();
    });

    it('disposes the pre-read watcher when cancellation wins an in-progress open', async () => {
        const uri = vscode_mock.Uri.file('/cancel-open.csv') as vscode.Uri;
        const bytes = encoder.encode('a,b\n1,2\n');
        const read_started = deferred();
        const release_read = deferred();
        let read_count = 0;
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength,
            mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => {
            read_count += 1;
            if (read_count === 1) {
                read_started.resolve();
                await release_read.promise;
            }
            return bytes;
        });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        let cancelled = false;
        const opening_token = {
            get isCancellationRequested() { return cancelled; },
        } as vscode.CancellationToken;

        const opening = provider.openCustomDocument(uri, open_context(), opening_token);
        await read_started.promise;
        expect(vscode_mock.__getActiveWatchers()).toHaveLength(1);
        cancelled = true;
        release_read.resolve();

        await expect(opening).rejects.toBeInstanceOf(vscode_mock.CancellationError);
        expect(vscode_mock.__getWatcherHistory()).toHaveLength(1);
        expect(vscode_mock.__getActiveWatchers()).toEqual([]);
        provider.dispose();
    });

    it('drains admitted lifecycle work, disposes documents, and rejects late callbacks', async () => {
        const first_uri = vscode_mock.Uri.file('/first.csv') as vscode.Uri;
        const second_uri = vscode_mock.Uri.file('/second.csv') as vscode.Uri;
        const backup_uri = vscode_mock.Uri.file('/backups/second/1') as vscode.Uri;
        const save_as_uri = vscode_mock.Uri.file('/late-save-as.csv') as vscode.Uri;
        const watcher_subscriptions_before = vscode_mock.__getActiveWatchers().length;
        const registry_before = file_coordinator_registry_size();
        install_memory_file_system({
            [first_uri.toString()]: 'a\n1\n',
            [second_uri.toString()]: 'b\n2\n',
        });
        const registration = register_table_viewer(context(), state_store());
        const provider = registered_csv_provider();
        const first_document = await open_document(provider, first_uri);
        const second_document = await open_document(provider, second_uri);
        const disposed_documents = new Set<CsvCustomDocument>();
        first_document.on_did_dispose(() => disposed_documents.add(first_document));
        second_document.on_did_dispose(() => disposed_documents.add(second_document));
        expect(vscode_mock.__getActiveWatchers()).toHaveLength(
            watcher_subscriptions_before + 2,
        );
        expect(file_coordinator_registry_size()).toBe(registry_before + 2);
        const backup_started = deferred();
        const release_backup = deferred();
        vscode_mock.__setWriteFileImplementation(async (target) => {
            if (target.toString() !== backup_uri.toString()) return;
            backup_started.resolve();
            await release_backup.promise;
        });

        const admitted_backup = provider.backupCustomDocument(
            second_document,
            { destination: backup_uri } as vscode.CustomDocumentBackupContext,
            cancellation,
        );
        await backup_started.promise;
        registration.dispose();
        let drain_settled = false;
        const drain = registration.drain().finally(() => { drain_settled = true; });
        await Promise.resolve();
        expect(drain_settled).toBe(false);

        await expect(provider.saveCustomDocument(first_document, cancellation))
            .rejects.toThrow('Table Viewer is deactivating.');
        await expect(provider.saveCustomDocumentAs(
            first_document,
            save_as_uri,
            cancellation,
        )).rejects.toThrow('Table Viewer is deactivating.');
        await expect(provider.revertCustomDocument(first_document, cancellation))
            .rejects.toThrow('Table Viewer is deactivating.');
        await expect(provider.backupCustomDocument(
            first_document,
            { destination: vscode_mock.Uri.file('/backups/first/1') as vscode.Uri },
            cancellation,
        )).rejects.toThrow('Table Viewer is deactivating.');

        release_backup.resolve();
        await expect(admitted_backup).resolves.toMatchObject({
            id: backup_uri.toString(),
        });
        await drain;
        expect(drain_settled).toBe(true);
        expect(disposed_documents).toEqual(new Set([
            first_document,
            second_document,
        ]));
        expect(vscode_mock.__getActiveWatchers()).toHaveLength(
            watcher_subscriptions_before,
        );
        expect(file_coordinator_registry_size()).toBe(registry_before);
    });

    it('awaits tracked document disposal before registration drain settles', async () => {
        const uri = vscode_mock.Uri.file('/dispose-drain.csv') as vscode.Uri;
        const watcher_subscriptions_before = vscode_mock.__getActiveWatchers().length;
        const registry_before = file_coordinator_registry_size();
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const registration = register_table_viewer(context(), state_store());
        const provider = registered_csv_provider();
        const provider_dispose_spy = vi.spyOn(
            provider as CsvTableEditorProvider,
            'dispose',
        );
        const document = await open_document(provider, uri);
        const disposal_started = deferred();
        const release_disposal = deferred();
        const original_dispose = document.dispose.bind(document);
        const dispose_spy = vi.spyOn(document, 'dispose').mockImplementation(async () => {
            disposal_started.resolve();
            await release_disposal.promise;
            await original_dispose();
        });
        let disposal_completed = false;
        document.on_did_dispose(() => { disposal_completed = true; });

        registration.dispose();
        let drain_settled = false;
        const drain = registration.drain().finally(() => { drain_settled = true; });
        await disposal_started.promise;

        expect(dispose_spy).toHaveBeenCalledTimes(1);
        expect(provider_dispose_spy).not.toHaveBeenCalled();
        expect(disposal_completed).toBe(false);
        expect(drain_settled).toBe(false);
        expect(vscode_mock.__getActiveWatchers()).toHaveLength(
            watcher_subscriptions_before + 1,
        );
        expect(file_coordinator_registry_size()).toBe(registry_before + 1);

        release_disposal.resolve();
        await drain;

        expect(disposal_completed).toBe(true);
        expect(drain_settled).toBe(true);
        expect(provider_dispose_spy).toHaveBeenCalledTimes(1);
        expect(vscode_mock.__getActiveWatchers()).toHaveLength(
            watcher_subscriptions_before,
        );
        expect(file_coordinator_registry_size()).toBe(registry_before);
    });

    it('waits for an in-flight controller source build before drain resolves', async () => {
        const uri = vscode_mock.Uri.file('/drain.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        const snapshot_started = deferred();
        const release_snapshot = deferred();
        const events: string[] = [];
        const original_snapshot = document.viewer_snapshot.bind(document);
        document.viewer_snapshot = vi.fn(async () => {
            snapshot_started.resolve();
            await release_snapshot.promise;
            const snapshot = await original_snapshot();
            events.push('snapshot');
            return snapshot;
        });
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'drain',
        ) as unknown as vscode.WebviewPanel;
        const register_dispose = panel.onDidDispose.bind(panel);
        vi.spyOn(panel, 'onDidDispose').mockImplementation((handler) => {
            const subscription = register_dispose(handler);
            return {
                dispose() {
                    subscription.dispose();
                    throw new Error('panel subscription dispose failed');
                },
            };
        });
        await provider.resolveCustomEditor(document, panel, cancellation);
        const ready = vscode_mock.__getPanels()[0].__receive({ type: 'ready' });
        await snapshot_started.promise;

        expect(() => provider.dispose()).toThrow('panel subscription dispose failed');
        const drain = provider.drain_documents_and_controllers().then(() => {
            events.push('drain');
        });
        release_snapshot.resolve();
        await Promise.all([ready, drain]);

        expect(events).toEqual(['snapshot', 'drain']);
        await document.dispose();
    });

    it('detaches a view admitted before shutdown while attach is in progress', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        const attach_started = deferred();
        const release_attach = deferred();
        const original_attach = document.attach_view.bind(document);
        document.attach_view = vi.fn(async (view_id: string) => {
            attach_started.resolve();
            await release_attach.promise;
            return original_attach(view_id);
        });
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'data',
        ) as unknown as vscode.WebviewPanel;

        const resolving = provider.resolveCustomEditor(document, panel, cancellation);
        await attach_started.promise;
        provider.stop_admissions();
        const drain = provider.drain_documents_and_controllers();
        release_attach.resolve();

        await expect(resolving).rejects.toThrow('Table Viewer is deactivating.');
        await drain;
        document.attach_view = original_attach;
        expect(await attach_test_view(document,'view:after-shutdown')).toMatchObject({
            type: 'attached',
            viewMutationEpoch: expect.any(Number),
        });
        await document.detach_view('view:after-shutdown');
        await document.dispose();
        provider.dispose();
    });
});

describe('native custom document lifecycle', () => {
    it('clamps legacy settings above the backup ceiling before reading a source', async () => {
        const uri = vscode_mock.Uri.file('/oversized.csv') as vscode.Uri;
        const read = vi.fn(async () => new Uint8Array());
        vscode_mock.__setConfigurationValue('tableViewer.maxFileSizeMiB', 512);
        expect(get_max_file_size_mib()).toBe(256);
        vscode_mock.__setStatImplementation(async () => ({
            size: CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES + 1,
            mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(read);
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );

        await expect(open_document(provider, uri)).rejects.toMatchObject({ code: 'tooLarge' });

        expect(read).not.toHaveBeenCalled();
        expect(vscode_mock.__getActiveWatchers()).toEqual([]);
        provider.dispose();
    });

    it('opens untitled initial data without filesystem access and reverts in memory', async () => {
        const uri = vscode_mock.Uri.from({
            scheme: 'untitled', path: '/Untitled-1.csv',
        }) as vscode.Uri;
        const fs = install_memory_file_system({});
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );

        const document = await provider.openCustomDocument(
            uri,
            {
                backupId: undefined,
                untitledDocumentData: encoder.encode('a,b\n1,2\n'),
            },
            cancellation,
        );

        expect(fs.reads).toEqual([]);
        expect(vscode_mock.__getWatcherHistory()).toEqual([]);
        expect(document.cell_value('0:1')).toBe('2');
        await attach_test_view(document,'view:untitled');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:untitled'), key: '0:1', value: 'dirty', revision: 0,
        });
        await provider.revertCustomDocument(document, cancellation);
        expect(document.cell_value('0:1')).toBe('2');
        expect(document.isDirty).toBe(false);
        expect(fs.reads).toEqual([]);

        await document.dispose();
        provider.dispose();
    });

    it('maps native lifecycle cancellation to vscode.CancellationError', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        const cancelled = {
            isCancellationRequested: true,
        } as vscode.CancellationToken;

        await expect(provider.saveCustomDocument(document, cancelled))
            .rejects.toBeInstanceOf(vscode_mock.CancellationError);
        await expect(provider.saveCustomDocumentAs(
            document,
            vscode_mock.Uri.file('/copy.csv') as vscode.Uri,
            cancelled,
        )).rejects.toBeInstanceOf(vscode_mock.CancellationError);
        await expect(provider.revertCustomDocument(document, cancelled))
            .rejects.toBeInstanceOf(vscode_mock.CancellationError);
        await expect(provider.backupCustomDocument(
            document,
            { destination: vscode_mock.Uri.file('/backup.bin') } as vscode.CustomDocumentBackupContext,
            cancelled,
        )).rejects.toBeInstanceOf(vscode_mock.CancellationError);

        await document.dispose();
        provider.dispose();
    });

    it('saves through the document, emits one source replacement, and does not self-reload', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        const fs = install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        await attach_test_view(document,'view:save');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:save'), key: '0:1', value: '3', revision: 0,
        });
        const replacements: string[] = [];
        document.on_did_change_content((event) => {
            if (event.type === 'sourceReplaced') replacements.push(event.reason);
        });

        await provider.saveCustomDocument(document, cancellation);

        expect(fs.text(uri as unknown as vscode_mock.UriLike)).toBe('a,b\n1,3\n');
        expect(document.isDirty).toBe(false);
        expect(replacements).toEqual(['save']);
        expect(document.sourceGeneration).toBe(2);
        await document.dispose();
        provider.dispose();
    });

    it('writes Save As as a copy without rebinding or cleaning the original document', async () => {
        const source = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        const destination = vscode_mock.Uri.file('/copy.TsV') as vscode.Uri;
        const fs = install_memory_file_system({ [source.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, source);
        await attach_test_view(document,'view:save-as');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:save-as'), key: '0:1', value: '9', revision: 0,
        });
        const revision = document.revision;
        const generation = document.sourceGeneration;

        await provider.saveCustomDocumentAs(document, destination, cancellation);

        expect(fs.text(destination as unknown as vscode_mock.UriLike)).toBe('a\tb\n1\t9\n');
        expect(fs.writes).toEqual([destination.toString()]);
        expect(document.uri).toBe(source);
        expect(document.delimiter).toBe(',');
        expect(document.isDirty).toBe(true);
        expect(document.revision).toBe(revision);
        expect(document.sourceGeneration).toBe(generation);
        await document.dispose();
        provider.dispose();
    });

    it('preserves the exact header width when Save As changes delimiters', async () => {
        const source = vscode_mock.Uri.file('/narrow-header.csv') as vscode.Uri;
        const destination = vscode_mock.Uri.file('/narrow-header.tsv') as vscode.Uri;
        const fs = install_memory_file_system({ [source.toString()]: 'h1\nx,y\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, source);

        await provider.saveCustomDocumentAs(document, destination, cancellation);

        expect(fs.text(destination as unknown as vscode_mock.UriLike)).toBe('h1\nx\ty\n');
        await document.dispose();
        provider.dispose();
    });

    it('preserves a TSV document delimiter for extensionless and unrecognized destinations', async () => {
        const source = vscode_mock.Uri.file('/data.tsv') as vscode.Uri;
        const extensionless = vscode_mock.Uri.file('/copy') as vscode.Uri;
        const unrecognized = vscode_mock.Uri.file('/copy.data') as vscode.Uri;
        const fs = install_memory_file_system({ [source.toString()]: 'a\tb\n1\t2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, source);

        await provider.saveCustomDocumentAs(document, extensionless, cancellation);
        await provider.saveCustomDocumentAs(document, unrecognized, cancellation);

        expect(fs.text(extensionless as unknown as vscode_mock.UriLike)).toBe('a\tb\n1\t2\n');
        expect(fs.text(unrecognized as unknown as vscode_mock.UriLike)).toBe('a\tb\n1\t2\n');
        expect(document.delimiter).toBe('\t');
        await document.dispose();
        provider.dispose();
    });

    it('uses an explicit CSV destination extension case-insensitively for a TSV document', async () => {
        const source = vscode_mock.Uri.file('/data.tsv') as vscode.Uri;
        const destination = vscode_mock.Uri.file('/copy.CsV') as vscode.Uri;
        const fs = install_memory_file_system({ [source.toString()]: 'a\tb\n1\t2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, source);

        await provider.saveCustomDocumentAs(document, destination, cancellation);

        expect(fs.text(destination as unknown as vscode_mock.UriLike)).toBe('a,b\n1,2\n');
        expect(document.delimiter).toBe('\t');
        await document.dispose();
        provider.dispose();
    });

    it('rejects multi-view Save As before writing and keeps later edits behind host settlement', async () => {
        const source = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        const destination = vscode_mock.Uri.file('/copy.csv') as vscode.Uri;
        const fs = install_memory_file_system({ [source.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, source);
        await attach_test_view(document,'view:save-as-first');
        await attach_test_view(document,'view:save-as-second');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:save-as-first'), key: '0:1', value: 'saved', revision: 0,
        });
        await document.complete_gesture({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:save-as-first'),
            revision: 1,
        });
        let host_save_as_settled = false;
        const edit_observations: boolean[] = [];
        provider.onDidChangeCustomDocument(() => {
            edit_observations.push(host_save_as_settled);
        });

        const saving = provider.saveCustomDocumentAs(
            document,
            destination,
            cancellation,
        ).finally(() => {
            host_save_as_settled = true;
        });
        const later_edit = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:save-as-first'), key: '0:1', value: 'later', revision: 1,
        });

        await expect(saving).rejects.toThrow(
            'Save As is unavailable while this CSV is open in multiple Table Viewer views. '
            + 'Close the other views and try again.',
        );
        await expect(later_edit).resolves.toMatchObject({
            type: 'accepted', revision: 2, changed: true,
        });
        expect(edit_observations).toEqual([true]);
        expect(fs.writes).toEqual([]);
        expect(fs.files.has(destination.toString())).toBe(false);
        expect(document.dirty_entry('0:1')).toEqual({ value: 'later', base: '2' });
        await document.dispose();
        provider.dispose();
    });

    it('publishes edits queued during native Save As only after its host promise settles', async () => {
        const source = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        const destination = vscode_mock.Uri.file('/copy.csv') as vscode.Uri;
        const fs = install_memory_file_system({ [source.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, source);
        await attach_test_view(document,'view:save-as-fence');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:save-as-fence'), key: '0:1', value: 'saved', revision: 0,
        });
        await document.complete_gesture({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:save-as-fence'),
            revision: 1,
        });
        const write_started = deferred();
        const release_write = deferred();
        vscode_mock.__setWriteFileImplementation(async (target, bytes) => {
            write_started.resolve();
            await release_write.promise;
            const key = target.toString();
            const previous = fs.files.get(key);
            fs.files.set(key, {
                bytes: bytes.slice(),
                mtime: (previous?.mtime ?? 0) + 1,
            });
        });
        let host_save_settled = false;
        const edit_observations: boolean[] = [];
        provider.onDidChangeCustomDocument(() => {
            edit_observations.push(host_save_settled);
        });

        const saving = provider.saveCustomDocumentAs(
            document,
            destination,
            cancellation,
        ).then(() => {
            host_save_settled = true;
        });
        await write_started.promise;
        await expect(document.attach_view('view:save-as-concurrent')).rejects.toThrow(
            'Save As is unavailable while this CSV is open in multiple Table Viewer views.',
        );
        const later_edit = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:save-as-fence'), key: '0:1', value: 'later', revision: 1,
        });
        release_write.resolve();
        await saving;
        await expect(document.attach_view('view:save-as-concurrent')).rejects.toThrow(
            'Save As is unavailable while this CSV is open in multiple Table Viewer views.',
        );
        await later_edit;
        expect(await attach_test_view(document,'view:save-as-concurrent')).toMatchObject({
            type: 'attached',
            viewMutationEpoch: expect.any(Number),
        });

        expect(edit_observations).toEqual([true]);
        expect(fs.text(destination as unknown as vscode_mock.UriLike)).toBe('a,b\n1,saved\n');
        expect(document.dirty_entry('0:1')).toEqual({ value: 'later', base: '2' });
        await document.dispose();
        provider.dispose();
    });

    it('reverts from workspace.fs and replaces the dirty source', async () => {
        const uri = vscode_mock.Uri.from({
            scheme: 'vscode-remote', authority: 'host', path: '/data.csv',
        }) as vscode.Uri;
        const fs = install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        await attach_test_view(document,'view:revert');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:revert'), key: '0:1', value: 'dirty', revision: 0,
        });
        fs.replace(uri as unknown as vscode_mock.UriLike, 'a,b\n8,7\n');

        await provider.revertCustomDocument(document, cancellation);

        expect(document.uri).toBe(uri);
        expect(document.cell_value('0:1')).toBe('7');
        expect(document.isDirty).toBe(false);
        await document.dispose();
        provider.dispose();
    });

    it('writes, restores, and best-effort deletes hot-exit backups through workspace.fs', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        const backup = vscode_mock.Uri.file('/backups/session/1') as vscode.Uri;
        const fs = install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        await attach_test_view(document,'view:backup');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:backup'), key: '0:1', value: 'saved in backup', revision: 0,
        });

        const created = await provider.backupCustomDocument(
            document,
            { destination: backup } as vscode.CustomDocumentBackupContext,
            cancellation,
        );
        expect(created.id).toBe(backup.toString());
        expect(fs.directories).toContain('/backups/session/1/..');

        const reads_before_restore = fs.reads.length;
        const restored = await open_document(provider, uri, created.id);
        expect(fs.reads.slice(reads_before_restore)).toEqual([
            backup.toString(),
            uri.toString(),
        ]);
        expect(restored.cell_value('0:1')).toBe('saved in backup');
        expect(restored.isDirty).toBe(true);
        expect(restored.conflict).toEqual({ type: 'none' });

        created.delete();
        await vi.waitFor(() => expect(fs.deleted).toContain(backup.toString()));
        await document.dispose();
        await restored.dispose();
        provider.dispose();
    });

    it('rejects an oversized hot-exit backup before workspace.fs reads it', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        const backup = vscode_mock.Uri.file('/backups/session/oversized') as vscode.Uri;
        const reads: string[] = [];
        vscode_mock.__setStatImplementation(async (resource) => {
            expect(resource.toString()).toBe(backup.toString());
            return {
                size: CSV_DOCUMENT_BACKUP_V2_MAX_BACKUP_BYTES + 1,
                mtime: 1,
            };
        });
        vscode_mock.__setReadFileImplementation(async (resource) => {
            reads.push(resource.toString());
            return new Uint8Array();
        });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );

        await expect(open_document(provider, uri, backup.toString())).rejects.toMatchObject({
            code: 'sizeLimit',
        });
        expect(reads).toEqual([]);
        provider.dispose();
    });
});

describe('controller document bridge', () => {
    it('synchronizes, patches, resynchronizes, and routes native commands', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const registration = register_table_viewer(context(), state_store());
        const provider = registered_csv_provider();
        const document = await open_document(provider, uri);
        const edit_events: vscode.CustomDocumentEditEvent<CsvProviderDocument>[] = [];
        provider.onDidChangeCustomDocument((event) => {
            if ('undo' in event && 'redo' in event) {
                edit_events.push(
                    event as vscode.CustomDocumentEditEvent<CsvProviderDocument>,
                );
            }
        });
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'data',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(document, panel, cancellation);
        const mock_panel = vscode_mock.__getPanels()[0];
        await mock_panel.__receive({ type: 'ready' });
        const snapshot = await wait_for_message<{
            type: 'workbookSnapshot';
            snapshot: { capabilities: { csvEditingMode: string; csvDocumentViewId: string } };
        }>(mock_panel, 'workbookSnapshot');
        const sync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; sourceGeneration: number;
            viewMutationEpoch: number;
        }>(mock_panel, 'csvDocumentSync');
        expect(snapshot.snapshot.capabilities).toMatchObject({
            csvEditingMode: 'vscodeDocument',
            csvDocumentViewId: expect.any(String),
        });
        const viewId = snapshot.snapshot.capabilities.csvDocumentViewId;
        const before_input = mock_panel.__messages.length;

        await mock_panel.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            key: '0:1',
            value: '3',
            revision: sync.revision,
        });
        const patch = await wait_for_message<{
            type: 'csvDocumentPatch'; revision: number; key: string; value: string;
        }>(mock_panel, 'csvDocumentPatch', before_input);
        expect(patch).toMatchObject({ key: '0:1', value: '3', revision: 1 });
        expect(edit_events).toHaveLength(1);

        const before_resync = mock_panel.__messages.length;
        await mock_panel.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            key: '0:1',
            value: 'stale',
            revision: 99,
        });
        const resync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; dirtyEntries: unknown;
            viewMutationEpoch: number;
        }>(mock_panel, 'csvDocumentSync', before_resync);
        expect(resync.revision).toBe(document.revision);

        vi.spyOn(document, 'apply_cell_input').mockRejectedValueOnce(
            Object.assign(new Error('backup admission rejected'), { code: 'sizeLimit' }),
        );
        const before_rejected_input = mock_panel.__messages.length;
        await mock_panel.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: resync.viewMutationEpoch,
            viewId,
            key: '0:1',
            value: 'rejected',
            revision: resync.revision,
        });
        await wait_for_message(
            mock_panel,
            'csvDocumentSync',
            before_rejected_input,
        );
        expect(vscode_mock.__getWarningMessages()).toEqual([
            'Table Viewer could not apply that edit. The previous value was restored.',
        ]);

        const undo_registration = vscode_mock.commands.registerCommand(
            'undo',
            () => edit_events[edit_events.length - 1]?.undo(),
        );
        const redo_registration = vscode_mock.commands.registerCommand(
            'redo',
            () => edit_events[edit_events.length - 1]?.redo(),
        );
        await mock_panel.__receive({ type: 'csvDocumentNativeCommand', command: 'save' });
        await mock_panel.__receive({ type: 'csvDocumentNativeCommand', command: 'undo' });
        expect(document.cell_value('0:1')).toBe('2');
        await mock_panel.__receive({ type: 'csvDocumentNativeCommand', command: 'redo' });
        expect(document.cell_value('0:1')).toBe('3');
        expect(vscode_mock.__getExecutedCommands().slice(-3).map(({ command }) => command))
            .toEqual(['workbench.action.files.save', 'undo', 'redo']);
        undo_registration.dispose();
        redo_registration.dispose();

        registration.dispose();
        await registration.drain();
        expect(mock_panel.__messages.some((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'requestPendingEditsFlush'
        ))).toBe(false);
        await document.dispose();
    });

    it('cancels every pre- and post-backup segment and preserves Redo order', async () => {
        const uri = vscode_mock.Uri.file('/cancel.csv') as vscode.Uri;
        const backup = vscode_mock.Uri.file('/backups/cancel/1') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const registration = register_table_viewer(context(), state_store());
        const provider = registered_csv_provider();
        const document = await open_document(provider, uri);
        const edit_events: vscode.CustomDocumentEditEvent<CsvProviderDocument>[] = [];
        let native_cursor = 0;
        provider.onDidChangeCustomDocument((event) => {
            if ('undo' in event && 'redo' in event) {
                edit_events.splice(native_cursor);
                edit_events.push(
                    event as vscode.CustomDocumentEditEvent<CsvProviderDocument>,
                );
                native_cursor += 1;
            }
        });
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'cancel',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(document, panel, cancellation);
        const mock_panel = vscode_mock.__getPanels()[0];
        await mock_panel.__receive({ type: 'ready' });
        const snapshot = await wait_for_message<{
            type: 'workbookSnapshot';
            snapshot: { capabilities: { csvDocumentViewId: string } };
        }>(mock_panel, 'workbookSnapshot');
        const sync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; viewMutationEpoch: number;
        }>(mock_panel, 'csvDocumentSync');
        const viewId = snapshot.snapshot.capabilities.csvDocumentViewId;
        const undo_registration = vscode_mock.commands.registerCommand(
            'undo',
            async () => {
                native_cursor -= 1;
                await edit_events[native_cursor]?.undo();
            },
        );
        const redo_registration = vscode_mock.commands.registerCommand(
            'redo',
            async () => {
                await edit_events[native_cursor]?.redo();
                native_cursor += 1;
            },
        );

        await mock_panel.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            key: '0:1',
            value: 'live',
            revision: sync.revision,
        });
        await provider.backupCustomDocument(
            document,
            { destination: backup } as vscode.CustomDocumentBackupContext,
            cancellation,
        );
        await mock_panel.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            key: '0:1',
            value: 'later',
            revision: 1,
        });
        expect(edit_events).toHaveLength(2);
        const before_cancel = mock_panel.__messages.length;
        await mock_panel.__receive({
            type: 'csvDocumentGestureCancel',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            revision: 2,
        });
        expect(document.cell_value('0:1')).toBe('2');
        expect(document.isDirty).toBe(false);
        expect(document.revision).toBe(4);
        expect(native_cursor).toBe(0);
        expect(mock_panel.__messages.slice(before_cancel).filter((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'csvDocumentPatch'
        ))).toEqual([
            expect.objectContaining({ revision: 3, key: '0:1', value: 'live' }),
            expect.objectContaining({ revision: 4, key: '0:1', value: '2' }),
        ]);
        expect(vscode_mock.__getExecutedCommands().slice(-2).map(({ command }) => command))
            .toEqual(['undo', 'undo']);

        await mock_panel.__receive({
            type: 'csvDocumentNativeCommand', command: 'redo',
        });
        expect(document.cell_value('0:1')).toBe('live');
        expect(document.isDirty).toBe(true);
        expect(document.revision).toBe(5);
        await mock_panel.__receive({
            type: 'csvDocumentNativeCommand', command: 'redo',
        });
        expect(document.cell_value('0:1')).toBe('later');
        expect(document.revision).toBe(6);

        undo_registration.dispose();
        redo_registration.dispose();
        registration.dispose();
        await registration.drain();
        await document.dispose();
    });

    it('returns native history to its savepoint when completion is net-zero', async () => {
        const uri = vscode_mock.Uri.file('/net-zero.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const registration = register_table_viewer(context(), state_store());
        const provider = registered_csv_provider();
        const document = await open_document(provider, uri);
        const edit_events: vscode.CustomDocumentEditEvent<CsvProviderDocument>[] = [];
        let native_cursor = 0;
        provider.onDidChangeCustomDocument((event) => {
            if (!('undo' in event && 'redo' in event)) return;
            edit_events.splice(native_cursor);
            edit_events.push(event as vscode.CustomDocumentEditEvent<CsvProviderDocument>);
            native_cursor += 1;
        });
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'net zero',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(document, panel, cancellation);
        const mock_panel = vscode_mock.__getPanels()[0];
        await mock_panel.__receive({ type: 'ready' });
        const snapshot = await wait_for_message<{
            type: 'workbookSnapshot';
            snapshot: { capabilities: { csvDocumentViewId: string } };
        }>(mock_panel, 'workbookSnapshot');
        const sync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; viewMutationEpoch: number;
        }>(mock_panel, 'csvDocumentSync');
        const viewId = snapshot.snapshot.capabilities.csvDocumentViewId;
        const callbacks: number[] = [];
        const undo_registration = vscode_mock.commands.registerCommand(
            'undo',
            async () => {
                native_cursor -= 1;
                callbacks.push(native_cursor);
                await edit_events[native_cursor].undo();
            },
        );

        await mock_panel.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            key: '0:1',
            value: 'live',
            revision: sync.revision,
        });
        await mock_panel.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            key: '0:1',
            value: '2',
            revision: 1,
        });
        expect(edit_events).toHaveLength(2);
        expect(document.isDirty).toBe(false);
        expect(native_cursor).toBe(2);

        await mock_panel.__receive({
            type: 'csvDocumentGestureComplete',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            revision: 2,
        });

        expect(callbacks).toEqual([1, 0]);
        expect(vscode_mock.__getExecutedCommands().slice(-2).map(({ command }) => command))
            .toEqual(['undo', 'undo']);
        expect(native_cursor).toBe(0);
        expect(document.cell_value('0:1')).toBe('2');
        expect(document.isDirty).toBe(false);
        expect(document.revision).toBe(4);

        const commands_after_reconciliation = vscode_mock.__getExecutedCommands().length;
        await mock_panel.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            key: '0:1',
            value: 'ordinary change',
            revision: 4,
        });
        await mock_panel.__receive({
            type: 'csvDocumentGestureComplete',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            revision: 5,
        });
        expect(vscode_mock.__getExecutedCommands()).toHaveLength(
            commands_after_reconciliation,
        );
        expect(native_cursor).toBe(1);
        expect(document.cell_value('0:1')).toBe('ordinary change');
        expect(document.isDirty).toBe(true);

        undo_registration.dispose();
        registration.dispose();
        await registration.drain();
        await document.dispose();
    });

    it('warns and resynchronizes when cancellation gets no native callback', async () => {
        const uri = vscode_mock.Uri.file('/cancel-failure.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const registration = register_table_viewer(context(), state_store());
        const provider = registered_csv_provider();
        const document = await open_document(provider, uri);
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'cancel failure',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(document, panel, cancellation);
        const mock_panel = vscode_mock.__getPanels()[0];
        await mock_panel.__receive({ type: 'ready' });
        const snapshot = await wait_for_message<{
            type: 'workbookSnapshot';
            snapshot: { capabilities: { csvDocumentViewId: string } };
        }>(mock_panel, 'workbookSnapshot');
        const sync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; viewMutationEpoch: number;
        }>(mock_panel, 'csvDocumentSync');
        const viewId = snapshot.snapshot.capabilities.csvDocumentViewId;
        const undo_registration = vscode_mock.commands.registerCommand(
            'undo',
            () => undefined,
        );
        await mock_panel.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            key: '0:1',
            value: 'live',
            revision: sync.revision,
        });

        const before_cancel = mock_panel.__messages.length;
        await mock_panel.__receive({
            type: 'csvDocumentGestureCancel',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId,
            revision: 1,
        });
        const resync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; viewMutationEpoch: number;
            dirtyEntries: Record<string, { value: string; base: string }>;
        }>(mock_panel, 'csvDocumentSync', before_cancel);
        expect(resync).toMatchObject({
            revision: 1,
            dirtyEntries: { '0:1': { value: 'live', base: '2' } },
        });
        expect(document.cell_value('0:1')).toBe('live');
        expect(vscode_mock.__getWarningMessages()).toEqual([
            'Table Viewer could not complete the document history operation. '
            + 'The table was resynchronized.',
        ]);

        undo_registration.dispose();
        registration.dispose();
        await registration.drain();
        await document.dispose();
    });

    it('refuses inactive-panel native commands instead of saving another editor', async () => {
        const uri = vscode_mock.Uri.file('/inactive.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const registration = register_table_viewer(context(), state_store());
        const provider = registered_csv_provider();
        const document = await open_document(provider, uri);
        const save = vi.fn(async (saved_uri: vscode_mock.UriLike) => saved_uri);
        vscode_mock.__setSaveImplementation(save);
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'inactive',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(document, panel, cancellation);
        const mock_panel = vscode_mock.__getPanels()[0];
        await mock_panel.__receive({ type: 'ready' });
        await wait_for_message(mock_panel, 'csvDocumentSync');
        mock_panel.__setActive(false);

        const before_history = mock_panel.__messages.length;
        await mock_panel.__receive({
            type: 'csvDocumentNativeCommand', command: 'undo',
        });
        expect(vscode_mock.__getExecutedCommands().some(
            ({ command }) => command === 'undo',
        )).toBe(false);
        await wait_for_message(mock_panel, 'csvDocumentSync', before_history);
        expect(vscode_mock.__getWarningMessages()).toEqual([
            'Table Viewer could not complete the document history operation. '
            + 'The table was resynchronized.',
        ]);

        await mock_panel.__receive({
            type: 'csvDocumentNativeCommand', command: 'save',
        });
        expect(save).not.toHaveBeenCalled();
        expect(vscode_mock.__getExecutedCommands().some(
            ({ command }) => command === 'workbench.action.files.save',
        )).toBe(false);
        expect(vscode_mock.__getWarningMessages()).toEqual([
            'Table Viewer could not complete the document history operation. '
            + 'The table was resynchronized.',
            'Table Viewer could not route Save because the requesting table is no longer active. '
            + 'Return to the table and try again.',
        ]);

        registration.dispose();
        await registration.drain();
        await document.dispose();
    });

    it('refuses queued Save when another editor becomes active before dispatch', async () => {
        const first_uri = vscode_mock.Uri.file('/targeted-first.csv') as vscode.Uri;
        const second_uri = vscode_mock.Uri.file('/targeted-second.csv') as vscode.Uri;
        install_memory_file_system({
            [first_uri.toString()]: 'a\nfirst\n',
            [second_uri.toString()]: 'a\nsecond\n',
        });
        const registration = register_table_viewer(context(), state_store());
        const provider = registered_csv_provider();
        const first_document = await open_document(provider, first_uri);
        const second_document = await open_document(provider, second_uri);
        const first_panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'targeted first',
        ) as unknown as vscode.WebviewPanel;
        const second_panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'targeted second',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(first_document, first_panel, cancellation);
        await provider.resolveCustomEditor(second_document, second_panel, cancellation);
        const [first, second] = vscode_mock.__getPanels();
        await Promise.all([
            first.__receive({ type: 'ready' }),
            second.__receive({ type: 'ready' }),
        ]);
        await Promise.all([
            wait_for_message(first, 'csvDocumentSync'),
            wait_for_message(second, 'csvDocumentSync'),
        ]);
        const saved_uris: vscode_mock.UriLike[] = [];
        vscode_mock.__setSaveImplementation(async (saved_uri) => {
            saved_uris.push(saved_uri);
            return saved_uri;
        });
        first.__setActive(true);
        second.__setActive(false);

        const save_request = Promise.resolve().then(() => first.__receive({
            type: 'csvDocumentNativeCommand', command: 'save',
        }));
        first.__setActive(false);
        second.__setActive(true);
        await save_request;

        expect(saved_uris).toEqual([]);
        expect(vscode_mock.__getExecutedCommands().some(
            ({ command }) => command === 'workbench.action.files.save',
        )).toBe(false);
        expect(vscode_mock.__getWarningMessages()).toEqual([
            'Table Viewer could not route Save because the requesting table is no longer active. '
            + 'Return to the table and try again.',
        ]);

        registration.dispose();
        await registration.drain();
        await Promise.all([first_document.dispose(), second_document.dispose()]);
    });

    it('rechecks the originating panel when a queued history command reaches dispatch', async () => {
        const uri = vscode_mock.Uri.file('/queued-panel.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const registration = register_table_viewer(context(), state_store());
        const provider = registered_csv_provider();
        const document = await open_document(provider, uri);
        const edit_events: vscode.CustomDocumentEditEvent<CsvProviderDocument>[] = [];
        provider.onDidChangeCustomDocument((event) => {
            if ('undo' in event && 'redo' in event) {
                edit_events.push(
                    event as vscode.CustomDocumentEditEvent<CsvProviderDocument>,
                );
            }
        });
        const first_panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'queued first',
        ) as unknown as vscode.WebviewPanel;
        const second_panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'queued second',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(document, first_panel, cancellation);
        await provider.resolveCustomEditor(document, second_panel, cancellation);
        const [first, second] = vscode_mock.__getPanels();
        await Promise.all([
            first.__receive({ type: 'ready' }),
            second.__receive({ type: 'ready' }),
        ]);
        const first_snapshot = await wait_for_message<{
            type: 'workbookSnapshot';
            snapshot: { capabilities: { csvDocumentViewId: string } };
        }>(first, 'workbookSnapshot');
        await wait_for_message(second, 'workbookSnapshot');
        const first_sync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; viewMutationEpoch: number;
        }>(first, 'csvDocumentSync');
        await wait_for_message(second, 'csvDocumentSync');
        first.__setActive(true);
        await first.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: first_sync.viewMutationEpoch,
            viewId: first_snapshot.snapshot.capabilities.csvDocumentViewId,
            key: '0:1',
            value: 'live',
            revision: first_sync.revision,
        });

        const first_command_started = deferred();
        const release_first_command = deferred();
        let native_invocations = 0;
        const undo_registration = vscode_mock.commands.registerCommand(
            'undo',
            async () => {
                native_invocations += 1;
                first_command_started.resolve();
                await release_first_command.promise;
                await edit_events[0].undo();
            },
        );
        const first_command = first.__receive({
            type: 'csvDocumentNativeCommand', command: 'undo',
        });
        await first_command_started.promise;

        second.__setActive(true);
        expect(second.active).toBe(true);
        const history_spy = vi.spyOn(document, 'run_native_history_command');
        const second_before = second.__messages.length;
        const queued_command = second.__receive({
            type: 'csvDocumentNativeCommand', command: 'redo',
        });
        await vi.waitFor(() => {
            expect(history_spy).toHaveBeenCalledWith('redo', expect.any(Function));
        });
        first.__setActive(true);
        expect(second.active).toBe(false);

        release_first_command.resolve();
        await first_command;
        await queued_command;
        expect(native_invocations).toBe(1);
        expect(vscode_mock.__getExecutedCommands().filter(
            ({ command }) => command === 'undo' || command === 'redo',
        ).map(({ command }) => command)).toEqual(['undo']);
        expect(document.cell_value('0:1')).toBe('2');
        await wait_for_message(second, 'csvDocumentSync', second_before);
        expect(vscode_mock.__getWarningMessages()).toEqual([
            'Table Viewer could not complete the document history operation. '
            + 'The table was resynchronized.',
        ]);

        undo_registration.dispose();
        registration.dispose();
        await registration.drain();
        await document.dispose();
    });

    it('publishes queued edits before finalizing the provider bridge during drain', async () => {
        const uri = vscode_mock.Uri.file('/history-drain.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const registration = register_table_viewer(context(), state_store());
        const provider = registered_csv_provider();
        const document = await open_document(provider, uri);
        const final_cell_values = new Map<string, string>();
        document.on_did_change_content((event) => {
            if (event.type === 'cell') final_cell_values.set(event.key, event.value);
        });
        const edit_events: vscode.CustomDocumentEditEvent<CsvProviderDocument>[] = [];
        provider.onDidChangeCustomDocument((event) => {
            if ('undo' in event && 'redo' in event) {
                edit_events.push(
                    event as vscode.CustomDocumentEditEvent<CsvProviderDocument>,
                );
            }
        });
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'history drain',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(document, panel, cancellation);
        const mock_panel = vscode_mock.__getPanels()[0];
        await mock_panel.__receive({ type: 'ready' });
        const snapshot = await wait_for_message<{
            type: 'workbookSnapshot';
            snapshot: { capabilities: { csvDocumentViewId: string } };
        }>(mock_panel, 'workbookSnapshot');
        const sync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; viewMutationEpoch: number;
        }>(mock_panel, 'csvDocumentSync');
        await mock_panel.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId: snapshot.snapshot.capabilities.csvDocumentViewId,
            key: '0:1',
            value: 'live',
            revision: sync.revision,
        });
        const command_started = deferred();
        const release_command = deferred();
        const undo_registration = vscode_mock.commands.registerCommand(
            'undo',
            async () => {
                command_started.resolve();
                await release_command.promise;
                await edit_events[0].undo();
            },
        );
        const command = mock_panel.__receive({
            type: 'csvDocumentNativeCommand', command: 'undo',
        });
        await command_started.promise;
        const apply_spy = vi.spyOn(document, 'apply_cell_input');
        const queued_input_message = {
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: sync.viewMutationEpoch,
            viewId: snapshot.snapshot.capabilities.csvDocumentViewId,
            key: '0:0',
            value: 'queued during history',
            revision: 2,
        } as const;
        const queued_input = mock_panel.__receive(queued_input_message);
        await vi.waitFor(() => {
            expect(apply_spy).toHaveBeenCalledWith({
                viewId: queued_input_message.viewId,
                key: queued_input_message.key,
                value: queued_input_message.value,
                revision: queued_input_message.revision,
                mutationEpoch: queued_input_message.mutationEpoch,
                viewMutationEpoch: queued_input_message.viewMutationEpoch,
            });
        });

        registration.dispose();
        let drain_settled = false;
        const drain = registration.drain().finally(() => { drain_settled = true; });
        await Promise.resolve();
        expect(drain_settled).toBe(false);

        release_command.resolve();
        await command;
        await queued_input;
        await drain;
        expect(final_cell_values).toEqual(new Map([
            ['0:1', '2'],
            ['0:0', 'queued during history'],
        ]));
        expect(edit_events).toHaveLength(2);
        expect(edit_events[1]).toMatchObject({ document, label: 'Edit CSV cell' });
        expect(drain_settled).toBe(true);

        undo_registration.dispose();
    });

    it('rejects a stale document source candidate when replacement advances its generation', async () => {
        const uri = vscode_mock.Uri.file('/candidate.csv') as vscode.Uri;
        const fs = install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        const verification_started = deferred();
        const release_verification = deferred();
        const original_resync = document.resync_snapshot.bind(document);
        let verification_count = 0;
        document.resync_snapshot = vi.fn(async () => {
            verification_count += 1;
            if (verification_count === 1) {
                verification_started.resolve();
                await release_verification.promise;
            }
            return original_resync();
        });
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'candidate',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(document, panel, cancellation);
        const mock_panel = vscode_mock.__getPanels()[0];

        const ready = mock_panel.__receive({ type: 'ready' });
        await verification_started.promise;
        fs.replace(uri as unknown as vscode_mock.UriLike, 'a,b\n1,9\n');
        await document.revert();
        expect(document.sourceGeneration).toBe(2);
        release_verification.resolve();
        await ready;
        await vi.waitFor(() => expect(mock_panel.__messages.filter((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'workbookSnapshot'
        ))).toHaveLength(1));
        const workbook = await wait_for_message<{
            type: 'workbookSnapshot';
            snapshot: { generation: number };
        }>(mock_panel, 'workbookSnapshot');
        const sync = await wait_for_message<{
            type: 'csvDocumentSync'; sourceGeneration: number; viewMutationEpoch: number;
        }>(mock_panel, 'csvDocumentSync');
        expect(sync.sourceGeneration).toBe(2);

        await mock_panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 1,
            requestId: 'candidate-generation-rows',
            generation: workbook.snapshot.generation,
        });
        const rows = await wait_for_message<{
            type: 'rowData';
            requestId: string;
            rows: Array<Array<{ raw: string }>>;
        }>(mock_panel, 'rowData');
        expect(rows.requestId).toBe('candidate-generation-rows');
        expect(rows.rows[0].map((cell) => cell.raw)).toEqual(['1', '9']);

        document.resync_snapshot = original_resync;
        panel.dispose();
        await provider.drain_documents_and_controllers();
        await document.dispose();
        provider.dispose();
    });

    it('publishes document sync after a replacement refresh succeeds on retry', async () => {
        const uri = vscode_mock.Uri.file('/candidate-retry.csv') as vscode.Uri;
        const fs = install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        const panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'candidate retry',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(document, panel, cancellation);
        const mock_panel = vscode_mock.__getPanels()[0];
        await mock_panel.__receive({ type: 'ready' });
        await wait_for_message(mock_panel, 'workbookSnapshot');
        await wait_for_message(mock_panel, 'csvDocumentSync');

        const original_resync = document.resync_snapshot.bind(document);
        const stale_verification_returned = deferred();
        let reject_first_replacement_candidate = true;
        document.resync_snapshot = vi.fn(async () => {
            const snapshot = await original_resync();
            if (
                reject_first_replacement_candidate
                && snapshot.sourceGeneration === 2
            ) {
                reject_first_replacement_candidate = false;
                stale_verification_returned.resolve();
                return Object.freeze({
                    ...snapshot,
                    sourceGeneration: snapshot.sourceGeneration - 1,
                });
            }
            return snapshot;
        });

        const before_replacement = mock_panel.__messages.length;
        vi.useFakeTimers();
        try {
            fs.replace(uri as unknown as vscode_mock.UriLike, 'a,b\n1,9\n');
            await document.revert();
            await stale_verification_returned.promise;
            await vi.advanceTimersByTimeAsync(0);
            expect(vi.getTimerCount()).toBeGreaterThan(0);
            await vi.runOnlyPendingTimersAsync();
            await provider.drain_documents_and_controllers();

            const replacement_messages = mock_panel.__messages.slice(before_replacement);
            const workbook_index = replacement_messages.findIndex((message) => (
                typeof message === 'object' && message !== null
                && 'type' in message && message.type === 'workbookSnapshot'
            ));
            const sync_index = replacement_messages.findIndex((message) => (
                typeof message === 'object' && message !== null
                && 'type' in message && message.type === 'csvDocumentSync'
            ));
            expect(workbook_index).toBeGreaterThanOrEqual(0);
            expect(sync_index).toBeGreaterThan(workbook_index);
            expect(replacement_messages.filter((message) => (
                typeof message === 'object' && message !== null
                && 'type' in message && message.type === 'workbookSnapshot'
            ))).toHaveLength(1);
            expect(replacement_messages[sync_index]).toMatchObject({
                type: 'csvDocumentSync',
                mutationEpoch: 2,
                sourceGeneration: 2,
            });

            const workbook = replacement_messages[workbook_index] as {
                type: 'workbookSnapshot'; snapshot: { generation: number };
            };
            await mock_panel.__receive({
                type: 'requestRows',
                sheetIndex: 0,
                startRow: 0,
                count: 1,
                requestId: 'candidate-retry-rows',
                generation: workbook.snapshot.generation,
            });
            const rows = mock_panel.__messages.find((message) => (
                typeof message === 'object' && message !== null
                && 'type' in message && message.type === 'rowData'
                && 'requestId' in message
                && message.requestId === 'candidate-retry-rows'
            )) as { rows: Array<Array<{ raw: string }>> } | undefined;
            expect(rows?.rows[0].map((cell) => cell.raw)).toEqual(['1', '9']);
        } finally {
            vi.useRealTimers();
            document.resync_snapshot = original_resync;
            panel.dispose();
            await provider.drain_documents_and_controllers();
            await document.dispose();
            provider.dispose();
        }
    });

    it('shares broadcasts, targeted resync, panel lifetime, and backup across two views', async () => {
        const uri = vscode_mock.Uri.file('/shared.csv') as vscode.Uri;
        const backup = vscode_mock.Uri.file('/backups/shared/1') as vscode.Uri;
        const fs = install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const registration = register_table_viewer(context(), state_store());
        const provider = registered_csv_provider();
        const document = await open_document(provider, uri);
        const edit_events: vscode.CustomDocumentEditEvent<CsvProviderDocument>[] = [];
        provider.onDidChangeCustomDocument((event) => {
            if ('undo' in event && 'redo' in event) {
                edit_events.push(
                    event as vscode.CustomDocumentEditEvent<CsvProviderDocument>,
                );
            }
        });
        const first_panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'shared first',
        ) as unknown as vscode.WebviewPanel;
        const second_panel = vscode_mock.window.createWebviewPanel(
            'tableViewer.editor', 'shared second',
        ) as unknown as vscode.WebviewPanel;
        await provider.resolveCustomEditor(document, first_panel, cancellation);
        await provider.resolveCustomEditor(document, second_panel, cancellation);
        const [first, second] = vscode_mock.__getPanels();
        await Promise.all([
            first.__receive({ type: 'ready' }),
            second.__receive({ type: 'ready' }),
        ]);
        const first_snapshot = await wait_for_message<{
            type: 'workbookSnapshot';
            snapshot: { capabilities: { csvDocumentViewId: string } };
        }>(first, 'workbookSnapshot');
        const second_snapshot = await wait_for_message<{
            type: 'workbookSnapshot';
            snapshot: { capabilities: { csvDocumentViewId: string } };
        }>(second, 'workbookSnapshot');
        const first_sync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; viewMutationEpoch: number;
        }>(first, 'csvDocumentSync');
        const second_sync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; viewMutationEpoch: number;
        }>(second, 'csvDocumentSync');
        const first_view_id = first_snapshot.snapshot.capabilities.csvDocumentViewId;
        const second_view_id = second_snapshot.snapshot.capabilities.csvDocumentViewId;
        expect(first_view_id).not.toBe(second_view_id);
        expect(first_sync.revision).toBe(0);
        expect(second_sync.revision).toBe(0);
        const first_before = first.__messages.length;
        const second_before = second.__messages.length;

        await Promise.all([
            first.__receive({
                type: 'csvDocumentCellInput',
                mutationEpoch: 1,
                viewMutationEpoch: first_sync.viewMutationEpoch,
                viewId: first_view_id,
                key: '0:0',
                value: 'first',
                revision: 0,
            }),
            second.__receive({
                type: 'csvDocumentCellInput',
                mutationEpoch: 1,
                viewMutationEpoch: second_sync.viewMutationEpoch,
                viewId: second_view_id,
                key: '0:1',
                value: 'stale',
                revision: 0,
            }),
            second.__receive({
                type: 'csvDocumentCellInput',
                mutationEpoch: 1,
                viewMutationEpoch: second_sync.viewMutationEpoch,
                viewId: second_view_id,
                key: '0:1',
                value: 'later stale',
                revision: 1,
            }),
        ]);
        await Promise.all([
            wait_for_message(first, 'csvDocumentPatch', first_before),
            wait_for_message(second, 'csvDocumentPatch', second_before),
        ]);
        const second_targeted_sync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; viewMutationEpoch: number;
        }>(second, 'csvDocumentSync', second_before);
        const first_patches = first.__messages.slice(first_before).filter((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'csvDocumentPatch'
        )) as Array<{ selfOriginated: boolean; key: string; value: string }>;
        const second_patches = second.__messages.slice(second_before).filter((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'csvDocumentPatch'
        )) as Array<{ selfOriginated: boolean; key: string; value: string }>;
        expect(first_patches).toHaveLength(1);
        expect(second_patches).toHaveLength(1);
        expect(first_patches[0]).toMatchObject({
            selfOriginated: true,
            key: '0:0',
            value: 'first',
        });
        expect(second_patches[0]).toMatchObject({
            selfOriginated: false,
            key: '0:0',
            value: 'first',
        });
        expect(first.__messages.slice(first_before).some((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'csvDocumentSync'
        ))).toBe(false);
        expect(second.__messages.slice(second_before).filter((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'csvDocumentSync'
        ))).toHaveLength(1);
        expect(second_targeted_sync.viewMutationEpoch)
            .not.toBe(second_sync.viewMutationEpoch);
        expect(document.revision).toBe(1);
        expect(document.cell_value('0:1')).toBe('2');
        expect(edit_events).toHaveLength(1);

        const first_before_explicit_resync = first.__messages.length;
        const second_before_explicit_resync = second.__messages.length;
        await second.__receive({
            type: 'csvDocumentResyncRequest',
            mutationEpoch: 1,
            viewMutationEpoch: second_targeted_sync.viewMutationEpoch,
            viewId: second_view_id,
        });
        const second_explicit_sync = await wait_for_message<{
            type: 'csvDocumentSync'; revision: number; viewMutationEpoch: number;
        }>(second, 'csvDocumentSync', second_before_explicit_resync);
        expect(first.__messages.slice(first_before_explicit_resync).some((message) => (
            typeof message === 'object' && message !== null
            && 'type' in message && message.type === 'csvDocumentSync'
        ))).toBe(false);

        first.dispose();
        await (provider as CsvTableEditorProvider).drain_documents_and_controllers();
        const second_edit_start = second.__messages.length;
        await second.__receive({
            type: 'csvDocumentCellInput',
            mutationEpoch: 1,
            viewMutationEpoch: second_explicit_sync.viewMutationEpoch,
            viewId: second_view_id,
            key: '0:1',
            value: 'second',
            revision: 1,
        });
        await wait_for_message(second, 'csvDocumentPatch', second_edit_start);
        expect(document.cell_value('0:0')).toBe('first');
        expect(document.cell_value('0:1')).toBe('second');
        expect(document.revision).toBe(2);
        expect(edit_events).toHaveLength(2);

        const created = await provider.backupCustomDocument(
            document,
            { destination: backup } as vscode.CustomDocumentBackupContext,
            cancellation,
        );
        const reads_before_restore = fs.reads.length;
        const restored = await open_document(provider, uri, created.id);
        expect(fs.reads.slice(reads_before_restore)).toEqual([
            backup.toString(),
            uri.toString(),
        ]);
        expect(restored.cell_value('0:0')).toBe('first');
        expect(restored.cell_value('0:1')).toBe('second');
        expect(restored.isDirty).toBe(true);

        registration.dispose();
        await registration.drain();
        await document.dispose();
        await restored.dispose();
    });

    it('uses workspace.fs for a non-file CSV resource', async () => {
        const uri = vscode_mock.Uri.from({
            scheme: 'memfs', authority: 'tests', path: '/data.csv',
        }) as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );

        const document = await open_document(provider, uri);

        expect(document.identity.uri.scheme).toBe('memfs');
        expect(document.cell_value('0:1')).toBe('2');
        await document.dispose();
        provider.dispose();
    });
});

describe('document watcher reconciliation', () => {
    it('observes before the initial read and reconciles a change queued during open', async () => {
        const uri = vscode_mock.Uri.file('/open-race.csv') as vscode.Uri;
        const fs = install_memory_file_system({ [uri.toString()]: 'a,b\n1,initial\n' });
        let stat_calls = 0;
        vscode_mock.__setStatImplementation(async (target) => {
            const file = fs.files.get(target.toString());
            if (!file) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
            const observed = { size: file.bytes.byteLength, mtime: file.mtime };
            stat_calls += 1;
            expect(vscode_mock.__getActiveWatchers()).toHaveLength(1);
            if (stat_calls === 2) {
                fs.replace(uri as unknown as vscode_mock.UriLike, 'a,b\n1,changed\n');
                await vscode_mock.__getActiveWatchers()[0].__fireChange(
                    uri as unknown as vscode_mock.UriLike,
                );
            }
            return observed;
        });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );

        const document = await open_document(provider, uri);

        expect(document.cell_value('0:1')).toBe('changed');
        expect(document.sourceGeneration).toBe(2);
        expect(document.mutationEpoch).toBe(2);
        expect(document.conflict).toEqual({ type: 'none' });
        expect(vscode_mock.__getWatcherHistory()).toHaveLength(1);
        await document.dispose();
        provider.dispose();
        expect(vscode_mock.__getActiveWatchers()).toEqual([]);
    });

    it('reloads a clean external change and preserves a dirty document as a conflict', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        const fs = install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        const watcher = vscode_mock.__getActiveWatchers()[0];
        fs.replace(uri as unknown as vscode_mock.UriLike, 'a,b\n1,5\n');

        await watcher.__fireChange(uri as unknown as vscode_mock.UriLike);
        await vi.waitFor(() => expect(document.cell_value('0:1')).toBe('5'));
        expect(document.conflict).toEqual({ type: 'none' });

        await attach_test_view(document,'view:dirty-watch');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:dirty-watch'), key: '0:1', value: 'mine',
            revision: document.revision,
        });
        fs.replace(uri as unknown as vscode_mock.UriLike, 'a,b\n1,6\n');
        await watcher.__fireChange(uri as unknown as vscode_mock.UriLike);
        await vi.waitFor(() => expect(document.conflict).toEqual({
            type: 'externalChange',
        }));
        expect(document.cell_value('0:1')).toBe('mine');

        await document.dispose();
        provider.dispose();
    });

    it('preserves a clean document and reports conflict when its external source is deleted', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        const fs = install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        const watcher = vscode_mock.__getActiveWatchers()[0];
        fs.files.delete(uri.toString());

        await watcher.__fireDelete(uri as unknown as vscode_mock.UriLike);
        await vi.waitFor(() => expect(document.conflict).toEqual({
            type: 'externalChange',
        }));

        expect(document.cell_value('0:1')).toBe('2');
        expect(document.isDirty).toBe(false);
        await document.dispose();
        provider.dispose();
    });

    it('reconciles an overwrite queued after save verification before post-save dispatch', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        const fs = install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        const watcher = vscode_mock.__getActiveWatchers()[0];
        await attach_test_view(document,'view:post-save-overwrite');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:post-save-overwrite'), key: '0:1', value: 'saved', revision: 0,
        });
        const replacements: string[] = [];
        document.on_did_change_content((event) => {
            if (event.type === 'sourceReplaced') replacements.push(event.reason);
        });
        let write_completed = false;
        vscode_mock.__setWriteFileImplementation(async (target, bytes) => {
            const key = target.toString();
            const previous = fs.files.get(key);
            fs.files.set(key, {
                bytes: bytes.slice(),
                mtime: (previous?.mtime ?? 0) + 1,
            });
            write_completed = true;
        });
        let post_write_stats = 0;
        vscode_mock.__setStatImplementation(async (target) => {
            const file = fs.files.get(target.toString());
            if (!file) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
            const observed = { size: file.bytes.byteLength, mtime: file.mtime };
            if (write_completed && ++post_write_stats === 2) {
                fs.replace(uri as unknown as vscode_mock.UriLike, 'a,b\n1,external\n');
                void watcher.__fireChange(uri as unknown as vscode_mock.UriLike);
            }
            return observed;
        });

        const result = await document.save();
        await expect(result.postSaveCompletion).resolves.toEqual({ type: 'completed' });

        expect(document.cell_value('0:1')).toBe('saved');
        expect(document.isDirty).toBe(false);
        expect(document.conflict).toEqual({ type: 'externalChange' });
        expect(document.sourceGeneration).toBe(2);
        expect(document.mutationEpoch).toBe(1);
        expect(replacements).toEqual(['save']);
        await document.dispose();
        provider.dispose();
    });

    it('does not replace the source again for an own-write-only reconciliation', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        const fs = install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const document = await open_document(provider, uri);
        const watcher = vscode_mock.__getActiveWatchers()[0];
        await attach_test_view(document,'view:own-write');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...direct_view_authority(document, 'view:own-write'), key: '0:1', value: 'saved', revision: 0,
        });
        const initial_epoch = document.mutationEpoch;
        const replacements: string[] = [];
        document.on_did_change_content((event) => {
            if (event.type === 'sourceReplaced') replacements.push(event.reason);
        });
        vscode_mock.__setWriteFileImplementation(async (target, bytes) => {
            const key = target.toString();
            const previous = fs.files.get(key);
            fs.files.set(key, {
                bytes: bytes.slice(),
                mtime: (previous?.mtime ?? 0) + 1,
            });
            await watcher.__fireChange(uri as unknown as vscode_mock.UriLike);
        });

        const result = await document.save();
        await expect(result.postSaveCompletion).resolves.toEqual({ type: 'completed' });

        expect(document.cell_value('0:1')).toBe('saved');
        expect(document.isDirty).toBe(false);
        expect(document.sourceGeneration).toBe(2);
        expect(document.mutationEpoch).toBe(initial_epoch);
        expect(replacements).toEqual(['save']);
        await document.dispose();
        provider.dispose();
    });

    it('delivers another document save while absorbing the initiating document save', async () => {
        const uri = vscode_mock.Uri.file('/data.csv') as vscode.Uri;
        install_memory_file_system({ [uri.toString()]: 'a,b\n1,2\n' });
        const first_provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const second_provider = new CsvTableEditorProvider(
            vscode_mock.Uri.file('/extension') as vscode.Uri,
            state_store(),
        );
        const first = await open_document(first_provider, uri);
        const second = await open_document(second_provider, uri);
        await attach_test_view(first, 'view:first');
        await first.apply_cell_input({
            mutationEpoch: first.mutationEpoch,
            ...direct_view_authority(first, 'view:first'), key: '0:1', value: '8', revision: 0,
        });
        const first_replacements: string[] = [];
        first.on_did_change_content((event) => {
            if (event.type === 'sourceReplaced') first_replacements.push(event.reason);
        });

        await first_provider.saveCustomDocument(first, cancellation);
        await vi.waitFor(() => expect(second.cell_value('0:1')).toBe('8'));

        expect(first_replacements).toEqual(['save']);
        expect(first.sourceGeneration).toBe(2);
        expect(second.sourceGeneration).toBe(2);
        first.dispose();
        second.dispose();
        first_provider.dispose();
        second_provider.dispose();
    });
});
