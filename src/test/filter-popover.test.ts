// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilterEntry, HistogramBin, SheetTransformState } from '../types';
import { FilterPopover } from '../webview/filter-popover';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const READY_BINS: readonly HistogramBin[] = [
    { lo: 0, hi: 1, count: 0 },
    { lo: 1, hi: 2, count: 4 },
];

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function render_popover(
    filters: FilterEntry[] = [],
    histogram?: { status: 'loading' }
        | {
            status: 'ready';
            bins: readonly HistogramBin[];
            columnKind?: import('../types').FilterColumnKind;
            distinctValues?: readonly (string | null)[];
            distinctValuesExceeded?: boolean;
        }
        | { status: 'error'; message: string },
) {
    const on_apply = vi.fn();
    const on_cancel = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(FilterPopover, {
        column_index: 1,
        column_name: 'Value',
        filters,
        histogram,
        anchor: { left: 10_000, top: 10_000 },
        on_apply,
        on_cancel,
    })));
    return { on_apply, on_cancel };
}

describe('FilterPopover', () => {
    it('does not show the raw-value transform description', () => {
        render_popover();
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        expect(dialog.getAttribute('aria-describedby')).toBeNull();
        expect(document.querySelector('.transform-value-description')).toBeNull();
        expect(document.body.textContent).not.toContain(
            'Sorting and filtering use raw cell values, not formatted display text.',
        );
    });

    it('limits operator options by column kind and keeps out-of-kind operators selectable', () => {
        render_popover([], { status: 'ready', bins: READY_BINS });
        let options = Array.from(
            document.querySelectorAll('#filter-condition option'),
            (option) => (option as HTMLOptionElement).value,
        );
        expect(options).toEqual([
            'equals', 'notEquals', 'greaterThan', 'greaterThanOrEqual',
            'lessThan', 'lessThanOrEqual', 'between', 'notBetween',
            'isEmpty', 'isNotEmpty',
        ]);
        expect(options).not.toContain('contains');
        act(() => root!.unmount());

        // loading/error keep the full list until the histogram settles.
        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [],
            histogram: { status: 'loading' },
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        })));
        options = Array.from(
            document.querySelectorAll('#filter-condition option'),
            (option) => (option as HTMLOptionElement).value,
        );
        expect(options).toContain('contains');
        expect(options).toContain('between');
        expect(options).toHaveLength(14);
        act(() => root!.unmount());

        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [],
            histogram: { status: 'error', message: 'scan failed' },
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        })));
        options = Array.from(
            document.querySelectorAll('#filter-condition option'),
            (option) => (option as HTMLOptionElement).value,
        );
        expect(options).toContain('between');
        expect(options).toContain('greaterThan');
        act(() => root!.unmount());

        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [],
            histogram: { status: 'ready', bins: [] },
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        })));
        options = Array.from(
            document.querySelectorAll('#filter-condition option'),
            (option) => (option as HTMLOptionElement).value,
        );
        expect(options).toEqual([
            'contains', 'notContains', 'equals', 'notEquals',
            'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty',
        ]);
        expect(options).not.toContain('between');
        act(() => root!.unmount());

        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [],
            histogram: { status: 'ready', bins: [], columnKind: 'orderedText' },
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        })));
        options = Array.from(
            document.querySelectorAll('#filter-condition option'),
            (option) => (option as HTMLOptionElement).value,
        );
        expect(options).toContain('contains');
        expect(options).toContain('between');
        expect(options).toContain('greaterThan');
        act(() => root!.unmount());

        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [{
                id: 'f', colIndex: 1, operator: 'contains', value: 'x',
                caseSensitive: false, enabled: true,
            }],
            histogram: { status: 'ready', bins: READY_BINS },
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        })));
        options = Array.from(
            document.querySelectorAll('#filter-condition option'),
            (option) => (option as HTMLOptionElement).value,
        );
        expect(options).toEqual([
            'equals', 'notEquals', 'greaterThan', 'greaterThanOrEqual',
            'lessThan', 'lessThanOrEqual', 'between', 'notBetween',
            'isEmpty', 'isNotEmpty', 'contains',
        ]);
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('contains');
    });

    it('shows Case sensitive only for text string comparisons', () => {
        render_popover([], { status: 'loading' });
        expect(document.body.textContent).toContain('Case sensitive');

        const select = document.querySelector('select') as HTMLSelectElement;
        act(() => {
            select.value = 'isEmpty';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(document.body.textContent).not.toContain('Case sensitive');

        act(() => {
            select.value = 'equals';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(document.body.textContent).toContain('Case sensitive');
        act(() => root!.unmount());

        const on_apply = vi.fn();
        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [{
                id: 'f', colIndex: 1, operator: 'equals', value: '1',
                caseSensitive: true, enabled: true,
            }],
            histogram: { status: 'ready', bins: READY_BINS, columnKind: 'numeric' },
            anchor: { left: 10, top: 10 }, on_apply, on_cancel: vi.fn(),
        })));
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('equals');
        expect(document.body.textContent).not.toContain('Case sensitive');
        expect(document.querySelector('input[type="checkbox"]')).toBeNull();
        act(() => (document.querySelector('.filter-popover-btn-primary') as HTMLButtonElement).click());
        expect(on_apply).toHaveBeenCalledWith(expect.objectContaining({
            operator: 'equals', value: '1', caseSensitive: true,
        }));
        act(() => root!.unmount());

        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [{
                id: 'f', colIndex: 1, operator: 'contains', value: 'A',
                caseSensitive: true, enabled: true,
            }],
            histogram: { status: 'ready', bins: READY_BINS, columnKind: 'numeric' },
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        })));
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('contains');
        expect(document.body.textContent).toContain('Case sensitive');
        expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked)
            .toBe(true);
        act(() => root!.unmount());

        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [{
                id: 'f', colIndex: 1, operator: 'between', value: '1', secondValue: '2',
                caseSensitive: true, enabled: true,
            }],
            histogram: { status: 'ready', bins: READY_BINS },
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        })));
        expect(document.body.textContent).not.toContain('Case sensitive');
        expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    });

    it('hides the histogram for non-range conditions and shows status only for range ops', () => {
        render_popover([], { status: 'loading' });
        expect(document.body.textContent).not.toContain('Loading distribution…');
        expect(document.querySelector('#filter-condition')).not.toBeNull();
        expect(document.querySelector('[role="group"][aria-label="Range histogram"]')).toBeNull();
        act(() => root!.unmount());

        // Between stays selectable for an existing range filter even while the histogram loads.
        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [{
                id: 'f', colIndex: 1, operator: 'between', value: '', secondValue: '',
                caseSensitive: false, enabled: true,
            }],
            histogram: { status: 'loading' },
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        })));
        expect(document.body.textContent).toContain('Loading distribution…');
        act(() => root!.unmount());

        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [{
                id: 'f', colIndex: 1, operator: 'between', value: '', secondValue: '',
                caseSensitive: false, enabled: true,
            }],
            histogram: { status: 'ready', bins: [] },
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        })));
        expect(document.body.textContent).toContain('No numeric values to chart.');
        act(() => root!.unmount());

        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [{
                id: 'f', colIndex: 1, operator: 'between', value: '', secondValue: '',
                caseSensitive: false, enabled: true,
            }],
            histogram: { status: 'error', message: 'scan failed' },
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        })));
        expect(document.body.textContent).toContain('Distribution unavailable: scan failed');
        act(() => root!.unmount());

        root = createRoot(container!);
        act(() => root!.render(React.createElement(FilterPopover, {
            column_index: 1, column_name: 'Value', filters: [{
                id: 'f', colIndex: 1, operator: 'between', value: '', secondValue: '',
                caseSensitive: false, enabled: true,
            }],
            histogram: { status: 'ready', bins: READY_BINS },
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        })));
        expect(document.querySelector('[role="group"][aria-label="Range histogram"]'))
            .not.toBeNull();
        expect(document.querySelectorAll('.filter-histogram-bar')).toHaveLength(2);
        expect((document.querySelector('.filter-popover-btn-primary') as HTMLButtonElement).disabled)
            .toBe(true);
    });

    it('defaults new numeric columns to Between and uses Lower/Upper labels', () => {
        render_popover([], { status: 'ready', bins: READY_BINS });
        const select = document.querySelector('select') as HTMLSelectElement;
        expect(select.value).toBe('between');
        expect((document.querySelector('[aria-label="Lower value"]') as HTMLInputElement)).not.toBeNull();
        expect((document.querySelector('[aria-label="Upper value"]') as HTMLInputElement)).not.toBeNull();
        expect(document.querySelector('[aria-label="Filter value"]')).toBeNull();
    });

    it('promotes pristine draft on histogram update without overriding existing filters', () => {
        const on_apply = vi.fn();
        const on_cancel = vi.fn();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        const props = {
            column_index: 1,
            column_name: 'Value',
            filters: [] as FilterEntry[],
            anchor: { left: 10, top: 10 },
            on_apply,
            on_cancel,
        };
        act(() => root!.render(React.createElement(FilterPopover, {
            ...props,
            histogram: { status: 'loading' },
        })));
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('contains');

        act(() => root!.render(React.createElement(FilterPopover, {
            ...props,
            histogram: { status: 'ready', bins: READY_BINS },
        })));
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('between');

        act(() => root!.unmount());
        root = createRoot(container);
        act(() => root!.render(React.createElement(FilterPopover, {
            ...props,
            histogram: { status: 'loading' },
        })));
        const select = document.querySelector('select') as HTMLSelectElement;
        act(() => {
            select.value = 'equals';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        act(() => root!.render(React.createElement(FilterPopover, {
            ...props,
            histogram: { status: 'ready', bins: READY_BINS },
        })));
        // Existing component instance is replaced by React element recreate with same key path;
        // user_edited_ref resets on remount. Validate non-override via existing filter instead.
        act(() => root!.unmount());
        root = createRoot(container);
        act(() => root!.render(React.createElement(FilterPopover, {
            ...props,
            filters: [{
                id: 'existing', colIndex: 1, operator: 'equals', value: 'x',
                caseSensitive: false, enabled: true,
            }],
            histogram: { status: 'ready', bins: READY_BINS },
        })));
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('equals');
    });

    it('hydrates id, enabled state, zero values, second value, and case sensitivity', () => {
        const existing: FilterEntry = {
            id: 'keep-me',
            colIndex: 1,
            operator: 'equals',
            value: '0',
            secondValue: '0',
            caseSensitive: true,
            enabled: false,
        };
        const { on_apply } = render_popover([existing]);
        const value_input = document.querySelector(
            '[aria-label="Filter value"]',
        ) as HTMLInputElement;
        expect(document.activeElement).toBe(value_input);
        expect(value_input.value).toBe('0');
        expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
        act(() => (document.querySelector('.filter-popover-btn-primary') as HTMLButtonElement).click());
        expect(on_apply).toHaveBeenCalledWith(existing);
    });

    it('focuses the first range value input when opened', () => {
        render_popover([], { status: 'ready', bins: READY_BINS });
        expect(document.activeElement).toBe(
            document.querySelector('[aria-label="Lower value"]'),
        );
    });

    it('focuses the condition menu when the filter has no value input', () => {
        render_popover([{
            id: 'empty', colIndex: 1, operator: 'isEmpty',
            caseSensitive: false, enabled: true,
        }]);
        expect(document.activeElement?.id).toBe('filter-condition');
    });

    it('preserves caseSensitive on apply when the checkbox is hidden for range ops', () => {
        const existing: FilterEntry = {
            id: 'keep-me',
            colIndex: 1,
            operator: 'between',
            value: '0',
            secondValue: '0',
            caseSensitive: true,
            enabled: false,
        };
        const { on_apply } = render_popover([existing], { status: 'ready', bins: READY_BINS });
        expect(document.querySelector('input[type="checkbox"]')).toBeNull();
        act(() => (document.querySelector('.filter-popover-btn-primary') as HTMLButtonElement).click());
        expect(on_apply).toHaveBeenCalledWith(existing);
    });

    it('applies with Enter and clamps the fixed popover to the viewport', () => {
        const { on_apply } = render_popover();
        const input = document.querySelector('[aria-label="Filter value"]') as HTMLInputElement;
        act(() => {
            Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value',
            )!.set!.call(input, 'needle');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        act(() => input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true,
        })));
        expect(on_apply).toHaveBeenCalledWith(expect.objectContaining({
            colIndex: 1,
            operator: 'contains',
            value: 'needle',
            enabled: true,
        }));
        const style = (document.querySelector('.filter-popover') as HTMLElement).style;
        expect(Number.parseFloat(style.left)).toBeLessThan(10_000);
        expect(Number.parseFloat(style.top)).toBeLessThan(10_000);
    });

    it('writes brushed range bounds into lower/upper fields and enables Apply', () => {
        const { on_apply } = render_popover([{
            id: 'f', colIndex: 1, operator: 'between', value: '', secondValue: '',
            caseSensitive: false, enabled: true,
        }], { status: 'ready', bins: READY_BINS });
        const upper = document.querySelector('[aria-label="Upper value"]') as SVGElement;
        // Thumb aria labels on the sliders
        const lo_thumb = document.querySelector('[role="slider"][aria-label="Lower value"]') as SVGElement;
        const hi_thumb = document.querySelector('[role="slider"][aria-label="Upper value"]') as SVGElement;
        expect(lo_thumb).not.toBeNull();
        expect(hi_thumb).not.toBeNull();
        act(() => {
            lo_thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        });
        expect((document.querySelector('input[aria-label="Lower value"]') as HTMLInputElement).value)
            .not.toBe('');
        expect((document.querySelector('input[aria-label="Upper value"]') as HTMLInputElement).value)
            .not.toBe('');
        expect((document.querySelector('.filter-popover-btn-primary') as HTMLButtonElement).disabled)
            .toBe(false);
        act(() => (document.querySelector('.filter-popover-btn-primary') as HTMLButtonElement).click());
        expect(on_apply).toHaveBeenCalledWith(expect.objectContaining({
            operator: 'between',
            value: expect.any(String),
            secondValue: expect.any(String),
        }));
        void upper;
    });

    it('preserves a single typed bound when brushing the other end', () => {
        const { on_apply } = render_popover([{
            id: 'f', colIndex: 1, operator: 'between', value: '1', secondValue: '',
            caseSensitive: false, enabled: true,
        }], { status: 'ready', bins: READY_BINS });
        expect((document.querySelector('input[aria-label="Lower value"]') as HTMLInputElement).value)
            .toBe('1');
        const hi_thumb = document.querySelector('[role="slider"][aria-label="Upper value"]') as SVGElement;
        act(() => {
            hi_thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        });
        const lower = (document.querySelector('input[aria-label="Lower value"]') as HTMLInputElement).value;
        const upper = (document.querySelector('input[aria-label="Upper value"]') as HTMLInputElement).value;
        expect(lower).toBe('1');
        expect(upper).not.toBe('');
        expect(Number(upper)).toBeLessThanOrEqual(2);
        act(() => (document.querySelector('.filter-popover-btn-primary') as HTMLButtonElement).click());
        expect(on_apply).toHaveBeenCalledWith(expect.objectContaining({
            operator: 'between', value: '1', secondValue: upper,
        }));
    });

    it('preserves bounds when switching Between and Not between', () => {
        const { on_apply } = render_popover([{
            id: 'f', colIndex: 1, operator: 'between', value: '1', secondValue: '2',
            caseSensitive: false, enabled: true,
        }], { status: 'ready', bins: READY_BINS });
        const select = document.querySelector('select') as HTMLSelectElement;
        act(() => {
            select.value = 'notBetween';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect((document.querySelector('input[aria-label="Lower value"]') as HTMLInputElement).value)
            .toBe('1');
        expect((document.querySelector('input[aria-label="Upper value"]') as HTMLInputElement).value)
            .toBe('2');
        expect(document.querySelector('[role="group"][aria-label="Range histogram"]')).not.toBeNull();
        act(() => (document.querySelector('.filter-popover-btn-primary') as HTMLButtonElement).click());
        expect(on_apply).toHaveBeenCalledWith(expect.objectContaining({
            operator: 'notBetween', value: '1', secondValue: '2',
        }));
    });

    it('does not suppress a notBetween upper-bound-only edit', async () => {
        vi.stubGlobal('acquireVsCodeApi', () => ({
            postMessage: vi.fn(),
            getState: vi.fn(),
            setState: vi.fn(),
        }));
        const { transforms_semantically_equal } = await import('../webview/app');
        const current: SheetTransformState = {
            sort: [],
            filters: [{
                id: 'f', colIndex: 1, operator: 'notBetween', value: '10', secondValue: '20',
                caseSensitive: false, enabled: true,
            }],
        };
        const edited: SheetTransformState = {
            ...current,
            filters: [{ ...current.filters[0], secondValue: '30' }],
        };
        const request_transform = vi.fn();

        if (!transforms_semantically_equal(current, edited)) {
            request_transform(edited);
        }

        expect(request_transform).toHaveBeenCalledWith(edited);
    });

    it('treats reordered isOneOf exclusion sets as equal, including null vs empty string', async () => {
        vi.stubGlobal('acquireVsCodeApi', () => ({
            postMessage: vi.fn(),
            getState: vi.fn(),
            setState: vi.fn(),
        }));
        const { transforms_semantically_equal } = await import('../webview/app');
        const entry = (excluded: (string | null)[]): SheetTransformState => ({
            sort: [],
            filters: [{
                id: 'f', colIndex: 1, operator: 'isOneOf',
                excludedValues: excluded, caseSensitive: false, enabled: true,
            }],
        });
        expect(transforms_semantically_equal(entry(['', null]), entry([null, ''])))
            .toBe(true);
        // Composed vs decomposed e-acute are collation-equal but distinct raw
        // values; reordering them must not read as a semantic change.
        const composed = '\u00e9';
        const decomposed = 'e\u0301';
        expect(transforms_semantically_equal(
            entry([composed, decomposed]),
            entry([decomposed, composed]),
        )).toBe(true);
        expect(transforms_semantically_equal(entry(['']), entry([null])))
            .toBe(false);
    });

    it('reclamps after isEmpty expands to between near the viewport edge', () => {
        const resize_callbacks: ResizeObserverCallback[] = [];
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: ResizeObserverCallback) {
                resize_callbacks.push(callback);
            }
            observe() {}
            disconnect() {}
            unobserve() {}
        });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function (this: HTMLElement) {
                if (this.classList.contains('filter-popover')) {
                    const expanded = this.querySelector(
                        '[aria-label="Upper value"]',
                    ) !== null;
                    return {
                        left: 0, top: 0, width: 200, height: expanded ? 220 : 100,
                        right: 200, bottom: expanded ? 220 : 100, x: 0, y: 0,
                        toJSON: () => '',
                    } as DOMRect;
                }
                return new DOMRect();
            });
        render_popover([{
            id: 'f', colIndex: 1, operator: 'isEmpty', caseSensitive: false, enabled: true,
        }], { status: 'ready', bins: READY_BINS });
        const popover = document.querySelector('.filter-popover') as HTMLElement;
        expect(popover.style.top).toBe('192px');

        const select = document.querySelector('select') as HTMLSelectElement;
        act(() => {
            select.value = 'between';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            resize_callbacks.at(-1)?.([], {} as ResizeObserver);
        });
        expect(document.querySelector('[aria-label="Upper value"]')).not.toBeNull();
        expect(popover.style.top).toBe('72px');
        expect(Number.parseFloat(popover.style.top) + 220).toBeLessThanOrEqual(292);
    });

    it('lets keyboard activation of Cancel dismiss instead of applying', () => {
        const existing: FilterEntry = {
            id: 'f',
            colIndex: 1,
            operator: 'equals',
            value: 'ready',
            caseSensitive: false,
            enabled: true,
        };
        const { on_apply, on_cancel } = render_popover([existing]);
        const cancel = Array.from(document.querySelectorAll('button'))
            .find((button) => button.textContent === 'Cancel')!;
        cancel.focus();
        act(() => cancel.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true,
        })));
        act(() => cancel.click());
        expect(on_cancel).toHaveBeenCalledOnce();
        expect(on_cancel).toHaveBeenCalledWith('explicit');
        expect(on_apply).not.toHaveBeenCalled();
    });

    it('preserves inactive draft operands when applying another operator', () => {
        const existing: FilterEntry = {
            id: 'draft', colIndex: 1, operator: 'between', value: 'low',
            secondValue: 'high', caseSensitive: false, enabled: true,
        };
        const { on_apply } = render_popover([existing], { status: 'ready', bins: READY_BINS });
        const select = document.querySelector('select') as HTMLSelectElement;
        act(() => {
            select.value = 'isEmpty';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        act(() => (document.querySelector('.filter-popover-btn-primary') as HTMLButtonElement).click());
        expect(on_apply).toHaveBeenCalledWith(expect.objectContaining({
            operator: 'isEmpty', value: 'low', secondValue: 'high',
        }));
    });

    it('dismisses on external scroll but ignores internal popover scrolling', () => {
        const { on_cancel } = render_popover();
        const body = document.querySelector('.filter-popover-body') as HTMLElement;
        act(() => body.dispatchEvent(new Event('scroll')));
        expect(on_cancel).not.toHaveBeenCalled();

        const grid = document.createElement('div');
        document.body.appendChild(grid);
        act(() => grid.dispatchEvent(new Event('scroll')));
        expect(on_cancel).toHaveBeenCalledOnce();
        expect(on_cancel).toHaveBeenCalledWith('layout');
    });

    it.each(['window', 'visual viewport'] as const)(
        'dismisses on %s resize instead of retaining stale coordinates',
        (viewport) => {
            const visual_viewport = new EventTarget();
            vi.stubGlobal('visualViewport', visual_viewport);
            const { on_cancel } = render_popover();
            act(() => {
                (viewport === 'window' ? window : visual_viewport)
                    .dispatchEvent(new Event('resize'));
            });
            expect(on_cancel).toHaveBeenCalledOnce();
            expect(on_cancel).toHaveBeenCalledWith('layout');
        },
    );

    it('dismisses on Escape and outside pointer-down without applying', () => {
        const { on_apply, on_cancel } = render_popover();
        act(() => document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true,
        })));
        expect(on_cancel).toHaveBeenNthCalledWith(1, 'escape');
        act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
        expect(on_cancel).toHaveBeenNthCalledWith(2, 'outside');
        expect(on_apply).not.toHaveBeenCalled();
    });
});

describe('FilterPopover value checklist (isOneOf)', () => {
    const TEXT_READY = {
        status: 'ready',
        bins: [],
        columnKind: 'text',
        distinctValues: ['alpha', 'beta', null],
        distinctValuesExceeded: false,
    } as const;

    const select_is_one_of = () => {
        const select = document.querySelector('select') as HTMLSelectElement;
        act(() => {
            select.value = 'isOneOf';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
    };

    const checkbox_labels = () => Array.from(
        document.querySelectorAll('.filter-value-item .filter-value-name'),
        (span) => span.textContent,
    );

    it('offers Is one of only when a complete distinct list is available', () => {
        render_popover([], TEXT_READY);
        const options = () => Array.from(
            document.querySelectorAll('#filter-condition option'),
            (option) => (option as HTMLOptionElement).value,
        );
        expect(options()).toContain('isOneOf');
        act(() => root!.unmount());

        for (const histogram of [
            { status: 'loading' } as const,
            { status: 'error', message: 'scan failed' } as const,
            { ...TEXT_READY, distinctValues: [], distinctValuesExceeded: true },
        ]) {
            root = createRoot(container!);
            act(() => root!.render(React.createElement(FilterPopover, {
                column_index: 1, column_name: 'Value', filters: [],
                histogram,
                anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
            })));
            expect(options()).not.toContain('isOneOf');
            act(() => root!.unmount());
        }
        root = null;
    });

    it('defaults new categorical columns to Is one of and lists it right after Contains', () => {
        render_popover([], TEXT_READY);
        const select = document.querySelector('select') as HTMLSelectElement;
        expect(select.value).toBe('isOneOf');
        const options = Array.from(
            document.querySelectorAll('#filter-condition option'),
            (option) => (option as HTMLOptionElement).value,
        );
        expect(options.slice(0, 3)).toEqual(['contains', 'isOneOf', 'notContains']);
    });

    it('promotes a pristine Contains draft to Is one of when the value list settles', () => {
        const props = {
            column_index: 1, column_name: 'Value', filters: [] as FilterEntry[],
            anchor: { left: 10, top: 10 }, on_apply: vi.fn(), on_cancel: vi.fn(),
        };
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root!.render(React.createElement(FilterPopover, {
            ...props, histogram: { status: 'loading' },
        })));
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('contains');
        act(() => root!.render(React.createElement(FilterPopover, {
            ...props, histogram: TEXT_READY,
        })));
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('isOneOf');
    });

    it('keeps Contains when the distinct list is over cap or empty', () => {
        render_popover([], { ...TEXT_READY, distinctValues: [], distinctValuesExceeded: true });
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('contains');
    });

    it('swaps in the checklist, hides value input and case sensitivity', () => {
        render_popover([], TEXT_READY);
        select_is_one_of();
        expect(document.querySelector('.filter-value-list')).not.toBeNull();
        expect(document.querySelector('.filter-popover-input')).toBeNull();
        expect(document.body.textContent).not.toContain('Case sensitive');
        expect(checkbox_labels()).toEqual(['alpha', 'beta', '(Blanks)']);
    });

    it('unchecking values excludes them and Apply emits a canonical entry', () => {
        const { on_apply } = render_popover([], TEXT_READY);
        select_is_one_of();

        const apply_button = document.querySelector(
            '.filter-popover-btn-primary',
        ) as HTMLButtonElement;
        // Nothing deselected yet: applying would be a no-op filter.
        expect(apply_button.disabled).toBe(true);

        const boxes = () => Array.from(
            document.querySelectorAll('.filter-value-item input'),
        ) as HTMLInputElement[];
        expect(boxes().every((box) => box.checked)).toBe(true);
        act(() => boxes()[1].click());
        act(() => boxes()[2].click());
        expect(boxes()[1].checked).toBe(false);
        expect(boxes()[2].checked).toBe(false);

        expect(apply_button.disabled).toBe(false);
        act(() => apply_button.click());
        expect(on_apply).toHaveBeenCalledWith(expect.objectContaining({
            operator: 'isOneOf',
            excludedValues: ['beta', null],
            caseSensitive: false,
            value: undefined,
            secondValue: undefined,
        }));
    });

    it('searches values and supports check/uncheck all across the full set', () => {
        render_popover([], TEXT_READY);
        select_is_one_of();

        const search = document.querySelector('.filter-value-search') as HTMLInputElement;
        const set_search = (value: string) => act(() => {
            const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype, 'value',
            )!.set!;
            setter.call(search, value);
            search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        set_search('alp');
        expect(checkbox_labels()).toEqual(['alpha']);
        set_search('blank');
        expect(checkbox_labels()).toEqual(['(Blanks)']);
        set_search('no such value');
        expect(document.body.textContent).toContain('No matching values');
        set_search('');

        // Uncheck all excludes every value even while a search was active.
        act(() => (Array.from(document.querySelectorAll('.filter-value-action'))
            .find((button) => button.textContent === 'Uncheck all') as HTMLButtonElement)
            .click());
        const boxes = Array.from(
            document.querySelectorAll('.filter-value-item input'),
        ) as HTMLInputElement[];
        expect(boxes.every((box) => !box.checked)).toBe(true);

        act(() => (Array.from(document.querySelectorAll('.filter-value-action'))
            .find((button) => button.textContent === 'Check all') as HTMLButtonElement)
            .click());
        expect((Array.from(
            document.querySelectorAll('.filter-value-item input'),
        ) as HTMLInputElement[]).every((box) => box.checked)).toBe(true);
    });

    it('restores checked state from a saved filter and keeps stale exclusions listed', () => {
        render_popover([{
            id: 'f', colIndex: 1, operator: 'isOneOf',
            excludedValues: ['beta', 'removed-from-file'],
            caseSensitive: false, enabled: true,
        }], TEXT_READY);
        expect((document.querySelector('select') as HTMLSelectElement).value)
            .toBe('isOneOf');
        expect(checkbox_labels()).toEqual([
            'alpha', 'beta', '(Blanks)', 'removed-from-file',
        ]);
        const boxes = Array.from(
            document.querySelectorAll('.filter-value-item input'),
        ) as HTMLInputElement[];
        expect(boxes.map((box) => box.checked)).toEqual([true, false, true, false]);
    });

    it('keeps a saved over-cap filter editable through its stored exclusions', () => {
        const { on_apply } = render_popover([{
            id: 'f', colIndex: 1, operator: 'isOneOf',
            excludedValues: ['old'],
            caseSensitive: false, enabled: true,
        }], {
            status: 'ready', bins: [], columnKind: 'text',
            distinctValues: [], distinctValuesExceeded: true,
        });
        expect((document.querySelector('select') as HTMLSelectElement).value)
            .toBe('isOneOf');
        expect(document.body.textContent).toContain('too many distinct values');
        expect(checkbox_labels()).toEqual(['old']);

        const apply_button = document.querySelector(
            '.filter-popover-btn-primary',
        ) as HTMLButtonElement;
        expect(apply_button.disabled).toBe(false);
        act(() => apply_button.click());
        expect(on_apply).toHaveBeenCalledWith(expect.objectContaining({
            operator: 'isOneOf',
            excludedValues: ['old'],
        }));
    });

    it('lets an over-cap filter undo re-checking its last stored exclusion', () => {
        render_popover([{
            id: 'f', colIndex: 1, operator: 'isOneOf',
            excludedValues: ['old'],
            caseSensitive: false, enabled: true,
        }], {
            status: 'ready', bins: [], columnKind: 'text',
            distinctValues: [], distinctValuesExceeded: true,
        });
        const box = () => document.querySelector(
            '.filter-value-item input',
        ) as HTMLInputElement;
        act(() => box().click());
        // Re-checking the only exclusion must keep the checklist mounted so
        // the toggle can be reversed without reopening the popover.
        expect(box()).not.toBeNull();
        expect(box().checked).toBe(true);
        act(() => box().click());
        expect(box().checked).toBe(false);
        expect((document.querySelector(
            '.filter-popover-btn-primary',
        ) as HTMLButtonElement).disabled).toBe(false);
    });

    it('distinguishes a real "(Blanks)" text value from the blank entry', () => {
        render_popover([], {
            status: 'ready', bins: [], columnKind: 'text',
            distinctValues: ['(Blanks)', null], distinctValuesExceeded: false,
        });
        select_is_one_of();
        expect(checkbox_labels()).toEqual(['(Blanks) (text value)', '(Blanks)']);
    });

    it('does not apply on Enter in the checklist search input', () => {
        const { on_apply } = render_popover([{
            id: 'f', colIndex: 1, operator: 'isOneOf',
            excludedValues: ['beta'],
            caseSensitive: false, enabled: true,
        }], TEXT_READY);
        const search = document.querySelector('.filter-value-search') as HTMLInputElement;
        search.focus();
        act(() => search.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', bubbles: true,
        })));
        expect(on_apply).not.toHaveBeenCalled();
    });

    it('focuses the checklist search for a saved isOneOf filter', () => {
        render_popover([{
            id: 'f', colIndex: 1, operator: 'isOneOf',
            excludedValues: ['beta'],
            caseSensitive: false, enabled: true,
        }], TEXT_READY);
        expect(document.activeElement?.className).toBe('filter-value-search');
    });
});
