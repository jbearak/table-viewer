import { describe, it, expect } from 'vitest';
import {
    CELL_TOOLTIP_HORIZONTAL_PADDING_PX,
    CELL_TOOLTIP_LINE_HEIGHT_PX,
    cell_tooltip_position,
    clamp_tooltip_text,
    text_overflows_cell,
} from '../webview/cell-overflow-model';

/** Deterministic measure: 1px per character (enough to exercise the rule). */
const measure = (s: string): number => s.length;

describe('text_overflows_cell', () => {
    const inner = (cell_width: number) =>
        cell_width - CELL_TOOLTIP_HORIZONTAL_PADDING_PX * 2;

    it('is false for empty text', () => {
        expect(text_overflows_cell('', 40, measure)).toBe(false);
    });

    it('is false when a single line fits the inner width', () => {
        const width = inner(100);
        expect(text_overflows_cell('a'.repeat(width), 100, measure, { wrapping: false }))
            .toBe(false);
    });

    it('is true when a single line exceeds the inner width', () => {
        const width = inner(100);
        expect(text_overflows_cell('a'.repeat(width + 1), 100, measure, { wrapping: false }))
            .toBe(true);
    });

    it('treats hard newlines as overflow without wrapping', () => {
        expect(text_overflows_cell('a\nb', 200, measure, { wrapping: false })).toBe(true);
    });

    it('is true when the cell is too narrow for any padding', () => {
        expect(text_overflows_cell('x', 4, measure, { wrapping: false })).toBe(true);
    });

    it('detects vertical clipping of wrapped content when height is known', () => {
        // One long line that wraps into 3 visual lines needs 3 * line_height.
        const cell_width = CELL_TOOLTIP_HORIZONTAL_PADDING_PX * 2 + 10;
        const text = 'a'.repeat(30); // 3 wrapped lines at 10px/line
        const short_height = CELL_TOOLTIP_LINE_HEIGHT_PX * 2;
        const tall_height = CELL_TOOLTIP_LINE_HEIGHT_PX * 4;
        expect(text_overflows_cell(text, cell_width, measure, {
            wrapping: true,
            cell_height: short_height,
        })).toBe(true);
        expect(text_overflows_cell(text, cell_width, measure, {
            wrapping: true,
            cell_height: tall_height,
        })).toBe(false);
    });

    it('detects multi-line content that exceeds the default single-row height', () => {
        const cell_width = 200;
        const height = CELL_TOOLTIP_LINE_HEIGHT_PX + 4;
        expect(text_overflows_cell('one\ntwo\nthree', cell_width, measure, {
            wrapping: true,
            cell_height: height,
        })).toBe(true);
    });
});

describe('clamp_tooltip_text', () => {
    it('returns short text unchanged', () => {
        expect(clamp_tooltip_text('hello', 10)).toBe('hello');
    });

    it('truncates with an ellipsis when over the cap', () => {
        expect(clamp_tooltip_text('abcdefghij', 6)).toBe('abcde…');
    });
});

describe('cell_tooltip_position', () => {
    it('centers below the cell when there is room', () => {
        const pos = cell_tooltip_position(
            { x: 100, y: 50, width: 80, height: 24 },
            { width: 40, height: 20 },
            { width: 800, height: 600 },
        );
        expect(pos.left).toBe(100 + 40 - 20);
        expect(pos.top).toBe(50 + 24 + 6);
    });

    it('flips above when the bottom would clip', () => {
        const pos = cell_tooltip_position(
            { x: 100, y: 580, width: 80, height: 24 },
            { width: 40, height: 20 },
            { width: 800, height: 600 },
        );
        expect(pos.top).toBe(580 - 20 - 6);
    });

    it('clamps horizontally into the viewport gutter', () => {
        const pos = cell_tooltip_position(
            { x: 0, y: 10, width: 20, height: 20 },
            { width: 100, height: 20 },
            { width: 200, height: 200 },
        );
        expect(pos.left).toBe(8);
    });
});
