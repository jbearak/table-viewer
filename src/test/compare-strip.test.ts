// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompareStrip, type CompareStripProps } from '../webview/compare-strip';

const COUNTS = { addedRows: 12, deletedRows: 4, movedRows: 0, changedCells: 37 };

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
            counts: { addedRows: 1, deletedRows: 1, movedRows: 0, changedCells: 1 },
        });
        expect(text()).toMatch(/1 row added/u);
        expect(text()).toMatch(/1 row deleted/u);
        expect(text()).toMatch(/1 changed cell/u);
        expect(text()).not.toMatch(/1 rows/u);
    });

    it('says so plainly when the files match, and offers nothing to filter', async () => {
        await strip({
            counts: { addedRows: 0, deletedRows: 0, movedRows: 0, changedCells: 0 },
        });
        expect(text()).toContain('No differences found.');
        expect(toggle().disabled).toBe(true);
    });

    it('counts moved rows, and does not call a reordered file unchanged', async () => {
        // Nothing added, deleted or edited — only rows in new places. Claiming
        // "No differences found." over a grid that is visibly banding them,
        // with the filter that would isolate them disabled, is the bug.
        await strip({
            counts: { addedRows: 0, deletedRows: 0, movedRows: 3, changedCells: 0 },
        });
        expect(text()).not.toContain('No differences found.');
        expect(text()).toContain('3 rows moved');
        expect(toggle().disabled).toBe(false);
    });

    it('omits the moved count when nothing moved', async () => {
        await strip({
            counts: { addedRows: 1, deletedRows: 0, movedRows: 0, changedCells: 0 },
        });
        expect(text()).not.toContain('moved');
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

    it('does not dress a degraded comparison up as counted findings', async () => {
        // A reordered row is positionally a screenful of changed cells. Stating
        // that total would present a failed alignment as a result.
        await strip({ degraded: true });
        expect(text()).toContain('Rows compared by position');
        expect(text()).not.toMatch(/rows added/u);
        expect(text()).not.toMatch(/changed cells/u);
    });

    it('does not claim "no differences" when a header changed', async () => {
        // Header renames and one-sided sheets are annotated in the grid and the
        // tabs but are not rows or cells, so the counts alone cannot answer this.
        await strip({
            counts: { addedRows: 0, deletedRows: 0, movedRows: 0, changedCells: 0 },
            other_differences: true,
        });
        expect(text()).not.toContain('No differences found.');
        // Still nothing for the row filter to keep, though.
        expect(toggle().disabled).toBe(true);
    });

    it('says when there were too many rows to check them all for moves', async () => {
        // Otherwise the window under-reports moves in silence, and a row that
        // only moved reads as an unrelated deletion and addition with nothing
        // saying the search gave up.
        await strip({ move_search_truncated: true });
        const status = container!.querySelector('.compare-strip-degraded');
        expect(status?.textContent).toMatch(/some rows that only moved/u);
        // The alignment itself stands, unlike a degraded one.
        expect(text()).not.toMatch(/compared by position/u);
        expect(toggle().disabled).toBe(false);
    });

    it('does not mention missed moves when the rows were compared by position', async () => {
        // A positional comparison never looked for moves, so reporting that
        // some were missed would imply a search that did not happen.
        await strip({ degraded: true, move_search_truncated: true });
        expect(text()).toMatch(/compared by position/u);
        expect(text()).not.toMatch(/only moved/u);
    });

    it('says nothing about alignment when the rows did match up', async () => {
        await strip();
        expect(container!.querySelector('.compare-strip-degraded')).toBeNull();
        expect(text()).not.toMatch(/compared by position/u);
    });

    it('waits for transform work in flight', async () => {
        await strip({ filter_pending: true });
        expect(toggle().disabled).toBe(true);
    });

    it('names both sides with their full paths, and says why it is read-only', async () => {
        // Basenames alone are not enough: the same report from two quarters
        // has the same name on both sides, and the window title carries only
        // those.
        await strip({
            sides: {
                originalPath: '/Reports/2025-Q3/quarterly.xlsx',
                modifiedPath: '/Reports/2025-Q4/quarterly.xlsx',
            },
        });
        expect(text()).toContain('Original');
        expect(text()).toContain('/Reports/2025-Q3/quarterly.xlsx');
        expect(text()).toContain('Modified');
        expect(text()).toContain('/Reports/2025-Q4/quarterly.xlsx');
        expect(text()).toContain('Read-only');
    });

    it('omits the side strip for a Git diff, whose original is not a path', async () => {
        await strip();
        expect(text()).not.toContain('Read-only');
    });

    it('announces the outcome, without re-reading it when the toggle is pressed', async () => {
        await strip();
        const counts = container!.querySelector('.compare-strip-counts');
        expect(counts?.getAttribute('role')).toBe('status');
        // The control is not inside the live region.
        expect(counts?.contains(toggle())).toBe(false);
    });

    it('has no show-changes toggle: the diff is the document', async () => {
        await strip();
        expect(text().toLowerCase()).not.toContain('show changes');
    });
});
