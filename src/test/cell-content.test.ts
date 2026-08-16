import { describe, it, expect } from 'vitest';
import {
    hyperlinks_equal,
    merge_text_styles,
    normalize_rich_text,
    normalize_text_style,
    rich_text_equal,
    rich_text_from_plain,
    rich_text_has_styles,
    rich_text_plain_text,
    text_styles_equal,
    type CellHyperlink,
    type RichText,
} from '../cell-content';

describe('normalize_text_style', () => {
    it('returns undefined for absent or all-false styles', () => {
        expect(normalize_text_style(undefined)).toBeUndefined();
        expect(normalize_text_style({})).toBeUndefined();
    });

    it('keeps only true fields', () => {
        expect(normalize_text_style({ bold: true, italic: true })).toEqual({ bold: true, italic: true });
        expect(normalize_text_style({ underline: true })).toEqual({ underline: true });
        expect(normalize_text_style({ strikethrough: true })).toEqual({ strikethrough: true });
    });
});

describe('text_styles_equal', () => {
    it('treats undefined and empty as equal', () => {
        expect(text_styles_equal(undefined, {})).toBe(true);
    });
    it('compares each property', () => {
        expect(text_styles_equal({ bold: true }, { bold: true })).toBe(true);
        expect(text_styles_equal({ bold: true }, { italic: true })).toBe(false);
        expect(text_styles_equal({ underline: true }, undefined)).toBe(false);
    });
});

describe('merge_text_styles', () => {
    it('unions properties', () => {
        expect(merge_text_styles({ bold: true }, { italic: true })).toEqual({ bold: true, italic: true });
    });
    it('returns undefined when both are plain', () => {
        expect(merge_text_styles(undefined, {})).toBeUndefined();
    });
});

describe('normalize_rich_text', () => {
    it('removes empty runs', () => {
        const value: RichText = { runs: [{ text: '' }, { text: 'a' }, { text: '' }] };
        expect(normalize_rich_text(value)).toEqual({ runs: [{ text: 'a' }] });
    });

    it('merges adjacent runs with equal styles', () => {
        const value: RichText = {
            runs: [
                { text: 'a', style: { bold: true } },
                { text: 'b', style: { bold: true } },
                { text: 'c' },
                { text: 'd' },
            ],
        };
        expect(normalize_rich_text(value)).toEqual({
            runs: [{ text: 'ab', style: { bold: true } }, { text: 'cd' }],
        });
    });

    it('normalizes empty style objects away and merges through them', () => {
        const value: RichText = { runs: [{ text: 'a', style: {} }, { text: 'b' }] };
        expect(normalize_rich_text(value)).toEqual({ runs: [{ text: 'ab' }] });
    });

    it('represents empty text as no runs', () => {
        expect(normalize_rich_text({ runs: [{ text: '' }] })).toEqual({ runs: [] });
    });
});

describe('rich_text_equal', () => {
    it('compares semantically, not structurally', () => {
        const a: RichText = { runs: [{ text: 'ab', style: { bold: true } }] };
        const b: RichText = {
            runs: [
                { text: 'a', style: { bold: true } },
                { text: 'b', style: { bold: true, italic: undefined as never } },
            ],
        };
        expect(rich_text_equal(a, b)).toBe(true);
    });
    it('detects style differences', () => {
        expect(rich_text_equal(
            { runs: [{ text: 'a', style: { bold: true } }] },
            { runs: [{ text: 'a', style: { italic: true } }] },
        )).toBe(false);
    });
    it('detects text differences', () => {
        expect(rich_text_equal(
            { runs: [{ text: 'a' }] },
            { runs: [{ text: 'b' }] },
        )).toBe(false);
    });
});

describe('rich_text_plain_text / rich_text_from_plain', () => {
    it('round-trips plain text', () => {
        const rich = rich_text_from_plain('hello');
        expect(rich).toEqual({ runs: [{ text: 'hello' }] });
        expect(rich_text_plain_text(rich)).toBe('hello');
    });
    it('applies a whole-cell style', () => {
        expect(rich_text_from_plain('x', { bold: true })).toEqual({
            runs: [{ text: 'x', style: { bold: true } }],
        });
    });
    it('empty text yields no runs', () => {
        expect(rich_text_from_plain('')).toEqual({ runs: [] });
        expect(rich_text_from_plain('', { bold: true })).toEqual({ runs: [] });
    });
});

describe('rich_text_has_styles', () => {
    it('is false for plain runs', () => {
        expect(rich_text_has_styles({ runs: [{ text: 'a' }] })).toBe(false);
    });
    it('is true when any run has a style', () => {
        expect(rich_text_has_styles({ runs: [{ text: 'a' }, { text: 'b', style: { strikethrough: true } }] })).toBe(true);
    });
});

describe('hyperlinks_equal', () => {
    const ext = (target: string, tooltip?: string): CellHyperlink =>
        ({ kind: 'external', target, ...(tooltip !== undefined ? { tooltip } : {}) });

    it('null/undefined equal each other only', () => {
        expect(hyperlinks_equal(null, undefined)).toBe(true);
        expect(hyperlinks_equal(null, ext('https://a'))).toBe(false);
    });
    it('compares targets and tooltips', () => {
        expect(hyperlinks_equal(ext('https://a'), ext('https://a'))).toBe(true);
        expect(hyperlinks_equal(ext('https://a'), ext('https://b'))).toBe(false);
        expect(hyperlinks_equal(ext('https://a', 'tip'), ext('https://a'))).toBe(false);
        expect(hyperlinks_equal(ext('https://a', ''), ext('https://a'))).toBe(true);
    });
    it('distinguishes internal from external', () => {
        const internal: CellHyperlink = { kind: 'internal', location: 'Sheet2!A1' };
        expect(hyperlinks_equal(internal, ext('https://a'))).toBe(false);
        expect(hyperlinks_equal(internal, { kind: 'internal', location: 'Sheet2!A1' })).toBe(true);
        expect(hyperlinks_equal(internal, { kind: 'internal', location: 'Sheet3!A1' })).toBe(false);
    });
});
