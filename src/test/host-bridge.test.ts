import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

async function setup_pending_edit_durability() {
    const injected = { postMessage: vi.fn() };
    (globalThis as { __tableViewerHostBridge?: unknown })
        .__tableViewerHostBridge = injected;
    const { pending_edit_durability } = await import('../webview/host-bridge');
    return { injected, pending_edit_durability };
}

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

    it('keeps monotonic pending-edit sequences across acknowledgements', async () => {
        const { injected, pending_edit_durability } =
            await setup_pending_edit_durability();
        const first = pending_edit_durability.publish('session:1', {
            '0:0': { value: 'b', base: 'a' },
        }, 0, 'People');
        const duplicate = pending_edit_durability.publish('session:1', {
            '0:0': { value: 'b', base: 'a' },
        }, 0, 'People');
        const second = pending_edit_durability.publish('session:1', null, 0, 'People');
        pending_edit_durability.acknowledge('session:1', first);

        expect([first, duplicate, second]).toEqual([1, 1, 2]);
        expect(injected.postMessage).toHaveBeenCalledTimes(2);
        expect(pending_edit_durability.snapshot('session:1')).toEqual({
            highestProducedSequence: 2,
        });

        pending_edit_durability.retire('session:1');
        expect(pending_edit_durability.publish('session:1', null, 0, 'People'))
            .toBe(1);
    });

    it('dedupes pending-edit payloads per sheet, not per session', async () => {
        const { injected, pending_edit_durability } =
            await setup_pending_edit_durability();
        const edits = { '0:0': { value: 'b', base: 'a' } };
        pending_edit_durability.publish('session:1', edits, 0, 'People');
        // A byte-identical map on another sheet is a distinct slot's content
        // and must reach the host — the host stores each sheet separately.
        pending_edit_durability.publish('session:1', edits, 1, 'Stock');
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

    it('retries an unacknowledged payload at its sheet’s new index', async () => {
        const { injected, pending_edit_durability } =
            await setup_pending_edit_durability();
        const edits = { '0:0': { value: 'b', base: 'a' } };
        pending_edit_durability.publish('session:1', edits, 0, 'People');
        // The host can reject the old index/name pair without acknowledging it.
        // When the refresh remounts People at index 1, the identical full map
        // must go through again with corrected coordinates.
        expect(pending_edit_durability.publish('session:1', edits, 1, 'People'))
            .toBe(2);
        expect(injected.postMessage).toHaveBeenCalledTimes(2);
        expect(injected.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
            sequence: 2,
            sheetIndex: 1,
            sheetName: 'People',
        }));
    });

    it('dedupes an acknowledged payload by sheet name across a reorder', async () => {
        const { injected, pending_edit_durability } =
            await setup_pending_edit_durability();
        const edits = { '0:0': { value: 'b', base: 'a' } };
        const sequence = pending_edit_durability.publish(
            'session:1', edits, 0, 'People');
        pending_edit_durability.acknowledge('session:1', sequence);

        expect(pending_edit_durability.publish('session:1', edits, 1, 'People'))
            .toBe(1);
        expect(injected.postMessage).toHaveBeenCalledTimes(1);
        // The sheet now at index 0 still has an independent dedupe identity.
        expect(pending_edit_durability.publish('session:1', edits, 0, 'Stock'))
            .toBe(2);
        expect(injected.postMessage).toHaveBeenCalledTimes(2);
    });

    it('dedupes by worksheet ID across rename and reorder', async () => {
        const { injected, pending_edit_durability } =
            await setup_pending_edit_durability();
        const edits = { '0:0': { value: 'b', base: 'a' } };
        const sequence = pending_edit_durability.publish(
            'session:id-rename', edits, 0, 'Before', false, '7');
        pending_edit_durability.acknowledge('session:id-rename', sequence);

        expect(pending_edit_durability.publish(
            'session:id-rename', edits, 2, 'After', false, '7')).toBe(1);
        expect(injected.postMessage).toHaveBeenCalledTimes(1);
    });

    it('does not dedupe different worksheet IDs that share a name', async () => {
        const { injected, pending_edit_durability } =
            await setup_pending_edit_durability();
        const edits = { '0:0': { value: 'b', base: 'a' } };
        expect(pending_edit_durability.publish(
            'session:id-replaced', edits, 0, 'Data', false, 'old')).toBe(1);
        expect(pending_edit_durability.publish(
            'session:id-replaced', edits, 0, 'Data', false, 'new')).toBe(2);
        expect(injected.postMessage).toHaveBeenCalledTimes(2);
    });

    it('tracks acknowledgement against each sheet’s latest publication', async () => {
        const { pending_edit_durability } = await setup_pending_edit_durability();
        const people = pending_edit_durability.publish(
            'session:1', { '0:0': { value: 'P', base: 'p' } }, 0, 'People');
        const inventory = pending_edit_durability.publish(
            'session:1', { '0:0': { value: 'I', base: 'i' } }, 1, 'Inventory');
        pending_edit_durability.acknowledge('session:1', inventory);

        expect(pending_edit_durability.has_unacknowledged_payload(
            'session:1', 0, 'People')).toBe(true);
        expect(pending_edit_durability.has_unacknowledged_payload(
            'session:1', 1, 'Inventory')).toBe(false);

        const people_newer = pending_edit_durability.publish(
            'session:1', { '0:0': { value: 'P2', base: 'p' } }, 0, 'People');
        pending_edit_durability.acknowledge('session:1', people);
        expect(people_newer).toBe(3);
        expect(pending_edit_durability.has_unacknowledged_payload(
            'session:1', 0, 'People')).toBe(true);
    });

    it('recognizes an authoritative echo of the latest unacknowledged payload', async () => {
        const { pending_edit_durability } = await setup_pending_edit_durability();
        const edits = { '0:0': { value: 'P', base: 'p' } };
        const sequence = pending_edit_durability.publish(
            'session:echo', edits, 0, 'People');

        expect(pending_edit_durability.unacknowledged_payload_matches(
            'session:echo', edits, edits, 0, 'People')).toBe(true);
        expect(pending_edit_durability.unacknowledged_payload_matches(
            'session:echo', null, edits, 0, 'People')).toBe(false);
        expect(pending_edit_durability.unacknowledged_payload_matches(
            'session:echo', edits, null, 0, 'People')).toBe(false);

        pending_edit_durability.acknowledge('session:echo', sequence);
        expect(pending_edit_durability.unacknowledged_payload_matches(
            'session:echo', edits, edits, 0, 'People')).toBe(false);
    });

    it('matches an echo after renderer-only pending-base metadata is normalized', async () => {
        const { injected, pending_edit_durability } =
            await setup_pending_edit_durability();
        const local = {
            '0:0': { value: 'P', base: '', base_pending: true },
        };
        const authoritative = {
            '0:0': { value: 'P', base: '' },
        };
        const sequence = pending_edit_durability.publish(
            'session:legacy', local, 0, 'People');

        expect(pending_edit_durability.unacknowledged_payload_matches(
            'session:legacy', authoritative, local, 0, 'People')).toBe(true);
        expect(pending_edit_durability.publish(
            'session:legacy', authoritative, 0, 'People')).toBe(sequence);
        expect(injected.postMessage).toHaveBeenCalledTimes(1);
    });

    it('matches equivalent edit maps inserted in reverse key order', async () => {
        const { injected, pending_edit_durability } =
            await setup_pending_edit_durability();
        const published = {
            '2:1': { value: 'A', base: 'a' },
            '10:3': { value: 'B', base: 'b' },
        };
        const echoed = {
            '10:3': { value: 'B', base: 'b' },
            '2:1': { value: 'A', base: 'a' },
        };
        const sequence = pending_edit_durability.publish(
            'session:key-order', published, 0, 'People');

        expect(pending_edit_durability.unacknowledged_payload_matches(
            'session:key-order', echoed, published, 0, 'People')).toBe(true);
        expect(pending_edit_durability.publish(
            'session:key-order', echoed, 0, 'People')).toBe(sequence);
        expect(injected.postMessage).toHaveBeenCalledTimes(1);
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
