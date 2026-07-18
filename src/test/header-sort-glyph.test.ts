import { describe, expect, it, vi } from 'vitest';
import { draw_sort_glyphs, header_sort_metadata } from '../webview/header-sort-glyph';

describe('header sort glyphs', () => {
    it('maps source sort keys to one-based priority metadata', () => {
        const metadata = header_sort_metadata([
            { colIndex: 4, direction: 'desc' },
            { colIndex: 1, direction: 'asc' },
        ]);
        expect(metadata.get(4)).toEqual({ direction: 'desc', priority: 1 });
        expect(metadata.get(1)).toEqual({ direction: 'asc', priority: 2 });
    });

    it('clips, draws an arrow, and paints a priority badge without changing titles', () => {
        const ctx = {
            save: vi.fn(),
            beginPath: vi.fn(),
            rect: vi.fn(),
            clip: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            closePath: vi.fn(),
            fill: vi.fn(),
            arc: vi.fn(),
            fillText: vi.fn(),
            restore: vi.fn(),
            fillStyle: '',
            globalAlpha: 1,
            font: '',
            textAlign: 'start',
            textBaseline: 'alphabetic',
        } as unknown as CanvasRenderingContext2D;
        draw_sort_glyphs(
            ctx,
            { x: 0, y: 0, width: 100, height: 36 },
            { textHeader: '#fff', bgHeader: '#222', bgCell: '#111', fontFamily: 'sans' },
            { direction: 'asc', priority: 2 },
            true,
        );
        expect(ctx.save).toHaveBeenCalledOnce();
        expect(ctx.clip).toHaveBeenCalledOnce();
        expect(ctx.arc).toHaveBeenCalledOnce();
        expect(ctx.fillText).toHaveBeenCalledWith('2', expect.any(Number), expect.any(Number));
        expect(ctx.restore).toHaveBeenCalledOnce();
    });
});
