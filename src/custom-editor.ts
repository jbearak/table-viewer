import * as vscode from 'vscode';
import { attach_viewer, profile_for } from './viewer-controller';
import type { AuthorityFileStateStore } from './state';
import { build_webview_html, generate_nonce } from './webview-html';

const EXCEL_VIEW_TYPE = 'tableViewer.excelViewer';
export const TABLE_VIEW_TYPE = 'tableViewer.editor';

class TableViewerDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}
    dispose(): void {}
}

export class TableViewerEditorProvider
    implements vscode.CustomReadonlyEditorProvider<TableViewerDocument> {

    constructor(
        private readonly extension_uri: vscode.Uri,
        private readonly state_store: AuthorityFileStateStore,
    ) {}

    async openCustomDocument(uri: vscode.Uri): Promise<TableViewerDocument> {
        return new TableViewerDocument(uri);
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
        webview_panel.webview.html = build_webview_html(
            webview_panel.webview, this.extension_uri, generate_nonce());

        const controller = attach_viewer(
            webview_panel, document.uri, this.state_store, profile_for(document.uri));
        webview_panel.onDidDispose(() => controller.dispose());
    }
}

export function register_table_viewer(
    context: vscode.ExtensionContext,
    state_store: AuthorityFileStateStore,
): void {
    const provider = new TableViewerEditorProvider(context.extensionUri, state_store);
    // Both editors deliberately allow multiple tabs per document. The CSV/TSV
    // editor could have set this to false to dodge the cross-tab pending-edits
    // race (#22), but we keep multi-viewer support and serialize editing with
    // an exclusive edit-session lock (see viewer-controller) instead.
    const excel_options = { supportsMultipleEditorsPerDocument: true };
    const table_options = { supportsMultipleEditorsPerDocument: true };
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(EXCEL_VIEW_TYPE, provider, excel_options),
        vscode.window.registerCustomEditorProvider(TABLE_VIEW_TYPE, provider, table_options),
    );
}
