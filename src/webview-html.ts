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

    // Content-Security-Policy for the Glide DataEditor.
    //
    // Glide v6 (we pin 6.0.3) dropped styled-components for @linaria/react, a
    // zero-runtime CSS-in-JS library: all of Glide's styles are extracted at
    // build time into the mandatory dist/index.css, which we ship in our bundled
    // stylesheet and load via the <link> below. Glide injects no runtime <style>
    // element, and our webview bundle contains no createElement('style'),
    // insertRule, or setAttribute('style') (React applies inline styles via the
    // CSSOM .style property, which CSP does not gate). So style-src needs only
    // the webview host source for the external <link> stylesheet — no
    // 'unsafe-inline', no nonce.
    //
    // img-src adds data:/blob: because Glide draws header/group icons and
    // markdown-cell images from data URIs onto the canvas. Glide v6 uses no web
    // workers (canvas + offscreen measureText only), so no worker-src is needed.
    // script-src stays nonce-locked; default-src stays 'none'.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src ${webview.cspSource};
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
