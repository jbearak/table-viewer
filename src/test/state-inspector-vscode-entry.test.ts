// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateInspectorResponse } from '../state-inspector/protocol';

/**
 * The webview bootstrap runs on import: it acquires the VS Code API and mounts
 * the inspector, which immediately sends the first 'inspect' request. Each test
 * therefore stubs the webview globals, imports a fresh copy of the module, and
 * drives it through window message events — the only channel a real host has.
 */

let posted: Array<{ id: number }>;

async function import_entry(): Promise<void> {
    posted = [];
    (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
        postMessage: (message: unknown) => posted.push(message as { id: number }),
    });
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    await import('../state-inspector/vscode-entry');
}

function reply(id: number, response: StateInspectorResponse): void {
    window.dispatchEvent(new MessageEvent('message', { data: { id, response } }));
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    document.body.innerHTML = '';
});

afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
});

describe('the VS Code transport', () => {
    it('hands a correlated reply to the UI', async () => {
        await import_entry();
        expect(posted).toHaveLength(1);

        reply(posted[0].id, {
            kind: 'inventory',
            inventory: {
                entries: [{
                    path: '/files/plain.csv',
                    sizeBytes: 400,
                    hasPendingEdits: false,
                    isProtected: false,
                    openHere: false,
                }],
                totalEntryCount: 1,
                databaseSizeBytes: 2048,
                databasePath: '/state/file-state.sqlite3',
            },
        });
        await vi.waitFor(() => {
            expect(document.body.textContent).toContain('/files/plain.csv');
        });
    });

    it('settles an unanswered request as an error instead of hanging forever', async () => {
        await import_entry();
        expect(posted).toHaveLength(1);

        // The host never replies — a crashed handler or a disposed panel. The
        // deadline must surface an error the UI renders, not a silent hang.
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(() => {
            expect(document.body.textContent).toContain('The editor did not respond');
        });
    });

    it('ignores a reply that arrives after the deadline already answered', async () => {
        await import_entry();
        const id = posted[0].id;
        await vi.advanceTimersByTimeAsync(60_000);

        // A straggler for a request the deadline already settled must not blow
        // up or resurrect the abandoned promise.
        expect(() => reply(id, { kind: 'error', message: 'late' })).not.toThrow();
        expect(document.body.textContent).not.toContain('late');
    });
});
