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

    it('answers a pre-session flush from the always-mounted bridge with sequence zero', async () => {
        const injected = { postMessage: vi.fn() };
        (globalThis as { __tableViewerHostBridge?: unknown })
            .__tableViewerHostBridge = injected;
        const target = new EventTarget();
        vi.stubGlobal('window', target);
        await import('../webview/host-bridge');

        target.dispatchEvent(new MessageEvent('message', { data: {
            type: 'requestPendingEditsFlush',
            requestId: 'close-before-grid',
        } }));
        await vi.waitFor(() => expect(injected.postMessage).toHaveBeenCalledWith({
            type: 'pendingEditsFlush',
            requestId: 'close-before-grid',
            editSessionId: undefined,
            highestProducedSequence: 0,
        }));
    });

    it.each<[string, () => never | Promise<never>]>([
        ['synchronous throw', () => { throw new Error('private sync detail'); }],
        ['asynchronous rejection', () => Promise.reject(new Error('private async detail'))],
    ])('reports flush failure after a responder %s without exposing its reason', async (_name, fail) => {
        const injected = { postMessage: vi.fn() };
        (globalThis as { __tableViewerHostBridge?: unknown })
            .__tableViewerHostBridge = injected;
        const target = new EventTarget();
        vi.stubGlobal('window', target);
        const { install_pending_edit_flush_responder } = await import('../webview/host-bridge');
        install_pending_edit_flush_responder(fail);

        target.dispatchEvent(new MessageEvent('message', { data: {
            type: 'requestPendingEditsFlush',
            requestId: 'close-failed',
        } }));

        await vi.waitFor(() => expect(injected.postMessage).toHaveBeenCalledWith({
            type: 'pendingEditsFlushFailed',
            requestId: 'close-failed',
        }));
        expect(JSON.stringify(injected.postMessage.mock.calls)).not.toContain('private');
    });

    it('keeps monotonic pending-edit sequences across subscribers', async () => {
        const injected = { postMessage: vi.fn() };
        (globalThis as { __tableViewerHostBridge?: unknown })
            .__tableViewerHostBridge = injected;

        const { pending_edit_durability } = await import('../webview/host-bridge');
        const first = pending_edit_durability.publish('session:1', {
            '0:0': { value: 'b', base: 'a' },
        });
        const duplicate = pending_edit_durability.publish('session:1', {
            '0:0': { value: 'b', base: 'a' },
        });
        const snapshots: unknown[] = [];
        const unsubscribe = pending_edit_durability.subscribe(
            'session:1',
            (snapshot) => snapshots.push(snapshot),
        );
        unsubscribe();
        const second = pending_edit_durability.publish('session:1', null);
        pending_edit_durability.acknowledge('session:1', first);

        expect([first, duplicate, second]).toEqual([1, 1, 2]);
        expect(injected.postMessage).toHaveBeenCalledTimes(2);
        expect(snapshots).toEqual([{
            highestProducedSequence: 1,
            highestAcknowledgedSequence: 0,
        }]);
        expect(pending_edit_durability.snapshot('session:1')).toEqual({
            highestProducedSequence: 2,
            highestAcknowledgedSequence: 1,
        });
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
