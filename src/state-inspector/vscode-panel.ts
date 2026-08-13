/**
 * The "Manage Stored File State" panel.
 *
 * A singleton webview: two copies of this over one database would show each
 * other stale counts the moment either deleted anything.
 *
 * The HTML is built here rather than reusing `build_webview_html`, whose CSP is
 * shaped for the Glide grid (`data:`/`blob:` images for canvas-drawn icons). This
 * page is a table and two dialogs; it needs a script and a stylesheet, and
 * granting it less is free.
 */
import * as vscode from 'vscode';
import { generate_nonce } from '../webview-html';
import { create_state_inspector_handler } from './host-handler';
import type { StateInspectorRequest } from './protocol';
import type { StoredFileStateMaintenance } from '../sqlite-file-state-maintenance';

export const STATE_INSPECTOR_VIEW_TYPE = 'tableViewer.storedFileState';

function build_html(scriptUri: vscode.Uri, cspSource: string, nonce: string): string {
    // Inline styles are allowed because the shared UI module installs its own
    // stylesheet at mount — the same bytes the desktop window gets, which is
    // what keeps the two surfaces from drifting.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src ${cspSource} 'unsafe-inline';
               script-src 'nonce-${nonce}';">
<title>Stored File State</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

export interface StateInspectorPanelOptions {
    readonly extensionUri: vscode.Uri;
    readonly maintenance: StoredFileStateMaintenance;
    readonly databasePath: string;
}

let panel: vscode.WebviewPanel | undefined;

/** Open the inspector, or focus the one already open. */
export function show_state_inspector_panel(options: StateInspectorPanelOptions): void {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Active);
        return;
    }

    const created = vscode.window.createWebviewPanel(
        STATE_INSPECTOR_VIEW_TYPE,
        'Stored File State',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            // The listing is rebuilt from the database on every reveal anyway,
            // so there is nothing worth the memory of retaining it hidden.
            retainContextWhenHidden: false,
            localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, 'dist')],
        },
    );
    panel = created;

    const handler = create_state_inspector_handler({
        maintenance: options.maintenance,
        databasePath: options.databasePath,
    });

    const scriptUri = created.webview.asWebviewUri(
        vscode.Uri.joinPath(options.extensionUri, 'dist', 'webview', 'state-inspector.js'),
    );
    created.webview.html = build_html(
        scriptUri,
        created.webview.cspSource,
        generate_nonce(),
    );

    created.webview.onDidReceiveMessage(async (message: unknown) => {
        const envelope = message as { id?: unknown; request?: StateInspectorRequest } | null;
        if (!envelope || typeof envelope.id !== 'number' || !envelope.request) return;
        const response = await handler(envelope.request);
        // The panel can be disposed while a trim is in flight; posting to a
        // disposed webview throws, and there is no one left to tell.
        if (panel !== created) return;
        void created.webview.postMessage({ id: envelope.id, response });
    });

    created.onDidDispose(() => {
        if (panel === created) panel = undefined;
    });
}

/** Close the panel, if one is open. For extension deactivation. */
export function dispose_state_inspector_panel(): void {
    const open = panel;
    panel = undefined;
    open?.dispose();
}
