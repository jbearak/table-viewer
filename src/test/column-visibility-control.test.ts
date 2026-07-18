// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ColumnVisibilityControl,
    type ColumnVisibilityControlProps,
} from '../webview/column-visibility-control';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const options: ColumnVisibilityControlProps['options'] = [
    { source_index: 0, display_name: 'Revenue', source_letter: 'A' },
    { source_index: 1, display_name: 'Revenue', source_letter: 'B' },
    { source_index: 2, display_name: '', source_letter: 'C' },
];

function render_control(
    overrides: Partial<ColumnVisibilityControlProps> = {},
) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const props: ColumnVisibilityControlProps = {
        options,
        hidden_columns: [1],
        reset_key: 'sheet-1',
        on_toggle: vi.fn(),
        on_show_all: vi.fn(),
        on_hide_all: vi.fn(),
        ...overrides,
    };
    act(() => {
        root!.render(React.createElement(ColumnVisibilityControl, props));
    });
    return {
        props,
        rerender(next: Partial<ColumnVisibilityControlProps>) {
            act(() => {
                root!.render(React.createElement(ColumnVisibilityControl, {
                    ...props,
                    ...next,
                }));
            });
        },
    };
}

function trigger(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(
        '.column-visibility-trigger',
    )!;
}

function search(): HTMLInputElement {
    return document.querySelector<HTMLInputElement>(
        '.column-visibility-search',
    )!;
}

function button_named(name: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === name,
    );
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
}

function set_input_value(input: HTMLInputElement, value: string) {
    act(() => {
        Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
        )!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function make_rect(left: number, top: number, width: number, height: number) {
    return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => '',
    } as DOMRect;
}

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('ColumnVisibilityControl', () => {
    it('opens an accessible dialog, autofocuses search, and renders the hidden badge', () => {
        render_control();
        expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        expect(trigger().querySelector('.hidden-count-badge')?.textContent).toBe('1');

        act(() => trigger().click());

        expect(trigger().getAttribute('aria-expanded')).toBe('true');
        expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label'))
            .toBe('Choose visible columns');
        expect(document.activeElement).toBe(search());
    });

    it('searches case-insensitively by displayed name and spreadsheet letter', () => {
        render_control();
        act(() => trigger().click());

        set_input_value(search(), 'REVENUE');
        expect(document.querySelectorAll('.column-visibility-item')).toHaveLength(2);

        set_input_value(search(), 'c');
        const matches = document.querySelectorAll('.column-visibility-item');
        expect(matches).toHaveLength(1);
        expect(matches[0].textContent).toContain('(blank)');
        expect(matches[0].textContent).toContain('Column C');

        set_input_value(search(), 'not present');
        expect(document.querySelector('.column-visibility-empty')?.textContent)
            .toBe('No matching columns');
    });

    it('keeps duplicate and blank names distinct in secondary text and accessible labels', () => {
        render_control();
        act(() => trigger().click());

        const rows = Array.from(document.querySelectorAll('.column-visibility-item'));
        expect(rows[0].textContent).toContain('Column A · source 1');
        expect(rows[1].textContent).toContain('Column B · source 2');
        expect(rows[2].textContent).toContain('(blank)');
        const labels = Array.from(document.querySelectorAll<HTMLInputElement>(
            '.column-visibility-item input',
        )).map((input) => input.getAttribute('aria-label'));
        expect(labels).toEqual([
            'Hide Revenue; Column A · source 1',
            'Show Revenue; Column B · source 2',
            'Hide blank column; Column C · source 3',
        ]);
    });

    it('toggles source-indexed checkboxes and keeps bulk actions open', () => {
        const on_toggle = vi.fn();
        const on_show_all = vi.fn();
        const on_hide_all = vi.fn();
        render_control({ on_toggle, on_show_all, on_hide_all });
        act(() => trigger().click());

        const checkboxes = document.querySelectorAll<HTMLInputElement>(
            '.column-visibility-item input',
        );
        expect(Array.from(checkboxes).map((input) => input.checked))
            .toEqual([true, false, true]);
        act(() => checkboxes[1].click());
        expect(on_toggle).toHaveBeenCalledWith(1);

        act(() => button_named('Show all').click());
        act(() => button_named('Hide all').click());
        expect(on_show_all).toHaveBeenCalledTimes(1);
        expect(on_hide_all).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it('dismisses on Escape and restores focus to the trigger', () => {
        render_control();
        act(() => trigger().click());
        expect(document.activeElement).toBe(search());

        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }));
        });

        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(trigger());
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
    });

    it('dismisses on an outside pointer press and resets when the sheet changes', () => {
        const rendered = render_control();
        act(() => trigger().click());
        set_input_value(search(), 'Revenue');

        act(() => {
            document.body.dispatchEvent(new Event('pointerdown', {
                bubbles: true,
                cancelable: true,
            }));
        });
        expect(document.querySelector('[role="dialog"]')).toBeNull();

        act(() => trigger().click());
        set_input_value(search(), 'Revenue');
        rendered.rerender({ reset_key: 'sheet-2' });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        act(() => trigger().click());
        expect(search().value).toBe('');
    });

    it('bounds initial DOM work for unusually wide CSV schemas while keeping search complete', () => {
        const wide_options = Array.from({ length: 505 }, (_, source_index) => ({
            source_index,
            display_name: source_index === 504 ? 'Target column' : `Field ${source_index}`,
            source_letter: `L${source_index}`,
        }));
        render_control({ options: wide_options, hidden_columns: [] });
        act(() => trigger().click());

        expect(document.querySelectorAll('.column-visibility-item')).toHaveLength(500);
        expect(document.querySelector('.column-visibility-limit')?.textContent)
            .toContain('first 500 of 505 matches');

        set_input_value(search(), 'target column');
        expect(document.querySelectorAll('.column-visibility-item')).toHaveLength(1);
        expect(document.querySelector('.column-visibility-item')?.textContent)
            .toContain('Target column');
        expect(document.querySelector('.column-visibility-limit')).toBeNull();
    });

    it('clamps horizontally and flips above the trigger near the viewport edge', () => {
        const original_width = window.innerWidth;
        const original_height = window.innerHeight;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function (this: HTMLElement) {
                if (this.classList.contains('column-visibility-trigger')) {
                    return make_rect(270, 250, 40, 24);
                }
                if (this.classList.contains('column-visibility-popover')) {
                    return make_rect(0, 0, 300, 200);
                }
                return make_rect(0, 0, 0, 0);
            });

        render_control();
        act(() => trigger().click());
        const popover = document.querySelector<HTMLElement>(
            '.column-visibility-popover',
        )!;
        expect(popover.style.left).toBe('10px');
        expect(popover.style.top).toBe('44px');

        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: original_width,
        });
        Object.defineProperty(window, 'innerHeight', {
            configurable: true,
            value: original_height,
        });
    });
});
