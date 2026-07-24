// Adapter turning an abstract host<->webview transport into the
// `ViewerHostPanel` shape `attach_viewer` expects. Pure module (no electron
// import): tabs.ts supplies a transport backed by `webContents.send` /
// `ipcMain`, tests supply an in-memory one.
import type { ViewerHostPanel } from '../../src/viewer-controller';
import type { HostMessage, WebviewMessage } from '../../src/types';

export interface ViewerPanelTransport {
    /** Deliver a host message to the webview. Returns false if it was dropped. */
    send(message: HostMessage): boolean;
    /** Subscribe to messages from the webview; returns an unsubscribe fn. */
    on_message(listener: (message: WebviewMessage) => void): () => void;
}

export interface DesktopViewerPanel extends ViewerHostPanel {
    /** Tear down all inbound subscriptions (called when the tab closes). */
    dispose(): void;
}

export function create_viewer_panel(transport: ViewerPanelTransport): DesktopViewerPanel {
    const unsubscribers = new Set<() => void>();
    let disposed = false;
    return {
        webview: {
            postMessage(message: unknown): boolean {
                if (disposed) return false;
                return transport.send(message as HostMessage);
            },
            onDidReceiveMessage(handler: (msg: WebviewMessage) => unknown) {
                if (disposed) return { dispose() {} };
                const unsubscribe = transport.on_message((msg) => void handler(msg));
                unsubscribers.add(unsubscribe);
                let done = false;
                return {
                    dispose() {
                        if (done) return;
                        done = true;
                        unsubscribers.delete(unsubscribe);
                        unsubscribe();
                    },
                };
            },
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const unsubscribe of [...unsubscribers]) unsubscribe();
            unsubscribers.clear();
        },
    };
}
