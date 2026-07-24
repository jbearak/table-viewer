import * as crypto from 'crypto';

export function generate_nonce(): string {
    return crypto.randomBytes(16).toString('hex');
}

/** Host-agnostic asset locations for the viewer shell. The VS Code host
 *  derives these from webview.asWebviewUri/cspSource (vscode-host-ports.ts);
 *  other hosts can pass any URLs their loader serves. */
export interface WebviewHtmlAssets {
    readonly scriptUrl: string;
    readonly styleUrl: string;
    /** Source expression for style/img/font CSP directives. */
    readonly cspSource: string;
}

/** JSON string literal that is safe to inline inside a <script> element. */
function script_literal(value: string): string {
    return JSON.stringify(value)
        .replaceAll('<', '\\u003c')
        .replaceAll('>', '\\u003e')
        .replaceAll('&', '\\u0026')
        .replaceAll('\u2028', '\\u2028')
        .replaceAll('\u2029', '\\u2029');
}

export function build_webview_html(
    assets: WebviewHtmlAssets,
    nonce: string,
    font_family: string | null = null,
    font_size: number | null = null,
): string {
    // Set before the bundle loads so the first paint already uses the
    // configured font; styles.css and the Glide theme both read these vars.
    const font_declarations: string[] = [];
    if (font_family) {
        font_declarations.push(
            `document.documentElement.style.setProperty('--table-viewer-font-family', ${
                script_literal(font_family)});`,
        );
    }
    if (font_size && Number.isFinite(font_size) && font_size > 0) {
        font_declarations.push(
            `document.documentElement.style.setProperty('--table-viewer-font-size', ${
                script_literal(`${font_size}px`)});`,
        );
    }
    const font_bootstrap = font_declarations.length > 0
        ? `<script nonce="${nonce}">${font_declarations.join('')}</script>\n`
        : '';

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
               style-src ${assets.cspSource};
               img-src ${assets.cspSource} data: blob:;
               script-src 'nonce-${nonce}';
               font-src ${assets.cspSource};">
<title>Table Viewer</title>
${font_bootstrap}<link nonce="${nonce}" rel="stylesheet" href="${assets.styleUrl}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${assets.scriptUrl}"></script>
<!-- Glide's DataEditor portals its cell-overlay editor into an element with
     id="portal"; without it getElementById("portal") returns null and the
     editor silently never mounts (the Edit toggle flips but nothing edits).
     Must be the last child of <body> so the fixed-position overlay stacks
     above the grid. -->
<div id="portal"></div>
</body>
</html>`;
}
