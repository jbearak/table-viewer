import { describe, it, expect } from 'vitest';
import { GridCellKind } from '@glideapps/glide-data-grid';
import { build_grid_cell, font_style } from '../webview/cell-renderer';
import { MergeIndex } from '../webview/merge-index';
import type { RenderedCell } from '../data-source/interface';
import type { MergeRange } from '../types';

const rc = (raw: string, bold = false, italic = false): RenderedCell => ({
    raw,
    formatted: raw,
    bold,
    italic,
});

// Mirrors merged.xlsx plus a synthetic 2D merge.
const merges: MergeRange[] = [
    { startRow: 0, startCol: 0, endRow: 0, endCol: 2 }, // horizontal "Merged Header"
    { startRow: 2, startCol: 0, endRow: 3, endCol: 0 }, // vertical "Tall"
    { startRow: 5, startCol: 1, endRow: 6, endCol: 2 }, // 2D "Box"
];

const rows: Record<number, (RenderedCell | null)[]> = {
    0: [rc('Merged Header'), null, null],
    1: [rc('A', true), rc('B'), rc('C', false, true)],
    2: [rc('Tall'), rc('D'), rc('E')],
    3: [null, rc('F'), rc('G')],
    5: [rc('x'), rc('Box'), null],
    6: [rc('y'), null, null],
};

const idx = new MergeIndex(merges);
const cell = (row: number, col: number, show_formatting = true) =>
    build_grid_cell(row, col, rows[row], idx, show_formatting);

describe('font_style', () => {
    it('is undefined when neither bold nor italic', () => {
        expect(font_style(false, false)).toBeUndefined();
    });
    it('encodes bold as 600 and italic as italic, with a size', () => {
        expect(font_style(true, false)).toContain('600');
        expect(font_style(false, true)).toContain('italic');
        const both = font_style(true, true)!;
        expect(both).toContain('600');
        expect(both).toContain('italic');
    });
});

describe('build_grid_cell — plain cells', () => {
    it('returns text with raw/displayData and no span', () => {
        const c = cell(1, 1);
        expect(c.kind).toBe(GridCellKind.Text);
        expect((c as { data: string }).data).toBe('B');
        expect((c as { displayData: string }).displayData).toBe('B');
        expect((c as { span?: unknown }).span).toBeUndefined();
    });

    it('applies bold/italic via themeOverride when show_formatting', () => {
        const bolded = cell(1, 0); // 'A', bold
        expect((bolded as { themeOverride?: { baseFontStyle?: string } }).themeOverride?.baseFontStyle).toContain('600');
        const italicized = cell(1, 2); // 'C', italic
        expect((italicized as { themeOverride?: { baseFontStyle?: string } }).themeOverride?.baseFontStyle).toContain('italic');
    });

    it('omits themeOverride when show_formatting is off', () => {
        const c = cell(1, 0, false);
        expect((c as { themeOverride?: unknown }).themeOverride).toBeUndefined();
    });

    it('renders a null / out-of-range cell as blank text', () => {
        const c = cell(3, 0); // null in data, but also covered — blank either way
        expect(c.kind).toBe(GridCellKind.Text);
        expect((c as { data: string }).data).toBe('');
    });
});

describe('build_grid_cell — horizontal merges (native span)', () => {
    it('anchor returns span across the merged columns with its content', () => {
        const c = cell(0, 0);
        expect((c as { span?: [number, number] }).span).toEqual([0, 2]);
        expect((c as { data: string }).data).toBe('Merged Header');
    });

    it('covered cells echo the anchor content AND the same span', () => {
        // Critical: a covered column must return the anchor content + span so
        // Glide neither repaints blank over the anchor nor draws an empty span
        // when the anchor column is scrolled off-screen.
        for (const col of [1, 2]) {
            const c = cell(0, col);
            expect((c as { span?: [number, number] }).span).toEqual([0, 2]);
            expect((c as { data: string }).data).toBe('Merged Header');
            expect((c as { displayData: string }).displayData).toBe('Merged Header');
        }
    });
});

describe('build_grid_cell — edit overlay (CSV edit mode)', () => {
    const plain_idx = new MergeIndex([]);
    const plain_rows: (RenderedCell | null)[] = [rc('A', true), rc('B'), null];
    const ecell = (
        col: number,
        overlay: Parameters<typeof build_grid_cell>[5],
        show_formatting = true,
    ) => build_grid_cell(0, col, plain_rows, plain_idx, show_formatting, overlay);

    it('makes the cell editable when overlay.editable is set', () => {
        const c = ecell(1, { editable: true });
        expect((c as { allowOverlay: boolean }).allowOverlay).toBe(true);
    });

    it('stays read-only (allowOverlay false) with no overlay', () => {
        const c = build_grid_cell(0, 1, plain_rows, plain_idx, true);
        expect((c as { allowOverlay: boolean }).allowOverlay).toBe(false);
    });

    it('shows the dirty value instead of the persisted content', () => {
        const c = ecell(1, { editable: true, dirty_value: 'EDITED' });
        expect((c as { data: string }).data).toBe('EDITED');
        expect((c as { displayData: string }).displayData).toBe('EDITED');
    });

    it('tints the background via themeOverride.bgCell', () => {
        const c = ecell(1, { editable: true, bg: '#332200' });
        expect((c as { themeOverride?: { bgCell?: string } }).themeOverride?.bgCell).toBe('#332200');
    });

    it('combines a bold font override with the dirty tint', () => {
        const c = ecell(0, { editable: true, dirty_value: 'X', bg: '#332200' });
        const to = (c as { themeOverride?: { baseFontStyle?: string; bgCell?: string } }).themeOverride;
        expect(to?.baseFontStyle).toContain('600');
        expect(to?.bgCell).toBe('#332200');
    });

    it('renders an empty cell as an editable dirty cell', () => {
        // col 2 is null in the row, but a dirty edit on an empty CSV cell must
        // still display its value and open the editor.
        const c = ecell(2, { editable: true, dirty_value: 'new' });
        expect(c.kind).toBe(GridCellKind.Text);
        expect((c as { data: string }).data).toBe('new');
        expect((c as { allowOverlay: boolean }).allowOverlay).toBe(true);
    });
});

describe('build_grid_cell — vertical / 2D merges (overlay)', () => {
    it('vertical merge anchor and covered cells are blank with no span', () => {
        const anchor = cell(2, 0);
        expect((anchor as { data: string }).data).toBe('');
        expect((anchor as { span?: unknown }).span).toBeUndefined();

        const covered = cell(3, 0);
        expect((covered as { data: string }).data).toBe('');
        expect((covered as { span?: unknown }).span).toBeUndefined();
    });

    it('2D merge anchor and covered cells are blank with no span', () => {
        const anchor = cell(5, 1);
        expect((anchor as { data: string }).data).toBe('');
        expect((anchor as { span?: unknown }).span).toBeUndefined();

        const covered = cell(6, 2);
        expect((covered as { data: string }).data).toBe('');
        expect((covered as { span?: unknown }).span).toBeUndefined();
    });
});
