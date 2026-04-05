import * as crypto from 'crypto';
import * as vscode from 'vscode';

export function generate_nonce(): string {
    return crypto.randomBytes(16).toString('hex');
}

export function build_webview_html(
    webview: vscode.Webview,
    extension_uri: vscode.Uri,
    nonce: string
): string {
    const js_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(
            extension_uri,
            'dist',
            'webview',
            'index.js'
        )
    );
    const css_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(
            extension_uri,
            'dist',
            'webview',
            'index.css'
        )
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src ${webview.cspSource} 'nonce-${nonce}';
               script-src 'nonce-${nonce}';
               font-src ${webview.cspSource};">
<title>Table Viewer</title>
<link nonce="${nonce}" rel="stylesheet" href="${css_uri}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js_uri}"></script>
</body>
</html>`;
}
