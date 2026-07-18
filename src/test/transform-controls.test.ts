// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SheetTransformState } from '../types';
import { TransformControls } from '../webview/transform-controls';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_STATE: SheetTransformState = {
    sort: [],
    filters: [],
};

async function render_controls(
    state: SheetTransformState,
    props?: Partial<React.ComponentProps<typeof TransformControls>>,
) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const on_change = props?.on_change ?? vi.fn();
    await act(async () => {
        root!.render(
            React.createElement(TransformControls, {
                state,
                column_names: ['A', 'B', 'C', 'D'],
                disabled: false,
                pending: false,
                row_count: 4,
                source_row_count: 4,
                merges_flattened: false,
                on_change,
                on_cancel_pending: vi.fn(),
                ...props,
            }),
        );
    });
    return { on_change };
}

function button_named(name: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.trim() === name);
    if (!button) throw new Error(`button "${name}" not found`);
    return button;
}

async function click(element: HTMLElement): Promise<void> {
    await act(async () => element.click());
}

async function change_select(
    select: HTMLSelectElement,
    value: string,
): Promise<void> {
    await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

afterEach(async () => {
    if (root) {
        await act(async () => root!.unmount());
    }
    container?.remove();
    root = null;
    container = null;
});

describe('TransformControls', () => {
    it('hydrates existing filters on open and column switch without losing IDs or zero values', async () => {
        const state: SheetTransformState = {
            sort: [],
            filters: [{
                id: 'saved-filter',
                colIndex: 0,
                operator: 'between',
                value: '0',
                secondValue: '10',
                caseSensitive: true,
                enabled: false,
            }],
        };
        const { on_change } = await render_controls(state);

        const opener = button_named('Filter');
        expect(opener.getAttribute('aria-expanded')).toBe('false');
        await click(opener);
        expect(opener.getAttribute('aria-expanded')).toBe('true');

        const selects = () => [
            ...Array.from(document.querySelectorAll<HTMLSelectElement>(
                '#transform-filter-editor select',
            )),
        ];
        expect(selects()[0].value).toBe('0');
        expect(selects()[1].value).toBe('between');
        expect((document.querySelector(
            'input[aria-label="Filter value"]',
        ) as HTMLInputElement).value).toBe('0');
        expect((document.querySelector(
            'input[aria-label="Second filter value"]',
        ) as HTMLInputElement).value).toBe('10');
        expect((document.querySelector(
            '.transform-checkbox input',
        ) as HTMLInputElement).checked).toBe(true);

        await change_select(selects()[0], '1');
        expect(selects()[1].value).toBe('contains');
        expect((document.querySelector(
            'input[aria-label="Filter value"]',
        ) as HTMLInputElement).value).toBe('');
        expect((document.querySelector(
            '.transform-checkbox input',
        ) as HTMLInputElement).checked).toBe(false);

        await change_select(selects()[0], '0');
        expect(selects()[1].value).toBe('between');
        expect((document.querySelector(
            'input[aria-label="Filter value"]',
        ) as HTMLInputElement).value).toBe('0');

        await click(button_named('Apply'));
        expect(on_change).toHaveBeenCalledWith({
            ...state,
            filters: [expect.objectContaining({
                id: 'saved-filter',
                colIndex: 0,
                value: '0',
                secondValue: '10',
                enabled: false,
            })],
        });
    });

    it('exposes toggle state, editor expansion, and descriptive chip actions', async () => {
        const on_change = vi.fn();
        const state: SheetTransformState = {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [{
                id: 'filter-a',
                colIndex: 1,
                operator: 'equals',
                value: '0',
                caseSensitive: false,
                enabled: true,
            }],
        };
        await render_controls(state, { on_change });

        const sort_opener = button_named('Sort');
        expect(sort_opener.getAttribute('aria-expanded')).toBe('false');
        await click(sort_opener);
        expect(sort_opener.getAttribute('aria-expanded')).toBe('true');
        expect(document.querySelector('#transform-sort-editor')).not.toBeNull();

        const sort_chip = document.querySelector<HTMLButtonElement>(
            'div.transform-chip button[aria-label^="Sort priority"]',
        )!;
        expect(sort_chip.getAttribute('aria-label')).toContain(
            'Sort priority 1 on A, ascending; change to descending',
        );

        const filter_chip = document.querySelector<HTMLButtonElement>(
            'div.transform-chip button[aria-pressed]',
        )!;
        expect(filter_chip.getAttribute('aria-pressed')).toBe('true');
        expect(filter_chip.getAttribute('aria-label')).toContain(
            'Toggle filter: B equals “0”',
        );
        await click(filter_chip);
        expect(on_change).toHaveBeenCalledWith({
            ...state,
            filters: [{ ...state.filters[0], enabled: false }],
        });
    });

    it('shows the merge warning whenever the rendered grid is flattened', async () => {
        await render_controls(EMPTY_STATE, { merges_flattened: true });
        expect(document.body.textContent).toContain('Merged cells shown unmerged');
    });

    it('selects the first unsorted column and associates disabled reasons', async () => {
        const state: SheetTransformState = {
            ...EMPTY_STATE,
            sort: [
                { colIndex: 0, direction: 'asc' },
                { colIndex: 1, direction: 'desc' },
                { colIndex: 2, direction: 'asc' },
            ],
        };
        await render_controls(state);
        await click(button_named('Sort'));
        expect((document.querySelector(
            '#transform-sort-editor select',
        ) as HTMLSelectElement).value).toBe('3');

        await act(async () => {
            root!.render(
                React.createElement(TransformControls, {
                    state: EMPTY_STATE,
                    column_names: ['A'],
                    disabled: true,
                    disabled_reason: 'Unavailable while editing',
                    pending: false,
                    row_count: 1,
                    source_row_count: 1,
                    merges_flattened: false,
                    on_change: vi.fn(),
                    on_cancel_pending: vi.fn(),
                }),
            );
        });
        const sort_disabled = button_named('Sort');
        expect(sort_disabled.disabled).toBe(true);
        expect(sort_disabled.getAttribute('aria-describedby')).toBe(
            'transform-disabled-reason',
        );
        expect(document.querySelector('#transform-disabled-reason')?.textContent)
            .toBe('Unavailable while editing');
    });
});
