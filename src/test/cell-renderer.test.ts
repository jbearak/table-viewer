import { describe, it, expect } from 'vitest';
import { GridCellKind } from '../webview/glide-data-grid';
import {
    build_grid_cell,
    font_style,
    rich_cell_display_data,
} from '../webview/cell-renderer';
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
        const c = rich(0) as unknown as { data: { lines: unknown[] }; copyData: string };
        expect(c.copyData).toBe('ab');
        expect(c.data.lines).toEqual([
            [{ text: 'a' }, { text: 'b', style: { bold: true } }],
        ]);
    });

    it('updates rich wrapping when the same cached source row becomes tall', () => {
        type RichResult = { data: { allow_wrapping?: true } };
        const cell_for_height = (tall: boolean): RichResult => build_grid_cell(
            0, rich_row, true, undefined, 13, tall,
        ) as unknown as RichResult;
        const short = cell_for_height(false);
        const tall = cell_for_height(true);
        const short_again = cell_for_height(false);

        expect(short.data.allow_wrapping).toBeUndefined();
        expect(tall.data.allow_wrapping).toBe(true);
        expect(short_again.data.allow_wrapping).toBeUndefined();
    });

    it('wraps a Formatting-off hyperlink when its row is tall', () => {
        const linked = build_grid_cell(
            1, rich_row, false, undefined, 13, true,
        ) as unknown as { data: { allow_wrapping?: true } };
        expect(linked.data.allow_wrapping).toBe(true);
    });

    it('requests width wrapping for the Undesa-style rich information note', () => {
        const display = 'A long introductory paragraph.\r\n\r\nNotes More long prose.';
        const information_note: RenderedCell = {
            raw: display,
            formatted: display,
            bold: false,
            italic: false,
            richText: {
                runs: [
                    { text: 'A long introductory paragraph.\r\n\r\n' },
                    { text: 'Notes', style: { bold: true } },
                    { text: ' More long prose.' },
                ],
            },
        };
        const c = build_grid_cell(0, [information_note], true) as unknown as {
            data: { allow_wrapping?: true; lines: unknown[] };
        };
        expect(c.data.allow_wrapping).toBe(true);
        expect(c.data.lines).toHaveLength(3);

        const formatting_off = build_grid_cell(
            0,
            [information_note],
            false,
        ) as unknown as {
            kind: unknown;
            allowWrapping?: boolean;
            displayData: string;
        };
        expect(formatting_off.kind).toBe(GridCellKind.Text);
        expect(formatting_off.allowWrapping).toBe(true);
        expect(formatting_off.displayData)
            .toBe('A long introductory paragraph.\n\nNotes More long prose.');
    });

    it('synthesizes a whole-cell styled run for a link/underline-only cell', () => {
        const c = rich(2) as unknown as { data: { lines: unknown[] } };
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

    it('keeps rich rendering while editable and paints dirty Markdown runs', () => {
        const editable = rich(0, true, { editable: true, edit_value: 'a **b**' });
        expect(editable.kind).toBe(GridCellKind.Custom);
        expect((editable as { allowOverlay: boolean }).allowOverlay).toBe(true);

        const dirty = rich(0, true, {
            editable: true,
            dirty_value: 'X',
            edit_value: '*X*',
            dirty_rich: { runs: [{ text: 'X', style: { italic: true } }] },
        }) as unknown as { kind: unknown; data: { lines: unknown[]; edit_value?: string } };
        expect(dirty.kind).toBe(GridCellKind.Custom);
        expect(dirty.data.lines).toEqual([[{ text: 'X', style: { italic: true } }]]);
        expect(dirty.data.edit_value).toBe('*X*');

        const formatting_off = rich(0, false, {
            editable: true,
            dirty_value: 'X',
            edit_value: '*X*',
            dirty_rich: { runs: [{ text: 'X', style: { italic: true } }] },
        }) as unknown as {
            kind: unknown;
            data: string;
            displayData: string;
            copyData?: string;
            allowOverlay: boolean;
            readonly?: boolean;
        };
        expect(formatting_off.kind).toBe(GridCellKind.Text);
        expect(formatting_off.data).toBe('*X*');
        expect(formatting_off.displayData).toBe('X');
        expect(formatting_off.copyData).toBe('X');
        expect(formatting_off.allowOverlay).toBe(true);
        expect(formatting_off.readonly).toBeUndefined();
    });

    it('promotes a blank cell to rich rendering after a Markdown edit', () => {
        const blank_row: (RenderedCell | null)[] = [null];
        const dirty = build_grid_cell(0, blank_row, true, {
            editable: true,
            dirty_value: 'new',
            edit_value: '**new**',
            dirty_rich: { runs: [{ text: 'new', style: { bold: true } }] },
        }) as unknown as { kind: unknown; data: { lines: unknown[] } };

        expect(dirty.kind).toBe(GridCellKind.Custom);
        expect(dirty.data.lines).toEqual([[{ text: 'new', style: { bold: true } }]]);
    });

    it('does not reuse persisted runs after clearing a rich cell', () => {
        const cleared = rich(0, true, {
            editable: true,
            dirty_value: '',
            edit_value: '',
        }) as unknown as { kind: unknown; data: { lines: unknown[] } };

        expect(cleared.kind).toBe(GridCellKind.Custom);
        expect(cleared.data.lines).toEqual([[]]);
    });

    it('exposes dirty Markdown runs to tooltip overflow measurement', () => {
        const data = rich_cell_display_data(rc('plain'), true, 13, {
            dirty_value: 'wide',
            dirty_rich: { runs: [{ text: 'wide', style: { bold: true } }] },
        });

        expect(data?.lines).toEqual([[{ text: 'wide', style: { bold: true } }]]);
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

describe('build_grid_cell — rich cells, code-review regressions', () => {
    const linked_date: (RenderedCell | null)[] = [{
        raw: '45123',
        formatted: '7/16/2023',
        bold: false,
        italic: false,
        hyperlink: { kind: 'external', target: 'https://example.com/' },
    }];

    it('displays the formatted value on a rich cell without source runs', () => {
        const c = build_grid_cell(0, linked_date, true) as unknown as {
            data: { lines: { text: string }[][] };
        };
        expect(c.data.lines).toEqual([[{ text: '7/16/2023' }]]);
    });

    it('keeps the link presentation when formatting is off (raw text, plain runs)', () => {
        const c = build_grid_cell(0, linked_date, false) as unknown as {
            kind: unknown;
            data: { lines: { text: string }[][]; hyperlink?: unknown };
        };
        expect(c.kind).toBe(GridCellKind.Custom);
        expect(c.data.hyperlink).toBeDefined();
        expect(c.data.lines).toEqual([[{ text: '45123' }]]);
    });

    it('drops run styling when formatting is off on an unlinked rich cell', () => {
        const styled: (RenderedCell | null)[] = [{
            raw: 'ab',
            formatted: 'ab',
            bold: false,
            italic: false,
            richText: { runs: [{ text: 'a' }, { text: 'b', style: { bold: true } }] },
        }];
        const c = build_grid_cell(0, styled, false);
        expect(c.kind).toBe(GridCellKind.Text);
    });

    it('sets the pointer cursor only while the open modifier is held over a link', () => {
        // Bare hover: plain click selects, so no pointer.
        const bare = build_grid_cell(0, linked_date, true) as { cursor?: string };
        expect(bare.cursor).toBeUndefined();
        // Ctrl/Cmd held: the open gesture is live.
        const held = build_grid_cell(
            0, linked_date, true, undefined, undefined, false, true,
        ) as { cursor?: string };
        expect(held.cursor).toBe('pointer');
        // The modifier over an unlinked rich cell changes nothing.
        const unlinked: (RenderedCell | null)[] = [{
            raw: 'u', formatted: 'u', bold: false, italic: false, underline: true,
        }];
        expect((build_grid_cell(
            0, unlinked, true, undefined, undefined, false, true,
        ) as { cursor?: string }).cursor).toBeUndefined();
    });

    it('marks RTL display text', () => {
        const rtl_row: (RenderedCell | null)[] = [{
            raw: 'שלום',
            formatted: 'שלום',
            bold: false,
            italic: false,
            underline: true,
        }];
        const c = build_grid_cell(0, rtl_row, true) as unknown as { data: { rtl?: true } };
        expect(c.data.rtl).toBe(true);
        const ltr = build_grid_cell(0, linked_date, true) as unknown as { data: { rtl?: true } };
        expect(ltr.data.rtl).toBeUndefined();
    });
});

describe('build_grid_cell — diff overlay (Diff toggle)', () => {
    const colors = { deleted: '#c00', added: '#0c0' };
    const diff_cell = (
        c: RenderedCell | null,
        diff_base: string,
        dirty_value: string,
        show_formatting = true,
    ) => build_grid_cell(
        0,
        [c],
        show_formatting,
        { diff_base, dirty_value, editable: true },
        undefined,
        false,
        false,
        colors,
    );

    it('forces a plain cell onto the rich path', () => {
        const c = diff_cell(rc('old text with words'), 'old text with words', 'new words here now');
        expect(c.kind).toBe(GridCellKind.Custom);
    });

    it('renders numbers as old -> new, deletion/addition colored', () => {
        const c = diff_cell(
            { raw: '5', formatted: '5', bold: false, italic: false, rawType: 'number' },
            '5',
            '7',
        ) as unknown as { data: { lines: unknown[] } };
        expect(c.data.lines).toEqual([[
            { text: '5', style: { strikethrough: true }, diff_color: '#c00' },
            { text: ' -> ' },
            { text: '7', diff_color: '#0c0' },
        ]]);
    });

    it('renders short text as old -> new', () => {
        const c = diff_cell(rc('New York'), 'New York', 'Boston') as unknown as {
            data: { lines: unknown[] };
        };
        expect(c.data.lines).toEqual([[
            { text: 'New York', style: { strikethrough: true }, diff_color: '#c00' },
            { text: ' -> ' },
            { text: 'Boston', diff_color: '#0c0' },
        ]]);
    });

    it('renders longer text as an inline word diff', () => {
        const c = diff_cell(
            rc('the quick brown fox'),
            'the quick brown fox',
            'the slow brown fox',
        ) as unknown as { data: { lines: unknown[] } };
        expect(c.data.lines).toEqual([[
            { text: 'the ' },
            { text: 'quick', style: { strikethrough: true }, diff_color: '#c00' },
            { text: 'slow', diff_color: '#0c0' },
            { text: ' brown fox' },
        ]]);
    });

    it('splits hard breaks in either side into visual lines and keeps wrapping on', () => {
        const c = diff_cell(
            rc('single line'),
            'was\nsplit over lines already',
            'single line',
        ) as unknown as { data: { lines: unknown[][]; allow_wrapping?: true } };
        expect(c.data.lines.length).toBeGreaterThan(1);
        expect(c.data.allow_wrapping).toBe(true);
    });

    it('keeps the cell editable and copies the new value, not the diff text', () => {
        const c = diff_cell(rc('old'), 'old words here really', 'new words here truly') as unknown as {
            allowOverlay: boolean;
            copyData: string;
        };
        expect(c.allowOverlay).toBe(true);
        expect(c.copyData).toBe('new words here truly');
    });

    it('outranks a markdown edit\'s rich runs', () => {
        const c = build_grid_cell(
            0,
            [rc('x')],
            true,
            {
                diff_base: 'x',
                dirty_value: 'y',
                dirty_rich: { runs: [{ text: 'y', style: { bold: true } }] },
            },
            undefined,
            false,
            false,
            colors,
        ) as unknown as { data: { lines: unknown[] } };
        expect(c.data.lines).toEqual([[
            { text: 'x', style: { strikethrough: true }, diff_color: '#c00' },
            { text: ' -> ' },
            { text: 'y', diff_color: '#0c0' },
        ]]);
    });

    it('shows the diff in the tooltip payload too', () => {
        const data = rich_cell_display_data(
            rc('plain'),
            true,
            undefined,
            { diff_base: 'plain', dirty_value: 'fancy' },
            false,
            colors,
        );
        expect(data?.lines).toEqual([[
            { text: 'plain', style: { strikethrough: true }, diff_color: '#c00' },
            { text: ' -> ' },
            { text: 'fancy', diff_color: '#0c0' },
        ]]);
    });

    it('never reuses a cached rich cell for a diff overlay', () => {
        const shared = {
            raw: 'ab',
            formatted: 'ab',
            bold: false,
            italic: false,
            richText: { runs: [{ text: 'ab' }] },
        } as RenderedCell;
        const plain = build_grid_cell(0, [shared], true) as unknown as {
            data: { lines: unknown[] };
        };
        const diffed = build_grid_cell(
            0, [shared], true,
            { diff_base: 'ab', dirty_value: 'cd' },
            undefined, false, false, colors,
        ) as unknown as { data: { lines: unknown[] } };
        expect(diffed.data.lines).not.toEqual(plain.data.lines);
        const plain_again = build_grid_cell(0, [shared], true) as unknown as {
            data: { lines: unknown[] };
        };
        expect(plain_again.data.lines).toEqual(plain.data.lines);
    });
});
