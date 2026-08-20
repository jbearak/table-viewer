// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { use_compare_loader } from '../webview/use-compare-loader';
import type { HostMessage } from '../types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let hook_result: ReturnType<typeof use_compare_loader> | null = null;

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    hook_result = null;
});

function compare_diff(overrides: Partial<Extract<HostMessage, { type: 'compareDiff' }>> = {}) {
    return {
        type: 'compareDiff' as const,
        sheetIndex: 0,
        startRow: 0,
        rowStatus: ['same', 'added'] as ('same' | 'added' | 'deleted')[],
        changedCells: [{ row: 0, col: 1, base: 'before' }],
        requestId: 'r1',
        generation: 1,
        ...overrides,
    };
}

async function render_hook(sheet_index: number, generation: number, enabled: boolean) {
    function Harness() {
        hook_result = use_compare_loader(sheet_index, generation, enabled);
        return null;
    }
    if (root === null) {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    }
    await act(async () => {
        root!.render(React.createElement(Harness));
    });
}

async function post(msg: HostMessage) {
    await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data: msg }));
    });
}

describe('use_compare_loader', () => {
    it('ingests compareDiff messages and bumps version for repaints', async () => {
        await render_hook(0, 1, true);
        expect(hook_result!.version).toBe(0);
        await post(compare_diff());
        expect(hook_result!.version).toBe(1);
        expect(hook_result!.get_status(1)).toBe('added');
        expect(hook_result!.get_base(0, 1)).toBe('before');
    });

    it('drops pages for another generation', async () => {
        await render_hook(0, 2, true);
        await post(compare_diff({ generation: 1 }));
        expect(hook_result!.version).toBe(0);
        expect(hook_result!.get_status(1)).toBeUndefined();
    });

    it('is inert when disabled', async () => {
        await render_hook(0, 1, false);
        await post(compare_diff());
        expect(hook_result!.version).toBe(0);
        expect(hook_result!.get_status(1)).toBeUndefined();
        expect(hook_result!.get_base(0, 1)).toBeUndefined();
    });

    it('clears stored pages on a sheet switch', async () => {
        await render_hook(0, 1, true);
        await post(compare_diff());
        await render_hook(1, 1, true);
        expect(hook_result!.get_status(1)).toBeUndefined();
    });
});
