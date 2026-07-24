import { describe, it, expect } from 'vitest';
import { build_webview_html, type WebviewHtmlAssets } from '../webview-html';

// `build_webview_html` is host-agnostic: it only needs resolved asset URLs and
// a CSP source expression.
const assets: WebviewHtmlAssets = {
    scriptUrl: 'https://webview.test/ext/dist/webview/index.js',
    styleUrl: 'https://webview.test/ext/dist/webview/index.css',
    cspSource: 'https://webview.test',
};

describe('build_webview_html', () => {
    it('renders the Glide overlay-editor portal target so cell editing can mount', () => {
        // Regression: Glide's DataGridOverlayEditor portals into the element with
        // id="portal" (document.getElementById("portal")). Without it the editor
        // returns null and CSV editing silently fails — the Edit toggle flips the
        // button colour but no overlay ever opens. See src/webview-html.ts.
        const html = build_webview_html(assets, 'nonce123');
        expect(html).toContain('<div id="portal"></div>');
    });

    it('places the portal inside <body>, after the React root, so the overlay stacks above the grid', () => {
        const html = build_webview_html(assets, 'nonce123');
        const body = html.slice(html.indexOf('<body>'));
        const root_at = body.indexOf('id="root"');
        const portal_at = body.indexOf('id="portal"');
        expect(root_at).toBeGreaterThanOrEqual(0);
        expect(portal_at).toBeGreaterThan(root_at);
    });

    it('embeds the provided asset URLs and CSP source', () => {
        const html = build_webview_html(assets, 'nonce123');
        expect(html).toContain(`src="${assets.scriptUrl}"`);
        expect(html).toContain(`href="${assets.styleUrl}"`);
        expect(html).toContain(`style-src ${assets.cspSource};`);
        expect(html).toContain(`img-src ${assets.cspSource} data: blob:;`);
        expect(html).toContain(`font-src ${assets.cspSource};`);
    });

    it('bootstraps a configured font before the stylesheet loads', () => {
        const html = build_webview_html(
            assets,
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
            assets,
            'nonce123',
            '</script><script>alert(1)</script>',
        );
        expect(html).not.toContain('</script><script>alert(1)</script>');
        expect(html).toContain('\\u003c/script\\u003e');
    });
});
