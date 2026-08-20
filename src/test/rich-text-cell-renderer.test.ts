import { describe, it, expect } from 'vitest';
import {
    is_rich_text_cell,
    rich_text_cell_renderer,
    type RichTextGridCell,
} from '../webview/rich-text-cell-renderer';
import {
    clearTextMetricsCache,
    GridCellKind,
    getDefaultTheme,
    type FullTheme,
} from '../webview/glide-data-grid';
import type { RichTextLine } from '../webview/rich-text-layout';

/** Stub 2D context: width defaults to 10px/char, so layout is assertable.
 * Records every fillText with the font active at the time. */
function stub_ctx(measure_width: (text: string) => number = text => text.length * 10) {
    const calls: { text: string; x: number; y: number; font: string }[] = [];
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const ctx = {
        font: '',
        fillStyle: '',
        textBaseline: 'middle',
        measureText: (s: string) => ({
            width: measure_width(s),
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

const width_with_padding = (content_width: number): number =>
    content_width + 2 * theme.cellHorizontalPadding;

interface CellOptions {
    readonly hyperlink?: boolean;
    readonly allow_wrapping?: boolean;
}

function make_cell(
    lines: RichTextLine[],
    { hyperlink = false, allow_wrapping = false }: CellOptions = {},
): RichTextGridCell {
    return {
        kind: GridCellKind.Custom,
        data: {
            kind: 'rich-text',
            lines,
            font_size_px: 13,
            ...(hyperlink
                ? { hyperlink: { kind: 'external' as const, target: 'https://x.example/' } }
                : {}),
            ...(allow_wrapping ? { allow_wrapping: true as const } : {}),
        },
        copyData: 'x',
        allowOverlay: false,
    };
}

function draw(
    cell: RichTextGridCell,
    rect = { x: 0, y: 0, width: 200, height: 30 },
    stub = stub_ctx(),
) {
    rich_text_cell_renderer.draw(
        {
            ctx: stub.ctx,
            theme,
            rect,
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

    it('soft-wraps mixed runs and preserves wrapped fonts and decorations', () => {
        // 50px content width: exactly five stub characters.
        const { calls, rects } = draw(make_cell([[
            { text: 'alpha ' },
            { text: 'beta', style: { bold: true, underline: true } },
        ]], { allow_wrapping: true }), { x: 0, y: 0, width: width_with_padding(50), height: 80 });

        expect(calls.map(call => call.text)).toEqual(['alpha', 'beta']);
        expect(calls[1].y).toBeGreaterThan(calls[0].y);
        expect(calls[1].x).toBe(calls[0].x);
        expect(calls[1].font).toBe('600 13px sans');
        expect(rects).toHaveLength(1);
        expect(rects[0].x).toBe(calls[1].x);
        expect(rects[0].w).toBe(40);
    });

    it('does not cache wrapping measured while a web font starts loading', () => {
        const fonts = { status: 'loaded' };
        let character_width = 10;
        let start_loading_on_measure = true;
        const stub = stub_ctx(text => {
            // Canvas can request a previously unused face/weight. The status
            // transition therefore happens inside the first layout measurement,
            // after the renderer sampled its initial state.
            if (start_loading_on_measure) {
                start_loading_on_measure = false;
                fonts.status = 'loading';
            }
            return text.length * character_width;
        });
        const document_descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { fonts },
        });

        try {
            const cell = make_cell([[{ text: 'aaaa bbbb' }]], { allow_wrapping: true });
            const rect = { x: 0, y: 0, width: width_with_padding(50), height: 80 };
            draw(cell, rect, stub);
            expect(stub.calls.map(call => call.text)).toEqual(['aaaa', 'bbbb']);

            // The fallback layout was not cached: final-font metrics recompute it.
            stub.calls.length = 0;
            character_width = 5;
            fonts.status = 'loaded';
            draw(cell, rect, stub);
            expect(stub.calls.map(call => call.text)).toEqual(['aaaa bbbb']);
        } finally {
            if (document_descriptor) {
                Object.defineProperty(globalThis, 'document', document_descriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'document');
            }
        }
    });

    it('invalidates cached wrapping with Glide text metrics', () => {
        let character_width = 5;
        const stub = stub_ctx(text => text.length * character_width);
        const cell = make_cell([[{ text: 'aaaa bbbb' }]], { allow_wrapping: true });
        const rect = { x: 0, y: 0, width: width_with_padding(50), height: 80 };

        draw(cell, rect, stub);
        expect(stub.calls.map(call => call.text)).toEqual(['aaaa bbbb']);

        stub.calls.length = 0;
        character_width = 8;
        clearTextMetricsCache();
        draw(cell, rect, stub);
        expect(stub.calls.map(call => call.text)).toEqual(['aaaa', 'bbbb']);
    });

    it('starts each wrapped RTL line at the right padding edge', () => {
        const base = make_cell([[
            { text: 'אבגד ' },
            { text: 'הוזח', style: { bold: true } },
        ]], { allow_wrapping: true });
        const rtl_cell: RichTextGridCell = {
            ...base,
            data: { ...base.data, rtl: true },
        };
        const width = width_with_padding(40);
        const { calls } = draw(rtl_cell, { x: 0, y: 0, width, height: 80 });
        expect(calls).toHaveLength(2);
        expect(calls[0].x).toBe(width - theme.cellHorizontalPadding);
        expect(calls[1].x).toBe(width - theme.cellHorizontalPadding);
        expect(calls[1].y).toBeGreaterThan(calls[0].y);
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
            { hyperlink: true },
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
        // Widest line: 5 chars * 10 = 50, plus horizontal padding.
        expect(rich_text_cell_renderer.measure!(ctx, cell, theme))
            .toBe(width_with_padding(50));
    });

    it('keeps auto-fit measurement at the natural width when wrapping is enabled', () => {
        const { ctx } = stub_ctx();
        const cell = make_cell([[
            { text: 'abc ' },
            { text: 'de', style: { bold: true } },
        ]], { allow_wrapping: true });
        expect(rich_text_cell_renderer.measure!(ctx, cell, theme))
            .toBe(width_with_padding(60));
    });

    it('leaves the measurement font as it found it', () => {
        // The column sizer reuses one offscreen context for every cell and the
        // column title, and does not re-set the font between them — a leaked
        // bold variant would measure later plain cells too wide.
        const { ctx } = stub_ctx();
        (ctx as unknown as { font: string }).font = theme.baseFontFull;
        const cell = make_cell([[{ text: 'bold end', style: { bold: true } }]]);
        rich_text_cell_renderer.measure!(ctx, cell, theme);
        expect((ctx as unknown as { font: string }).font).toBe(theme.baseFontFull);
    });
});

describe('rich_text_cell_renderer.draw — code-review regressions', () => {
    it('restores the base font after a cell ending in a styled run', () => {
        const stub = stub_ctx();
        const cell = make_cell([[{ text: 'end bold', style: { bold: true } }]]);
        draw(cell, undefined, stub);
        // Glide's draw loop tracks the canvas font and skips resetting it
        // between cells, so draw must leave the base font behind.
        expect((stub.ctx as unknown as { font: string }).font).toBe(theme.baseFontFull);
    });

    it('stops the line after a truncated segment instead of misplacing followers', () => {
        // 200px cell → max_chars = 50; first segment is 60 chars.
        const { calls } = draw(make_cell([[
            { text: 'x'.repeat(60) },
            { text: 'AFTER', style: { bold: true } },
        ]]));
        expect(calls).toHaveLength(1);
        expect(calls[0].text).toBe('x'.repeat(50));
    });

    it('lays RTL segments out from the right edge', () => {
        const cell: RichTextGridCell = {
            ...make_cell([[{ text: 'אב' }, { text: 'גד', style: { bold: true } }]]),
        };
        const rtl_cell: RichTextGridCell = {
            ...cell,
            data: { ...cell.data, rtl: true },
        };
        const { calls } = draw(rtl_cell);
        expect(calls).toHaveLength(2);
        // First segment anchors at the right padding edge; the next continues
        // leftward (each segment is 2 chars * 10px wide).
        expect(calls[0].x).toBe(200 - theme.cellHorizontalPadding);
        expect(calls[1].x).toBe(200 - theme.cellHorizontalPadding - 20);
    });
});
