/**
 * Host bridge: a narrow abstraction over the channel the webview uses to talk
 * to its host. In VS Code this wraps `acquireVsCodeApi()`. Other hosts (e.g.
 * an Electron preload script) can install their own implementation by
 * assigning `globalThis.__tableViewerHostBridge` before the webview bundle
 * loads.
 *
 * The message shapes (`HostMessage` / `WebviewMessage` in ../types) are
 * host-agnostic and unchanged by this indirection.
 */

export interface HostBridge {
    /** Send a message from the webview to the host. */
    postMessage(msg: unknown): void;
}

/** Shape of the API returned by VS Code's `acquireVsCodeApi()`. */
interface VsCodeApi {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function create_host_bridge(): HostBridge {
    // A non-VS Code host (e.g. Electron preload via contextBridge) may
    // pre-install a bridge on the global object.
    const injected = (globalThis as { __tableViewerHostBridge?: HostBridge })
        .__tableViewerHostBridge;
    if (injected) {
        return injected;
    }
    const api = acquireVsCodeApi();
    return {
        postMessage: (msg) => api.postMessage(msg),
    };
}

export const host_bridge: HostBridge = create_host_bridge();
