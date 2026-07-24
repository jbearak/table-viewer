// Preload for viewer tabs. Runs before the shared webview bundle and:
//  1. installs `globalThis.__tableViewerHostBridge` (see src/webview/host-bridge.ts)
//     so the bundle posts WebviewMessages over ipcRenderer instead of
//     acquireVsCodeApi();
//  2. relays HostMessages from the main process into `window.postMessage` so
//     the bundle's existing window 'message' listeners see them unchanged;
//  3. applies the desktop theme as `--vscode-*` inline custom properties on
//     <html> (synchronously, before first paint) and re-applies on OS
//     appearance changes — the webview's MutationObserver picks up the style
//     mutation and rebuilds the Glide theme;
//  4. synthesizes the webview's own Cmd/Ctrl+S save shortcut when the native
//     File > Save menu item is used.
import { contextBridge, ipcRenderer } from 'electron';
import {
    CHANNEL_GET_THEME,
    CHANNEL_HOST_MESSAGE,
    CHANNEL_MENU_SAVE,
    CHANNEL_THEME_CHANGED,
    CHANNEL_WEBVIEW_MESSAGE,
} from '../shared/ipc';
import type { ThemePayload } from '../main/theme';

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

function apply_theme(payload: ThemePayload): void {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(payload.variables)) {
        root.style.setProperty(name, value);
    }
    root.style.colorScheme = payload.kind;
    document.body?.classList.toggle('vscode-dark', payload.kind === 'dark');
    document.body?.classList.toggle('vscode-light', payload.kind === 'light');
}

// Synchronous fetch so the variables exist before the bundle evaluates and
// the first Glide theme read happens.
const initial_theme = ipcRenderer.sendSync(CHANNEL_GET_THEME) as ThemePayload;
apply_theme(initial_theme);
window.addEventListener('DOMContentLoaded', () => apply_theme(initial_theme));

ipcRenderer.on(CHANNEL_THEME_CHANGED, (_event, payload: ThemePayload) => {
    apply_theme(payload);
});

ipcRenderer.on(CHANNEL_MENU_SAVE, () => {
    // grid-shell.tsx listens for Cmd/Ctrl+S on window; synthetic DOM events
    // dispatched from the isolated world reach main-world listeners.
    window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 's',
        metaKey: process.platform === 'darwin',
        ctrlKey: process.platform !== 'darwin',
        bubbles: true,
        cancelable: true,
    }));
});
