import { describe, it, expect } from 'vitest';
import { build_webview_html } from '../webview-html';

// `build_webview_html` only touches `webview.asWebviewUri`, `webview.cspSource`
// and `vscode.Uri.joinPath` (the latter via the aliased mock). A tiny fake
// webview is all the function needs.
function fake_webview() {
    return {
        asWebviewUri: (uri: { toString(): string }) => ({
            toString: () => `https://webview.test/${uri.toString()}`,
        }),
        cspSource: 'https://webview.test',
    } as unknown as Parameters<typeof build_webview_html>[0];
}

const ext_uri = { path: '/ext', toString: () => '/ext' } as unknown as Parameters<
    typeof build_webview_html
>[1];

describe('build_webview_html', () => {
    it('renders the Glide overlay-editor portal target so cell editing can mount', () => {
        // Regression: Glide's DataGridOverlayEditor portals into the element with
        // id="portal" (document.getElementById("portal")). Without it the editor
        // returns null and CSV editing silently fails — the Edit toggle flips the
        // button colour but no overlay ever opens. See src/webview-html.ts.
        const html = build_webview_html(fake_webview(), ext_uri, 'nonce123');
        expect(html).toContain('<div id="portal"></div>');
    });

    it('places the portal inside <body>, after the React root, so the overlay stacks above the grid', () => {
        const html = build_webview_html(fake_webview(), ext_uri, 'nonce123');
        const body = html.slice(html.indexOf('<body>'));
        const root_at = body.indexOf('id="root"');
        const portal_at = body.indexOf('id="portal"');
        expect(root_at).toBeGreaterThanOrEqual(0);
        expect(portal_at).toBeGreaterThan(root_at);
    });

    it('bootstraps a configured font before the stylesheet loads', () => {
        const html = build_webview_html(
            fake_webview(),
            ext_uri,
            'nonce123',
            '"Atkinson Hyperlegible", sans-serif',
        );
        const font_at = html.indexOf("style.setProperty('--table-viewer-font-family'");
        const stylesheet_at = html.indexOf('<link nonce="nonce123" rel="stylesheet"');
        expect(font_at).toBeGreaterThanOrEqual(0);
        expect(font_at).toBeLessThan(stylesheet_at);
        expect(html).toContain(
            '<script nonce="nonce123">document.documentElement.style.setProperty(',
        );
    });

    it('escapes configured font text before embedding it in a script', () => {
        const html = build_webview_html(
            fake_webview(),
            ext_uri,
            'nonce123',
            '</script><script>alert(1)</script>',
        );
        expect(html).not.toContain('</script><script>alert(1)</script>');
        expect(html).toContain('\\u003c/script\\u003e');
    });
});
