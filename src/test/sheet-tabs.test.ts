// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SheetTabs } from '../webview/sheet-tabs';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
});

function render_tabs(vertical: boolean) {
    const on_select = vi.fn();
    const on_context_menu = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(SheetTabs, {
        sheets: ['One', 'Two', 'Three'],
        active_sheet_index: 0,
        on_select,
        on_context_menu,
        vertical,
    })));
    return { on_select, on_context_menu };
}

function tabs(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll('.sheet-tab'));
}

describe('SheetTabs', () => {
    it('ordinary click selects the tab', () => {
        const { on_select, on_context_menu } = render_tabs(false);
        act(() => tabs()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(on_select).toHaveBeenCalledWith(1);
        expect(on_context_menu).not.toHaveBeenCalled();
    });

    it('right-click suppresses the native menu and reports coordinates', () => {
        const { on_select, on_context_menu } = render_tabs(false);
        const event = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 42,
            clientY: 84,
        });
        act(() => tabs()[2].dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
        expect(on_context_menu).toHaveBeenCalledWith(2, 42, 84);
        expect(on_select).not.toHaveBeenCalled();
    });

    it('wires the same context-menu behavior for vertical tabs', () => {
        const { on_context_menu } = render_tabs(true);
        const event = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 5,
            clientY: 6,
        });
        act(() => tabs()[0].dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
        expect(on_context_menu).toHaveBeenCalledWith(0, 5, 6);
    });
});
