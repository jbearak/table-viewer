import { describe, it, expect } from 'vitest';
import { GridCellKind } from '../webview/glide-data-grid';
import { build_grid_cell, font_style } from '../webview/cell-renderer';
import type { RenderedCell } from '../data-source/interface';

const rc = (raw: string, bold = false, italic = false): RenderedCell => ({
    raw,
    formatted: raw,
    bold,
    italic,
});

// Merged cells need no cases here any more: the vendored grid resolves merges
// itself and only ever asks this callback for a merge's anchor coordinates, so
// build_grid_cell simply returns each cell's own content.
const row: (RenderedCell | null)[] = [rc('A', true), rc('B'), rc('C', false, true)];

const cell = (col: number, show_formatting = true, soft_wrap = false) =>
    build_grid_cell(col, row, show_formatting, undefined, undefined, soft_wrap);

describe('font_style', () => {
    it('is undefined when neither bold nor italic', () => {
        expect(font_style(false, false)).toBeUndefined();
    });
    it('encodes bold as 600 and italic as italic, with a size, in style→weight→size order', () => {
        expect(font_style(true, false)).toBe('600 13px');
        expect(font_style(false, true)).toBe('italic 13px');
        expect(font_style(true, true)).toBe('italic 600 13px');
    });
});

describe('build_grid_cell — plain cells', () => {
    it('returns text with raw/displayData', () => {
        const c = cell(1);
        expect(c.kind).toBe(GridCellKind.Text);
        expect((c as { data: string }).data).toBe('B');
        expect((c as { displayData: string }).displayData).toBe('B');
    });

    it('applies bold/italic via themeOverride when show_formatting', () => {
        const bolded = cell(0); // 'A', bold
        expect((bolded as { themeOverride?: { baseFontStyle?: string } }).themeOverride?.baseFontStyle).toContain('600');
        const italicized = cell(2); // 'C', italic
        expect((italicized as { themeOverride?: { baseFontStyle?: string } }).themeOverride?.baseFontStyle).toContain('italic');
    });

    it('omits themeOverride when show_formatting is off', () => {
        const c = cell(0, false);
        expect((c as { themeOverride?: unknown }).themeOverride).toBeUndefined();
    });

    it('renders a null / out-of-range cell as blank text', () => {
        const c = build_grid_cell(5, row, true);
        expect(c.kind).toBe(GridCellKind.Text);
        expect((c as { data: string }).data).toBe('');
    });

    it('renders an unloaded row (undefined cells) as blank text', () => {
        const c = build_grid_cell(0, undefined, true);
        expect(c.kind).toBe(GridCellKind.Text);
        expect((c as { data: string }).data).toBe('');
        expect((c as { allowOverlay: boolean }).allowOverlay).toBe(false);
    });

    it('reuses one shared blank cell when there is no content and no overlay', () => {
        // getCellContent runs per visible cell per draw; the no-overlay blank
        // must not allocate.
        expect(build_grid_cell(0, undefined, true))
            .toBe(build_grid_cell(5, row, false));
    });

    it('still synthesizes a distinct cell for a blank with an overlay', () => {
        const a = build_grid_cell(0, undefined, true, { editable: true });
        expect((a as { allowOverlay: boolean }).allowOverlay).toBe(true);
        expect(a).not.toBe(build_grid_cell(0, undefined, true, { editable: true }));
    });

    it('wraps multiline content', () => {
        const note = 'First paragraph.\n\nSecond paragraph.\nFinal line.';
        const c = build_grid_cell(0, [rc(note)], true);
        expect(c).toMatchObject({
            data: note,
            displayData: note,
            allowWrapping: true,
        });
    });

    it('does not enable wrapping for single-line content in a default-height row', () => {
        expect((cell(1) as { allowWrapping?: boolean }).allowWrapping).toBeUndefined();
    });

    it('soft-wraps single-line content when the row is taller than the default', () => {
        // Deliberately more eager than Excel (which wraps only wrapText-styled
        // cells): a grown row must always reveal more content, so long
        // single-line values soft-wrap to the column width instead of clipping.
        const c = cell(1, true, true);
        expect((c as { allowWrapping?: boolean }).allowWrapping).toBe(true);
    });

    it('wraps and normalizes CRLF and bare CR displayed text, preserving raw data (#202)', () => {
        // Glide's renderer and measurer split on `\n` only, so the displayed
        // text is canonicalized to LF at this boundary; `data` keeps the source
        // bytes so edits and copies do not silently rewrite the value.
        for (const raw of ['a\r\nb', 'a\rb']) {
            const c = build_grid_cell(0, [rc(raw)], true);
            expect(c).toMatchObject({
                data: raw,
                displayData: 'a\nb',
                allowWrapping: true,
            });
        }
    });

    it('normalizes a dirty overlay value for display without touching data', () => {
        const c = build_grid_cell(0, [rc('x')], true, { dirty_value: 'a\rb' });
        expect(c).toMatchObject({
            data: 'a\rb',
            displayData: 'a\nb',
            allowWrapping: true,
        });
    });
});

describe('build_grid_cell — formatting toggle (raw vs formatted)', () => {
    // A cell where the raw value differs from its formatted display, e.g. a
    // number with a display format ('3.14') over its full precision ('3.14159').
    const num: RenderedCell = { raw: '3.14159', formatted: '3.14', bold: false, italic: false };
    const num_rows: (RenderedCell | null)[] = [num];
    const num_cell = (show_formatting: boolean) =>
        build_grid_cell(0, num_rows, show_formatting);

    it('displays the formatted value when show_formatting is on', () => {
        const c = num_cell(true);
        expect((c as { displayData: string }).displayData).toBe('3.14');
    });

    it('displays the raw value when show_formatting is off', () => {
        const c = num_cell(false);
        expect((c as { displayData: string }).displayData).toBe('3.14159');
    });

    it('keeps the underlying data on the raw value regardless of toggle', () => {
        expect((num_cell(true) as { data: string }).data).toBe('3.14159');
        expect((num_cell(false) as { data: string }).data).toBe('3.14159');
    });
});

describe('build_grid_cell — edit overlay (CSV edit mode)', () => {
    const plain_rows: (RenderedCell | null)[] = [rc('A', true), rc('B'), null];
    const ecell = (
        col: number,
        overlay: Parameters<typeof build_grid_cell>[3],
        show_formatting = true,
    ) => build_grid_cell(col, plain_rows, show_formatting, overlay);

    it('makes the cell editable when overlay.editable is set', () => {
        const c = ecell(1, { editable: true });
        expect((c as { allowOverlay: boolean }).allowOverlay).toBe(true);
    });

    it('stays read-only (allowOverlay false) with no overlay', () => {
        const c = build_grid_cell(1, plain_rows, true);
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

    it('marks a refused overlay cell readonly, and an editable one not', () => {
        // Glide's paste path never consults allowOverlay — pasteToCell gates on
        // isReadWriteCell, which for a Text cell checks only `readonly !== true` —
        // so a cell we refuse to open an overlay on needs this flag too or a paste
        // (or cut) still lands on it.
        const blocked = ecell(1, { editable: false, refused: true, bg: '#332200' });
        expect((blocked as { allowOverlay: boolean }).allowOverlay).toBe(false);
        expect((blocked as { readonly?: boolean }).readonly).toBe(true);

        const editable = ecell(1, { editable: true });
        expect((editable as { readonly?: boolean }).readonly).toBeUndefined();
    });

    it('leaves a highlight-only overlay on a read-only sheet un-readonly', () => {
        // Cell highlights are plain view state, available with editing off and on
        // non-CSV files, and GridShell builds an overlay for them so the tint can be
        // painted. Keying `readonly` off `!editable` would therefore make a
        // highlighted read-only cell announce aria-readonly="true" (Glide derives it
        // from isReadWriteCell) while its unhighlighted neighbour does not — an
        // accessibility difference keyed on a colour. Nothing is being refused here:
        // editing was never offered.
        const highlighted = ecell(1, { bg: 'rgba(0, 128, 255, 0.2)' });
        expect((highlighted as { allowOverlay: boolean }).allowOverlay).toBe(false);
        expect('readonly' in highlighted).toBe(false);
        expect(
            (highlighted as { themeOverride?: { bgCell?: string } }).themeOverride?.bgCell,
        ).toBe('rgba(0, 128, 255, 0.2)');
    });

    it('leaves a no-overlay read-only cell shape untouched', () => {
        // A read-only sheet passes no overlay at all; the conditional spread must
        // keep its cell shape (and every snapshot of it) exactly as before.
        const c = build_grid_cell(1, plain_rows, true);
        expect('readonly' in c).toBe(false);
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

describe('build_grid_cell — rich cells', () => {
    const rich_row: (RenderedCell | null)[] = [
        {
            raw: 'ab',
            formatted: 'ab',
            bold: false,
            italic: false,
            richText: { runs: [{ text: 'a' }, { text: 'b', style: { bold: true } }] },
        },
        {
            raw: 'link',
            formatted: 'link',
            bold: false,
            italic: false,
            hyperlink: { kind: 'external', target: 'https://example.com/' },
        },
        {
            raw: 'u',
            formatted: 'u',
            bold: true,
            italic: false,
            underline: true,
        },
        rc('plain'),
    ];

    const rich = (col: number, show_formatting = true, overlay?: Parameters<typeof build_grid_cell>[3]) =>
        build_grid_cell(col, rich_row, show_formatting, overlay);

    it('emits a Custom cell for run-styled, linked, and underlined cells', () => {
        for (const col of [0, 1, 2]) {
            const c = rich(col);
            expect(c.kind).toBe(GridCellKind.Custom);
        }
        expect(rich(3).kind).toBe(GridCellKind.Text);
    });

    it('carries the runs as visual lines and the raw text as copyData', () => {
        const c = rich(0) as { data: { lines: unknown[] }; copyData: string };
        expect(c.copyData).toBe('ab');
        expect(c.data.lines).toEqual([
            [{ text: 'a' }, { text: 'b', style: { bold: true } }],
        ]);
    });

    it('synthesizes a whole-cell styled run for a link/underline-only cell', () => {
        const c = rich(2) as { data: { lines: unknown[] } };
        expect(c.data.lines).toEqual([
            [{ text: 'u', style: { bold: true, underline: true } }],
        ]);
    });

    it('carries the hyperlink into the cell data', () => {
        const c = rich(1) as { data: { hyperlink?: { kind: string; target?: string } } };
        expect(c.data.hyperlink).toEqual({ kind: 'external', target: 'https://example.com/' });
    });

    it('closes the paste path and the overlay on rich cells', () => {
        const c = rich(0) as { allowOverlay: boolean; readonly?: boolean };
        expect(c.allowOverlay).toBe(false);
        expect(c.readonly).toBe(true);
    });

    it('falls back to Text when formatting is off', () => {
        const c = rich(0, false);
        expect(c.kind).toBe(GridCellKind.Text);
        expect((c as { data: string }).data).toBe('ab');
    });

    it('falls back to Text when the cell is editable or dirty', () => {
        expect(rich(0, true, { editable: true }).kind).toBe(GridCellKind.Text);
        expect(rich(0, true, { dirty_value: 'X' }).kind).toBe(GridCellKind.Text);
        const dirty = rich(0, true, { dirty_value: 'X' });
        expect((dirty as { displayData: string }).displayData).toBe('X');
    });

    it('keeps the highlight tint on a rich cell', () => {
        const c = rich(0, true, { bg: '#123456' }) as {
            kind: unknown;
            themeOverride?: { bgCell?: string };
        };
        expect(c.kind).toBe(GridCellKind.Custom);
        expect(c.themeOverride?.bgCell).toBe('#123456');
    });
});
