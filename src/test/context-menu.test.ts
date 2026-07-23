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

    it('clamps the rendered position through component state', () => {
        const original_width = window.innerWidth;
        const original_height = window.innerHeight;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 30 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 20 });
        const get_bounding_client_rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockReturnValue({ width: 40, height: 30 } as DOMRect);

        render_menu([{ label: 'Copy', on_click: vi.fn() }]);

        const menu = document.querySelector<HTMLElement>('.context-menu')!;
        expect(menu.style.left).toBe('4px');
        expect(menu.style.top).toBe('4px');

        get_bounding_client_rect.mockRestore();
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: original_width });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: original_height });
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

    it('uses roving tabIndex and dismisses on Tab without restoring focus', () => {
        const { on_dismiss, restore_focus } = render_menu([
            { label: 'First', on_click: vi.fn() },
            { label: 'Disabled', disabled: true, on_click: vi.fn() },
            { label: 'Last', on_click: vi.fn() },
        ]);
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'));
        expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);
        act(() => buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
        expect(buttons.map((button) => button.tabIndex)).toEqual([-1, -1, 0]);
        act(() => buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
        expect(on_dismiss).toHaveBeenCalledOnce();
        expect(restore_focus).not.toHaveBeenCalled();
    });

    it('ignores menu-internal scroll and outside dismissal does not restore focus', () => {
        vi.useFakeTimers();
        const { on_dismiss, restore_focus } = render_menu([
            { label: 'Copy', on_click: vi.fn() },
        ]);
        act(() => vi.runOnlyPendingTimers());
        const menu = document.querySelector('.context-menu')!;
        act(() => menu.dispatchEvent(new Event('scroll', { bubbles: true })));
        expect(on_dismiss).not.toHaveBeenCalled();
        act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
        expect(on_dismiss).toHaveBeenCalledOnce();
        act(() => vi.runAllTimers());
        expect(restore_focus).not.toHaveBeenCalled();
    });

    it('opens a submenu with ArrowRight and closes only it with ArrowLeft', () => {
        vi.useFakeTimers();
        const { on_dismiss } = render_menu([
            {
                kind: 'submenu',
                label: 'Hide',
                items: [{ label: 'Hide row', on_click: vi.fn() }],
            },
        ]);
        const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight', bubbles: true,
        })));
        act(() => vi.runAllTimers());
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement?.textContent).toContain('Hide row');
        act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowLeft', bubbles: true,
        })));
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);
        expect(on_dismiss).not.toHaveBeenCalled();
    });

    it('opens on hover and closes when hovering a sibling action', () => {
        render_menu([
            {
                kind: 'submenu',
                label: 'Select',
                items: [{ label: 'Select row', on_click: vi.fn() }],
            },
            { label: 'Copy', on_click: vi.fn() },
        ]);
        const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
        const copy = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            .find((button) => button.textContent === 'Copy')!;
        act(() => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        act(() => copy.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('activates a submenu leaf and dismisses/restores exactly once', () => {
        vi.useFakeTimers();
        const on_click = vi.fn();
        const { on_dismiss, restore_focus } = render_menu([
            {
                kind: 'submenu',
                label: 'Hide',
                items: [{ label: 'Hide row', on_click }],
            },
        ]);
        const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
        act(() => trigger.click());
        act(() => vi.runOnlyPendingTimers());
        const leaf = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            .find((button) => button.textContent === 'Hide row')!;
        act(() => leaf.click());
        expect(on_click).toHaveBeenCalledOnce();
        expect(on_dismiss).toHaveBeenCalledOnce();
        act(() => vi.runAllTimers());
        expect(restore_focus).toHaveBeenCalledOnce();
    });

    it('Escape from a child dismisses the whole menu and disabled submenus stay closed', () => {
        vi.useFakeTimers();
        const { on_dismiss, restore_focus } = render_menu([
            {
                kind: 'submenu',
                label: 'Hide',
                items: [{ label: 'Hide row', on_click: vi.fn() }],
            },
            {
                kind: 'submenu',
                label: 'Disabled',
                disabled: true,
                items: [{ label: 'Never', on_click: vi.fn() }],
            },
        ]);
        const triggers = document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]');
        act(() => triggers[1].click());
        expect(triggers[1].getAttribute('aria-expanded')).toBe('false');
        act(() => triggers[0].click());
        act(() => vi.runOnlyPendingTimers());
        act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true,
        })));
        expect(on_dismiss).toHaveBeenCalledOnce();
        act(() => vi.runAllTimers());
        expect(restore_focus).toHaveBeenCalledOnce();
    });

});
