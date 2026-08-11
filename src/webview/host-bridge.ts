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

export interface PendingEditDurabilitySnapshot {
    readonly highestProducedSequence: number;
    readonly highestAcknowledgedSequence: number;
}

interface PendingEditSessionChannel {
    nextSequence: number;
    highestAcknowledgedSequence: number;
    // Dedupe per sheet: two sheets with byte-identical maps are distinct
    // slots' content and must not suppress each other's posts.
    lastPayloadBySheet: Map<number, string>;
    listeners: Set<(snapshot: PendingEditDurabilitySnapshot) => void>;
}

const pending_edit_channels = new Map<string, PendingEditSessionChannel>();

function pending_edit_channel(session_id: string): PendingEditSessionChannel {
    let channel = pending_edit_channels.get(session_id);
    if (!channel) {
        channel = {
            nextSequence: 1,
            highestAcknowledgedSequence: 0,
            lastPayloadBySheet: new Map(),
            listeners: new Set(),
        };
        pending_edit_channels.set(session_id, channel);
    }
    return channel;
}

function notify_pending_edit_channel(channel: PendingEditSessionChannel): void {
    const snapshot = {
        highestProducedSequence: channel.nextSequence - 1,
        highestAcknowledgedSequence: channel.highestAcknowledgedSequence,
    } as const;
    for (const listener of channel.listeners) listener(snapshot);
}

/** Webview-lifetime sequence owner, so GridShell remounts cannot reuse a sequence. */
export interface PendingEditFlushResult {
    readonly editSessionId?: string;
    readonly highestProducedSequence: number;
}

type PendingEditFlushResponder = () => PendingEditFlushResult | Promise<PendingEditFlushResult>;

let pending_edit_flush_responder: PendingEditFlushResponder = () => ({
    highestProducedSequence: 0,
});

/**
 * Installs the document-lifetime close/reload responder. The module-level default
 * answers sequence zero before App has an edit session, so a host that closes
 * immediately after `ready` can never wait on a GridShell that did not mount.
 */
export function install_pending_edit_flush_responder(
    responder: PendingEditFlushResponder,
): () => void {
    pending_edit_flush_responder = responder;
    return () => {
        if (pending_edit_flush_responder === responder) {
            pending_edit_flush_responder = () => ({ highestProducedSequence: 0 });
        }
    };
}

export const pending_edit_durability = {
    publish(
        editSessionId: string,
        edits: Record<string, { value: string; base: string }> | null,
        sheetIndex: number,
        sheetName: string | undefined,
        force = false,
    ): number {
        const channel = pending_edit_channel(editSessionId);
        const payload = JSON.stringify(edits);
        if (!force && channel.lastPayloadBySheet.get(sheetIndex) === payload) {
            return channel.nextSequence - 1;
        }
        const sequence = channel.nextSequence++;
        channel.lastPayloadBySheet.set(sheetIndex, payload);
        host_bridge.postMessage({
            type: 'pendingEditsChanged',
            editSessionId,
            edits,
            sequence,
            sheetIndex,
            ...(sheetName !== undefined ? { sheetName } : {}),
        });
        notify_pending_edit_channel(channel);
        return sequence;
    },
    snapshot(editSessionId: string): PendingEditDurabilitySnapshot {
        const channel = pending_edit_channel(editSessionId);
        return {
            highestProducedSequence: channel.nextSequence - 1,
            highestAcknowledgedSequence: channel.highestAcknowledgedSequence,
        };
    },
    subscribe(
        editSessionId: string,
        listener: (snapshot: PendingEditDurabilitySnapshot) => void,
    ): () => void {
        const channel = pending_edit_channel(editSessionId);
        channel.listeners.add(listener);
        listener(this.snapshot(editSessionId));
        return () => channel.listeners.delete(listener);
    },
    acknowledge(editSessionId: string, sequence: number): void {
        const channel = pending_edit_channels.get(editSessionId);
        if (!channel || sequence > channel.nextSequence - 1) return;
        channel.highestAcknowledgedSequence = Math.max(
            channel.highestAcknowledgedSequence,
            sequence,
        );
        notify_pending_edit_channel(channel);
    },
    retire(editSessionId: string): void {
        pending_edit_channels.delete(editSessionId);
    },
};

type PendingEditMessageGlobal = typeof globalThis & {
    __tableViewerPendingEditMessageDispatch?: (event: MessageEvent) => void;
    __tableViewerPendingEditMessageListenerWindow?: Window;
};

const pending_edit_message_global = globalThis as PendingEditMessageGlobal;
pending_edit_message_global.__tableViewerPendingEditMessageDispatch = (event: MessageEvent) => {
    const message = event.data;
    if (
        message?.type === 'requestPendingEditsFlush'
        && typeof message.requestId === 'string'
    ) {
        const request_id = message.requestId;
        // Start the responder in a promise callback so both a synchronous throw
        // and an asynchronous rejection produce the same explicit, correlated
        // failure response. The reason stays inside the renderer: the host only
        // needs to know that the durability boundary was not established.
        void Promise.resolve()
            .then(() => pending_edit_flush_responder())
            .then(
                (result) => host_bridge.postMessage({
                    type: 'pendingEditsFlush',
                    requestId: request_id,
                    editSessionId: result.editSessionId,
                    highestProducedSequence: result.highestProducedSequence,
                }),
                () => host_bridge.postMessage({
                    type: 'pendingEditsFlushFailed',
                    requestId: request_id,
                }),
            )
            // A failed host transport cannot be reported over that same
            // transport, but must not become an unhandled renderer rejection.
            .catch(() => {});
        return;
    }
    if (
        message?.type !== 'pendingEditsAcknowledged'
        || typeof message.editSessionId !== 'string'
        || !Number.isSafeInteger(message.sequence)
    ) return;
    pending_edit_durability.acknowledge(message.editSessionId, message.sequence);
};

if (typeof window !== 'undefined'
    && pending_edit_message_global.__tableViewerPendingEditMessageListenerWindow !== window) {
    window.addEventListener('message', (event: MessageEvent) => {
        pending_edit_message_global.__tableViewerPendingEditMessageDispatch?.(event);
    });
    pending_edit_message_global.__tableViewerPendingEditMessageListenerWindow = window;
}
