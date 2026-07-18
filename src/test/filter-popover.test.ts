// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilterEntry } from '../types';
import { FilterPopover } from '../webview/filter-popover';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

function render_popover(filters: FilterEntry[] = []) {
    const on_apply = vi.fn();
    const on_cancel = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(React.createElement(FilterPopover, {
        column_index: 1,
        column_name: 'Value',
        filters,
        anchor: { left: 10_000, top: 10_000 },
        on_apply,
        on_cancel,
    })));
    return { on_apply, on_cancel };
}

describe('FilterPopover', () => {
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
        expect((document.querySelector('[aria-label="Filter value"]') as HTMLInputElement).value).toBe('0');
        expect((document.querySelector('[aria-label="Second filter value"]') as HTMLInputElement).value).toBe('0');
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
        expect(on_apply).not.toHaveBeenCalled();
    });

    it('dismisses on Escape and outside pointer-down without applying', () => {
        const { on_apply, on_cancel } = render_popover();
        act(() => document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true,
        })));
        expect(on_cancel).toHaveBeenCalledOnce();
        act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
        expect(on_cancel).toHaveBeenCalledTimes(2);
        expect(on_apply).not.toHaveBeenCalled();
    });
});
