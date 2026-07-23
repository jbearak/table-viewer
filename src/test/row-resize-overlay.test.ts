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
    const on_resize = vi.fn();
    const ref = React.createRef<RowResizeOverlayHandle>();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(RowResizeOverlay, {
        ref,
        on_resize,
    })));
    // Arm a target so the grab strip renders.
    act(() => ref.current!.set_target({ row: 2, boundary_y: 100, height: 24 }));
    return { on_resize };
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
        const { on_resize } = render_overlay();
        act(() => strip().dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, button: 0, clientY: 100,
        })));
        act(() => document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, clientY: 130,
        })));
        expect(on_resize).toHaveBeenCalled();
        expect(on_resize.mock.calls[0][0]).toBe(2);
    });
});
