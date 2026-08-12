// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SheetTabs } from '../webview/sheet-tabs';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

function cleanup_render() {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
}

afterEach(() => {
    cleanup_render();
    vi.restoreAllMocks();
});

function render_tabs(vertical: boolean, sheets = ['One', 'Two', 'Three']) {
    const on_select = vi.fn();
    const on_context_menu = vi.fn();
    const on_strip_context_menu = vi.fn();
    const on_toggle_orientation = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(SheetTabs, {
        sheets,
        active_sheet_index: 0,
        on_select,
        on_context_menu,
        on_strip_context_menu,
        on_toggle_orientation,
        vertical,
    })));
    return { on_select, on_context_menu, on_strip_context_menu, on_toggle_orientation };
}

function tabs(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll('.sheet-tab'));
}

function orientation_button(): HTMLButtonElement | null {
    return document.querySelector('.sheet-tabs-orientation');
}

function strip(): HTMLElement {
    const node = document.querySelector<HTMLElement>(
        '.sheet-tabs-horizontal, .sheet-tabs-vertical',
    );
    expect(node).not.toBeNull();
    return node!;
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

    it('toggles orientation from a control on the strip itself', () => {
        const { on_toggle_orientation, on_select } = render_tabs(false);
        act(() => orientation_button()!.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        ));
        expect(on_toggle_orientation).toHaveBeenCalledOnce();
        expect(on_select).not.toHaveBeenCalled();
    });

    it('names the destination rather than the current state', () => {
        // "Move sheet tabs to the left" says what pressing it does; a state name like
        // "Vertical tabs" leaves a screen-reader user to infer whether it is a toggle
        // or an action, and which way it currently sits.
        render_tabs(false);
        expect(orientation_button()?.getAttribute('aria-label'))
            .toBe('Move sheet tabs to the left of the table');
        cleanup_render();

        render_tabs(true);
        expect(orientation_button()?.getAttribute('aria-label'))
            .toBe('Move sheet tabs above the table');
        // The rail has width to spare, so the label is shown as well as announced.
        expect(orientation_button()?.textContent).toContain('Tabs on top');
    });

    it('is absent whenever the tabs are, so it is never a dead control', () => {
        // Same condition as the strip itself: one sheet has no tabs to reorient.
        render_tabs(false, ['Only']);
        expect(tabs()).toHaveLength(0);
        expect(orientation_button()).toBeNull();
    });

    it('offers sheet actions for a right-click on empty strip space', () => {
        const { on_strip_context_menu, on_context_menu } = render_tabs(false);
        const event = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 300,
            clientY: 12,
        });
        act(() => strip().dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
        expect(on_strip_context_menu).toHaveBeenCalledWith(300, 12);
        // A click on the background names no sheet, so the per-sheet handler stays out.
        expect(on_context_menu).not.toHaveBeenCalled();
    });

    it('does not treat a right-click on a tab as one on the strip', () => {
        const { on_strip_context_menu, on_context_menu } = render_tabs(false);
        act(() => tabs()[1].dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 9,
            clientY: 9,
        })));
        expect(on_context_menu).toHaveBeenCalledWith(1, 9, 9);
        expect(on_strip_context_menu).not.toHaveBeenCalled();
    });
});
