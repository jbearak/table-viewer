import { describe, it, expect } from 'vitest';
import { format_selection_tsv } from '../webview/grid-copy-model';
import type { RenderedCell } from '../data-source/interface';
import type { MergeRange } from '../types';

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

const NO_MERGES: MergeRange[] = [];

describe('format_selection_tsv', () => {
    it('copies a single cell', () => {
        const get_row = loader({ 0: [cell('a'), cell('b')] });
        const out = format_selection_tsv(
            { x: 1, y: 0, width: 1, height: 1 },
            get_row,
            NO_MERGES,
            true,
        );
        expect(out).toEqual({ text: 'b', truncated: false });
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
            merges,
            true,
        );
        expect(out.text).toBe('merged\t\tx');
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
