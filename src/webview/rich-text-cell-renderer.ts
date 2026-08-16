/**
 * Custom Glide renderer for rich text cells: per-run bold/italic fonts plus
 * underline/strikethrough decorations, which the built-in text cell cannot
 * draw (one font per cell, no decorations). Hyperlinked cells render in the
 * theme's link color with an underline, Excel-style.
 *
 * The cell data is pure and canvas-free (built by cell-renderer.ts); all
 * measurement happens here against Glide's cached text metrics so drawing and
 * column auto-fit agree. Rich cells draw hard line breaks only — no soft wrap
 * in v1 (that would need a run-aware re-implementation of Glide's wrap
 * layout).
 */
import {
    GridCellKind,
    getEmHeight,
    getMiddleCenterBias,
    measureTextCached,
    type CustomCell,
    type CustomRenderer,
} from './glide-data-grid';
import type { CellTextStyle } from '../cell-content';
import { canvas_font } from './fit-column-model';
import { rich_lines_max_width, type RichCellData } from './rich-text-layout';

export type { RichCellData } from './rich-text-layout';

export type RichTextGridCell = CustomCell<RichCellData>;

export function is_rich_text_cell(cell: CustomCell): cell is RichTextGridCell {
    return (cell.data as Partial<RichCellData> | undefined)?.kind === 'rich-text';
}

/** The four style-affecting font variants per family+size, built once instead
 *  of per segment per frame (draw runs for every visible rich cell). */
const font_variant_cache = new Map<string, [string, string, string, string]>();

function font_variants(size_px: number, family: string): [string, string, string, string] {
    const key = `${size_px}|${family}`;
    let variants = font_variant_cache.get(key);
    if (!variants) {
        variants = [
            canvas_font(false, false, family, size_px),
            canvas_font(true, false, family, size_px),
            canvas_font(false, true, family, size_px),
            canvas_font(true, true, family, size_px),
        ];
        font_variant_cache.set(key, variants);
    }
    return variants;
}

function variant_of(
    variants: readonly [string, string, string, string],
    style: CellTextStyle | undefined,
): string {
    return variants[(style?.bold ? 1 : 0) | (style?.italic ? 2 : 0)];
}

export const rich_text_cell_renderer: CustomRenderer<RichTextGridCell> = {
    kind: GridCellKind.Custom,
    isMatch: is_rich_text_cell,
    // The pointer cursor on linked cells comes from the GridCell's `cursor`
    // field (read directly by the grid), not a hover-gated override — enabling
    // needsHover would run Glide's enter/leave hover animation and its damage
    // redraws for no visual effect.
    needsHover: false,
    needsHoverPosition: false,
    draw: (args) => {
        const { ctx, rect, theme, cell } = args;
        const data = cell.data;
        const { x, y, width: w, height: h } = rect;
        const linked = data.hyperlink !== undefined;

        // Mirrors drawMultiLineText's vertical layout so a rich cell lines up
        // with its plain neighbours: em-box line metric from the base font,
        // theme line height, center the block, clip anything that spills.
        const em_height = getEmHeight(ctx, theme.baseFontFull);
        const line_height = theme.lineHeight * em_height;
        const bias = getMiddleCenterBias(ctx, theme);
        const actual_height = em_height + line_height * (data.lines.length - 1);

        // Glide's draw loop already clips each column horizontally, so a local
        // clip is only needed when the line block can spill vertically into
        // the rows above/below — the same rule drawMultiLineText uses.
        const must_clip = actual_height + theme.cellVerticalPadding > h;
        if (must_clip) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip();
        }
        ctx.fillStyle = linked ? theme.linkColor : theme.textDark;

        const variants = font_variants(data.font_size_px, theme.fontFamily);
        const left = x + theme.cellHorizontalPadding + 0.5;
        const right = x + w - theme.cellHorizontalPadding;
        const optimal_y = y + h / 2 - actual_height / 2;
        let draw_y = Math.max(y + theme.cellVerticalPadding, optimal_y);
        // Longest run of glyphs that can possibly fit; the same 4px/char floor
        // Glide's truncateString uses, applied per segment below (per-segment
        // rather than whole-string, since only the segments up to the clip
        // edge are drawn at all).
        const max_chars = Math.ceil(w / 4);
        let last_font: string | null = null;

        for (const line of data.lines) {
            const text_y = draw_y + em_height / 2 + bias;
            let pen_x = left;
            for (const segment of line) {
                if (pen_x >= right) break;
                const text = segment.text.length > max_chars
                    ? segment.text.slice(0, max_chars)
                    : segment.text;
                const font = variant_of(variants, segment.style);
                if (font !== last_font) {
                    ctx.font = font;
                    last_font = font;
                }
                ctx.fillText(text, pen_x, text_y);
                const seg_w = measureTextCached(text, ctx, font).width;
                if (segment.style?.strikethrough) {
                    ctx.fillRect(pen_x, Math.round(text_y) - 0.5, seg_w, 1);
                }
                if (linked || segment.style?.underline) {
                    ctx.fillRect(
                        pen_x,
                        Math.round(text_y + em_height / 2) + 0.5,
                        seg_w,
                        1,
                    );
                }
                pen_x += seg_w;
            }
            draw_y += line_height;
            if (draw_y > y + h) break;
        }

        if (must_clip) ctx.restore();
    },
    measure: (ctx, cell, theme) => {
        const variants = font_variants(cell.data.font_size_px, theme.fontFamily);
        const width = rich_lines_max_width(cell.data.lines, (text, style) => {
            const font = variant_of(variants, style);
            // measureTextCached keys its cache on `font` but measures with the
            // context's current font, so the two must be set together.
            ctx.font = font;
            return measureTextCached(text, ctx, font).width;
        });
        return width + 2 * theme.cellHorizontalPadding;
    },
    onPaste: () => undefined,
};
