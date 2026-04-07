// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toolbar } from '../webview/toolbar';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render_toolbar(props?: Partial<React.ComponentProps<typeof Toolbar>>) {
    const on_toggle_formatting = vi.fn();
    const on_toggle_tab_orientation = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const merged_props: React.ComponentProps<typeof Toolbar> = {
        show_formatting: true,
        on_toggle_formatting,
        show_formatting_button: true,
        vertical_tabs: false,
        on_toggle_tab_orientation,
        show_vertical_tabs_button: true,
        auto_fit_active: false,
        on_toggle_auto_fit: vi.fn(),
        edit_mode: false,
        is_dirty: false,
        on_toggle_edit_mode: vi.fn(),
        show_edit_button: false,
        ...props,
    };

    act(() => {
        root!.render(React.createElement(Toolbar, merged_props));
    });

    return {
        container,
        on_toggle_formatting,
        on_toggle_tab_orientation,
        rerender(next_props?: Partial<React.ComponentProps<typeof Toolbar>>) {
            act(() => {
                root!.render(React.createElement(Toolbar, {
                    ...merged_props,
                    ...next_props,
                }));
            });
        },
    };
}

function cleanup() {
    act(() => {
        root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
}

function dispatch_mouse_event(target: EventTarget, type: string) {
    act(() => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });
}

function get_button(label: string): HTMLButtonElement {
    const buttons = Array.from(document.querySelectorAll('button'));
    const button = buttons.find((candidate) => candidate.textContent === label);
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
}

function get_tooltip(): HTMLElement | null {
    return document.querySelector('[role="tooltip"]');
}

function make_rect({
    left = 0,
    top = 0,
    width = 0,
    height = 0,
}: {
    left?: number;
    top?: number;
    width?: number;
    height?: number;
}) {
    return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON() {
            return '';
        },
    } as DOMRect;
}

afterEach(() => {
    cleanup();
});

describe('Toolbar', () => {
    it('keeps the existing button labels and removes native title tooltips', () => {
        render_toolbar();

        const formatting = get_button('Formatting');
        const vertical_tabs = get_button('Vertical Tabs');

        expect(formatting.textContent).toBe('Formatting');
        expect(vertical_tabs.textContent).toBe('Vertical Tabs');
        expect(formatting.getAttribute('title')).toBeNull();
        expect(vertical_tabs.getAttribute('title')).toBeNull();
    });

    it('shows state-aware tooltip text on hover and hides it on mouseout', () => {
        render_toolbar({
            show_formatting: true,
            vertical_tabs: false,
        });

        const formatting = get_button('Formatting');
        dispatch_mouse_event(formatting, 'mouseover');
        expect(get_tooltip()?.textContent).toBe('Show raw cell values.');
        dispatch_mouse_event(formatting, 'mouseout');
        expect(get_tooltip()).toBeNull();

        const vertical_tabs = get_button('Vertical Tabs');
        dispatch_mouse_event(vertical_tabs, 'mouseover');
        expect(get_tooltip()?.textContent).toBe('Move sheet tabs to the left of the table.');
        dispatch_mouse_event(vertical_tabs, 'mouseout');
        expect(get_tooltip()).toBeNull();
    });

    it('shows state-aware tooltip text on focus and hides it on blur', () => {
        render_toolbar({
            show_formatting: false,
            vertical_tabs: true,
        });

        const formatting = get_button('Formatting');
        act(() => {
            formatting.focus();
        });
        expect(get_tooltip()?.textContent).toBe('Show formatted cell values.');
        act(() => {
            formatting.blur();
        });
        expect(get_tooltip()).toBeNull();

        const vertical_tabs = get_button('Vertical Tabs');
        act(() => {
            vertical_tabs.focus();
        });
        expect(get_tooltip()?.textContent).toBe('Move sheet tabs above the table.');
        act(() => {
            vertical_tabs.blur();
        });
        expect(get_tooltip()).toBeNull();
    });

    it('keeps the tooltip visible while the button remains focused', () => {
        render_toolbar();

        const formatting = get_button('Formatting');
        act(() => {
            formatting.focus();
        });
        dispatch_mouse_event(formatting, 'mouseover');
        dispatch_mouse_event(formatting, 'mouseout');
        expect(get_tooltip()?.textContent).toBe('Show raw cell values.');

        act(() => {
            formatting.blur();
        });
        expect(get_tooltip()).toBeNull();
    });

    it('renders the Auto-fit Columns button and calls on_toggle_auto_fit on click', () => {
        const on_toggle_auto_fit = vi.fn();
        render_toolbar({
            auto_fit_active: false,
            on_toggle_auto_fit,
        });

        const auto_fit = get_button('Auto-fit Columns');
        expect(auto_fit).toBeDefined();
        expect(auto_fit.classList.contains('active')).toBe(false);

        act(() => {
            auto_fit.click();
        });
        expect(on_toggle_auto_fit).toHaveBeenCalledTimes(1);
    });

    it('shows active state and correct tooltip when auto-fit is active', () => {
        render_toolbar({
            auto_fit_active: true,
            on_toggle_auto_fit: vi.fn(),
        });

        const auto_fit = get_button('Auto-fit Columns');
        expect(auto_fit.classList.contains('active')).toBe(true);

        dispatch_mouse_event(auto_fit, 'mouseover');
        expect(get_tooltip()?.textContent).toBe('Restore original column widths.');
    });

    it('shows correct tooltip when auto-fit is inactive', () => {
        render_toolbar({
            auto_fit_active: false,
            on_toggle_auto_fit: vi.fn(),
        });

        const auto_fit = get_button('Auto-fit Columns');
        dispatch_mouse_event(auto_fit, 'mouseover');
        expect(get_tooltip()?.textContent).toBe(
            'Auto-fit all columns to their content.'
        );
    });

    it('hides the tooltip when the button is clicked', () => {
        render_toolbar();

        const formatting = get_button('Formatting');
        dispatch_mouse_event(formatting, 'mouseover');
        expect(get_tooltip()).not.toBeNull();

        act(() => {
            formatting.click();
        });
        expect(get_tooltip()).toBeNull();
    });

    it('clamps tooltip positioning so it stays inside the viewport near the left edge', () => {
        const original_inner_width = window.innerWidth;
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 260,
        });

        const rect_spy = vi
            .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function () {
                if (
                    this instanceof HTMLButtonElement &&
                    this.textContent === 'Vertical Tabs'
                ) {
                    return make_rect({
                        left: 4,
                        top: 0,
                        width: 120,
                        height: 26,
                    });
                }

                if ((this as HTMLElement).getAttribute('role') === 'tooltip') {
                    return make_rect({
                        left: 0,
                        top: 0,
                        width: 240,
                        height: 40,
                    });
                }

                return make_rect({});
            });

        render_toolbar();

        const vertical_tabs = get_button('Vertical Tabs');
        dispatch_mouse_event(vertical_tabs, 'mouseover');

        const tooltip = get_tooltip();
        expect(tooltip).not.toBeNull();
        expect(tooltip?.style.left).toBe('8px');
        expect(tooltip?.style.top).toBe('32px');
        expect(
            tooltip?.style.getPropertyValue('--toolbar-tooltip-arrow-left')
        ).toBe('56px');

        rect_spy.mockRestore();
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: original_inner_width,
        });
    });
});
