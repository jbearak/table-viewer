import { describe, it, expect } from 'vitest';
import {
    count_lines,
    has_line_break,
    normalize_line_breaks,
    split_lines,
} from '../webview/line-breaks';

describe('has_line_break', () => {
    it('detects LF, CRLF, and bare CR', () => {
        expect(has_line_break('a\nb')).toBe(true);
        expect(has_line_break('a\r\nb')).toBe(true);
        expect(has_line_break('a\rb')).toBe(true);
    });

    it('is false for single-line text', () => {
        expect(has_line_break('')).toBe(false);
        expect(has_line_break('plain')).toBe(false);
    });
});

describe('split_lines', () => {
    it('splits LF, CRLF, and bare CR identically', () => {
        expect(split_lines('a\nb')).toEqual(['a', 'b']);
        expect(split_lines('a\r\nb')).toEqual(['a', 'b']);
        expect(split_lines('a\rb')).toEqual(['a', 'b']);
    });

    it('treats CRLF as one break, not two', () => {
        expect(split_lines('a\r\n\r\nb')).toEqual(['a', '', 'b']);
    });

    it('splits mixed break styles consistently', () => {
        expect(split_lines('a\rb\nc\r\nd')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('yields a trailing empty line for a trailing break', () => {
        expect(split_lines('a\r')).toEqual(['a', '']);
        expect(split_lines('a\n')).toEqual(['a', '']);
    });
});

describe('count_lines', () => {
    it('counts every break style as one line boundary', () => {
        expect(count_lines('a')).toBe(1);
        expect(count_lines('a\nb')).toBe(2);
        expect(count_lines('a\r\nb')).toBe(2);
        expect(count_lines('a\rb')).toBe(2);
        expect(count_lines('a\rb\nc\r\nd')).toBe(4);
    });
});

describe('normalize_line_breaks', () => {
    it('rewrites CRLF and bare CR to LF', () => {
        expect(normalize_line_breaks('a\r\nb')).toBe('a\nb');
        expect(normalize_line_breaks('a\rb')).toBe('a\nb');
        expect(normalize_line_breaks('a\rb\r\nc\nd')).toBe('a\nb\nc\nd');
    });

    it('returns LF-only text unchanged (same reference)', () => {
        const text = 'a\nb';
        expect(normalize_line_breaks(text)).toBe(text);
        expect(normalize_line_breaks('plain')).toBe('plain');
    });
});
