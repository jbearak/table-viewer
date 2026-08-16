import { describe, it, expect } from 'vitest';
import {
    CELL_TOOLTIP_HORIZONTAL_PADDING_PX,
    CELL_TOOLTIP_LINE_HEIGHT_PX,
    cell_tooltip_content,
    cell_tooltip_position,
    clamp_tooltip_text,
    link_open_hint,
    rich_text_overflows_cell,
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

    it('treats LF, CRLF, and bare CR breaks identically (#202)', () => {
        // Hard break without wrapping → overflow, whatever the break style.
        for (const text of ['a\nb', 'a\r\nb', 'a\rb']) {
            expect(text_overflows_cell(text, 200, measure, { wrapping: false })).toBe(true);
        }
        // Two short lines in a two-line-tall cell fit, whatever the break style.
        for (const text of ['a\nb', 'a\r\nb', 'a\rb']) {
            expect(text_overflows_cell(text, 200, measure, {
                cell_height: CELL_TOOLTIP_LINE_HEIGHT_PX * 2 + CELL_TOOLTIP_HORIZONTAL_PADDING_PX,
            })).toBe(false);
        }
    });

    it('never measures a CR as part of a line', () => {
        // Inner width exactly fits the one-character lines; a surviving CR
        // would make the first CRLF line measure 2px and report a wrap.
        const cell_width = CELL_TOOLTIP_HORIZONTAL_PADDING_PX * 2 + 1;
        expect(text_overflows_cell('a\r\nb', cell_width, measure, {
            wrapping: true,
            cell_height: CELL_TOOLTIP_LINE_HEIGHT_PX * 2 + CELL_TOOLTIP_HORIZONTAL_PADDING_PX,
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

describe('cell_tooltip_content', () => {
    const link = { kind: 'external' as const, target: 'https://x.example/', tooltip: 'Go' };

    it('is null with no overflow and no link', () => {
        expect(cell_tooltip_content('short', false, undefined)).toBeNull();
    });

    it('shows the text alone on overflow', () => {
        expect(cell_tooltip_content('long text', true, undefined)).toBe('long text');
    });

    it("shows the link's tooltip without overflow", () => {
        expect(cell_tooltip_content('short', false, link)).toBe('Go');
    });

    it('falls back to the target / location when the link has no tooltip', () => {
        expect(cell_tooltip_content('short', false, { kind: 'external', target: 'https://x.example/' }))
            .toBe('https://x.example/');
        expect(cell_tooltip_content('short', false, { kind: 'internal', location: 'Sheet2!A1' }))
            .toBe('Sheet2!A1');
    });

    it('appends the link line to overflowing text', () => {
        expect(cell_tooltip_content('long text', true, link)).toBe('long text\nGo');
    });

    it('appends the platform open hint to external links only', () => {
        expect(cell_tooltip_content('short', false, link, link_open_hint(true)))
            .toBe('Go\nCmd+click to open link');
        expect(cell_tooltip_content('long text', true, link, link_open_hint(false)))
            .toBe('long text\nGo\nCtrl+click to open link');
        // Internal links aren't openable, so no gesture to teach.
        expect(cell_tooltip_content(
            'short',
            false,
            { kind: 'internal', location: 'Sheet2!A1' },
            link_open_hint(false),
        )).toBe('Sheet2!A1');
        // Plain overflow tooltips stay hint-free.
        expect(cell_tooltip_content('long text', true, undefined, link_open_hint(true)))
            .toBe('long text');
    });
});

describe('link_open_hint', () => {
    it('names the platform modifier', () => {
        expect(link_open_hint(true)).toBe('Cmd+click to open link');
        expect(link_open_hint(false)).toBe('Ctrl+click to open link');
    });
});

describe('rich_text_overflows_cell', () => {
    // 1px per char; bold counts double, so per-style fonts matter.
    const rich_measure = (text: string, style?: { bold?: true }): number =>
        text.length * (style?.bold ? 2 : 1);

    it('fits when the widest line fits', () => {
        expect(rich_text_overflows_cell(
            [[{ text: 'abc' }]],
            3 + 2 * CELL_TOOLTIP_HORIZONTAL_PADDING_PX + 1,
            rich_measure,
        )).toBe(false);
    });

    it('overflows when a bold run pushes past the width plain text would fit', () => {
        const width = 8 + 2 * CELL_TOOLTIP_HORIZONTAL_PADDING_PX;
        expect(rich_text_overflows_cell(
            [[{ text: 'abcd' }, { text: 'efgh' }]],
            width, rich_measure,
        )).toBe(false);
        expect(rich_text_overflows_cell(
            [[{ text: 'abcd' }, { text: 'efgh', style: { bold: true } }]],
            width, rich_measure,
        )).toBe(true);
    });

    it('treats extra hard lines as overflow without a height budget (no soft wrap)', () => {
        expect(rich_text_overflows_cell(
            [[{ text: 'a' }], [{ text: 'b' }]],
            100, rich_measure,
        )).toBe(true);
    });

    it('fits multiple lines inside a sufficient height budget', () => {
        expect(rich_text_overflows_cell(
            [[{ text: 'a' }], [{ text: 'b' }]],
            100, rich_measure,
            { cell_height: 3 * CELL_TOOLTIP_LINE_HEIGHT_PX, line_height: CELL_TOOLTIP_LINE_HEIGHT_PX },
        )).toBe(false);
        expect(rich_text_overflows_cell(
            [[{ text: 'a' }], [{ text: 'b' }], [{ text: 'c' }], [{ text: 'd' }]],
            100, rich_measure,
            { cell_height: 3 * CELL_TOOLTIP_LINE_HEIGHT_PX, line_height: CELL_TOOLTIP_LINE_HEIGHT_PX },
        )).toBe(true);
    });
});
