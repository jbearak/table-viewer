// Preload for viewer tabs. Runs before the shared webview bundle and:
//  1. installs `globalThis.__tableViewerHostBridge` (see src/webview/host-bridge.ts)
//     so the bundle posts WebviewMessages over ipcRenderer instead of
//     acquireVsCodeApi();
//  2. relays HostMessages from the main process into `window.postMessage` so
//     the bundle's existing window 'message' listeners see them unchanged;
//  3. re-applies the desktop theme as `--vscode-*` inline custom properties on
//     <html> when the OS appearance changes — the webview's MutationObserver
//     picks up the style mutation and rebuilds the Glide theme. The *initial*
//     palette is baked into the page HTML (desktop/main/viewer-html.ts) because
//     a preload runs before <html> exists, so it cannot style the document yet.
//
// Cmd/Ctrl+S is deliberately not handled here: the grid's own window keydown
// listener (src/webview/grid-shell.tsx) saves in CSV edit mode, and it only
// sees the keystroke while no application-menu accelerator claims it first.
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_GET_THEME,
    CHANNEL_HOST_MESSAGE,
    CHANNEL_THEME_CHANGED,
    CHANNEL_WEBVIEW_MESSAGE,
} from '../shared/ipc';
import { apply_theme_to_document, type ThemePayload } from '../main/theme';

// contextBridge clones the object into the main world, so the shared bundle
// (which only calls postMessage) works across the isolation boundary.
contextBridge.exposeInMainWorld('__tableViewerHostBridge', {
    postMessage(msg: unknown): void {
        ipcRenderer.send(CHANNEL_WEBVIEW_MESSAGE, msg);
    },
});

ipcRenderer.on(CHANNEL_HOST_MESSAGE, (_event, message: unknown) => {
    // Re-dispatch into the page so the bundle's window 'message' listeners
    // receive `event.data` exactly like a VS Code webview would.
    window.postMessage(message, '*');
});

// Latest known palette. The page HTML already carries the variables for it, but
// the body classes (`vscode-dark`/`vscode-light`, which the shared webview reads
// to detect high-contrast themes) still need a document to exist.
let current_theme = ipcRenderer.sendSync(CHANNEL_GET_THEME) as ThemePayload | undefined;

function apply_theme(payload: ThemePayload | undefined): void {
    if (!payload) return;
    current_theme = payload;
    apply_theme_to_document(document, payload);
}

apply_theme(current_theme);
window.addEventListener('DOMContentLoaded', () => apply_theme(current_theme));

ipcRenderer.on(CHANNEL_THEME_CHANGED, (_event, payload: ThemePayload) => {
    apply_theme(payload);
});
