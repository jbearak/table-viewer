import { describe, it, expect } from 'vitest';
import { format_selection_tsv, copy_truncation_message } from '../webview/grid-copy-model';
import type { RenderedCell } from '../data-source/interface';
import type { MergeRange } from '../types';
import { MergeIndex } from '../webview/merge-index';

const cell = (raw: string, formatted = raw): RenderedCell => ({
    raw,
    formatted,
    bold: false,
    italic: false,
});

// A loader over a dense in-memory grid; rows outside `loaded` are "not resident".
function loader(
    grid: Record<number, (RenderedCell | null)[]>,
): (row: number) => (RenderedCell | null)[] | undefined {
    return (row) => grid[row];
}

const NO_MERGES = new MergeIndex([]);

describe('format_selection_tsv', () => {
    it('copies a single cell', () => {
        const get_row = loader({ 0: [cell('a'), cell('b')] });
        const out = format_selection_tsv(
            { x: 1, y: 0, width: 1, height: 1 },
            get_row,
            NO_MERGES,
            true,
        );
        expect(out).toEqual({ text: 'b', truncated: false, truncationReason: null });
    });

    it('joins columns with tabs and rows with newlines', () => {
        const get_row = loader({
            0: [cell('a'), cell('b'), cell('c')],
            1: [cell('d'), cell('e'), cell('f')],
        });
        const out = format_selection_tsv(
            { x: 0, y: 0, width: 3, height: 2 },
            get_row,
            NO_MERGES,
            true,
        );
        expect(out.text).toBe('a\tb\tc\nd\te\tf');
        expect(out.truncated).toBe(false);
    });

    it('copies raw text when formatting is off', () => {
        const get_row = loader({ 0: [cell('1000', '$1,000')] });
        const out = format_selection_tsv(
            { x: 0, y: 0, width: 1, height: 1 },
            get_row,
            NO_MERGES,
            false,
        );
        expect(out.text).toBe('1000');
    });

    it('copies formatted text when formatting is on', () => {
        const get_row = loader({ 0: [cell('1000', '$1,000')] });
        const out = format_selection_tsv(
            { x: 0, y: 0, width: 1, height: 1 },
            get_row,
            NO_MERGES,
            true,
        );
        expect(out.text).toBe('$1,000');
    });

    it('blanks merge-hidden cells, keeping the anchor text', () => {
        // A 1x2 horizontal merge over (0,0)-(0,1): col 1 is hidden.
        const get_row = loader({ 0: [cell('merged'), cell('shadow'), cell('x')] });
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
        ];
        const out = format_selection_tsv(
            { x: 0, y: 0, width: 3, height: 1 },
            get_row,
            new MergeIndex(merges),
            true,
        );
        expect(out.text).toBe('merged\t\tx');
    });

    it('blanks vertically covered cells in a multi-row merge', () => {
        // A 2x1 vertical merge over (0,0)-(1,0): the cell at (1,0) is covered
        // (inside the merge, not the anchor) and must copy as blank.
        const get_row = loader({
            0: [cell('merged'), cell('a')],
            1: [cell('shadow'), cell('b')],
        });
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
        ];
        const out = format_selection_tsv(
            { x: 0, y: 0, width: 2, height: 2 },
            get_row,
            new MergeIndex(merges),
            true,
        );
        expect(out.text).toBe('merged\ta\n\tb');
    });

    it('blanks a covered cell reached via the rect x/y offset', () => {
        // Selecting only the bottom-right 1x1 covered cell of a 2x2 merge
        // anchored at (5,5) proves abs coords (not rect-relative) drive
        // is_covered: (6,6) is covered, so it copies blank.
        const get_row = loader({
            6: [null, null, null, null, null, null, cell('shadow')],
        });
        const merges: MergeRange[] = [
            { startRow: 5, startCol: 5, endRow: 6, endCol: 6 },
        ];
        const out = format_selection_tsv(
            { x: 6, y: 6, width: 1, height: 1 },
            get_row,
            new MergeIndex(merges),
            true,
        );
        expect(out.text).toBe('');
    });

    it('emits blanks and flags truncated when a row is not loaded', () => {
        const get_row = loader({ 0: [cell('a'), cell('b')] }); // row 1 missing
        const out = format_selection_tsv(
            { x: 0, y: 0, width: 2, height: 2 },
            get_row,
            NO_MERGES,
            true,
        );
        expect(out.text).toBe('a\tb\n\t');
        expect(out.truncated).toBe(true);
        expect(out.truncationReason).toBe('non-resident');
    });

    it('caps the row count at max_rows and flags truncated', () => {
        const grid: Record<number, (RenderedCell | null)[]> = {};
        for (let r = 0; r < 10; r++) grid[r] = [cell(`r${r}`)];
        const out = format_selection_tsv(
            { x: 0, y: 0, width: 1, height: 10 },
            loader(grid),
            NO_MERGES,
            true,
            3,
        );
        expect(out.text).toBe('r0\nr1\nr2');
        expect(out.truncated).toBe(true);
        expect(out.truncationReason).toBe('row-cap');
    });

    it('reports no truncation reason for a complete copy', () => {
        const out = format_selection_tsv(
            { x: 0, y: 0, width: 1, height: 1 },
            loader({ 0: [cell('a')] }),
            NO_MERGES,
            true,
        );
        expect(out.truncated).toBe(false);
        expect(out.truncationReason).toBeNull();
    });

    it('prefers the row-cap reason when the selection also overflows the cap', () => {
        // height 5 > cap 2: capped rows never get read, so the cap is the
        // dominant reason the user should hear about.
        const out = format_selection_tsv(
            { x: 0, y: 0, width: 1, height: 5 },
            loader({ 0: [cell('a')], 1: [cell('b')] }),
            NO_MERGES,
            true,
            2,
        );
        expect(out.truncated).toBe(true);
        expect(out.truncationReason).toBe('row-cap');
    });
});

describe('copy_truncation_message', () => {
    it('returns null when nothing was clipped', () => {
        expect(copy_truncation_message(null)).toBeNull();
    });

    it('explains a non-resident clip (rows beyond the loaded range)', () => {
        const msg = copy_truncation_message('non-resident');
        expect(msg).toMatch(/copied/i);
        expect(msg).toMatch(/loaded/i);
    });

    it('explains a row-cap clip mentioning the 100,000-row limit', () => {
        const msg = copy_truncation_message('row-cap');
        expect(msg).toMatch(/copied/i);
        expect(msg).toMatch(/100,000/);
    });

    it('treats null cells as empty', () => {
        const get_row = loader({ 0: [cell('a'), null] });
        const out = format_selection_tsv(
            { x: 0, y: 0, width: 2, height: 1 },
            get_row,
            NO_MERGES,
            true,
        );
        expect(out.text).toBe('a\t');
    });
});
