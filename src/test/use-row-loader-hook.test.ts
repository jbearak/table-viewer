// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_SIZE } from '../webview/grid-model';
import type { HostMessage, WebviewMessage } from '../types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let hook_result: Awaited<ReturnType<typeof load_hook>>['result'] | null = null;

async function load_hook() {
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({
        postMessage,
        getState: vi.fn(),
        setState: vi.fn(),
    }));
    const { use_row_loader } = await import('../webview/use-row-loader');
    return {
        use_row_loader,
        postMessage,
        result: null as ReturnType<typeof use_row_loader> | null,
    };
}

function row_data(
    startRow: number,
    generation: number,
    requestId: string,
    sourceRows = Array.from({ length: PAGE_SIZE }, (_, i) => startRow + i),
): HostMessage {
    return {
        type: 'rowData',
        sheetIndex: 0,
        startRow,
        rows: Array.from({ length: PAGE_SIZE }, () => []),
        sourceRows,
        requestId,
        generation,
    };
}

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    hook_result = null;
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('use_row_loader', () => {
    it('keeps row access callback identities stable across page-load re-renders', async () => {
        const { use_row_loader, postMessage } = await load_hook();

        function Harness() {
            hook_result = use_row_loader(0, 10_000, 1);
            return null;
        }

        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root!.render(React.createElement(Harness));
        });

        const first = hook_result!;
        first.ensure_rows(500, 540);
        const request = postMessage.mock.calls.at(-1)?.[0] as
            | Extract<WebviewMessage, { type: 'requestRows' }>
            | undefined;
        expect(request?.type).toBe('requestRows');

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', {
                data: row_data(500, 1, request!.requestId),
            }));
        });

        expect(hook_result!.version).toBeGreaterThan(first.version);
        expect(hook_result!.get_source_row(500)).toBe(500);
        expect(hook_result!.ensure_rows).toBe(first.ensure_rows);
        expect(hook_result!.get_row).toBe(first.get_row);
        expect(hook_result!.get_source_row).toBe(first.get_source_row);
        expect(hook_result!.sample_loaded_rows).toBe(first.sample_loaded_rows);
    });

    it('settles a pending bulk load to false when the hook unmounts', async () => {
        const { use_row_loader } = await load_hook();

        function Harness() {
            hook_result = use_row_loader(0, 10_000, 1);
            return null;
        }

        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(React.createElement(Harness));
        });

        // A whole-sheet copy load is in flight (pages still requested from host).
        const load = hook_result!.ensure_rows_loaded(0, 500);
        let resolved: boolean | null = null;
        void load.then((v) => { resolved = v; });

        // The keyed GridShell unmounts on a sheet switch/reload before the rows
        // arrive; the load must settle (false) rather than dangle forever.
        await act(async () => {
            root!.unmount();
        });
        root = null;
        await load;
        expect(resolved).toBe(false);
    });

    it('ignores malformed messages and keeps a mismatched sourceRows request pending', async () => {
        const { use_row_loader, postMessage } = await load_hook();

        function Harness() {
            hook_result = use_row_loader(0, 10_000, 1);
            return null;
        }

        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        await act(async () => {
            root!.render(React.createElement(Harness));
        });

        hook_result!.ensure_rows(500, 540);
        const request = postMessage.mock.calls.at(-1)?.[0] as
            Extract<WebviewMessage, { type: 'requestRows' }>;
        const initial_version = hook_result!.version;

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: null }));
            window.dispatchEvent(new MessageEvent('message', { data: 'not a message' }));
            window.dispatchEvent(new MessageEvent('message', {
                data: row_data(500, 1, request.requestId, [500]),
            }));
        });

        expect(hook_result!.version).toBe(initial_version);
        expect(hook_result!.get_row(500)).toBeUndefined();
        expect(hook_result!.get_source_row(500)).toBeUndefined();

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', {
                data: row_data(500, 1, request.requestId),
            }));
        });

        expect(hook_result!.version).toBeGreaterThan(initial_version);
        expect(hook_result!.get_row(500)).toEqual([]);
        expect(hook_result!.get_source_row(500)).toBe(500);
    });
});
