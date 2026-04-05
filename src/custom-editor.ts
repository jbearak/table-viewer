import * as path from 'path';
import * as vscode from 'vscode';
import { parse_xlsx } from './parse-xlsx';
import { parse_xls } from './parse-xls';
import { assert_safe_file_size } from './spreadsheet-safety';
import type { FileStateStore } from './state';
import type { WorkbookData, WebviewMessage } from './types';
import { build_webview_html, generate_nonce } from './webview-html';

export const VIEW_TYPE = 'tableViewer.editor';

class TableViewerDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}
    dispose(): void {}
}

export class TableViewerEditorProvider
    implements vscode.CustomReadonlyEditorProvider<TableViewerDocument> {

    constructor(
        private readonly extension_uri: vscode.Uri,
        private readonly state_store: FileStateStore
    ) {}

    async openCustomDocument(
        uri: vscode.Uri
    ): Promise<TableViewerDocument> {
        return new TableViewerDocument(uri);
    }

    async resolveCustomEditor(
        document: TableViewerDocument,
        webview_panel: vscode.WebviewPanel
    ): Promise<void> {
        webview_panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(
                    this.extension_uri,
                    'dist',
                    'webview'
                ),
            ],
        };

        const nonce = generate_nonce();
        webview_panel.webview.html = build_webview_html(
            webview_panel.webview,
            this.extension_uri,
            nonce
        );

        const panel = new ViewerPanel(
            webview_panel,
            document.uri,
            this.state_store
        );

        webview_panel.onDidDispose(() => panel.dispose());
    }
}

class ViewerPanel implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private consecutive_reload_failures = 0;
    private file_path: string;
    private watcher: vscode.FileSystemWatcher;

    constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly uri: vscode.Uri,
        private readonly state_store: FileStateStore
    ) {
        this.file_path = uri.fsPath;

        this.disposables.push(
            panel.webview.onDidReceiveMessage(
                (msg: WebviewMessage) => this.handle_message(msg)
            )
        );

        // Live reload: watch the parent directory for changes to this file
        const dir = path.dirname(this.file_path);
        const basename = path.basename(this.file_path);
        this.watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                vscode.Uri.file(dir),
                basename
            )
        );

        const on_file_change = async () => {
            await this.send_reload();
        };

        this.disposables.push(
            this.watcher.onDidChange(on_file_change)
        );
        this.disposables.push(
            this.watcher.onDidCreate(on_file_change)
        );
        this.disposables.push(this.watcher);
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private async handle_message(msg: WebviewMessage): Promise<void> {
        switch (msg.type) {
            case 'ready':
                await this.send_initial_data();
                break;
            case 'stateChanged':
                await this.state_store.set(
                    this.file_path,
                    msg.state
                );
                break;
        }
    }

    private async parse_file(): Promise<{ data: WorkbookData; warnings: string[] }> {
        const stat = await vscode.workspace.fs.stat(this.uri);
        assert_safe_file_size(stat.size);
        const raw = await vscode.workspace.fs.readFile(this.uri);
        const ext = this.file_path.toLowerCase();
        if (ext.endsWith('.xlsx')) {
            return parse_xlsx(raw);
        }
        return parse_xls(Buffer.from(raw));
    }

    private async send_initial_data(): Promise<void> {
        try {
            const { data, warnings } = await this.parse_file();
            const state = this.state_store.get(this.file_path);
            const config = vscode.workspace.getConfiguration('tableViewer');
            const default_orientation = config.get<'horizontal' | 'vertical'>(
                'tabOrientation',
                'horizontal'
            );

            this.panel.webview.postMessage({
                type: 'workbookData',
                data,
                state,
                defaultTabOrientation: default_orientation,
            });

            if (warnings.length > 0) {
                vscode.window.showWarningMessage(warnings[0]);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }

    private async send_reload(): Promise<void> {
        try {
            const { data, warnings } = await this.parse_file();
            const delivered = await this.panel.webview.postMessage({
                type: 'reload',
                data,
            });
            if (!delivered) return;
            this.consecutive_reload_failures = 0;
            if (warnings.length > 0) {
                vscode.window.showWarningMessage(warnings[0]);
            }
        } catch (err) {
            const code = typeof err === 'object'
                && err !== null
                && 'code' in err
                && typeof err.code === 'string'
                ? err.code
                : null;

            if (code === 'EBUSY' || code === 'EPERM') {
                return;
            }

            this.consecutive_reload_failures += 1;
            if (this.consecutive_reload_failures >= 3) {
                const message = err instanceof Error ? err.message : String(err);
                console.error('Failed to reload table viewer data', err);
                vscode.window.showErrorMessage(`Failed to reload spreadsheet: ${message}`);
            }
        }
    }
}

export function register_table_viewer(
    context: vscode.ExtensionContext,
    state_store: FileStateStore
): void {
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            VIEW_TYPE,
            new TableViewerEditorProvider(
                context.extensionUri,
                state_store
            ),
            { supportsMultipleEditorsPerDocument: true }
        )
    );
}
