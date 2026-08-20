import { describe, it, expect } from 'vitest';
import { rich_text_lines, wrap_rich_text_lines } from '../webview/rich-text-layout';

describe('rich_text_lines', () => {
    it('keeps a single plain run on one line', () => {
        expect(rich_text_lines([{ text: 'hello' }])).toEqual([
            [{ text: 'hello' }],
        ]);
    });

    it('carries run styles onto segments', () => {
        expect(rich_text_lines([
            { text: 'a' },
            { text: 'b', style: { bold: true } },
        ])).toEqual([
            [{ text: 'a' }, { text: 'b', style: { bold: true } }],
        ]);
    });

    it('splits a run at LF, CRLF, and bare CR alike', () => {
        expect(rich_text_lines([{ text: 'a\nb\r\nc\rd' }])).toEqual([
            [{ text: 'a' }],
            [{ text: 'b' }],
            [{ text: 'c' }],
            [{ text: 'd' }],
        ]);
    });

    it('spans a styled run across the lines it covers', () => {
        expect(rich_text_lines([
            { text: 'x\ny', style: { italic: true } },
            { text: 'z' },
        ])).toEqual([
            [{ text: 'x', style: { italic: true } }],
            [{ text: 'y', style: { italic: true } }, { text: 'z' }],
        ]);
    });

    it('preserves empty lines but drops empty segments', () => {
        expect(rich_text_lines([{ text: 'a\n\nb' }])).toEqual([
            [{ text: 'a' }],
            [],
            [{ text: 'b' }],
        ]);
    });

    it('a trailing break yields a final empty line, matching count_lines', () => {
        expect(rich_text_lines([{ text: 'a\n' }])).toEqual([
            [{ text: 'a' }],
            [],
        ]);
    });

    it('empty input yields one empty line', () => {
        expect(rich_text_lines([])).toEqual([[]]);
    });
});

describe('wrap_rich_text_lines', () => {
    const measure = (text: string): number => Array.from(text).length;

    it('wraps at spaces and keeps the wrapped run style', () => {
        expect(wrap_rich_text_lines([[
            { text: 'hello ' },
            { text: 'world', style: { bold: true } },
        ]], 6, measure)).toEqual([
            [{ text: 'hello' }],
            [{ text: 'world', style: { bold: true } }],
        ]);
    });

    it('carries diff colors across a wrap', () => {
        // Diff-mode segments tag a paint-only diff_color; the wrapper must
        // forward it or a wrapped deleted word loses its color mid-line.
        expect(wrap_rich_text_lines([[
            { text: 'gone ', style: { strikethrough: true }, diff_color: 'red' },
            { text: 'fresh', diff_color: 'green' },
        ]], 5, measure)).toEqual([
            [{ text: 'gone', style: { strikethrough: true }, diff_color: 'red' }],
            [{ text: 'fresh', diff_color: 'green' }],
        ]);
    });

    it('does not treat a style boundary inside a word as a wrap point', () => {
        expect(wrap_rich_text_lines([[
            { text: 'ab' },
            { text: 'cd', style: { italic: true } },
            { text: ' ef' },
        ]], 4, measure)).toEqual([
            [{ text: 'ab' }, { text: 'cd', style: { italic: true } }],
            [{ text: 'ef' }],
        ]);
    });

    it('preserves repeated spaces within a line and omits them at a soft break', () => {
        const line = [[{ text: 'a  b' }]];
        expect(wrap_rich_text_lines(line, 4, measure)).toEqual(line);
        expect(wrap_rich_text_lines(line, 3, measure)).toEqual([
            [{ text: 'a' }],
            [{ text: 'b' }],
        ]);
    });

    it('preserves hard blank lines alongside soft-wrapped lines', () => {
        expect(wrap_rich_text_lines([
            [{ text: 'aa bb' }],
            [],
            [{ text: 'cc' }],
        ], 2, measure)).toEqual([
            [{ text: 'aa' }],
            [{ text: 'bb' }],
            [],
            [{ text: 'cc' }],
        ]);
    });

    it('does not prefer a non-breaking space as a wrap point', () => {
        expect(wrap_rich_text_lines([[
            { text: 'a b c' },
        ]], 3, measure)).toEqual([
            [{ text: 'a b' }],
            [{ text: 'c' }],
        ]);
    });

    it('splits an over-wide word at grapheme boundaries and always advances', () => {
        const family = '👨‍👩‍👧‍👦';
        const grapheme_measure = (text: string): number => text === family
            ? 10
            : Array.from(text).length;
        expect(wrap_rich_text_lines([[
            { text: `${family}x`, style: { underline: true } },
        ]], 2, grapheme_measure)).toEqual([
            [{ text: family, style: { underline: true } }],
            [{ text: 'x', style: { underline: true } }],
        ]);
    });

    it('keeps measurement work bounded for a long word without spaces', () => {
        const text = 'x'.repeat(4096);
        let measured_characters = 0;
        const tracking_measure = (value: string): number => {
            measured_characters += value.length;
            return value.length;
        };
        const lines = wrap_rich_text_lines([[{ text }]], 8, tracking_measure);

        expect(lines).toHaveLength(text.length / 8);
        expect(lines.flatMap(line => line.map(segment => segment.text)).join('')).toBe(text);
        // Exponential search only probes around each emitted line. A search over
        // every remaining suffix would grow quadratically and exceed this bound
        // by orders of magnitude for the same input.
        expect(measured_characters).toBeLessThan(text.length * 12);
    });
});
