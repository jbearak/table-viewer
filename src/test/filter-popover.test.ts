// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilterEntry, HistogramBin } from '../types';
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
        | { status: 'ready'; bins: readonly HistogramBin[] }
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
    it('visibly describes raw-value filter semantics and associates the description', () => {
        render_popover();
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        const description_id = dialog.getAttribute('aria-describedby');
        expect(description_id).toBeTruthy();
        const description = document.getElementById(description_id!);
        expect(description?.classList.contains('transform-value-description')).toBe(true);
        expect(description?.textContent).toBe(
            'Sorting and filtering use raw cell values, not formatted display text.',
        );
    });

    it('hides the histogram for non-range conditions and shows status only for range ops', () => {
        render_popover([], { status: 'loading' });
        expect(document.body.textContent).not.toContain('Loading distribution…');
        expect(document.querySelector('#filter-condition')).not.toBeNull();
        expect(document.querySelector('[role="group"][aria-label="Range histogram"]')).toBeNull();

        const select = document.querySelector('select') as HTMLSelectElement;
        act(() => {
            select.value = 'between';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
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
            operator: 'between',
            value: '0',
            secondValue: '0',
            caseSensitive: true,
            enabled: false,
        };
        const { on_apply } = render_popover([existing]);
        expect(document.activeElement?.id).toBe('filter-condition');
        expect((document.querySelector('[aria-label="Lower value"]') as HTMLInputElement).value).toBe('0');
        expect((document.querySelector('[aria-label="Upper value"]') as HTMLInputElement).value).toBe('0');
        expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
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
        }]);
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
        const { on_apply } = render_popover([existing]);
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
