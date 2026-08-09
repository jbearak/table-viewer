import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
    CsvCustomDocument,
    type CsvDocumentRefreshSubscription,
} from './csv-custom-document';
import {
    CSV_DOCUMENT_BACKUP_V2_MAX_BACKUP_BYTES,
    CsvDocumentBackupError,
} from './csv-document-backup';
import { CsvSaveServiceError } from './csv-save-service';
import {
    acquire_file_coordinator,
    type FileCoordinatorAttachment,
    type FileRefreshSubscription,
} from './file-coordinator';
import { attach_viewer, profile_for, type ViewerController } from './viewer-controller';
import type { ResourceIdentity } from './resource-identity';
import { create_resource_identity } from './resource-identity';
import type { FileStateStore } from './state';
import {
    build_vscode_webview_html,
    vscode_file_system_port,
    vscode_viewer_host,
} from './vscode-host-ports';
import { get_csv_max_rows, get_max_file_size_mib } from './viewer-config';
import { vscode_file_refresh_watcher_factory } from './vscode-file-refresh-watcher';
import { generate_nonce } from './webview-html';

const EXCEL_VIEW_TYPE = 'tableViewer.excelViewer';
export const TABLE_VIEW_TYPE = 'tableViewer.editor';
const BYTES_PER_MIB = 1024 * 1024;

type VscodeCsvCustomDocument = CsvCustomDocument & vscode.CustomDocument;

function configure_webview(
    panel: vscode.WebviewPanel,
    extension_uri: vscode.Uri,
): void {
    panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(extension_uri, 'dist', 'webview'),
        ],
    };
    panel.webview.html = build_vscode_webview_html(
        panel.webview,
        extension_uri,
        generate_nonce(),
    );
}

function max_file_size_bytes(): number {
    return Math.floor(get_max_file_size_mib() * BYTES_PER_MIB);
}

async function read_csv_document_backup(backup_id: string): Promise<Uint8Array> {
    const resource = vscode.Uri.parse(backup_id);
    const stat = await vscode.workspace.fs.stat(resource);
    if (
        !Number.isSafeInteger(stat.size)
        || stat.size < 0
        || stat.size > CSV_DOCUMENT_BACKUP_V2_MAX_BACKUP_BYTES
    ) {
        throw new CsvDocumentBackupError(
            'sizeLimit',
            'CSV backup exceeds the immutable V2 backup size limit.',
        );
    }
    return vscode.workspace.fs.readFile(resource);
}

function save_as_delimiter(
    destination: vscode.Uri,
    current: ',' | '\t',
): ',' | '\t' {
    const path = destination.path.toLowerCase();
    if (path.endsWith('.tsv')) return '\t';
    if (path.endsWith('.csv')) return ',';
    return current;
}

async function vscode_csv_operation<T>(operation: Promise<T>): Promise<T> {
    try {
        return await operation;
    } catch (error) {
        if (error instanceof CsvSaveServiceError && error.code === 'cancelled') {
            throw new vscode.CancellationError();
        }
        throw error;
    }
}

function throw_if_cancelled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
}

class CoordinatorDocumentRefresh implements CsvDocumentRefreshSubscription {
    private readonly coordinator: FileCoordinatorAttachment;
    private readonly subscription: FileRefreshSubscription;
    private disposed = false;

    constructor(
        identity: ResourceIdentity,
        on_external_change: (() => Promise<void>) | undefined,
    ) {
        this.coordinator = acquire_file_coordinator(identity.uri);
        try {
            this.subscription = this.coordinator.subscribe_refresh(async (event) => {
                if (!on_external_change || this.disposed) return { type: 'disposed' };
                // A pure own postSave needs no reload. If it absorbed watcher evidence,
                // reconciliation queues behind the save without delaying save completion.
                if (
                    event.requestedByThisSubscription
                    && !event.absorbedWatcherSignal
                ) return { type: 'completed' };
                try {
                    await on_external_change();
                    return { type: 'completed' };
                } catch (error) {
                    return { type: 'failed', error };
                }
            }, vscode_file_refresh_watcher_factory);
        } catch (error) {
            // Construction transfers coordinator ownership only after the watcher-backed
            // subscription exists. Roll it back when pre-read observation cannot start.
            this.coordinator.dispose();
            throw error;
        }
    }

    reserve_post_save(): { cancel(): void } {
        return this.subscription.reserve_post_save();
    }

    request(reason: 'postSave'): Promise<unknown> {
        return this.subscription.request(reason);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.subscription.dispose();
        this.coordinator.dispose();
    }
}

interface ManagedController {
    readonly controller: ViewerController;
    readonly panel: vscode.WebviewPanel;
    readonly document?: CsvCustomDocument;
    readonly viewId?: string;
    panelDisposeSubscription?: vscode.Disposable;
}

abstract class ViewerProviderBase {
    protected readonly controllers = new Set<ManagedController>();
    private readonly drains = new Set<Promise<void>>();
    private readonly pending_admissions = new Set<Promise<unknown>>();
    protected admissions_open = true;

    constructor(
        protected readonly extension_uri: vscode.Uri,
        protected readonly state_store: FileStateStore,
    ) {}

    protected track_admission<T>(operation: Promise<T>): Promise<T> {
        this.pending_admissions.add(operation);
        void operation.finally(() => {
            this.pending_admissions.delete(operation);
        }).catch(() => undefined);
        return operation;
    }

    protected manage_controller(managed: ManagedController): boolean {
        this.controllers.add(managed);
        if (!this.admissions_open) {
            this.dispose_controller(managed);
            return false;
        }
        managed.panelDisposeSubscription = managed.panel.onDidDispose(() => {
            this.dispose_controller(managed);
        });
        return true;
    }

    protected dispose_controller(managed: ManagedController): void {
        if (!this.controllers.delete(managed)) return;
        let first_error: unknown;
        try {
            managed.panelDisposeSubscription?.dispose();
        } catch (error) {
            first_error = error;
        }
        try {
            managed.controller.dispose();
        } catch (error) {
            first_error ??= error;
        }
        // Register the drain even when either synchronous disposable throws. Otherwise
        // deactivation can close SQLite while controller/document work is still live.
        const drain = (async () => {
            if (managed.document && managed.viewId) {
                try {
                    await managed.document.detach_view(managed.viewId);
                } catch {
                    // The document may already be disposing; controller drain still runs.
                }
            }
            await managed.controller.drain();
        })();
        this.drains.add(drain);
        void drain.finally(() => this.drains.delete(drain)).catch(() => undefined);
        if (first_error !== undefined) throw first_error;
    }

    stop_admissions(): void {
        if (!this.admissions_open) return;
        this.admissions_open = false;
        let first_error: unknown;
        for (const managed of this.controllers) {
            try {
                managed.controller.stop_edit_admission();
            } catch (error) {
                first_error ??= error;
            }
        }
        if (first_error !== undefined) throw first_error;
    }

    dispose_controllers(): void {
        let first_error: unknown;
        try {
            this.stop_admissions();
        } catch (error) {
            first_error = error;
        }
        for (const managed of [...this.controllers]) {
            try {
                this.dispose_controller(managed);
            } catch (error) {
                first_error ??= error;
            }
        }
        if (first_error !== undefined) throw first_error;
    }

    async drain_controllers(): Promise<void> {
        while (this.pending_admissions.size > 0 || this.drains.size > 0) {
            await Promise.allSettled([
                ...this.pending_admissions,
                ...this.drains,
            ]);
        }
    }
}

export class CsvTableEditorProvider extends ViewerProviderBase
    implements vscode.CustomEditorProvider<VscodeCsvCustomDocument> {

    private readonly change_emitter = new vscode.EventEmitter<
        vscode.CustomDocumentEditEvent<VscodeCsvCustomDocument>
    >();
    readonly onDidChangeCustomDocument = this.change_emitter.event;
    private readonly documents = new Set<CsvCustomDocument>();
    private readonly document_subscriptions = new Map<
        CsvCustomDocument,
        vscode.Disposable[]
    >();

    openCustomDocument(
        uri: vscode.Uri,
        context: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken,
    ): Promise<VscodeCsvCustomDocument> {
        if (!this.admissions_open) {
            return Promise.reject(new Error('Table Viewer is deactivating.'));
        }
        return this.track_admission((async () => {
            if (token.isCancellationRequested) throw new vscode.CancellationError();
            const primary_identity = create_resource_identity(uri);
            const refresh_factory = (
                identity: ResourceIdentity,
                on_external_change?: () => Promise<void>,
            ) => (
                new CoordinatorDocumentRefresh(
                    identity,
                    identity.key === primary_identity.key
                        ? on_external_change
                        : undefined,
                )
            );
            const is_untitled = uri.scheme.toLowerCase() === 'untitled';
            const options = {
                resource: uri,
                fs: vscode_file_system_port,
                maxFileSizeBytes: max_file_size_bytes(),
                maxRows: get_csv_max_rows(),
                refreshFactory: refresh_factory,
            };
            const document = context.backupId
                ? await CsvCustomDocument.restore({
                    ...options,
                    backup: await read_csv_document_backup(context.backupId),
                })
                : context.untitledDocumentData !== undefined || is_untitled
                    ? await CsvCustomDocument.create(
                        options,
                        context.untitledDocumentData ?? new Uint8Array(),
                    )
                    : await CsvCustomDocument.open(options);

            if (!this.admissions_open || token.isCancellationRequested) {
                await document.dispose();
                if (token.isCancellationRequested) throw new vscode.CancellationError();
                throw new Error('Table Viewer is deactivating.');
            }
            this.documents.add(document);
            const edit_subscription = document.on_did_change((edit) => {
                this.change_emitter.fire({
                    document: document as VscodeCsvCustomDocument,
                    label: edit.label,
                    undo: edit.undo,
                    redo: edit.redo,
                });
            });
            const dispose_subscription = document.on_did_dispose(() => {
                this.documents.delete(document);
                const subscriptions = this.document_subscriptions.get(document);
                this.document_subscriptions.delete(document);
                for (const subscription of subscriptions ?? []) subscription.dispose();
            });
            this.document_subscriptions.set(
                document,
                [edit_subscription, dispose_subscription],
            );
            return document as VscodeCsvCustomDocument;
        })());
    }

    resolveCustomEditor(
        document: VscodeCsvCustomDocument,
        panel: vscode.WebviewPanel,
        token: vscode.CancellationToken,
    ): Promise<void> {
        if (!this.admissions_open) {
            return Promise.reject(new Error('Table Viewer is deactivating.'));
        }
        return this.track_admission((async () => {
            if (token.isCancellationRequested) throw new vscode.CancellationError();
            const view_id = randomUUID();
            const attachment = await document.attach_view(view_id);
            try {
                if (!this.admissions_open || token.isCancellationRequested) {
                    if (token.isCancellationRequested) throw new vscode.CancellationError();
                    throw new Error('Table Viewer is deactivating.');
                }
                configure_webview(panel, this.extension_uri);
                const profile = profile_for(
                    document.identity.filePath,
                    vscode_viewer_host.config,
                );
                profile.editing = profile.editing && this.admissions_open;
                const controller = attach_viewer(
                    panel,
                    document.uri,
                    this.state_store,
                    profile,
                    vscode_viewer_host,
                    {
                        editingMode: {
                            type: 'vscodeDocument',
                            document,
                            viewId: view_id,
                            viewMutationEpoch: attachment.viewMutationEpoch,
                            requestNativeCommand: async (command) => {
                                if (command === 'save') {
                                    const saved = await vscode.workspace.save(document.uri);
                                    if (saved === undefined) {
                                        throw new Error('VS Code could not save the CSV document.');
                                    }
                                    return;
                                }
                                // Undo/Redo are global active-editor commands. Recheck at
                                // dispatch time because this document-scoped request may
                                // have waited behind another view's history transaction.
                                if (!panel.active) {
                                    throw new Error(
                                        'The requesting Table Viewer panel is no longer active.',
                                    );
                                }
                                await vscode.commands.executeCommand(command);
                            },
                        },
                    },
                );
                if (!this.manage_controller({
                    controller,
                    panel,
                    document,
                    viewId: view_id,
                })) {
                    throw new Error('Table Viewer is deactivating.');
                }
            } catch (error) {
                await document.detach_view(view_id);
                throw error;
            }
        })());
    }

    saveCustomDocument(
        document: VscodeCsvCustomDocument,
        cancellation: vscode.CancellationToken,
    ): Promise<void> {
        if (!this.admissions_open) {
            return Promise.reject(new Error('Table Viewer is deactivating.'));
        }
        if (cancellation.isCancellationRequested) {
            return Promise.reject(new vscode.CancellationError());
        }
        return this.track_admission(
            vscode_csv_operation(document.save_for_host(cancellation))
                .then(() => undefined),
        );
    }

    saveCustomDocumentAs(
        document: VscodeCsvCustomDocument,
        destination: vscode.Uri,
        cancellation: vscode.CancellationToken,
    ): Promise<void> {
        if (!this.admissions_open) {
            return Promise.reject(new Error('Table Viewer is deactivating.'));
        }
        if (cancellation.isCancellationRequested) {
            return Promise.reject(new vscode.CancellationError());
        }
        return this.track_admission(vscode_csv_operation(document.save_as_for_host(destination, {
            delimiter: save_as_delimiter(destination, document.delimiter),
            cancellation,
        })).then(() => undefined));
    }

    revertCustomDocument(
        document: VscodeCsvCustomDocument,
        cancellation: vscode.CancellationToken,
    ): Promise<void> {
        if (!this.admissions_open) {
            return Promise.reject(new Error('Table Viewer is deactivating.'));
        }
        if (cancellation.isCancellationRequested) {
            return Promise.reject(new vscode.CancellationError());
        }
        return this.track_admission(
            vscode_csv_operation(document.revert_for_host(cancellation)),
        );
    }

    backupCustomDocument(
        document: VscodeCsvCustomDocument,
        context: vscode.CustomDocumentBackupContext,
        cancellation: vscode.CancellationToken,
    ): Promise<vscode.CustomDocumentBackup> {
        if (!this.admissions_open) {
            return Promise.reject(new Error('Table Viewer is deactivating.'));
        }
        if (cancellation.isCancellationRequested) {
            return Promise.reject(new vscode.CancellationError());
        }
        return this.track_admission((async () => {
            throw_if_cancelled(cancellation);
            const bytes = await document.backup();
            throw_if_cancelled(cancellation);
            await vscode.workspace.fs.createDirectory(
                vscode.Uri.joinPath(context.destination, '..'),
            );
            throw_if_cancelled(cancellation);
            await vscode.workspace.fs.writeFile(context.destination, bytes);
            if (cancellation.isCancellationRequested) {
                try {
                    await vscode.workspace.fs.delete(context.destination);
                } catch {
                    // Cancellation still wins when cleanup of the partial backup fails.
                }
                throw new vscode.CancellationError();
            }
            const id = context.destination.toString();
            return {
                id,
                delete: () => {
                    void (async () => {
                        try {
                            await vscode.workspace.fs.delete(context.destination);
                        } catch {
                            // Hot-exit cleanup is best-effort after VS Code releases it.
                        }
                    })();
                },
            };
        })());
    }

    async drain_documents_and_controllers(): Promise<void> {
        await this.drain_controllers();
        await Promise.allSettled(
            [...this.documents].map((document) => document.when_idle()),
        );
    }

    async drain_controllers_and_dispose_documents(): Promise<void> {
        // Provider callbacks and controller detach/drain work admitted before shutdown
        // must finish before document disposal fences their shared operation queues.
        await this.drain_controllers();
        await Promise.allSettled(
            [...this.documents].map((document) => document.dispose()),
        );
    }

    dispose(): void {
        let first_error: unknown;
        try {
            this.dispose_controllers();
        } catch (error) {
            first_error = error;
        }
        try {
            this.change_emitter.dispose();
        } catch (error) {
            first_error ??= error;
        }
        if (first_error !== undefined) throw first_error;
    }
}

class ExcelViewerDocument implements vscode.CustomDocument {
    constructor(readonly uri: vscode.Uri) {}
    dispose(): void {}
}

export class ExcelTableViewerProvider extends ViewerProviderBase
    implements vscode.CustomReadonlyEditorProvider<ExcelViewerDocument> {

    openCustomDocument(uri: vscode.Uri): ExcelViewerDocument {
        if (!this.admissions_open) throw new Error('Table Viewer is deactivating.');
        return new ExcelViewerDocument(uri);
    }

    async resolveCustomEditor(
        document: ExcelViewerDocument,
        panel: vscode.WebviewPanel,
        token: vscode.CancellationToken,
    ): Promise<void> {
        if (!this.admissions_open) throw new Error('Table Viewer is deactivating.');
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        configure_webview(panel, this.extension_uri);
        const profile = profile_for(document.uri.fsPath, vscode_viewer_host.config);
        profile.editing = false;
        const controller = attach_viewer(
            panel,
            document.uri,
            this.state_store,
            profile,
            vscode_viewer_host,
        );
        if (!this.manage_controller({ controller, panel })) {
            throw new Error('Table Viewer is deactivating.');
        }
    }
}

export interface TableViewerRegistration extends vscode.Disposable {
    stop_admissions(): void;
    drain(): Promise<void>;
}

export function register_table_viewer(
    context: vscode.ExtensionContext,
    state_store: FileStateStore,
): TableViewerRegistration {
    const csv_provider = new CsvTableEditorProvider(context.extensionUri, state_store);
    const excel_provider = new ExcelTableViewerProvider(context.extensionUri, state_store);
    const registrations: vscode.Disposable[] = [];
    try {
        registrations.push(vscode.window.registerCustomEditorProvider(
            EXCEL_VIEW_TYPE,
            excel_provider,
            {
                supportsMultipleEditorsPerDocument: true,
                webviewOptions: { retainContextWhenHidden: true },
            },
        ));
        registrations.push(vscode.window.registerCustomEditorProvider(
            TABLE_VIEW_TYPE,
            csv_provider,
            {
                supportsMultipleEditorsPerDocument: true,
                webviewOptions: { retainContextWhenHidden: true },
            },
        ));
    } catch (error) {
        const cleanup = (action: () => void) => {
            try {
                action();
            } catch {
                // Preserve the provider registration failure.
            }
        };
        for (const disposable of registrations.reverse()) {
            cleanup(() => disposable.dispose());
        }
        cleanup(() => csv_provider.dispose());
        cleanup(() => excel_provider.dispose_controllers());
        throw error;
    }
    let disposal_requested = false;
    let shutdown: Promise<void> | undefined;
    const drain_live_work = async () => {
        await Promise.allSettled([
            csv_provider.drain_documents_and_controllers(),
            excel_provider.drain_controllers(),
        ]);
    };
    const drain_shutdown_work = async () => {
        await Promise.allSettled([
            csv_provider.drain_controllers_and_dispose_documents(),
            excel_provider.drain_controllers(),
        ]);
    };
    const finalize_registration = () => {
        let first_error: unknown;
        const cleanup = (action: () => void) => {
            try {
                action();
            } catch (error) {
                first_error ??= error;
            }
        };
        // Keep provider registration and the CSV edit-event emitter alive until
        // admitted operations have published their native edits and every tracked
        // document disposal has settled.
        for (const disposable of registrations.splice(0).reverse()) {
            cleanup(() => disposable.dispose());
        }
        cleanup(() => csv_provider.dispose());
        cleanup(() => excel_provider.dispose_controllers());
        if (first_error !== undefined) throw first_error;
    };
    const registration: TableViewerRegistration = {
        stop_admissions() {
            let first_error: unknown;
            try {
                csv_provider.stop_admissions();
            } catch (error) {
                first_error = error;
            }
            try {
                excel_provider.stop_admissions();
            } catch (error) {
                first_error ??= error;
            }
            if (first_error !== undefined) throw first_error;
        },
        dispose() {
            if (disposal_requested) return;
            disposal_requested = true;
            let first_error: unknown;
            const cleanup = (action: () => void) => {
                try {
                    action();
                } catch (error) {
                    first_error ??= error;
                }
            };
            cleanup(() => this.stop_admissions());
            // Dispose message admission now, but retain the provider event bridge
            // until the admitted controller and document work has drained below.
            cleanup(() => csv_provider.dispose_controllers());
            cleanup(() => excel_provider.dispose_controllers());
            shutdown = (async () => {
                await drain_shutdown_work();
                finalize_registration();
            })();
            void shutdown.catch(() => undefined);
            if (first_error !== undefined) throw first_error;
        },
        drain() {
            return shutdown ?? drain_live_work();
        },
    };
    context.subscriptions.push(registration);
    return registration;
}
