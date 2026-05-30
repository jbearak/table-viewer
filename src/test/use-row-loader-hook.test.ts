// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_SIZE } from '../webview/grid-model';
import type { HostMessage } from '../types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let hook_result: Awaited<ReturnType<typeof load_hook>>['result'] | null = null;

async function load_hook() {
    vi.stubGlobal('acquireVsCodeApi', () => ({
        postMessage: vi.fn(),
        getState: vi.fn(),
        setState: vi.fn(),
    }));
    const { use_row_loader } = await import('../webview/use-row-loader');
    return { use_row_loader, result: null as ReturnType<typeof use_row_loader> | null };
}

function row_data(startRow: number, generation: number): HostMessage {
    return {
        type: 'rowData',
        sheetIndex: 0,
        startRow,
        rows: Array.from({ length: PAGE_SIZE }, () => []),
        requestId: 'x',
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

        const first = hook_result!;
        first.ensure_rows(500, 540);

        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', { data: row_data(500, 1) }));
        });

        expect(hook_result!.version).toBeGreaterThan(first.version);
        expect(hook_result!.ensure_rows).toBe(first.ensure_rows);
        expect(hook_result!.get_row).toBe(first.get_row);
        expect(hook_result!.sample_loaded_rows).toBe(first.sample_loaded_rows);
    });
});
