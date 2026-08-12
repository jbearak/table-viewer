// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStrip } from '../webview/state-strip';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render_strip(props?: Partial<React.ComponentProps<typeof StateStrip>>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const merged_props: React.ComponentProps<typeof StateStrip> = {
        transform: { sort: [], filters: [] },
        transform_disabled: false,
        transform_pending: false,
        column_names: ['Name', 'Value'],
        merges_flattened: false,
        on_transform_change: vi.fn(),
        on_edit_filter: vi.fn(),
        on_cancel_transform: vi.fn(),
        ...props,
    };

    act(() => {
        root!.render(React.createElement(StateStrip, merged_props));
    });

    return {
        container,
        rerender(next_props?: Partial<React.ComponentProps<typeof StateStrip>>) {
            act(() => {
                root!.render(React.createElement(StateStrip, {
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
}

function get_button(label: string): HTMLButtonElement {
    const buttons = Array.from(document.querySelectorAll('button'));
    const button = buttons.find((candidate) => candidate.textContent === label);
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
}

afterEach(() => {
    cleanup();
});

describe('StateStrip', () => {
    it('renders nothing at all when the view is untransformed', () => {
        // Not an empty strip: a band that could show up blank would cost every clean
        // sheet a row of height and would train the reader to skip the region.
        const { container } = render_strip();

        expect(container.querySelector('.state-strip')).toBeNull();
        expect(container.innerHTML).toBe('');
    });

    it('appears for a sort alone, and for a filter alone', () => {
        const { container, rerender } = render_strip({
            transform: { sort: [{ colIndex: 1, direction: 'asc' }], filters: [] },
        });
        expect(container.querySelector('.state-strip')).not.toBeNull();
        expect(container.querySelector('.sort-strip')).not.toBeNull();
        expect(container.querySelector('.filter-strip')).toBeNull();

        rerender({
            transform: {
                sort: [],
                filters: [{
                    id: 'f',
                    colIndex: 1,
                    operator: 'equals',
                    value: '0',
                    caseSensitive: false,
                    enabled: true,
                }],
            },
        });
        expect(container.querySelector('.sort-strip')).toBeNull();
        expect(container.querySelector('.filter-strip')).not.toBeNull();
    });

    it('shows hidden row count and invokes Unhide all', () => {
        const on_unhide_all = vi.fn();
        const { container, rerender } = render_strip({
            hidden_rows: { count: 0, pending: false, on_unhide_all },
        });
        expect(container.textContent).not.toContain('hidden row');

        rerender({
            hidden_rows: { count: 2, pending: false, on_unhide_all },
        });
        expect(container.textContent).toContain('2 hidden rows');
        act(() => get_button('Unhide all').click());
        expect(on_unhide_all).toHaveBeenCalledOnce();
    });

    it('composes chips, progress, cancel, and the merge notice', () => {
        const on_cancel_transform = vi.fn();
        const { container } = render_strip({
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

        // The room the strip has is not an argument for putting the row count back:
        // it was removed from the toolbar as ambiguous (6622eb7), and the ambiguity is
        // in the number rather than in where it sat. This guard came with that removal.
        expect(container.textContent).not.toMatch(/\d+ of \d+ rows/);
        expect(container.textContent).toContain('Hidden active');
        expect(container.textContent).toContain('Applying saved…');
        expect(container.textContent).toContain('Merged cells shown unmerged');
        act(() => get_button('Cancel').click());
        expect(on_cancel_transform).toHaveBeenCalledOnce();

        // Work in flight leaves the chips focusable but inert, so a keyboard user is
        // not dropped out of the strip mid-transform.
        expect((container.querySelector('.sort-chip') as HTMLButtonElement).disabled)
            .toBe(false);
        expect(container.querySelector('.sort-chip')?.getAttribute('aria-disabled'))
            .toBe('true');
        expect((container.querySelector('.filter-chip-body') as HTMLButtonElement).disabled)
            .toBe(false);
        expect(container.querySelector('.filter-chip-body')?.getAttribute('aria-disabled'))
            .toBe('true');
    });

    it('names itself as the worksheet view state for assistive tech', () => {
        const { container } = render_strip({ merges_flattened: true });

        const strip = container.querySelector('.state-strip');
        expect(strip?.getAttribute('role')).toBe('group');
        expect(strip?.getAttribute('aria-label')).toBe('Active view state');
    });
});
