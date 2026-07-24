// Builds the viewer page HTML served from the desktop custom protocol,
// reusing the shared, host-agnostic HTML builder (src/webview-html.ts) and the
// existing dist/webview bundle. Pure module (no electron import).
import { build_webview_html, generate_nonce } from '../../src/webview-html';

/** Custom scheme serving the viewer page and the shared webview bundle. */
export const APP_SCHEME = 'tv-app';
export const WEBVIEW_HOST = 'webview';
export const VIEWER_HOST = 'viewer';

export const VIEWER_SCRIPT_URL = `${APP_SCHEME}://${WEBVIEW_HOST}/index.js`;
export const VIEWER_STYLE_URL = `${APP_SCHEME}://${WEBVIEW_HOST}/index.css`;
/** Scheme source: matches every tv-app:// asset in CSP directives. */
export const VIEWER_CSP_SOURCE = `${APP_SCHEME}:`;

/** The generated viewer page keeps the shared bundle's CSP (nonce-locked
 *  scripts, no inline styles) — see src/webview-html.ts for the rationale. */
export function build_desktop_viewer_html(
    font_family: string | null,
    font_size: number | null = null,
): string {
    return build_webview_html(
        {
            scriptUrl: VIEWER_SCRIPT_URL,
            styleUrl: VIEWER_STYLE_URL,
            cspSource: VIEWER_CSP_SOURCE,
        },
        generate_nonce(),
        font_family,
        font_size,
    );
}
