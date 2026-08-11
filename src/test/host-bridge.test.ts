import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('host-bridge', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete (globalThis as { __tableViewerHostBridge?: unknown })
            .__tableViewerHostBridge;
        delete (globalThis as { __tableViewerPendingEditMessageDispatch?: unknown })
            .__tableViewerPendingEditMessageDispatch;
        delete (globalThis as { __tableViewerPendingEditMessageListenerWindow?: unknown })
            .__tableViewerPendingEditMessageListenerWindow;
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

    it('installs only one flush listener across fresh module evaluations', async () => {
        const first = { postMessage: vi.fn() };
        (globalThis as { __tableViewerHostBridge?: unknown })
            .__tableViewerHostBridge = first;
        const target = new EventTarget();
        vi.stubGlobal('window', target);
        await import('../webview/host-bridge');

        vi.resetModules();
        const second = { postMessage: vi.fn() };
        (globalThis as { __tableViewerHostBridge?: unknown })
            .__tableViewerHostBridge = second;
        await import('../webview/host-bridge');

        target.dispatchEvent(new MessageEvent('message', { data: {
            type: 'requestPendingEditsFlush',
            requestId: 'one-listener',
        } }));

        await vi.waitFor(() => expect(second.postMessage).toHaveBeenCalledTimes(1));
        expect(second.postMessage).toHaveBeenCalledWith({
            type: 'pendingEditsFlush',
            requestId: 'one-listener',
            editSessionId: undefined,
            highestProducedSequence: 0,
        });
        expect(first.postMessage).not.toHaveBeenCalled();
    });

    it('keeps monotonic pending-edit sequences across subscribers', async () => {
        const injected = { postMessage: vi.fn() };
        (globalThis as { __tableViewerHostBridge?: unknown })
            .__tableViewerHostBridge = injected;

        const { pending_edit_durability } = await import('../webview/host-bridge');
        const first = pending_edit_durability.publish('session:1', {
            '0:0': { value: 'b', base: 'a' },
        }, 0, 'People');
        const duplicate = pending_edit_durability.publish('session:1', {
            '0:0': { value: 'b', base: 'a' },
        }, 0, 'People');
        const snapshots: unknown[] = [];
        const unsubscribe = pending_edit_durability.subscribe(
            'session:1',
            (snapshot) => snapshots.push(snapshot),
        );
        unsubscribe();
        const second = pending_edit_durability.publish('session:1', null, 0, 'People');
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

        pending_edit_durability.retire('session:1');
        expect(pending_edit_durability.publish('session:1', null, 0, 'People'))
            .toBe(1);
    });

    it('dedupes pending-edit payloads per sheet, not per session', async () => {
        const injected = { postMessage: vi.fn() };
        (globalThis as { __tableViewerHostBridge?: unknown })
            .__tableViewerHostBridge = injected;

        const { pending_edit_durability } = await import('../webview/host-bridge');
        const edits = { '0:0': { value: 'b', base: 'a' } };
        const on_people = pending_edit_durability.publish(
            'session:1', edits, 0, 'People');
        // A byte-identical map on another sheet is a distinct slot's content
        // and must reach the host — the host stores each sheet separately.
        const on_stock = pending_edit_durability.publish(
            'session:1', edits, 1, 'Stock');

        expect([on_people, on_stock]).toEqual([1, 2]);
        expect(injected.postMessage).toHaveBeenCalledTimes(2);
        expect(injected.postMessage).toHaveBeenLastCalledWith({
            type: 'pendingEditsChanged',
            editSessionId: 'session:1',
            edits,
            sequence: 2,
            sheetIndex: 1,
            sheetName: 'Stock',
        });
        // But re-posting the same map on the same sheet still dedupes.
        expect(pending_edit_durability.publish('session:1', edits, 1, 'Stock'))
            .toBe(2);
        expect(injected.postMessage).toHaveBeenCalledTimes(2);
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
