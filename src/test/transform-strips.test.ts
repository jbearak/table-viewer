// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterStrip } from '../webview/filter-strip';
import { SortStrip } from '../webview/sort-strip';

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

function mount(element: React.ReactElement) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(element));
}

function button(text: string): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.trim() === text);
    expect(found).toBeDefined();
    return found!;
}

describe('Raven transform strips', () => {
    it('supports sort flip, move-first, remove, clear-all, and pending disablement', () => {
        const on_change = vi.fn();
        const state = {
            sort: [
                { colIndex: 2, direction: 'asc' as const },
                { colIndex: 0, direction: 'desc' as const },
            ],
            filters: [],
        };
        mount(React.createElement(SortStrip, {
            state,
            column_names: ['A', 'B', 'Hidden sorted'],
            disabled: false,
            on_change,
        }));
        expect(document.body.textContent).toContain('Hidden sorted');
        act(() => (document.querySelectorAll('.sort-chip')[1] as HTMLButtonElement).click());
        act(() => button('Move to first').click());
        expect(on_change).toHaveBeenLastCalledWith({
            ...state,
            sort: [state.sort[1], state.sort[0]],
        });
        act(() => (document.querySelectorAll('.sort-chip')[0] as HTMLButtonElement).click());
        act(() => button('Flip direction').click());
        expect(on_change.mock.calls.at(-1)?.[0].sort[0].direction).toBe('desc');
        act(() => (document.querySelectorAll('.sort-chip')[0] as HTMLButtonElement).click());
        act(() => button('Remove from sort').click());
        expect(on_change.mock.calls.at(-1)?.[0].sort).toEqual([state.sort[1]]);
        act(() => (document.querySelector('[aria-label="Clear all sorts"]') as HTMLButtonElement).click());
        expect(on_change.mock.calls.at(-1)?.[0].sort).toEqual([]);
    });

    it('shows disabled filters, edits from the body, and toggles/removes through the kebab', () => {
        const on_change = vi.fn();
        const on_edit = vi.fn();
        const entry = {
            id: 'f',
            colIndex: 3,
            operator: 'equals' as const,
            value: '0',
            caseSensitive: true,
            enabled: false,
        };
        const state = { sort: [], filters: [entry] };
        mount(React.createElement(FilterStrip, {
            state,
            column_names: ['A', 'B', 'C', 'Hidden filtered'],
            disabled: false,
            on_change,
            on_edit,
        }));
        expect(document.querySelector('.filter-chip.disabled')).not.toBeNull();
        act(() => (document.querySelector('.filter-chip-body') as HTMLButtonElement).click());
        expect(on_edit).toHaveBeenCalledWith(entry, expect.any(HTMLElement));
        act(() => (document.querySelector('.filter-chip-kebab') as HTMLButtonElement).click());
        act(() => button('Enable').click());
        expect(on_change.mock.calls.at(-1)?.[0].filters[0].enabled).toBe(true);
        act(() => (document.querySelector('.filter-chip-kebab') as HTMLButtonElement).click());
        act(() => button('Remove').click());
        expect(on_change.mock.calls.at(-1)?.[0].filters).toEqual([]);
    });

    it('keeps focus in an editor opened from the filter kebab menu', async () => {
        const editor_control = document.createElement('input');
        document.body.appendChild(editor_control);
        const entry = {
            id: 'f', colIndex: 0, operator: 'contains' as const,
            value: 'x', caseSensitive: false, enabled: true,
        };
        mount(React.createElement(FilterStrip, {
            state: { sort: [], filters: [entry] },
            column_names: ['A'],
            disabled: false,
            on_change: vi.fn(),
            on_edit: () => editor_control.focus(),
        }));
        await act(async () => (
            document.querySelector('.filter-chip-kebab') as HTMLButtonElement
        ).click());
        await act(async () => button('Edit').click());
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
        expect(document.activeElement).toBe(editor_control);
        editor_control.remove();
    });

    it('restores filter-menu focus to a guarded chip while pending', async () => {
        const on_change = vi.fn();
        const entry = {
            id: 'f', colIndex: 0, operator: 'contains' as const,
            value: 'x', caseSensitive: false, enabled: true,
        };
        const state = { sort: [], filters: [entry] };
        mount(React.createElement(FilterStrip, {
            state,
            column_names: ['A'],
            disabled: false,
            on_edit: vi.fn(),
            on_change: (next) => {
                on_change(next);
                root!.render(React.createElement(FilterStrip, {
                    state,
                    column_names: ['A'],
                    disabled: true,
                    on_edit: vi.fn(),
                    on_change,
                }));
            },
        }));
        const kebab = document.querySelector('.filter-chip-kebab') as HTMLButtonElement;
        act(() => kebab.click());
        await act(async () => button('Disable').click());
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
        expect(document.activeElement).toBe(kebab);
        expect(kebab.disabled).toBe(false);
        expect(kebab.getAttribute('aria-disabled')).toBe('true');
        act(() => kebab.click());
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(on_change).toHaveBeenCalledOnce();
    });

    it('keeps restoration-target chips focusable but guarded while pending', async () => {
        const on_change = vi.fn();
        const state = { sort: [{ colIndex: 0, direction: 'asc' as const }], filters: [] };
        mount(React.createElement(SortStrip, {
            state,
            column_names: ['A'],
            disabled: false,
            on_change: (next) => {
                on_change(next);
                root!.render(React.createElement(SortStrip, {
                    state,
                    column_names: ['A'],
                    disabled: true,
                    on_change,
                }));
            },
        }));
        const chip = document.querySelector('.sort-chip') as HTMLButtonElement;
        act(() => chip.click());
        await act(async () => button('Flip direction').click());
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
        expect(document.activeElement).toBe(chip);
        expect(chip.disabled).toBe(false);
        expect(chip.getAttribute('aria-disabled')).toBe('true');
        act(() => chip.click());
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(on_change).toHaveBeenCalledOnce();
        expect((document.querySelector('[aria-label="Clear all sorts"]') as HTMLButtonElement).disabled)
            .toBe(true);
    });
});
