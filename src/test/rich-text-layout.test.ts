import { describe, it, expect } from 'vitest';
import { rich_text_lines } from '../webview/rich-text-layout';

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
