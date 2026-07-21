// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
        row_count: 3,
        source_row_count: 3,
        transform: { sort: [], filters: [] },
        transform_disabled: false,
        transform_pending: false,
        column_names: ['Name', 'Value'],
        merges_flattened: false,
        on_transform_change: vi.fn(),
        on_edit_filter: vi.fn(),
        on_cancel_transform: vi.fn(),
        show_formatting: true,
        on_toggle_formatting,
        show_formatting_button: true,
        show_excel_header_button: false,
        excel_header_active: false,
        excel_header_automatic: false,
        excel_header_pending: false,
        on_toggle_excel_header: vi.fn(),
        vertical_tabs: false,
        on_toggle_tab_orientation,
        show_vertical_tabs_button: true,
        column_visibility: {
            column_count: 2,
            get_column_name: (source_index) => ['Name', 'Value'][source_index] ?? '',
            duplicate_names: new Set(),
            is_visible: () => true,
            hidden_count: 0,
            reset_key: 'sheet-1',
            on_toggle: vi.fn(),
            on_show_all: vi.fn(),
            on_hide_all: vi.fn(),
        },
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    it('explains raw-value transform semantics before any sort or filter is active', () => {
        const { container } = render_toolbar({
            transform: { sort: [], filters: [] },
        });
        expect(container.querySelector('.sort-strip')).toBeNull();
        expect(container.querySelector('.filter-strip')).toBeNull();
        const note = container.querySelector('[role="note"]') as HTMLElement;
        expect(note.textContent).toBe('Sort/filter: raw values');
        const description_id = note.getAttribute('aria-describedby');
        expect(description_id).toBeTruthy();
        expect(container.querySelector('[role="toolbar"]')?.getAttribute('aria-describedby'))
            .toBe(description_id);
        const description = document.getElementById(description_id!);
        expect(description?.textContent).toBe(
            'Sorting and filtering use raw cell values, not formatted display text.',
        );
        expect(description?.closest('.toolbar-chips')).toBeNull();
    });

    it('excludes the hidden transform description from chip-width wrapping', () => {
        const scroll_width = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            'scrollWidth',
        );
        const client_width = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            'clientWidth',
        );
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
            configurable: true,
            get(this: HTMLElement) {
                if (this.classList.contains('toolbar-row-count')) return 70;
                if (this.classList.contains('toolbar-transform-semantics')) return 80;
                if (this.classList.contains('toolbar-item')) return 50;
                if (this.classList.contains('sr-only')
                    && this.textContent?.includes('Sorting and filtering')) return 1_000;
                return 0;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get(this: HTMLElement) {
                return this.classList.contains('toolbar') ? 400 : 0;
            },
        });
        try {
            const { container } = render_toolbar({
                transform: { sort: [], filters: [] },
            });
            expect(container.querySelector('.toolbar')?.classList.contains('is-wrapped'))
                .toBe(false);
        } finally {
            if (scroll_width) {
                Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll_width);
            } else {
                Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
            }
            if (client_width) {
                Object.defineProperty(HTMLElement.prototype, 'clientWidth', client_width);
            } else {
                Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
            }
        }
    });

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

    it('renders an accessible Excel first-row header toggle', () => {
        const on_toggle_excel_header = vi.fn();
        render_toolbar({
            show_excel_header_button: true,
            excel_header_active: true,
            excel_header_automatic: true,
            on_toggle_excel_header,
        });

        const button = get_button('First Row as Header');
        expect(button.classList.contains('active')).toBe(true);
        expect(button.getAttribute('aria-pressed')).toBe('true');
        dispatch_mouse_event(button, 'mouseover');
        expect(get_tooltip()?.textContent).toContain('Automatically using');
        act(() => button.click());
        expect(on_toggle_excel_header).toHaveBeenCalledTimes(1);
    });

    it('keeps the pending Excel header toggle focusable and announces status', () => {
        const on_toggle_excel_header = vi.fn();
        render_toolbar({
            show_excel_header_button: true,
            excel_header_active: true,
            excel_header_automatic: false,
            excel_header_pending: true,
            excel_header_status: 'Updating column names…',
            excel_header_disabled: true,
            excel_header_disabled_reason: 'Updating column names…',
            on_toggle_excel_header,
        });

        const button = get_button('First Row as Header');
        act(() => button.focus());
        expect(document.activeElement).toBe(button);
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(button.getAttribute('aria-pressed')).toBe('true');
        act(() => button.click());
        expect(on_toggle_excel_header).not.toHaveBeenCalled();
        expect(document.querySelector('[role="status"]')?.textContent)
            .toBe('Updating column names…');
    });

    it('shows the disabled reason for the Excel header toggle', () => {
        render_toolbar({
            show_excel_header_button: true,
            excel_header_active: false,
            excel_header_automatic: false,
            excel_header_disabled: true,
            excel_header_disabled_reason: 'Clear sorting and filters first.',
        });

        const button = get_button('First Row as Header');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        const wrapper = button.closest<HTMLElement>('.toolbar-item')!;
        expect(wrapper.getAttribute('role')).toBeNull();
        expect(wrapper.getAttribute('tabindex')).toBeNull();
        act(() => button.focus());
        expect(get_tooltip()?.textContent).toBe('Clear sorting and filters first.');
    });

    it('renders the Columns trigger with dialog semantics and a hidden-count badge', () => {
        render_toolbar({
            column_visibility: {
                column_count: 2,
                get_column_name: (source_index) => ['Name', 'Value'][source_index] ?? '',
                duplicate_names: new Set(),
                is_visible: (source_index) => source_index !== 1,
                hidden_count: 1,
                reset_key: 'sheet-1',
                on_toggle: vi.fn(),
                on_show_all: vi.fn(),
                on_hide_all: vi.fn(),
            },
        });

        const columns = document.querySelector<HTMLButtonElement>(
            '.column-visibility-trigger',
        )!;
        expect(columns.getAttribute('aria-haspopup')).toBe('dialog');
        expect(columns.getAttribute('aria-expanded')).toBe('false');
        expect(columns.getAttribute('aria-label')).toContain('1 column hidden');
        expect(columns.querySelector('.hidden-count-badge')?.textContent).toBe('1');
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

    it('shows the disabled Auto-fit recovery reason from the toolbar wrapper', () => {
        render_toolbar({
            auto_fit_disabled: true,
            auto_fit_disabled_reason: 'Show at least one column before using auto-fit.',
        });

        const auto_fit = get_button('Auto-fit Columns');
        const wrapper = auto_fit.closest<HTMLElement>('.toolbar-item')!;
        expect(auto_fit.disabled).toBe(true);
        expect(wrapper.tabIndex).toBe(0);
        expect(wrapper.getAttribute('aria-disabled')).toBe('true');
        dispatch_mouse_event(auto_fit, 'mouseover');
        expect(get_tooltip()?.textContent).toBe(
            'Show at least one column before using auto-fit.',
        );
        dispatch_mouse_event(auto_fit, 'mouseout');
        act(() => wrapper.focus());
        expect(get_tooltip()?.textContent).toBe(
            'Show at least one column before using auto-fit.',
        );
        expect(wrapper.getAttribute('aria-describedby')).toBe(
            get_tooltip()?.id,
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

    it('composes row count, hidden-column transform chips, progress, cancel, and actions', () => {
        const on_cancel_transform = vi.fn();
        const { container } = render_toolbar({
            row_count: 2,
            source_row_count: 5,
            column_names: ['Visible', 'Hidden active'],
            transform: {
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [{
                    id: 'f',
                    colIndex: 1,
                    operator: 'equals',
                    value: '0',
                    caseSensitive: false,
                    enabled: false,
                }],
            },
            transform_pending: true,
            transform_progress: 'Applying saved…',
            merges_flattened: true,
            on_cancel_transform,
        });
        expect(container.textContent).toContain('2 of 5 rows');
        expect(container.textContent).toContain('Hidden active');
        expect(container.textContent).toContain('Applying saved…');
        expect(container.textContent).toContain('Merged cells shown unmerged');
        expect(get_button('Formatting')).toBeDefined();
        expect(get_button('Cancel')).toBeDefined();
        act(() => get_button('Cancel').click());
        expect(on_cancel_transform).toHaveBeenCalledOnce();
        expect((container.querySelector('.sort-chip') as HTMLButtonElement).disabled).toBe(false);
        expect(container.querySelector('.sort-chip')?.getAttribute('aria-disabled')).toBe('true');
        expect((container.querySelector('.filter-chip-body') as HTMLButtonElement).disabled).toBe(false);
        expect(container.querySelector('.filter-chip-body')?.getAttribute('aria-disabled')).toBe('true');
    });

    it('keeps sort, filter, merge notice, and actions reachable in a narrow wrap', () => {
        const scroll_width = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            'scrollWidth',
        );
        const client_width = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            'clientWidth',
        );
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
            configurable: true,
            get(this: HTMLElement) {
                if (this.classList.contains('toolbar-row-count')) return 70;
                if (this.classList.contains('sort-strip')) return 210;
                if (this.classList.contains('filter-strip')) return 240;
                if (this.classList.contains('toolbar-merge-notice')) return 360;
                if (this.classList.contains('toolbar-item')) return 90;
                return 0;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get(this: HTMLElement) {
                return this.classList.contains('toolbar') ? 420 : 0;
            },
        });
        const style = document.createElement('style');
        style.textContent = readFileSync(
            resolve(process.cwd(), 'src/webview/styles.css'),
            'utf8',
        );
        document.head.appendChild(style);
        try {
            const { container } = render_toolbar({
                transform: {
                    sort: [{ colIndex: 0, direction: 'asc' }],
                    filters: [{
                        id: 'f', colIndex: 1, operator: 'contains', value: 'needle',
                        caseSensitive: false, enabled: true,
                    }],
                },
                merges_flattened: true,
            });
            const toolbar = container.querySelector('.toolbar') as HTMLElement;
            const chips = container.querySelector('.toolbar-chips') as HTMLElement;
            const sort = container.querySelector('.sort-strip') as HTMLElement;
            const filter = container.querySelector('.filter-strip') as HTMLElement;
            const notice = container.querySelector('.toolbar-merge-notice') as HTMLElement;
            const actions = container.querySelector('.toolbar-actions') as HTMLElement;

            expect(toolbar.classList.contains('is-wrapped')).toBe(true);
            expect(getComputedStyle(chips).flexWrap).toBe('wrap');
            expect(getComputedStyle(chips).overflow).toBe('visible');
            expect(getComputedStyle(sort).flexShrink).toBe('1');
            expect(getComputedStyle(filter).flexShrink).toBe('1');
            expect(getComputedStyle(sort).minWidth).not.toBe('0px');
            expect(getComputedStyle(filter).minWidth).not.toBe('0px');
            expect(getComputedStyle(notice).flexShrink).toBe('1');
            expect(getComputedStyle(notice).whiteSpace).toBe('normal');
            expect(getComputedStyle(notice).overflowWrap).toBe('anywhere');
            expect(getComputedStyle(actions).maxWidth).toBe('100%');
            expect(getComputedStyle(actions).overflowX).toBe('auto');
            expect(getComputedStyle(actions.firstElementChild as HTMLElement).marginLeft)
                .toBe('auto');
            expect(getComputedStyle(actions).justifyContent).toBe('');
            expect(container.querySelector('.sort-chip')).not.toBeNull();
            expect(container.querySelector('.filter-chip-body')).not.toBeNull();
            expect(get_button('Formatting')).toBeDefined();
            expect(get_button('Auto-fit Columns')).toBeDefined();
        } finally {
            style.remove();
            if (scroll_width) {
                Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll_width);
            } else {
                Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
            }
            if (client_width) {
                Object.defineProperty(HTMLElement.prototype, 'clientWidth', client_width);
            } else {
                Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
            }
        }
    });

    it('remeasures wrapping when pending progress text changes', () => {
        const scroll_width = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            'scrollWidth',
        );
        const client_width = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            'clientWidth',
        );
        Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
            configurable: true,
            get(this: HTMLElement) {
                if (this.classList.contains('toolbar-row-count')) return 50;
                if (this.classList.contains('toolbar-progress')) {
                    return this.textContent?.includes('A much longer pending progress label')
                        ? 700
                        : 100;
                }
                return 0;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get(this: HTMLElement) {
                return this.classList.contains('toolbar') ? 500 : 0;
            },
        });
        const rendered = render_toolbar({
            transform_pending: true,
            transform_progress: 'Short',
        });
        expect(rendered.container.querySelector('.toolbar')?.classList.contains('is-wrapped'))
            .toBe(false);
        rendered.rerender({
            transform_pending: true,
            transform_progress: 'A much longer pending progress label',
        });
        expect(rendered.container.querySelector('.toolbar')?.classList.contains('is-wrapped'))
            .toBe(true);
        if (scroll_width) {
            Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll_width);
        } else {
            Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
        }
        if (client_width) {
            Object.defineProperty(HTMLElement.prototype, 'clientWidth', client_width);
        } else {
            Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
        }
    });

    it('repositions a visible tooltip when a captured ancestor scroll moves its button', () => {
        let button_left = 40;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function (this: HTMLElement) {
                if (
                    this instanceof HTMLButtonElement
                    && this.textContent === 'Formatting'
                ) {
                    return make_rect({
                        left: button_left,
                        top: 10,
                        width: 80,
                        height: 24,
                    });
                }
                if (this.getAttribute('role') === 'tooltip') {
                    return make_rect({ width: 100, height: 30 });
                }
                return make_rect({});
            });

        const { container } = render_toolbar();
        const formatting = get_button('Formatting');
        dispatch_mouse_event(formatting, 'mouseover');
        expect(get_tooltip()?.style.left).toBe('30px');
        expect(get_tooltip()?.style.top).toBe('40px');

        button_left = 100;
        act(() => {
            container.dispatchEvent(new Event('scroll'));
        });
        expect(get_tooltip()?.style.left).toBe('90px');
        expect(get_tooltip()?.style.top).toBe('40px');
    });

    it('repositions a visible tooltip after toolbar layout reflow', () => {
        let resize_callback: ResizeObserverCallback | undefined;
        const disconnect = vi.fn();
        const observe = vi.fn();
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: ResizeObserverCallback) {
                resize_callback = callback;
            }
            observe = observe;
            disconnect = disconnect;
            unobserve() {}
        });
        let button_left = 20;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function (this: HTMLElement) {
                if (
                    this instanceof HTMLButtonElement
                    && this.textContent === 'Formatting'
                ) {
                    return make_rect({
                        left: button_left,
                        top: 5,
                        width: 60,
                        height: 20,
                    });
                }
                if (this.getAttribute('role') === 'tooltip') {
                    return make_rect({ width: 80, height: 30 });
                }
                return make_rect({});
            });

        render_toolbar();
        const formatting = get_button('Formatting');
        dispatch_mouse_event(formatting, 'mouseover');
        expect(observe).toHaveBeenCalledWith(formatting);
        expect(observe.mock.calls.some(([element]) => (
            (element as HTMLElement).classList.contains('toolbar')
        ))).toBe(true);
        expect(get_tooltip()?.style.left).toBe('10px');

        button_left = 140;
        act(() => resize_callback?.([], {} as ResizeObserver));
        expect(get_tooltip()?.style.left).toBe('130px');

        dispatch_mouse_event(formatting, 'mouseout');
        expect(disconnect).toHaveBeenCalledOnce();
    });

    it('clamps tooltip positioning so it stays inside the viewport near the left edge', () => {
        const original_inner_width = window.innerWidth;
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 260,
        });

        const rect_spy = vi
            .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function (this: HTMLElement) {
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
