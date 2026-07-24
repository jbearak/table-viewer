import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('host-bridge', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete (globalThis as { __tableViewerHostBridge?: unknown })
            .__tableViewerHostBridge;
    });

    it('wraps acquireVsCodeApi in VS Code hosts', async () => {
        const post_message = vi.fn();
        vi.stubGlobal('acquireVsCodeApi', () => ({
            postMessage: post_message,
            getState: () => undefined,
            setState: () => undefined,
        }));

        const { host_bridge } = await import('../webview/host-bridge');
        host_bridge.postMessage({ type: 'ready' });

        expect(post_message).toHaveBeenCalledWith({ type: 'ready' });
    });

    it('prefers an injected global bridge over acquireVsCodeApi', async () => {
        const injected = { postMessage: vi.fn() };
        (globalThis as { __tableViewerHostBridge?: unknown })
            .__tableViewerHostBridge = injected;
        const acquire = vi.fn();
        vi.stubGlobal('acquireVsCodeApi', acquire);

        const { host_bridge } = await import('../webview/host-bridge');
        host_bridge.postMessage({ type: 'ready' });

        expect(injected.postMessage).toHaveBeenCalledWith({ type: 'ready' });
        expect(acquire).not.toHaveBeenCalled();
    });
});
