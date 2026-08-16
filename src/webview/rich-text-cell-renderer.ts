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
    type FullTheme,
} from './glide-data-grid';
import type { CellHyperlink, CellTextStyle } from '../cell-content';
import { font_shorthand } from './cell-renderer';
import type { RichTextLine } from './rich-text-layout';

export interface RichCellData {
    /** Discriminant for isMatch — Glide funnels every Custom cell here. */
    readonly kind: 'rich-text';
    /** Styled segments per visual line (see rich_text_lines). */
    readonly lines: readonly RichTextLine[];
    /** Present on linked cells: renders link-colored and underlined. */
    readonly hyperlink?: CellHyperlink;
    /** The grid's configured cell font size; per-segment fonts rebuild the
     *  cell font shorthand around it, so it must match the theme. */
    readonly font_size_px: number;
}

export type RichTextGridCell = CustomCell<RichCellData>;

export function is_rich_text_cell(cell: CustomCell): cell is RichTextGridCell {
    return (cell.data as Partial<RichCellData> | undefined)?.kind === 'rich-text';
}

function segment_font(
    style: CellTextStyle | undefined,
    size_px: number,
    family: string,
): string {
    return `${font_shorthand(style?.bold ?? false, style?.italic ?? false, size_px)} ${family}`;
}

/** Widest line of the cell, as drawn (per-segment fonts summed per line). */
function content_width(
    ctx: CanvasRenderingContext2D,
    data: RichCellData,
    theme: FullTheme,
): number {
    let max = 0;
    for (const line of data.lines) {
        let width = 0;
        for (const segment of line) {
            const font = segment_font(segment.style, data.font_size_px, theme.fontFamily);
            // measureTextCached keys its cache on `font` but measures with the
            // context's current font, so the two must be set together.
            ctx.font = font;
            width += measureTextCached(segment.text, ctx, font).width;
        }
        if (width > max) max = width;
    }
    return max;
}

export const rich_text_cell_renderer: CustomRenderer<RichTextGridCell> = {
    kind: GridCellKind.Custom,
    isMatch: is_rich_text_cell,
    // Hover only matters on linked cells (pointer cursor); plain rich cells
    // keep the cheap no-hover path.
    needsHover: (cell) => cell.data.hyperlink !== undefined,
    needsHoverPosition: false,
    draw: (args) => {
        const { ctx, rect, theme, cell } = args;
        if (cell.data.hyperlink !== undefined && args.hoverAmount > 0) {
            args.overrideCursor?.('pointer');
        }
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

        // Always clip: segments never char-truncate the way the plain
        // single-line path does, so long text would paint into the neighbour.
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();

        const left = x + theme.cellHorizontalPadding + 0.5;
        const right = x + w - theme.cellHorizontalPadding;
        const optimal_y = y + h / 2 - actual_height / 2;
        let draw_y = Math.max(y + theme.cellVerticalPadding, optimal_y);
        // Longest run of glyphs that can possibly fit; the same 4px/char floor
        // Glide's truncateString uses, applied per segment below.
        const max_chars = Math.ceil(w / 4);

        for (const line of data.lines) {
            const text_y = draw_y + em_height / 2 + bias;
            let pen_x = left;
            for (const segment of line) {
                if (pen_x >= right) break;
                const text = segment.text.length > max_chars
                    ? segment.text.slice(0, max_chars)
                    : segment.text;
                const font = segment_font(segment.style, data.font_size_px, theme.fontFamily);
                ctx.font = font;
                ctx.fillStyle = linked ? theme.linkColor : theme.textDark;
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

        ctx.restore();
    },
    measure: (ctx, cell, theme) =>
        content_width(ctx, cell.data, theme) + 2 * theme.cellHorizontalPadding,
    onPaste: () => undefined,
};
