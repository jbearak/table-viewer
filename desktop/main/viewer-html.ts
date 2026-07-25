// Builds the viewer page HTML served from the desktop custom protocol,
// reusing the shared, host-agnostic HTML builder (src/webview-html.ts) and the
// existing dist/webview bundle. Pure module (no electron import).
import { build_webview_html, generate_nonce } from '../../src/webview-html';
import type { ThemePayload } from './theme';

/** Custom scheme serving the viewer page and the shared webview bundle. */
export const APP_SCHEME = 'tv-app';
export const WEBVIEW_HOST = 'webview';
export const VIEWER_HOST = 'viewer';

/**
 * URL for one viewer window's page. Chromium keys the zoom level by origin, so
 * every window that shared a host would also share its zoom — each window gets
 * its own `viewer-<n>` host to keep View → Zoom per-window.
 */
export function viewer_url(window_id: number): string {
    return `${APP_SCHEME}://${VIEWER_HOST}-${window_id}/index.html`;
}

/** Whether `host` is one of those per-window viewer hosts. */
export function is_viewer_host(host: string): boolean {
    return host === VIEWER_HOST || /^viewer-[0-9]+$/.test(host);
}

export const VIEWER_SCRIPT_URL = `${APP_SCHEME}://${WEBVIEW_HOST}/index.js`;
export const VIEWER_STYLE_URL = `${APP_SCHEME}://${WEBVIEW_HOST}/index.css`;
/** Scheme source: matches every tv-app:// asset in CSP directives. */
export const VIEWER_CSP_SOURCE = `${APP_SCHEME}:`;

/** The generated viewer page keeps the shared bundle's CSP (nonce-locked
 *  scripts, no inline styles) — see src/webview-html.ts for the rationale.
 *
 *  Unlike VS Code, nothing outside the app sets the `--vscode-*` variables the
 *  shared webview themes itself from, so the current light/dark palette is baked
 *  into the page here. OS appearance changes afterwards arrive over IPC and are
 *  re-applied by the viewer preload. */
export function build_desktop_viewer_html(
    font_family: string | null,
    font_size: number | null = null,
    theme: ThemePayload | null = null,
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
        theme && { variables: theme.variables, colorScheme: theme.kind },
    );
}
