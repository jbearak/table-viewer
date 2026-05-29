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

    // Content-Security-Policy for the Glide DataEditor (Phase C).
    //
    // Glide is built on styled-components v5, which injects its stylesheet as an
    // inline <style> element at runtime with no nonce. CSP3 ignores
    // 'unsafe-inline' in style-src whenever a nonce- or hash-source is also
    // present, so style-src must NOT carry a nonce — it lists the webview host
    // source (for our external <link> stylesheet) plus 'unsafe-inline' (for
    // Glide's injected <style>). The <link> below keeps its nonce attribute,
    // which is harmless and ignored since the host source already authorizes it.
    //
    // img-src adds data:/blob: because Glide draws header/group icons and
    // markdown-cell images from data URIs onto the canvas. Glide v6 uses no web
    // workers (canvas + offscreen measureText only), so no worker-src is needed.
    // script-src stays nonce-locked; default-src stays 'none'.
    //
    // NOTE: validated against the documented styled-components/Glide v6 behavior;
    // re-confirm with devtools (no CSP violations) during the Phase C smoke test.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src ${webview.cspSource} 'unsafe-inline';
               img-src ${webview.cspSource} data: blob:;
               script-src 'nonce-${nonce}';
               font-src ${webview.cspSource};">
<title>Table Viewer</title>
<link nonce="${nonce}" rel="stylesheet" href="${css_uri}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js_uri}"></script>
<!-- Glide's DataEditor portals its cell-overlay editor into an element with
     id="portal"; without it getElementById("portal") returns null and the
     editor silently never mounts (the Edit toggle flips but nothing edits).
     Must be the last child of <body> so the fixed-position overlay stacks
     above the grid. -->
<div id="portal"></div>
</body>
</html>`;
}
