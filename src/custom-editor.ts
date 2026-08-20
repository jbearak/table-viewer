import * as vscode from 'vscode';
import { attach_viewer, profile_for, type ViewerController } from './viewer-controller';
import { create_resource_identity } from './resource-identity';
import type { AuthorityFileStateStore } from './state';
import { build_vscode_webview_html, vscode_viewer_host } from './vscode-host-ports';
import { generate_nonce } from './webview-html';

export const TABLE_VIEW_TYPE = 'tableViewer.editor';

/**
 * The working-tree file path a git: revision URI diffs, from the git
 * extension's URI encoding (JSON query `{path, ref}`). Undefined when the
 * query is absent or malformed — such a URI still opens, just as a plain
 * read-only render with no compare pairing.
 */
export function git_diffed_file_path(uri: vscode.Uri): string | undefined {
    if (!uri.query) return undefined;
    try {
        const parsed: unknown = JSON.parse(uri.query);
        if (
            typeof parsed === 'object' && parsed !== null
            && 'path' in parsed && typeof parsed.path === 'string'
            && parsed.path.length > 0
        ) {
            return parsed.path;
        }
    } catch {
        // Not the git extension's encoding; treat as a bare revision URI.
    }
    return undefined;
}

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
    /** Compare intents awaiting their resolveCustomEditor, keyed by the
     *  modified file's resource identity. `vscode.openWith` cannot carry
     *  options, so openTableDiff parks the original's URI here and the next
     *  resolve for that resource consumes it. */
    readonly #pending_compares = new Map<string, { readonly originalUri: vscode.Uri }>();
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
            controller = this.#controller_for(resource);
            if (!controller) {
                throw new Error('Table Viewer did not open the requested workbook.');
            }
        }
        this.#panels.get(controller)?.reveal();
        return controller.select_sheet(sheet_name);
    }

    /**
     * Open `uri` as a table compared against `original_uri` (its git original).
     * The comparison needs a fresh resolve: an existing viewer for the file may
     * hold an edit session, and compare panels are read-only by construction.
     */
    async openTableDiff(uri: vscode.Uri, original_uri: vscode.Uri): Promise<void> {
        const resource = create_resource_identity(uri).key;
        // A fresh wrapper object per call: overlapping diff opens for the same
        // resource each park their own intent, and the cleanup below removes
        // only its own entry rather than a successor's.
        const intent = { originalUri: original_uri };
        this.#pending_compares.set(resource, intent);
        try {
            await vscode.commands.executeCommand(
                'vscode.openWith',
                uri,
                TABLE_VIEW_TYPE,
                // A new editor group: reusing an existing table tab for this
                // file would reveal it without calling resolveCustomEditor, so
                // the comparison would silently never attach.
                vscode.ViewColumn.Beside,
            );
        } finally {
            if (this.#pending_compares.get(resource) === intent) {
                // No resolve consumed the intent — the open failed or revealed
                // an existing tab. Clear it so a later plain open of this file
                // cannot inherit a stale compare.
                this.#pending_compares.delete(resource);
            }
        }
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

        const resource = create_resource_identity(document.uri).key;
        // An SCM-pane click runs `vscode.diff`, which resolves BOTH sides
        // through this provider: first the git: revision, then the working-tree
        // file. The git: side has no working tree to write back to, so it
        // renders plain read-only — and parks a compare intent so the file:
        // side that follows attaches the diff session against it. A bare git:
        // URI (no parseable {path} query) is just a read-only render.
        const read_only = document.uri.scheme === 'git';
        if (read_only) {
            const diffed_path = git_diffed_file_path(document.uri);
            if (diffed_path !== undefined) {
                const diffed_key = create_resource_identity(
                    vscode.Uri.file(diffed_path),
                ).key;
                const intent = { originalUri: document.uri };
                this.#pending_compares.set(diffed_key, intent);
                // In a `vscode.diff` the file: side resolves right after this
                // one and consumes the intent. If it never comes (the git:
                // side was opened alone), retire the intent with this panel so
                // a later plain open cannot inherit a stale compare.
                webview_panel.onDidDispose(() => {
                    if (this.#pending_compares.get(diffed_key) === intent) {
                        this.#pending_compares.delete(diffed_key);
                    }
                });
            }
        }
        const compare_original = this.#pending_compares.get(resource);
        if (compare_original) this.#pending_compares.delete(resource);
        const controller = attach_viewer(
            webview_panel,
            document.uri,
            this.state_store,
            profile_for(document.uri.fsPath, vscode_viewer_host.config),
            vscode_viewer_host,
            {
                requestClose: () => webview_panel.dispose(),
                ...(compare_original && !read_only
                    ? { compare: { originalUri: compare_original.originalUri } }
                    : {}),
                ...(read_only ? { readOnly: true } : {}),
            },
        );
        this.#controllers.add(controller);
        this.#panels.set(controller, webview_panel);
        this.#resources.set(controller, resource);
        webview_panel.onDidDispose(() => this.#dispose_controller(controller));
    }
}

export interface TableViewerRegistration extends vscode.Disposable {
    drain(): Promise<void>;
    openWorkbookAtSheet(uri: vscode.Uri, sheetName: string): Promise<boolean>;
    openTableDiff(uri: vscode.Uri, originalUri: vscode.Uri): Promise<void>;
}

export function register_table_viewer(
    context: vscode.ExtensionContext,
    state_store: AuthorityFileStateStore,
): TableViewerRegistration {
    const provider = new TableViewerEditorProvider(context.extensionUri, state_store);
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
        openTableDiff: (uri, originalUri) => provider.openTableDiff(uri, originalUri),
    };
    context.subscriptions.push(registration);
    return registration;
}
