import * as vscode from 'vscode';
import { attach_viewer, profile_for, type ViewerController } from './viewer-controller';
import { create_resource_identity } from './resource-identity';
import type { AuthorityFileStateStore } from './state';
import {
    TABLE_DIFF_SCHEME,
    TABLE_FILE_EXTENSION_PATTERN,
    table_diff_document_uri,
    table_diff_document_uris,
    table_diff_uris,
    table_diff_uris_from_unordered_pair,
    table_diff_working_tree_uri,
    type TableDiffUris,
} from './table-diff-uris';
import { build_vscode_webview_html, vscode_viewer_host } from './vscode-host-ports';
import { generate_nonce } from './webview-html';

export const TABLE_VIEW_TYPE = 'tableViewer.editor';

class TableViewerDocument implements vscode.CustomDocument {
    constructor(
        public readonly uri: vscode.Uri,
        public readonly diff?: TableDiffUris,
    ) {}
    dispose(): void {}
}

export interface TableViewerEditorProviderOptions {
    readonly replaceNativeDiff?: (tab: vscode.Tab, diff: TableDiffUris) => void;
}

interface NativeDiffCandidate {
    readonly uri: vscode.Uri;
    readonly panel: vscode.WebviewPanel;
}

export class TableViewerEditorProvider
    implements vscode.CustomReadonlyEditorProvider<TableViewerDocument> {

    readonly #controllers = new Set<ViewerController>();
    readonly #panels = new Map<ViewerController, vscode.WebviewPanel>();
    readonly #resources = new Map<ViewerController, string>();
    readonly #compare_documents = new Map<ViewerController, string>();
    readonly #workbook_opens = new Map<string, Promise<void>>();
    readonly #table_diff_opens = new Map<string, Promise<void>>();
    readonly #native_diff_candidates = new WeakMap<vscode.Tab, NativeDiffCandidate>();
    readonly #host_tabs = new Map<vscode.WebviewPanel, vscode.Tab>();
    readonly #drains = new Set<Promise<void>>();
    #close_barrier: Promise<void> | undefined;
    #close_barrier_settled = false;

    constructor(
        private readonly extension_uri: vscode.Uri,
        private readonly state_store: AuthorityFileStateStore,
        private readonly options: TableViewerEditorProviderOptions = {},
    ) {}

    #dispose_controller(controller: ViewerController): void {
        if (!this.#controllers.delete(controller)) return;
        const panel = this.#panels.get(controller);
        if (panel) this.#host_tabs.delete(panel);
        this.#panels.delete(controller);
        this.#resources.delete(controller);
        this.#compare_documents.delete(controller);
        controller.dispose();
        const drain = controller.drain();
        this.#drains.add(drain);
        void drain.finally(() => this.#drains.delete(drain)).catch(() => {});
    }

    stop_edit_admission(): void {
        for (const controller of this.#controllers) controller.stop_edit_admission();
    }

    #tab_is_open(tab: vscode.Tab): boolean {
        return vscode.window.tabGroups.all.some((group) => group.tabs.includes(tab));
    }

    async #close_panel(panel: vscode.WebviewPanel): Promise<void> {
        const tab = this.#host_tabs.get(panel);
        if (tab && this.#tab_is_open(tab)) {
            await vscode.window.tabGroups.close(tab);
            return;
        }
        panel.dispose();
    }

    dispose_viewers(): void {
        this.stop_edit_admission();
        if (this.#close_barrier && !this.#close_barrier_settled) return;
        this.#close_barrier_settled = false;
        const attempt = (async () => {
            const tab_controllers = new Map<vscode.Tab, ViewerController[]>();
            const standalone: ViewerController[] = [];
            for (const controller of this.#controllers) {
                const panel = this.#panels.get(controller);
                const tab = panel ? this.#host_tabs.get(panel) : undefined;
                if (!tab) {
                    standalone.push(controller);
                    continue;
                }
                const group = tab_controllers.get(tab) ?? [];
                group.push(controller);
                tab_controllers.set(tab, group);
            }
            // Keep every panel and transport alive until its renderer has folded its
            // live overlay and the controller has observed the exact durable
            // acknowledgement. Both sides of a native DiffEditorInput flush before
            // its one owning tab closes; no child webview is ever disposed alone.
            const actions = [
                ...standalone.map(async (controller) => {
                    await controller.flush_pending_edits();
                    this.#panels.get(controller)?.dispose();
                }),
                ...[...tab_controllers].map(async ([tab, controllers]) => {
                    await Promise.all(controllers.map(
                        (controller) => controller.flush_pending_edits(),
                    ));
                    if (this.#tab_is_open(tab)) {
                        if (!await vscode.window.tabGroups.close(tab)) {
                            throw new Error('VS Code declined to close a Table Viewer tab.');
                        }
                    } else {
                        for (const controller of controllers) {
                            this.#panels.get(controller)?.dispose();
                        }
                    }
                }),
            ];
            const results = await Promise.allSettled(actions);
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
        const diff = table_diff_document_uris(uri);
        if (uri.scheme === TABLE_DIFF_SCHEME && !diff) {
            throw new Error('The Table Viewer comparison URI is invalid.');
        }
        return new TableViewerDocument(uri, diff);
    }

    #normal_controller_for(resource: string): ViewerController | undefined {
        const matches = [...this.#controllers].filter(
            (controller) => this.#resources.get(controller) === resource
                && !this.#compare_documents.has(controller),
        );
        return matches.find((controller) => this.#panels.get(controller)?.active) ?? matches[0];
    }

    #compare_controller_for(document_uri: vscode.Uri): ViewerController | undefined {
        const document_key = document_uri.toString();
        const matches = [...this.#controllers].filter(
            (controller) => this.#compare_documents.get(controller) === document_key,
        );
        return matches.find((controller) => this.#panels.get(controller)?.active) ?? matches[0];
    }

    async openWorkbookAtSheet(uri: vscode.Uri, sheet_name: string): Promise<boolean> {
        const resource = create_resource_identity(uri).key;
        let controller = this.#normal_controller_for(resource);
        if (!controller) {
            let opening = this.#workbook_opens.get(resource);
            if (!opening) {
                opening = Promise.resolve(
                    vscode.commands.executeCommand('vscode.openWith', uri, TABLE_VIEW_TYPE),
                ).then(() => {});
                this.#workbook_opens.set(resource, opening);
                void opening.finally(() => {
                    if (this.#workbook_opens.get(resource) === opening) {
                        this.#workbook_opens.delete(resource);
                    }
                }).catch(() => {});
            }
            await opening;
            controller = this.#normal_controller_for(resource);
            if (!controller) {
                throw new Error('Table Viewer did not open the requested workbook.');
            }
        }
        this.#panels.get(controller)?.reveal();
        return controller.select_sheet(sheet_name);
    }

    /** Open one durable comparison document, or reveal its retained panel. */
    async openTableDiff(
        diff: TableDiffUris,
        view_column = vscode.ViewColumn.Active,
    ): Promise<void> {
        const document_uri = table_diff_document_uri(diff);
        const existing = this.#compare_controller_for(document_uri);
        if (existing) {
            const panel = this.#panels.get(existing);
            if (!panel?.active) panel?.reveal();
            await existing.refresh_if_changed();
            return;
        }
        const document_key = document_uri.toString();
        let opening = this.#table_diff_opens.get(document_key);
        if (!opening) {
            opening = Promise.resolve(vscode.commands.executeCommand(
                'vscode.openWith',
                document_uri,
                TABLE_VIEW_TYPE,
                view_column,
            )).then(() => {});
            this.#table_diff_opens.set(document_key, opening);
            void opening.finally(() => {
                if (this.#table_diff_opens.get(document_key) === opening) {
                    this.#table_diff_opens.delete(document_key);
                }
            }).catch(() => {});
        }
        await opening;
    }

    /** Open or reveal the normal working-tree viewer without closing a comparison. */
    async openWorkingTreeFile(uri: vscode.Uri): Promise<void> {
        const resource = create_resource_identity(uri).key;
        const existing = this.#normal_controller_for(resource);
        if (existing) {
            const panel = this.#panels.get(existing);
            if (!panel?.active) panel?.reveal();
            return;
        }
        await vscode.commands.executeCommand(
            'vscode.openWith',
            uri,
            TABLE_VIEW_TYPE,
            vscode.ViewColumn.Active,
        );
    }

    async #observe_native_diff(uri: vscode.Uri, panel: vscode.WebviewPanel): Promise<void> {
        const replace = this.options.replaceNativeDiff;
        const group = panel.viewColumn === undefined
            ? undefined
            : vscode.window.tabGroups.all.find(
                (candidate) => candidate.viewColumn === panel.viewColumn,
            );
        const tab = group?.activeTab;
        if (!replace || !tab || !TABLE_FILE_EXTENSION_PATTERN.test(uri.path)) return;
        this.#host_tabs.set(panel, tab);

        const prior = this.#native_diff_candidates.get(tab);
        if (prior && prior.panel !== panel) {
            const input = tab.input;
            const explicit = input instanceof vscode.TabInputTextDiff
                ? table_diff_uris(input.original, input.modified)
                : undefined;
            const diff = explicit
                ?? await table_diff_uris_from_unordered_pair(prior.uri, uri);
            if (
                diff
                && this.#native_diff_candidates.get(tab) === prior
                && this.#tab_is_open(tab)
            ) {
                this.#native_diff_candidates.delete(tab);
                replace(tab, diff);
                return;
            }
        }

        const candidate = { uri, panel };
        this.#native_diff_candidates.set(tab, candidate);
        panel.onDidDispose(() => {
            if (this.#native_diff_candidates.get(tab) === candidate) {
                this.#native_diff_candidates.delete(tab);
            }
        });
    }

    async resolveCustomEditor(
        document: TableViewerDocument,
        webview_panel: vscode.WebviewPanel,
    ): Promise<void> {
        const source_uri = document.diff?.modified ?? document.uri;
        if (document.diff) {
            const basename = create_resource_identity(
                table_diff_working_tree_uri(document.diff),
            ).basename;
            webview_panel.title = `${basename} (Changes)`;
        }
        const controller = this.#resolve_document(source_uri, webview_panel, {
            ...(document.diff
                ? { compare: { originalUri: document.diff.original } }
                : {}),
            ...(source_uri.scheme === 'git' ? { readOnly: true } : {}),
        });
        if (document.diff) {
            this.#compare_documents.set(controller, document.uri.toString());
        } else {
            await this.#observe_native_diff(source_uri, webview_panel);
        }
    }

    #resolve_document(
        source_uri: vscode.Uri,
        webview_panel: vscode.WebviewPanel,
        options: {
            readonly compare?: { readonly originalUri: vscode.Uri };
            readonly readOnly?: boolean;
        },
    ): ViewerController {
        webview_panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extension_uri, 'dist', 'webview'),
            ],
        };
        webview_panel.webview.html = build_vscode_webview_html(
            webview_panel.webview, this.extension_uri, generate_nonce());

        const resource = create_resource_identity(source_uri).key;
        const controller = attach_viewer(
            webview_panel,
            source_uri,
            this.state_store,
            profile_for(source_uri.fsPath, vscode_viewer_host.config),
            vscode_viewer_host,
            {
                requestClose: () => this.#close_panel(webview_panel),
                ...options,
            },
        );
        this.#controllers.add(controller);
        this.#panels.set(controller, webview_panel);
        this.#resources.set(controller, resource);
        webview_panel.onDidDispose(() => this.#dispose_controller(controller));
        return controller;
    }
}

export interface TableViewerRegistration extends vscode.Disposable {
    drain(): Promise<void>;
    openWorkbookAtSheet(uri: vscode.Uri, sheetName: string): Promise<boolean>;
    openTableDiff(
        diff: TableDiffUris,
        viewColumn?: vscode.ViewColumn,
    ): Promise<void>;
    openWorkingTreeFile(uri: vscode.Uri): Promise<void>;
}

export function register_table_viewer(
    context: vscode.ExtensionContext,
    state_store: AuthorityFileStateStore,
    provider_options: TableViewerEditorProviderOptions = {},
): TableViewerRegistration {
    const provider = new TableViewerEditorProvider(
        context.extensionUri,
        state_store,
        provider_options,
    );
    // The editor deliberately allows multiple tabs per document. It could have
    // set this to false to dodge the CSV/TSV cross-tab pending-edits
    // race (#22), but we keep multi-viewer support and serialize editing with
    // an exclusive edit-session lock (see viewer-controller) instead.
    const options = {
        supportsMultipleEditorsPerDocument: true,
        webviewOptions: { retainContextWhenHidden: true },
    };
    const registrations: vscode.Disposable[] = [];
    try {
        registrations.push(
            vscode.window.registerCustomEditorProvider(TABLE_VIEW_TYPE, provider, options),
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
        openTableDiff: (diff, viewColumn) => provider.openTableDiff(diff, viewColumn),
        openWorkingTreeFile: (uri) => provider.openWorkingTreeFile(uri),
    };
    context.subscriptions.push(registration);
    return registration;
}
