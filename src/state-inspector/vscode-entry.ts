/**
 * Webview bootstrap for the VS Code side of the inspector.
 *
 * The desktop reaches its host through a preload and `ipcRenderer.invoke`, which
 * gives request/response for free. A webview has only `postMessage`, so this
 * correlates replies by id and hands the shared UI the same one-call-one-reply
 * port the desktop hands it.
 */
import { mount_state_inspector } from './ui';
import type { StateInspectorRequest, StateInspectorResponse } from './protocol';

interface VsCodeApi {
    postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();
const pending = new Map<number, (response: StateInspectorResponse) => void>();
let nextRequestId = 0;

window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { id?: unknown; response?: StateInspectorResponse } | null;
    if (!data || typeof data.id !== 'number' || !data.response) return;
    const resolve = pending.get(data.id);
    if (typeof resolve !== 'function') return;
    pending.delete(data.id);
    resolve(data.response);
});

/**
 * How long to wait for the extension host before giving up on a reply.
 *
 * `ipcRenderer.invoke` rejects when its handler is gone; `postMessage` just
 * goes quiet, so without a deadline a crashed or disposed host would leave the
 * UI waiting forever with no error. Generous because a trim ends in VACUUM,
 * which rewrites the whole database file.
 */
const REPLY_TIMEOUT_MS = 60_000;

function send(request: StateInspectorRequest): Promise<StateInspectorResponse> {
    const id = nextRequestId++;
    return new Promise((resolve) => {
        const deadline = setTimeout(() => {
            if (!pending.delete(id)) return;
            resolve({
                kind: 'error',
                message: 'The editor did not respond. Close and reopen the inspector to try again.',
            });
        }, REPLY_TIMEOUT_MS);
        pending.set(id, (response) => {
            clearTimeout(deadline);
            resolve(response);
        });
        vscodeApi.postMessage({ id, request });
    });
}

mount_state_inspector(document.getElementById('root')!, { send });
