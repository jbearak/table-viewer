// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu } from '../webview/context-menu';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
});

function render_menu(items: React.ComponentProps<typeof ContextMenu>['items']) {
    const on_dismiss = vi.fn();
    const restore_focus = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(ContextMenu, {
        x: 10,
        y: 10,
        items,
        on_dismiss,
        restore_focus,
    })));
    return { on_dismiss, restore_focus };
}

describe('ContextMenu keyboard behavior', () => {
    it('focuses the first enabled item and navigates enabled items with arrows/Home/End', () => {
        render_menu([
            { label: 'Disabled', disabled: true, on_click: vi.fn() },
            { label: 'First', on_click: vi.fn() },
            { kind: 'separator' },
            { label: 'Last', on_click: vi.fn() },
        ]);
        expect(document.activeElement?.textContent).toContain('First');
        act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown', bubbles: true,
        })));
        expect(document.activeElement?.textContent).toContain('Last');
        act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown', bubbles: true,
        })));
        expect(document.activeElement?.textContent).toContain('First');
        act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'End', bubbles: true,
        })));
        expect(document.activeElement?.textContent).toContain('Last');
        act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Home', bubbles: true,
        })));
        expect(document.activeElement?.textContent).toContain('First');
    });

    it('renders checked items, separators, and textual shortcuts', () => {
        render_menu([
            { label: 'Sort ascending', checked: true, shortcut: 'Shift+Alt+A', on_click: vi.fn() },
            { kind: 'separator' },
            { label: 'Clear', on_click: vi.fn() },
        ]);
        const checked = document.querySelector('[role="menuitemcheckbox"]');
        expect(checked?.getAttribute('aria-checked')).toBe('true');
        expect(document.body.textContent).toContain('Shift+Alt+A');
        expect(document.querySelector('[role="separator"]')).not.toBeNull();
    });

    it('dismisses on Escape and restores focus', () => {
        vi.useFakeTimers();
        const { on_dismiss, restore_focus } = render_menu([
            { label: 'Copy', on_click: vi.fn() },
        ]);
        act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true,
        })));
        expect(on_dismiss).toHaveBeenCalledOnce();
        act(() => vi.runAllTimers());
        expect(restore_focus).toHaveBeenCalledOnce();
    });
});
