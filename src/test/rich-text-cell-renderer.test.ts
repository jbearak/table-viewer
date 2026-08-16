import { describe, it, expect } from 'vitest';
import {
    is_rich_text_cell,
    rich_text_cell_renderer,
    type RichTextGridCell,
} from '../webview/rich-text-cell-renderer';
import { GridCellKind, getDefaultTheme, type FullTheme } from '../webview/glide-data-grid';
import type { RichTextLine } from '../webview/rich-text-layout';

/** Stub 2D context: width = 10px/char, so layout is assertable. Records every
 *  fillText with the font active at the time. */
function stub_ctx() {
    const calls: { text: string; x: number; y: number; font: string }[] = [];
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const ctx = {
        font: '',
        fillStyle: '',
        textBaseline: 'middle',
        measureText: (s: string) => ({
            width: s.length * 10,
            actualBoundingBoxAscent: 9,
            actualBoundingBoxDescent: 3,
        }),
        fillText(text: string, x: number, y: number) {
            calls.push({ text, x, y, font: this.font });
        },
        fillRect(x: number, y: number, w: number, h: number) {
            rects.push({ x, y, w, h });
        },
        save() {},
        restore() {},
        beginPath() {},
        rect() {},
        clip() {},
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, rects };
}

const theme: FullTheme = {
    ...getDefaultTheme(),
    baseFontFull: '13px sans',
    headerFontFull: '600 13px sans',
    markerFontFull: '9px sans',
    fontFamily: 'sans',
};

function make_cell(lines: RichTextLine[], hyperlink = false): RichTextGridCell {
    return {
        kind: GridCellKind.Custom,
        data: {
            kind: 'rich-text',
            lines,
            font_size_px: 13,
            ...(hyperlink
                ? { hyperlink: { kind: 'external' as const, target: 'https://x.example/' } }
                : {}),
        },
        copyData: 'x',
        allowOverlay: false,
    };
}

function draw(cell: RichTextGridCell) {
    const stub = stub_ctx();
    rich_text_cell_renderer.draw(
        {
            ctx: stub.ctx,
            theme,
            rect: { x: 0, y: 0, width: 200, height: 30 },
            cell,
            col: 0,
            row: 0,
            highlighted: false,
            hoverAmount: 0,
            hoverX: undefined,
            hoverY: undefined,
            cellFillColor: '#fff',
            imageLoader: undefined as never,
            spriteManager: undefined as never,
            hyperWrapping: false,
            requestAnimationFrame: () => {},
            drawState: [undefined, () => {}],
            frameTime: 0,
            overrideCursor: undefined,
        },
        cell,
    );
    return stub;
}

describe('is_rich_text_cell', () => {
    it('matches only the rich-text discriminant', () => {
        expect(is_rich_text_cell(make_cell([[]]))).toBe(true);
        expect(is_rich_text_cell({
            kind: GridCellKind.Custom,
            data: { kind: 'other' },
            copyData: '',
            allowOverlay: false,
        })).toBe(false);
        expect(is_rich_text_cell({
            kind: GridCellKind.Custom,
            data: {},
            copyData: '',
            allowOverlay: false,
        } as never)).toBe(false);
    });
});

describe('rich_text_cell_renderer.draw', () => {
    it('draws segments left-to-right with per-segment fonts', () => {
        const { calls } = draw(make_cell([[
            { text: 'ab' },
            { text: 'cd', style: { bold: true } },
            { text: 'ef', style: { italic: true } },
        ]]));
        expect(calls.map((c) => c.text)).toEqual(['ab', 'cd', 'ef']);
        // Each segment starts where the previous one ended (10px/char).
        expect(calls[1].x - calls[0].x).toBe(20);
        expect(calls[2].x - calls[1].x).toBe(20);
        expect(calls[0].font).toBe('13px sans');
        expect(calls[1].font).toBe('600 13px sans');
        expect(calls[2].font).toBe('italic 13px sans');
    });

    it('stacks lines vertically', () => {
        const { calls } = draw(make_cell([
            [{ text: 'top' }],
            [{ text: 'bottom' }],
        ]));
        expect(calls).toHaveLength(2);
        expect(calls[1].y).toBeGreaterThan(calls[0].y);
        expect(calls[1].x).toBe(calls[0].x);
    });

    it('underlines and strikes styled segments via fillRect', () => {
        const { calls, rects } = draw(make_cell([[
            { text: 'plain' },
            { text: 'both', style: { underline: true, strikethrough: true } },
        ]]));
        expect(calls).toHaveLength(2);
        // One strike + one underline, spanning exactly the styled segment.
        expect(rects).toHaveLength(2);
        for (const rect of rects) {
            expect(rect.x).toBe(calls[1].x);
            expect(rect.w).toBe(40);
            expect(rect.h).toBe(1);
        }
        // Strike crosses the text; underline sits below it.
        expect(rects[0].y).toBeLessThan(rects[1].y);
    });

    it('underlines every segment of a linked cell in the link color', () => {
        const { calls, rects } = draw(make_cell(
            [[{ text: 'go' }, { text: 'to', style: { bold: true } }]],
            true,
        ));
        expect(rects).toHaveLength(2);
        expect(rects[0].x).toBe(calls[0].x);
        expect(rects[1].x).toBe(calls[1].x);
    });
});

describe('rich_text_cell_renderer.measure', () => {
    it('returns the widest line plus horizontal padding', () => {
        const { ctx } = stub_ctx();
        const cell = make_cell([
            [{ text: 'abc' }, { text: 'de', style: { bold: true } }],
            [{ text: 'xy' }],
        ]);
        // Widest line: 5 chars * 10 = 50, plus 2 * padding (8) = 66.
        expect(rich_text_cell_renderer.measure!(ctx, cell, theme)).toBe(66);
    });
});
