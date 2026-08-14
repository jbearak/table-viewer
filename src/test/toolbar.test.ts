// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toolbar } from '../webview/toolbar';

let webview_css: string | undefined;

function get_webview_css(): string {
    return webview_css ??= readFileSync(
        resolve(process.cwd(), 'src/webview/styles.css'),
        'utf8',
    );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render_toolbar(props?: Partial<React.ComponentProps<typeof Toolbar>>) {
    const on_toggle_formatting = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const merged_props: React.ComponentProps<typeof Toolbar> = {
        show_formatting: true,
        on_toggle_formatting,
        show_formatting_button: true,
        show_excel_header_button: false,
        excel_header_active: false,
        excel_header_automatic: false,
        excel_header_pending: false,
        on_toggle_excel_header: vi.fn(),
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

describe('toolbar toggle colors', () => {
    it('keeps active button hover colors on the button palette', () => {
        expect(get_webview_css()).toContain(
            '.toggle:not(.active):not([aria-disabled="true"]):hover',
        );
        expect(get_webview_css()).toMatch(
            /\.toggle\.active:not\(\.has-unsaved\):not\(\[aria-disabled="true"\]\):hover\s*\{[^}]*--vscode-button-hoverBackground[^}]*\}/,
        );
    });

    it('removes the active fill and hover color from disabled toggles', () => {
        expect(get_webview_css()).toMatch(
            /\.toggle\.active:disabled[\s\S]*?background:\s*transparent[\s\S]*?--vscode-disabledForeground/,
        );
        const hover_rule = /\.toggle\[aria-disabled="true"\]:hover\s*\{([^}]*)\}/
            .exec(get_webview_css())?.[1];
        expect(hover_rule).toBeDefined();
        expect(hover_rule).toMatch(/background:\s*transparent/);
        expect(hover_rule).toMatch(/--vscode-disabledForeground/);
        expect(hover_rule).toMatch(/opacity:\s*0\.45/);
    });

    it('paints the scope divider as a 1px rule despite its spacing', () => {
        // The rule carries breathing room on top of the action row's gap so it reads
        // as a boundary rather than one more crowded item. That room is padding, so
        // without clipping the background to the content box the 1px line would paint
        // 5px wide. Asserted against the stylesheet because jsdom computes no layout.
        const rule = /\.toolbar-actions-divider\s*\{([^}]*)\}/.exec(get_webview_css())?.[1];
        expect(rule).toBeDefined();
        expect(rule).toMatch(/padding:\s*0\s+2px/);
        expect(rule).toMatch(/background-clip:\s*content-box/);
        expect(rule).toMatch(/box-sizing:\s*content-box/);
    });
});

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

/**
 * The action row in order, with the scope divider read as `'|'`.
 *
 * Including the divider is the point: what the grouping asserts is which side of
 * the rule each button falls on, not merely their relative order.
 */
function get_action_labels(container: HTMLElement): (string | null)[] {
    return Array.from(
        container.querySelectorAll<HTMLElement>(
            '.toolbar-actions button, .toolbar-actions-divider',
        ),
        (node) => node.classList.contains('toolbar-actions-divider') ? '|' : node.textContent,
    );
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

/**
 * Put the shipped stylesheet behind the render, for the handful of assertions that
 * turn on a resolved style rather than on markup. jsdom lays nothing out, but it does
 * run the cascade, so `display` and `position` are answerable.
 */
function apply_webview_styles(): void {
    const style = document.createElement('style');
    style.dataset.webviewStyles = 'true';
    style.textContent = get_webview_css();
    document.head.appendChild(style);
}

afterEach(() => {
    cleanup();
    document.head.querySelectorAll('style[data-webview-styles]')
        .forEach((style) => style.remove());
});

describe('Toolbar', () => {
    it('suppresses the native context menu on the toolbar surface', () => {
        const { container } = render_toolbar();
        const toolbar = container.querySelector('[role="toolbar"]') as HTMLElement;
        const event = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
        });
        act(() => toolbar.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
    });

    it('orders actions workbook scope first, then worksheet scope', () => {
        const { container } = render_toolbar({
            show_edit_button: true,
            show_excel_header_button: true,
        });

        expect(get_action_labels(container)).toEqual([
            'Edit',
            'Formatting',
            '|',
            'Header Row',
            'Columns',
            'Auto-fit Columns',
        ]);
    });

    it('marks the divider as a vertical separator', () => {
        const { container } = render_toolbar({ show_edit_button: true });

        const divider = container.querySelector('.toolbar-actions-divider');
        expect(divider?.getAttribute('role')).toBe('separator');
        expect(divider?.getAttribute('aria-orientation')).toBe('vertical');
    });

    it('omits the divider when no workbook-scoped action is shown', () => {
        // A single-sheet CSV with no formatting: nothing sits left of the rule, so
        // a rule there would be a stray leading line.
        const { container } = render_toolbar({
            show_formatting_button: false,
        });

        expect(container.querySelector('.toolbar-actions-divider')).toBeNull();
        expect(container.querySelector('.toolbar-actions')?.firstElementChild?.textContent)
            .toBe('Columns');
    });

    it('keeps the divider when only one workbook-scoped action is shown', () => {
        // The expected state now that tab orientation moved to the sheet tabs (#154):
        // Edit is usually alone on the workbook side, and the rule still belongs there.
        const { container } = render_toolbar({
            show_formatting_button: false,
            show_edit_button: true,
        });

        expect(get_action_labels(container))
            .toEqual(['Edit', '|', 'Columns', 'Auto-fit Columns']);
    });

    it('divides the two groups for every combination of optional actions', () => {
        // The divider follows from whether the workbook group rendered anything, so
        // it must sit at exactly the group boundary in all four combinations —
        // including the two where only one workbook action is visible, which a
        // hand-written condition is most likely to get wrong.
        for (const show_edit_button of [false, true]) {
            for (const show_formatting_button of [false, true]) {
                const { container } = render_toolbar({
                    show_edit_button,
                    show_formatting_button,
                    show_excel_header_button: true,
                });
                const labels = get_action_labels(container);
                const workbook_count = [
                    show_edit_button,
                    show_formatting_button,
                ].filter(Boolean).length;

                if (workbook_count === 0) {
                    expect(labels).not.toContain('|');
                } else {
                    // One rule, at the boundary: every workbook action before it
                    // and every worksheet action after it.
                    expect(labels.filter((label) => label === '|')).toHaveLength(1);
                    expect(labels.indexOf('|')).toBe(workbook_count);
                    expect(labels.slice(0, workbook_count)).toEqual([
                        ...(show_edit_button ? ['Edit'] : []),
                        ...(show_formatting_button ? ['Formatting'] : []),
                    ]);
                    expect(labels.slice(workbook_count + 1)).toEqual([
                        'Header Row',
                        'Columns',
                        'Auto-fit Columns',
                    ]);
                }
                cleanup();
            }
        }
    });

    it('holds no view state: sort, filter, and progress live in the state strip', () => {
        // The toolbar is actions only since #154. Nothing here should render a chip
        // or a progress badge regardless of what the sheet's transform is doing.
        const { container } = render_toolbar();

        expect(container.querySelector('.sort-strip')).toBeNull();
        expect(container.querySelector('.filter-strip')).toBeNull();
        expect(container.querySelector('.state-strip')).toBeNull();
        expect(container.querySelector('.toolbar-progress')).toBeNull();
        expect(container.textContent).not.toContain('hidden row');
        expect(container.textContent).not.toContain('Merged cells shown unmerged');
    });

    it('keeps the existing button labels and removes native title tooltips', () => {
        render_toolbar();

        const formatting = get_button('Formatting');
        const auto_fit = get_button('Auto-fit Columns');

        expect(formatting.textContent).toBe('Formatting');
        expect(auto_fit.textContent).toBe('Auto-fit Columns');
        expect(formatting.getAttribute('title')).toBeNull();
        expect(auto_fit.getAttribute('title')).toBeNull();
    });

    it('shows state-aware tooltip text on hover and hides it on mouseout', () => {
        render_toolbar({
            show_formatting: true,
            auto_fit_active: false,
        });

        const formatting = get_button('Formatting');
        dispatch_mouse_event(formatting, 'mouseover');
        expect(get_tooltip()?.textContent).toBe('Show raw cell values on this sheet.');
        dispatch_mouse_event(formatting, 'mouseout');
        expect(get_tooltip()).toBeNull();

        const auto_fit = get_button('Auto-fit Columns');
        dispatch_mouse_event(auto_fit, 'mouseover');
        expect(get_tooltip()?.textContent).toBe('Auto-fit all columns to their content on this sheet.');
        dispatch_mouse_event(auto_fit, 'mouseout');
        expect(get_tooltip()).toBeNull();
    });

    it('shows state-aware tooltip text on focus and hides it on blur', () => {
        render_toolbar({
            show_formatting: false,
            auto_fit_active: true,
        });

        const formatting = get_button('Formatting');
        act(() => {
            formatting.focus();
        });
        expect(get_tooltip()?.textContent).toBe('Show formatted cell values on this sheet.');
        act(() => {
            formatting.blur();
        });
        expect(get_tooltip()).toBeNull();

        const auto_fit = get_button('Auto-fit Columns');
        act(() => {
            auto_fit.focus();
        });
        expect(get_tooltip()?.textContent).toBe('Restore original column widths on this sheet.');
        act(() => {
            auto_fit.blur();
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
        expect(get_tooltip()?.textContent).toBe('Show raw cell values on this sheet.');

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

        const button = get_button('Header Row');
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

        const button = get_button('Header Row');
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

        const button = get_button('Header Row');
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
        expect(get_tooltip()?.textContent).toBe('Restore original column widths on this sheet.');
    });

    it('shows correct tooltip when auto-fit is inactive', () => {
        render_toolbar({
            auto_fit_active: false,
            on_toggle_auto_fit: vi.fn(),
        });

        const auto_fit = get_button('Auto-fit Columns');
        dispatch_mouse_event(auto_fit, 'mouseover');
        expect(get_tooltip()?.textContent).toBe(
            'Auto-fit all columns to their content on this sheet.'
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
                    this.textContent === 'Auto-fit Columns'
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

        const auto_fit = get_button('Auto-fit Columns');
        dispatch_mouse_event(auto_fit, 'mouseover');

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

describe('Toolbar scope menus', () => {
    const scope_menu = (overrides?: Partial<{ disabled: boolean }>) => ({
        aria_label: 'Auto-fit scope',
        items: [
            { label: 'Auto-fit columns on all 3 sheets', on_click: vi.fn() },
            {
                label: 'Restore original widths on all 3 sheets',
                on_click: vi.fn(),
                disabled: overrides?.disabled ?? false,
            },
        ],
    });

    function open_caret(): HTMLButtonElement {
        const caret = document.querySelector<HTMLButtonElement>('.toolbar-split-caret');
        expect(caret).not.toBeNull();
        act(() => caret!.click());
        return caret!;
    }

    function menu_labels(): (string | null)[] {
        return Array.from(
            document.querySelectorAll('[role="menuitem"]'),
            (item) => item.textContent,
        );
    }

    it('adds no in-flow box to the action row when a menu opens', () => {
        // The row is right-aligned and gap-spaced, so any child that generates a box
        // widens it and slides every control left — by the 6px gap alone, even for a
        // child of zero width. The menu is fixed-positioned, but its wrapper is not,
        // so the wrapper has to generate no box at all. jsdom computes no layout, so
        // this asserts the used `display`/`position` the stylesheet resolves to.
        apply_webview_styles();
        render_toolbar({ auto_fit_scope_menu: scope_menu() });
        const actions = document.querySelector('.toolbar-actions') as HTMLElement;
        const before = new Set(Array.from(actions.children));

        open_caret();

        const added = Array.from(actions.children).filter((child) => !before.has(child));
        expect(added.length).toBeGreaterThan(0);
        for (const child of added) {
            const style = getComputedStyle(child);
            const out_of_flow = style.display === 'contents'
                || style.position === 'fixed'
                || style.position === 'absolute';
            expect(
                out_of_flow,
                `${child.className} takes a slot in the action row`,
            ).toBe(true);
        }
    });

    it('renders a plain button when there is no scope menu', () => {
        // A single-sheet workbook: the chevron could only restate the button.
        const { container } = render_toolbar();

        expect(container.querySelector('.toolbar-split')).toBeNull();
        expect(container.querySelector('.toolbar-split-caret')).toBeNull();
    });

    it('opens the all-sheets actions from the chevron', () => {
        render_toolbar({ auto_fit_scope_menu: scope_menu() });

        const caret = open_caret();
        expect(menu_labels()).toEqual([
            'Auto-fit columns on all 3 sheets',
            'Restore original widths on all 3 sheets',
        ]);
        expect(caret.getAttribute('aria-expanded')).toBe('true');
        expect(caret.getAttribute('aria-haspopup')).toBe('menu');
    });

    it('names every item with both its action and its scope', () => {
        // A bare "Restore original widths" under an "…all 3 sheets" item reads as
        // ambiguous: the reader cannot tell whether the omission means this sheet or
        // the same scope as the line above.
        render_toolbar({ auto_fit_scope_menu: scope_menu() });
        open_caret();

        for (const label of menu_labels()) {
            expect(label).toMatch(/all 3 sheets$/);
        }
    });

    it('greys an item that would change nothing', () => {
        render_toolbar({ auto_fit_scope_menu: scope_menu({ disabled: true }) });
        open_caret();

        const restore = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
        ).find((item) => item.textContent?.startsWith('Restore'));
        expect(restore?.disabled).toBe(true);
    });

    it('runs the chosen action and closes', () => {
        const menu = scope_menu();
        render_toolbar({ auto_fit_scope_menu: menu });
        open_caret();

        const first = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
        act(() => first!.click());
        expect(menu.items[0].on_click).toHaveBeenCalledOnce();
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('leaves the button itself meaning this sheet', () => {
        const on_toggle_auto_fit = vi.fn();
        const menu = scope_menu();
        render_toolbar({ auto_fit_scope_menu: menu, on_toggle_auto_fit });

        dispatch_mouse_event(get_button('Auto-fit Columns'), 'click');
        expect(on_toggle_auto_fit).toHaveBeenCalledOnce();
        expect(menu.items[0].on_click).not.toHaveBeenCalled();
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('opens the same menu on right-click, for people who reach for it', () => {
        render_toolbar({ auto_fit_scope_menu: scope_menu() });

        const button = get_button('Auto-fit Columns');
        const event = new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: 20, clientY: 30,
        });
        act(() => button.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
        expect(menu_labels()).toEqual([
            'Auto-fit columns on all 3 sheets',
            'Restore original widths on all 3 sheets',
        ]);
    });

    it('hides another button\'s tooltip when a menu opens', () => {
        // The tooltip and the menu belong to different controls, so a per-button
        // guard misses this: hovering Formatting then opening Header Row's menu left
        // the Formatting tooltip sitting underneath it.
        render_toolbar({
            auto_fit_scope_menu: scope_menu(),
            show_edit_button: true,
        });

        dispatch_mouse_event(get_button('Edit'), 'mouseover');
        expect(get_tooltip()?.textContent).toBe('Enter edit mode to modify cell values.');

        open_caret();
        expect(get_tooltip()).toBeNull();
    });

    it('anchors the menu to the left edge of the control, not the chevron', () => {
        const rect_spy = vi
            .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function (this: HTMLElement) {
                if (this.classList.contains('toolbar-split')) {
                    return make_rect({ left: 100, top: 0, width: 140, height: 26 });
                }
                if (this.classList.contains('toolbar-split-caret')) {
                    return make_rect({ left: 216, top: 0, width: 24, height: 26 });
                }
                return make_rect({});
            });
        render_toolbar({ auto_fit_scope_menu: scope_menu() });
        open_caret();

        // The chevron is the narrow right-hand slice; anchoring there threw the menu
        // out past the button that owns it.
        const menu = document.querySelector<HTMLElement>('[role="menu"]');
        expect(menu?.style.left).toBe('100px');
        rect_spy.mockRestore();
    });

    it('opens only one menu at a time', () => {
        render_toolbar({
            auto_fit_scope_menu: scope_menu(),
            formatting_scope_menu: {
                aria_label: 'Formatting scope',
                items: [{ label: 'Show raw values on all 3 sheets', on_click: vi.fn() }],
            },
        });

        const carets = Array.from(
            document.querySelectorAll<HTMLButtonElement>('.toolbar-split-caret'),
        );
        act(() => carets[0].click());
        act(() => carets[1].click());
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
        expect(menu_labels()).toEqual([
            'Auto-fit columns on all 3 sheets',
            'Restore original widths on all 3 sheets',
        ]);
    });

    /**
     * Let ContextMenu arm its document-level dismissal listener, which it registers a
     * tick after mount. Without this the real mechanism is never live and a test can
     * pass on nothing.
     */
    async function arm_dismissal() {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }

    /**
     * A full press of the chevron: pointerdown, then the click it produces, each
     * committed separately so React re-renders between them as a browser would. Both
     * in one `act` leaves the click handler reading the pre-dismissal render.
     */
    async function press_caret(caret: HTMLButtonElement) {
        await act(async () => {
            caret.dispatchEvent(new MouseEvent('pointerdown', {
                bubbles: true, cancelable: true,
            }));
        });
        await act(async () => {
            caret.click();
        });
    }

    it('closes an open menu when any toolbar button is pressed', async () => {
        render_toolbar({ auto_fit_scope_menu: scope_menu(), show_edit_button: true });
        open_caret();
        await arm_dismissal();

        await act(async () => get_button('Edit').dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
        ));
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('closes an open menu when the Columns trigger is pressed', async () => {
        render_toolbar({ auto_fit_scope_menu: scope_menu() });
        open_caret();
        await arm_dismissal();

        await act(async () => get_button('Columns').dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
        ));
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('closes its own menu when the chevron is pressed again', async () => {
        // ContextMenu dismisses on a document capture pointerdown, before anything on
        // the chevron. Without the guard the click that follows saw no open menu and
        // reopened it, so the chevron stuck open instead of toggling.
        render_toolbar({ auto_fit_scope_menu: scope_menu() });
        const caret = open_caret();
        await arm_dismissal();
        expect(document.querySelector('[role="menu"]')).not.toBeNull();

        await press_caret(caret);
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('reopens on the next chevron press, rather than eating it', async () => {
        // The skip covers only the press that dismissed; a fresh press must open.
        render_toolbar({ auto_fit_scope_menu: scope_menu() });
        const caret = open_caret();
        await arm_dismissal();
        await press_caret(caret);
        expect(document.querySelector('[role="menu"]')).toBeNull();

        await press_caret(caret);
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
    });

    it('opens after a press on the chevron that produced no click', async () => {
        // Pressing and then dragging off releases elsewhere, so the chevron never
        // sees a click to spend the "this press closed it" flag on. Left set, it was
        // spent on the next press instead, and the chevron did nothing.
        render_toolbar({ auto_fit_scope_menu: scope_menu() });
        const caret = open_caret();
        await arm_dismissal();

        await act(async () => {
            caret.dispatchEvent(new MouseEvent('pointerdown', {
                bubbles: true, cancelable: true,
            }));
        });
        expect(document.querySelector('[role="menu"]')).toBeNull();

        await press_caret(caret);
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
    });

    it('keeps a menu item clickable through the row-level dismissal', () => {
        const menu = scope_menu();
        render_toolbar({ auto_fit_scope_menu: menu });
        open_caret();

        const first = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
        act(() => first.dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
        ));
        act(() => first.click());
        expect(menu.items[0].on_click).toHaveBeenCalledOnce();
    });

    it('does not bring the tooltip back when the menu is dismissed from outside', async () => {
        // The menu renders inside the control, so focus moving into it fires no blur
        // and the pointer crossing it fires no mouseleave. Dismissing from elsewhere
        // removed the menu with both flags stuck on, and the tooltip — suppressed
        // only while the menu was open — popped back over a control the pointer had
        // long since left.
        render_toolbar({ auto_fit_scope_menu: scope_menu() });

        dispatch_mouse_event(get_button('Auto-fit Columns'), 'mouseover');
        expect(get_tooltip()).not.toBeNull();
        const caret = open_caret();
        act(() => caret.focus());
        expect(get_tooltip()).toBeNull();

        // A click out in the grid: ContextMenu dismisses on an outside pointerdown
        // and restores no focus, so nothing else clears the flags. Its listener is
        // attached a tick after mount, so wait for that before dispatching.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await act(async () => {
            document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        });
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(get_tooltip()).toBeNull();
    });

    it('does not raise the tooltip after a menu item is clicked', async () => {
        // ContextMenu restores focus to the chevron on activation, which is right for
        // the keyboard and wrong for the mouse: the tooltip would appear over a
        // control the user has just finished with.
        render_toolbar({ auto_fit_scope_menu: scope_menu() });
        open_caret();

        const first = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
        act(() => {
            first.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true, detail: 1,
            }));
        });
        // The focus restore lands a tick later; the tooltip must not follow it.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(get_tooltip()).toBeNull();
    });

    it('shows the tooltip again once the pointer comes back', async () => {
        // The suppression covers the interaction that just ended, not the control.
        render_toolbar({ auto_fit_scope_menu: scope_menu() });
        open_caret();

        const first = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
        act(() => {
            first.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true, detail: 1,
            }));
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        dispatch_mouse_event(get_button('Auto-fit Columns'), 'mouseover');
        expect(get_tooltip()).not.toBeNull();
    });

    it('keeps the tooltip for a keyboard activation, which restores focus visibly', () => {
        // detail === 0 is a keyboard activation synthesised as a click; landing back
        // on the chevron with its tooltip is the correct keyboard behaviour.
        render_toolbar({ auto_fit_scope_menu: scope_menu() });
        const caret = open_caret();

        const first = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
        act(() => {
            first.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true, detail: 0,
            }));
        });
        act(() => caret.focus());
        expect(get_tooltip()).not.toBeNull();
    });

    it('does not stack the tooltip on top of the menu it opened', () => {
        render_toolbar({ auto_fit_scope_menu: scope_menu() });

        dispatch_mouse_event(get_button('Auto-fit Columns'), 'mouseover');
        expect(get_tooltip()).not.toBeNull();
        open_caret();
        expect(get_tooltip()).toBeNull();
    });
});
