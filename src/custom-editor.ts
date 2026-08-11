import * as vscode from 'vscode';
import { attach_viewer, profile_for, type ViewerController } from './viewer-controller';
import { create_resource_identity } from './resource-identity';
import type { AuthorityFileStateStore } from './state';
import { build_vscode_webview_html, vscode_viewer_host } from './vscode-host-ports';
import { generate_nonce } from './webview-html';

const EXCEL_VIEW_TYPE = 'tableViewer.excelViewer';
export const TABLE_VIEW_TYPE = 'tableViewer.editor';

class TableViewerDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}
    dispose(): void {}
}

export class TableViewerEditorProvider
    implements vscode.CustomReadonlyEditorProvider<TableViewerDocument> {

    readonly #controllers = new Set<ViewerController>();
    readonly #panels = new Map<ViewerController, vscode.WebviewPanel>();
    readonly #resources = new Map<ViewerController, string>();
    readonly #workbook_opens = new Map<string, Promise<void>>();
    readonly #drains = new Set<Promise<void>>();
    #close_barrier: Promise<void> | undefined;
    #close_barrier_settled = false;

    constructor(
        private readonly extension_uri: vscode.Uri,
        private readonly state_store: AuthorityFileStateStore,
    ) {}

    #dispose_controller(controller: ViewerController): void {
        if (!this.#controllers.delete(controller)) return;
        this.#panels.delete(controller);
        this.#resources.delete(controller);
        controller.dispose();
        const drain = controller.drain();
        this.#drains.add(drain);
        void drain.finally(() => this.#drains.delete(drain)).catch(() => {});
    }

    stop_edit_admission(): void {
        for (const controller of this.#controllers) controller.stop_edit_admission();
    }

    dispose_viewers(): void {
        this.stop_edit_admission();
        if (this.#close_barrier && !this.#close_barrier_settled) return;
        this.#close_barrier_settled = false;
        const attempt = (async () => {
            const controllers = [...this.#controllers];
            // Keep every panel and transport alive until its renderer has folded its
            // live overlay and the controller has observed the exact durable
            // acknowledgement. A failed/timed-out panel remains open, fenced, and is
            // included in the next attempt instead of poisoning a permanent barrier.
            const results = await Promise.allSettled(controllers.map(async (controller) => {
                await controller.flush_pending_edits();
                this.#panels.get(controller)?.dispose();
            }));
            const failures = results
                .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                .map((result) => result.reason);
            if (failures.length > 0) {
                throw new AggregateError(failures, 'One or more viewers did not flush pending edits.');
            }
        })();
        this.#close_barrier = attempt;
        void attempt.finally(() => {
            if (this.#close_barrier === attempt) this.#close_barrier_settled = true;
        }).catch(() => {});
    }

    async drain_viewers(): Promise<void> {
        const close_barrier = this.#close_barrier;
        try {
            await close_barrier;
        } finally {
            while (this.#drains.size > 0) await Promise.allSettled([...this.#drains]);
        }
    }

    async openCustomDocument(uri: vscode.Uri): Promise<TableViewerDocument> {
        return new TableViewerDocument(uri);
    }

    #controller_for(resource: string): ViewerController | undefined {
        const matches = [...this.#controllers].filter(
            (controller) => this.#resources.get(controller) === resource,
        );
        return matches.find((controller) => this.#panels.get(controller)?.active) ?? matches[0];
    }

    async openWorkbookAtSheet(uri: vscode.Uri, sheet_name: string): Promise<boolean> {
        const resource = create_resource_identity(uri).key;
        let controller = this.#controller_for(resource);
        if (!controller) {
            let opening = this.#workbook_opens.get(resource);
            if (!opening) {
                opening = Promise.resolve(
                    vscode.commands.executeCommand('vscode.openWith', uri, EXCEL_VIEW_TYPE),
                ).then(() => {});
                this.#workbook_opens.set(resource, opening);
                void opening.finally(() => {
                    if (this.#workbook_opens.get(resource) === opening) {
                        this.#workbook_opens.delete(resource);
                    }
                }).catch(() => {});
            }
            await opening;
            controller = this.#controller_for(resource);
            if (!controller) {
                throw new Error('Table Viewer did not open the requested workbook.');
            }
        }
        this.#panels.get(controller)?.reveal();
        return controller.select_sheet(sheet_name);
    }

    async resolveCustomEditor(
        document: TableViewerDocument,
        webview_panel: vscode.WebviewPanel,
    ): Promise<void> {
        webview_panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extension_uri, 'dist', 'webview'),
            ],
        };
        webview_panel.webview.html = build_vscode_webview_html(
            webview_panel.webview, this.extension_uri, generate_nonce());

        const controller = attach_viewer(
            webview_panel,
            document.uri,
            this.state_store,
            profile_for(document.uri.fsPath, vscode_viewer_host.config),
            vscode_viewer_host,
        );
        this.#controllers.add(controller);
        this.#panels.set(controller, webview_panel);
        this.#resources.set(controller, create_resource_identity(document.uri).key);
        webview_panel.onDidDispose(() => this.#dispose_controller(controller));
    }
}

export interface TableViewerRegistration extends vscode.Disposable {
    drain(): Promise<void>;
    openWorkbookAtSheet(uri: vscode.Uri, sheetName: string): Promise<boolean>;
}

export function register_table_viewer(
    context: vscode.ExtensionContext,
    state_store: AuthorityFileStateStore,
): TableViewerRegistration {
    const provider = new TableViewerEditorProvider(context.extensionUri, state_store);
    // Both editors deliberately allow multiple tabs per document. The CSV/TSV
    // editor could have set this to false to dodge the cross-tab pending-edits
    // race (#22), but we keep multi-viewer support and serialize editing with
    // an exclusive edit-session lock (see viewer-controller) instead.
    const excel_options = {
        supportsMultipleEditorsPerDocument: true,
        webviewOptions: { retainContextWhenHidden: true },
    };
    const table_options = {
        supportsMultipleEditorsPerDocument: true,
        webviewOptions: { retainContextWhenHidden: true },
    };
    const registrations: vscode.Disposable[] = [];
    try {
        registrations.push(
            vscode.window.registerCustomEditorProvider(EXCEL_VIEW_TYPE, provider, excel_options),
        );
        registrations.push(
            vscode.window.registerCustomEditorProvider(TABLE_VIEW_TYPE, provider, table_options),
        );
    } catch (error) {
        for (const registration of [...registrations].reverse()) {
            try {
                registration.dispose();
            } catch {
                // Preserve the registration failure that triggered this rollback.
            }
        }
        throw error;
    }
    const registration: TableViewerRegistration = {
        dispose() {
            provider.dispose_viewers();
            for (const disposable of registrations) disposable.dispose();
        },
        drain: () => provider.drain_viewers(),
        openWorkbookAtSheet: (uri, sheetName) => provider.openWorkbookAtSheet(uri, sheetName),
    };
    context.subscriptions.push(registration);
    return registration;
}
