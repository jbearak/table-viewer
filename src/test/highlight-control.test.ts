// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HighlightControl, type HighlightControlProps } from '../webview/highlight-control';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const defaults = (): HighlightControlProps => ({
    active_color: 'yellow',
    on_color_change: vi.fn(),
    on_apply: vi.fn(),
    on_clear: vi.fn(),
    selection_available: true,
    pending: false,
    status: '',
});

async function render(props: Partial<HighlightControlProps> = {}) {
    await act(async () => root.render(React.createElement(HighlightControl, {
        ...defaults(),
        ...props,
    })));
}

async function click(element: Element) {
    await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.className = '';
});

describe('HighlightControl', () => {
    it('renders four named choices with a non-color selected indicator', async () => {
        await render({ active_color: 'blue' });
        await click(container.querySelector('button')!);
        const radios = Array.from(container.querySelectorAll('[role="radio"]'));
        expect(radios.map((radio) => radio.textContent?.trim())).toEqual([
            'Yellow', 'Green', '✓Blue', 'Pink',
        ]);
        expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
            'false', 'false', 'true', 'false',
        ]);
    });

    it('uses roving radio focus and supports arrow, Home, and End keys', async () => {
        const on_color_change = vi.fn();
        await render({ active_color: 'green', on_color_change });
        await click(container.querySelector('.highlight-trigger')!);
        const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
        expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1, -1]);
        expect(document.activeElement).toBe(radios[1]);

        await act(async () => radios[1].dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight', bubbles: true,
        })));
        expect(on_color_change).toHaveBeenLastCalledWith('blue');
        expect(document.activeElement).toBe(radios[2]);

        await act(async () => radios[2].dispatchEvent(new KeyboardEvent('keydown', {
            key: 'End', bubbles: true,
        })));
        expect(on_color_change).toHaveBeenLastCalledWith('pink');
        expect(document.activeElement).toBe(radios[3]);

        await act(async () => radios[3].dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Home', bubbles: true,
        })));
        expect(on_color_change).toHaveBeenLastCalledWith('yellow');
        expect(document.activeElement).toBe(radios[0]);
    });

    it('disables mutations without a selection or while pending', async () => {
        await render({ selection_available: false });
        await click(container.querySelector('button')!);
        expect(Array.from(container.querySelectorAll('.highlight-actions button'))
            .every((button) => (button as HTMLButtonElement).disabled)).toBe(true);

        await render({ selection_available: true, pending: true });
        expect(Array.from(container.querySelectorAll('.highlight-actions button'))
            .every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    });

    it('applies, clears, and restores trigger focus on Escape', async () => {
        const on_apply = vi.fn();
        const on_clear = vi.fn();
        await render({ on_apply, on_clear });
        const trigger = container.querySelector<HTMLButtonElement>('.highlight-trigger')!;
        await click(trigger);
        await click(Array.from(container.querySelectorAll('.highlight-actions button'))[0]);
        expect(on_apply).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(trigger);

        await click(trigger);
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true,
        })));
        expect(container.querySelector('.highlight-popover')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('closes on outside pointer without forcing trigger focus', async () => {
        await render();
        const trigger = container.querySelector<HTMLButtonElement>('.highlight-trigger')!;
        await click(trigger);
        const outside = document.createElement('button');
        document.body.appendChild(outside);
        outside.focus();
        await act(async () => outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
        expect(container.querySelector('.highlight-popover')).toBeNull();
        expect(document.activeElement).toBe(outside);
        outside.remove();
    });
});
