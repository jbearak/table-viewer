// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompareStrip, type CompareStripProps } from '../webview/compare-strip';

const COUNTS = { addedRows: 12, deletedRows: 4, changedRows: 9, changedCells: 37 };

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
});

async function strip(props: Partial<CompareStripProps> = {}): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(CompareStrip, {
            counts: COUNTS,
            degraded: false,
            only_changed_rows: false,
            on_toggle_only_changed_rows: () => {},
            ...props,
        }));
    });
}

const toggle = (): HTMLButtonElement =>
    container!.querySelector('.compare-strip-toggle') as HTMLButtonElement;

const text = (): string => container!.textContent ?? '';

describe('CompareStrip', () => {
    it('states what the comparison found', async () => {
        await strip();
        expect(text()).toMatch(/12 rows added/u);
        expect(text()).toMatch(/4 rows deleted/u);
        expect(text()).toMatch(/37 changed cells/u);
    });

    it('does not say "1 rows"', async () => {
        await strip({
            counts: { addedRows: 1, deletedRows: 1, changedRows: 1, changedCells: 1 },
        });
        expect(text()).toMatch(/1 row added/u);
        expect(text()).toMatch(/1 row deleted/u);
        expect(text()).toMatch(/1 changed cell/u);
        expect(text()).not.toMatch(/1 rows/u);
    });

    it('says so plainly when the files match, and offers nothing to filter', async () => {
        await strip({
            counts: { addedRows: 0, deletedRows: 0, changedRows: 0, changedCells: 0 },
        });
        expect(text()).toContain('No differences found.');
        expect(toggle().disabled).toBe(true);
    });

    it('toggles the filter and reports its state to assistive technology', async () => {
        const on_toggle = vi.fn();
        await strip({ on_toggle_only_changed_rows: on_toggle });
        expect(toggle().getAttribute('aria-pressed')).toBe('false');
        await act(async () => toggle().click());
        expect(on_toggle).toHaveBeenCalledWith(true);
    });

    it('asks to be turned off when it is already on', async () => {
        const on_toggle = vi.fn();
        await strip({ only_changed_rows: true, on_toggle_only_changed_rows: on_toggle });
        expect(toggle().getAttribute('aria-pressed')).toBe('true');
        await act(async () => toggle().click());
        expect(on_toggle).toHaveBeenCalledWith(false);
    });

    it('warns that a degraded comparison overstates the differences', async () => {
        await strip({ degraded: true });
        const status = container!.querySelector('[role="status"]');
        expect(status?.textContent).toMatch(/compared by position/u);
        // Nothing to single out when the rows were never matched up.
        expect(toggle().disabled).toBe(true);
    });

    it('says nothing about alignment when the rows did match up', async () => {
        await strip();
        expect(container!.querySelector('[role="status"]')).toBeNull();
    });

    it('waits for transform work in flight', async () => {
        await strip({ filter_pending: true });
        expect(toggle().disabled).toBe(true);
    });

    it('has no show-changes toggle: the diff is the document', async () => {
        await strip();
        expect(text().toLowerCase()).not.toContain('show changes');
    });
});
