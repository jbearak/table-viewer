// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    RowResizeOverlay,
    type RowResizeOverlayHandle,
} from '../webview/row-resize-overlay';

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

function render_overlay() {
    const on_resize_start = vi.fn();
    const on_resize = vi.fn();
    const on_resize_end = vi.fn();
    const ref = React.createRef<RowResizeOverlayHandle>();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(RowResizeOverlay, {
        ref,
        on_resize_start,
        on_resize,
        on_resize_end,
    })));
    // Arm a target so the grab strip renders.
    act(() => ref.current!.set_target({ row: 2, boundary_y: 100, height: 24 }));
    return { ref, on_resize_start, on_resize, on_resize_end };
}

function strip(): HTMLElement {
    return document.querySelector('.row-resize-strip') as HTMLElement;
}

describe('RowResizeOverlay right-click handling', () => {
    it('does not arm a resize on a non-primary mousedown', () => {
        const { on_resize } = render_overlay();
        act(() => strip().dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, button: 2,
        })));
        act(() => document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, clientY: 300,
        })));
        act(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
        expect(on_resize).not.toHaveBeenCalled();
    });

    it('suppresses the native context menu on the strip', () => {
        render_overlay();
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        act(() => strip().dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
    });

    it('still resizes on a primary-button drag', () => {
        const { on_resize_start, on_resize, on_resize_end } = render_overlay();
        act(() => strip().dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, button: 0, clientY: 100,
        })));
        act(() => document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, buttons: 1, clientY: 130,
        })));
        expect(on_resize).toHaveBeenCalled();
        expect(on_resize.mock.calls[0][0]).toBe(2);
        expect(on_resize_start).toHaveBeenCalledWith(2, 24);
        act(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
        expect(on_resize_end).toHaveBeenCalledWith(2, 54);
    });

    it('does not emit duplicate live updates for unchanged heights', () => {
        const { on_resize, on_resize_end } = render_overlay();
        act(() => strip().dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, button: 0, clientY: 100,
        })));
        act(() => document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, buttons: 1, clientY: 130,
        })));
        act(() => document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, buttons: 1, clientY: 130,
        })));
        expect(on_resize).toHaveBeenCalledOnce();
        act(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
        expect(on_resize_end).toHaveBeenCalledWith(2, 54);
    });

    it('finishes the drag when the window loses focus', () => {
        const { on_resize_end } = render_overlay();
        act(() => strip().dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, button: 0, clientY: 100,
        })));
        act(() => document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, buttons: 1, clientY: 120,
        })));
        act(() => window.dispatchEvent(new Event('blur')));
        expect(on_resize_end).toHaveBeenCalledOnce();
        expect(on_resize_end).toHaveBeenCalledWith(2, 44);
        act(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
        expect(on_resize_end).toHaveBeenCalledOnce();
    });

    it('uses updated callbacks without interrupting an active drag', () => {
        const first = render_overlay();
        act(() => strip().dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, button: 0, clientY: 100,
        })));
        act(() => document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, buttons: 1, clientY: 110,
        })));

        const next_resize = vi.fn();
        const next_end = vi.fn();
        act(() => root!.render(React.createElement(RowResizeOverlay, {
            ref: first.ref,
            on_resize: next_resize,
            on_resize_end: next_end,
        })));
        expect(first.on_resize_end).not.toHaveBeenCalled();
        act(() => document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, buttons: 1, clientY: 120,
        })));
        expect(next_resize).toHaveBeenCalledWith(2, 44);
        act(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
        expect(next_end).toHaveBeenCalledWith(2, 44);
        expect(first.on_resize_end).not.toHaveBeenCalled();
    });
});
