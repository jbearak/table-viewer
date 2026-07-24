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

/** Initial theme for hosts that have no ambient `--vscode-*` variables (the
 *  desktop app). VS Code injects its own, so it passes none. */
export interface WebviewThemeBootstrap {
    /** `--vscode-*` custom properties to set on <html> before the bundle runs. */
    readonly variables: Record<string, string>;
    readonly colorScheme?: 'light' | 'dark';
}

/** Custom-property names we are willing to inline. Names cannot be quoted the
 *  way values can, so anything unexpected is dropped rather than escaped. */
const CUSTOM_PROPERTY_NAME = /^--[A-Za-z0-9_-]+$/;

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
    theme: WebviewThemeBootstrap | null = null,
): string {
    // Set before the bundle loads so the first paint already uses the
    // configured font; styles.css and the Glide theme both read these vars.
    const font_declarations: string[] = [];
    if (font_family) {
        font_declarations.push(
            `r.style.setProperty('--table-viewer-font-family', ${
                script_literal(font_family)});`,
        );
    }
    if (font_size && Number.isFinite(font_size) && font_size > 0) {
        font_declarations.push(
            `r.style.setProperty('--table-viewer-font-size', ${
                script_literal(`${font_size}px`)});`,
        );
    }
    // The theme goes into the document itself rather than being pushed in by a
    // host (the desktop preload used to do it) so the very first paint — and the
    // Glide theme the bundle builds as it evaluates — already has the right
    // light/dark values, with no ordering race against the parser.
    const theme_declarations: string[] = [];
    for (const [name, value] of Object.entries(theme?.variables ?? {})) {
        if (!CUSTOM_PROPERTY_NAME.test(name)) continue;
        theme_declarations.push(
            `r.style.setProperty(${script_literal(name)}, ${script_literal(value)});`,
        );
    }
    if (theme?.colorScheme) {
        theme_declarations.push(
            `r.style.colorScheme = ${script_literal(theme.colorScheme)};`,
        );
    }

    const declarations = [...theme_declarations, ...font_declarations];
    const bootstrap = declarations.length > 0
        ? `<script nonce="${nonce}">{const r=document.documentElement;${
            declarations.join('')}}</script>\n`
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
${bootstrap}<link nonce="${nonce}" rel="stylesheet" href="${assets.styleUrl}">
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
