// Adapter turning an abstract host<->webview transport into the
// `ViewerHostPanel` shape `attach_viewer` expects. Pure module (no electron
// import): tabs.ts supplies a transport backed by `webContents.send` /
// `ipcMain`, tests supply an in-memory one.
import type { ViewerHostPanel } from '../../src/viewer-controller';
import type { HostMessage, WebviewMessage } from '../../src/types';
import type { PendingEditAcknowledgementReceipt } from '../shared/ipc';

export interface ViewerPanelTransport {
    /** Deliver a host message to the current renderer generation. */
    send(
        message: HostMessage,
        rendererGeneration: number,
        receipt?: PendingEditAcknowledgementReceipt,
    ): boolean;
    /** Subscribe to messages from the webview; returns an unsubscribe fn. */
    on_message(listener: (message: WebviewMessage) => void): () => void;
    /** Subscribe to successful main-frame navigations that replace the renderer generation. */
    on_renderer_generation_changed(listener: (error: Error) => void): () => void;
    /** Subscribe to navigation/process/transport loss for this renderer. */
    on_renderer_unavailable(listener: (error: Error, retryable: boolean) => void): () => void;
    /** Subscribe to recovery after a retryable unresponsive state. */
    on_renderer_responsive(listener: () => void): () => void;
    /** Subscribe to explicit renderer delivery receipts for edit acknowledgements. */
    on_pending_edit_ack_receipt(
        listener: (receipt: PendingEditAcknowledgementReceipt) => void,
    ): () => void;
}

export interface PendingEditFlush {
    editSessionId?: string;
    sequence: number;
    /** Renderer generation that produced this flush result. */
    rendererGeneration: number;
}

export interface ViewerPanelDeadlineScheduler {
    (callback: () => void, delayMs: number): () => void;
}

/** Long enough for normal persistence, finite so lifecycle actions can be retried. */
export const VIEWER_PROTOCOL_DEADLINE_MS = 15_000;

const schedule_viewer_protocol_deadline: ViewerPanelDeadlineScheduler = (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
};

export interface DesktopViewerPanel extends ViewerHostPanel {
    /** Stop renderer editing and report its highest produced full-map sequence. */
    flush_pending_edits(): Promise<PendingEditFlush>;
    /** Wait for an acknowledgement delivered to the renderer that produced the flush. */
    wait_for_pending_edit_ack(
        rendererGeneration: number,
        editSessionId: string | undefined,
        sequence: number,
    ): Promise<void>;
    /** Tear down all inbound subscriptions (called when the tab closes). */
    dispose(): void;
}

export function create_viewer_panel(
    transport: ViewerPanelTransport,
    schedule_deadline: ViewerPanelDeadlineScheduler = schedule_viewer_protocol_deadline,
): DesktopViewerPanel {
    const unsubscribers = new Set<() => void>();
    const flush_waiters = new Map<string, {
        rendererGeneration: number;
        resolve: (result: PendingEditFlush) => void;
        reject: (error: Error) => void;
        cancelDeadline: () => void;
    }>();
    const acknowledgement_waiters = new Set<{
        rendererGeneration: number;
        editSessionId: string;
        sequence: number;
        resolve: () => void;
        reject: (error: Error) => void;
        cancelDeadline: () => void;
    }>();
    let next_flush_request = 0;
    let next_receipt_request = 0;
    let renderer_generation = 0;
    const highest_acknowledged = new Map<string, number>();
    const pending_ack_receipts = new Map<string, PendingEditAcknowledgementReceipt>();
    let renderer_state: 'loading' | 'ready' | 'unavailable' = 'loading';
    let renderer_error: Error | undefined;
    let renderer_retryable = false;
    let disposed = false;

    const reject_protocol_waiters = (error: Error) => {
        for (const waiter of flush_waiters.values()) {
            waiter.cancelDeadline();
            waiter.reject(error);
        }
        flush_waiters.clear();
        for (const waiter of acknowledgement_waiters) {
            waiter.cancelDeadline();
            waiter.reject(error);
        }
        acknowledgement_waiters.clear();
        pending_ack_receipts.clear();
    };

    const resolve_acknowledgement_waiters = () => {
        for (const waiter of acknowledgement_waiters) {
            if (waiter.rendererGeneration !== renderer_generation) continue;
            const acknowledged = highest_acknowledged.get(waiter.editSessionId) ?? 0;
            if (acknowledged < waiter.sequence) continue;
            acknowledgement_waiters.delete(waiter);
            waiter.cancelDeadline();
            waiter.resolve();
        }
    };

    const replace_renderer_generation = (error: Error) => {
        renderer_generation += 1;
        highest_acknowledged.clear();
        pending_ack_receipts.clear();
        reject_protocol_waiters(error);
    };

    const stop_lifecycle = transport.on_message((message) => {
        if (message.type === 'ready') {
            // did-navigate normally announces the replacement first. A second
            // ready without that event is still a new page/protocol generation;
            // never let its acknowledgements satisfy the old page's waiters.
            if (renderer_state === 'ready' || renderer_state === 'unavailable') {
                replace_renderer_generation(new Error(
                    'Viewer renderer started a new protocol generation.',
                ));
            }
            renderer_state = 'ready';
            renderer_error = undefined;
            renderer_retryable = false;
            return;
        }
        if (
            message.type !== 'pendingEditsFlush'
            && message.type !== 'pendingEditsFlushFailed'
        ) return;
        const waiter = flush_waiters.get(message.requestId);
        if (!waiter || waiter.rendererGeneration !== renderer_generation) return;
        flush_waiters.delete(message.requestId);
        waiter.cancelDeadline();
        if (message.type === 'pendingEditsFlushFailed') {
            waiter.reject(new Error('Viewer renderer could not flush pending edits.'));
            return;
        }
        const sequence = message.highestProducedSequence;
        if (
            !Number.isSafeInteger(sequence)
            || sequence < 0
            || (sequence > 0 && typeof message.editSessionId !== 'string')
        ) {
            waiter.reject(new Error('Viewer renderer returned a malformed pending-edit flush.'));
            return;
        }
        waiter.resolve({
            editSessionId: message.editSessionId,
            sequence,
            rendererGeneration: waiter.rendererGeneration,
        });
    });
    unsubscribers.add(stop_lifecycle);
    unsubscribers.add(transport.on_renderer_generation_changed((error) => {
        if (disposed) return;
        // A successful navigation replaces the page just as surely as a crash.
        // Reject requests owned by the old page, then wait for the new page's
        // ready message before starting another renderer protocol.
        renderer_state = 'loading';
        renderer_error = undefined;
        renderer_retryable = false;
        replace_renderer_generation(error);
    }));
    unsubscribers.add(transport.on_renderer_unavailable((error, retryable) => {
        if (disposed) return;
        renderer_state = 'unavailable';
        renderer_error = error;
        renderer_retryable = retryable;
        reject_protocol_waiters(error);
    }));
    unsubscribers.add(transport.on_renderer_responsive(() => {
        if (disposed || renderer_state !== 'unavailable' || !renderer_retryable) return;
        // Electron's responsive event revives the same page. Failed waiters stay
        // rejected, but a user retry starts a fresh flush in the same generation.
        renderer_state = 'ready';
        renderer_error = undefined;
        renderer_retryable = false;
    }));
    unsubscribers.add(transport.on_pending_edit_ack_receipt((receipt) => {
        const expected = pending_ack_receipts.get(receipt.receiptId);
        if (
            disposed
            || !expected
            || expected.rendererGeneration !== receipt.rendererGeneration
            || expected.editSessionId !== receipt.editSessionId
            || expected.sequence !== receipt.sequence
            || receipt.rendererGeneration !== renderer_generation
            || !Number.isSafeInteger(receipt.sequence)
        ) return;
        pending_ack_receipts.delete(receipt.receiptId);
        highest_acknowledged.set(
            receipt.editSessionId,
            Math.max(highest_acknowledged.get(receipt.editSessionId) ?? 0, receipt.sequence),
        );
        resolve_acknowledgement_waiters();
    }));

    return {
        webview: {
            postMessage(message: unknown): boolean {
                if (disposed) return false;
                const host_message = message as HostMessage;
                const receipt = host_message.type === 'pendingEditsAcknowledged'
                    ? {
                        receiptId: `desktop-ack:${++next_receipt_request}`,
                        rendererGeneration: renderer_generation,
                        editSessionId: host_message.editSessionId,
                        sequence: host_message.sequence,
                    }
                    : undefined;
                if (receipt) pending_ack_receipts.set(receipt.receiptId, receipt);
                const sent = transport.send(host_message, renderer_generation, receipt);
                if (!sent && receipt) pending_ack_receipts.delete(receipt.receiptId);
                return sent;
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
        flush_pending_edits() {
            if (disposed) return Promise.reject(new Error('Viewer panel is disposed.'));
            // No renderer code has run yet, so it cannot have produced an edit.
            // This makes an immediate close safe without waiting for a readiness
            // message that will never arrive once the navigation is torn down.
            if (renderer_state === 'loading') {
                return Promise.resolve({
                    sequence: 0,
                    rendererGeneration: renderer_generation,
                });
            }
            if (renderer_state === 'unavailable') {
                return Promise.reject(renderer_error ?? new Error('Viewer renderer is unavailable.'));
            }
            const request_id = `desktop-close:${++next_flush_request}`;
            return new Promise<PendingEditFlush>((resolve, reject) => {
                const waiter = {
                    rendererGeneration: renderer_generation,
                    resolve,
                    reject,
                    cancelDeadline: () => {},
                };
                flush_waiters.set(request_id, waiter);
                waiter.cancelDeadline = schedule_deadline(() => {
                    if (flush_waiters.get(request_id) !== waiter) return;
                    flush_waiters.delete(request_id);
                    waiter.reject(new Error('Timed out waiting for the viewer renderer to flush pending edits.'));
                }, VIEWER_PROTOCOL_DEADLINE_MS);
                if (
                    flush_waiters.get(request_id) === waiter
                    && !transport.send({
                        type: 'requestPendingEditsFlush',
                        requestId: request_id,
                    }, renderer_generation)
                ) {
                    const error = new Error('Viewer renderer transport is unavailable.');
                    renderer_state = 'unavailable';
                    renderer_error = error;
                    reject_protocol_waiters(error);
                }
            });
        },
        wait_for_pending_edit_ack(rendererGeneration, editSessionId, sequence) {
            if (disposed) return Promise.reject(new Error('Viewer panel is disposed.'));
            if (rendererGeneration !== renderer_generation) {
                return Promise.reject(new Error(
                    'Viewer renderer generation changed before edit acknowledgement.',
                ));
            }
            if (!Number.isSafeInteger(sequence) || sequence < 0) {
                return Promise.reject(new Error('Viewer renderer returned an invalid pending-edit sequence.'));
            }
            if (sequence === 0) return Promise.resolve();
            if (typeof editSessionId !== 'string') {
                return Promise.reject(new Error(
                    'Viewer renderer returned a positive pending-edit sequence without a session.',
                ));
            }
            if ((highest_acknowledged.get(editSessionId) ?? 0) >= sequence) {
                return Promise.resolve();
            }
            if (renderer_state === 'unavailable') {
                return Promise.reject(renderer_error ?? new Error('Viewer renderer is unavailable.'));
            }
            return new Promise<void>((resolve, reject) => {
                const waiter = {
                    rendererGeneration,
                    editSessionId,
                    sequence,
                    resolve,
                    reject,
                    cancelDeadline: () => {},
                };
                acknowledgement_waiters.add(waiter);
                waiter.cancelDeadline = schedule_deadline(() => {
                    if (!acknowledgement_waiters.delete(waiter)) return;
                    for (const [receiptId, receipt] of pending_ack_receipts) {
                        if (
                            receipt.rendererGeneration === rendererGeneration
                            && receipt.editSessionId === editSessionId
                            && receipt.sequence === sequence
                        ) pending_ack_receipts.delete(receiptId);
                    }
                    waiter.reject(new Error(
                        'Timed out waiting for the viewer renderer to receive the pending-edit acknowledgement.',
                    ));
                }, VIEWER_PROTOCOL_DEADLINE_MS);
            });
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            reject_protocol_waiters(new Error(
                'Viewer panel was disposed before the close protocol completed.',
            ));
            pending_ack_receipts.clear();
            for (const unsubscribe of [...unsubscribers]) unsubscribe();
            unsubscribers.clear();
        },
    };
}
