// Preload for viewer tabs. Runs before the shared webview bundle and:
//  1. installs `globalThis.__tableViewerHostBridge` (see src/webview/host-bridge.ts)
//     so the bundle posts WebviewMessages over ipcRenderer instead of
//     acquireVsCodeApi();
//  2. relays HostMessages from the main process into `window.postMessage` so
//     the bundle's existing window 'message' listeners see them unchanged,
//     including the close-flush request that main must send before teardown;
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
    CHANNEL_HOST_MESSAGE_RECEIPT,
    CHANNEL_THEME_CHANGED,
    CHANNEL_TITLEBAR_INFO,
    CHANNEL_TITLEBAR_PATH_MENU,
    CHANNEL_WEBVIEW_MESSAGE,
    type DesktopHostMessageEnvelope,
    type PendingEditAcknowledgementReceipt,
} from '../shared/ipc';
import { apply_theme_to_document, type ThemePayload } from '../main/theme';
import {
    install_titlebar,
    set_titlebar_active,
    set_titlebar_zoom,
} from '../shared/titlebar';
import { titlebar_preload_api } from './titlebar-api';

// contextBridge clones the object into the main world, so the shared bundle
// (which only calls postMessage) works across the isolation boundary.
contextBridge.exposeInMainWorld('__tableViewerHostBridge', {
    postMessage(msg: unknown): void {
        ipcRenderer.send(CHANNEL_WEBVIEW_MESSAGE, msg);
    },
});

const RECEIPT_FIELD = '__tableViewerDesktopAcknowledgementReceipt';
const pending_receipts = new Map<string, PendingEditAcknowledgementReceipt>();

ipcRenderer.on(CHANNEL_HOST_MESSAGE, (_event, envelope: DesktopHostMessageEnvelope) => {
    // Re-dispatch into the page so the bundle's window 'message' listeners
    // receive `event.data` exactly like a VS Code webview would. A receipt marker
    // is ignored by the structural HostMessage protocol but lets this preload
    // confirm that the page's message event actually ran.
    const receipt = envelope.receipt;
    if (receipt) pending_receipts.set(receipt.receiptId, receipt);
    const message = receipt && envelope.message && typeof envelope.message === 'object'
        ? { ...envelope.message, [RECEIPT_FIELD]: receipt.receiptId }
        : envelope.message;
    window.postMessage(message, '*');
});

window.addEventListener('message', (event) => {
    const data = event.data as Record<string, unknown> | null;
    const receipt_id = data && typeof data[RECEIPT_FIELD] === 'string'
        ? data[RECEIPT_FIELD]
        : undefined;
    if (!receipt_id) return;
    const receipt = pending_receipts.get(receipt_id);
    if (!receipt) return;
    pending_receipts.delete(receipt_id);
    // Window message listeners run synchronously in registration order. Defer the
    // IPC receipt until the shared app's listener has also consumed this event.
    queueMicrotask(() => ipcRenderer.send(CHANNEL_HOST_MESSAGE_RECEIPT, receipt));
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

// macOS themed title bar. The strip itself is shared with the other
// windows (desktop/shared/titlebar.ts); the viewer supplies the file name, the
// toolbar's own band colors (see .toolbar in src/webview/styles.css), and the
// proxy-icon path menu, which only a window representing a file has. The title's
// own font and color are the system's, not the configured app font.
const titlebar_api = titlebar_preload_api();
if (titlebar_api.titlebar_inset) {
    const title = ipcRenderer.sendSync(CHANNEL_TITLEBAR_INFO) as string | undefined;
    window.addEventListener('DOMContentLoaded', () => install_titlebar(document, {
        title: title ?? document.title,
        inset: titlebar_api.titlebar_inset,
        style: {
            background: 'var(--vscode-editorGroupHeader-tabsBackground, #252526)',
            border: 'var(--vscode-panel-border, #444)',
        },
        on_path_menu: () => ipcRenderer.send(CHANNEL_TITLEBAR_PATH_MENU),
        zoom: titlebar_api.titlebar_zoom(),
        active: titlebar_api.titlebar_active(),
    }));
    titlebar_api.on_titlebar_zoom((zoom) => set_titlebar_zoom(document, zoom));
    titlebar_api.on_titlebar_active((active) => set_titlebar_active(document, active));
}
