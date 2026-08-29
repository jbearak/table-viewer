import { describe, it, expect } from 'vitest';
import {
    hyperlinks_equal,
    is_matching_rich_text,
    normalize_rich_text,
    normalize_text_style,
    rich_text_equal,
    rich_text_formatting_equal,
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

describe('rich_text_formatting_equal', () => {
    it('ignores text changes and plain-versus-style-free representation', () => {
        expect(rich_text_formatting_equal(
            { runs: [{ text: 'Apple' }] },
            { runs: [{ text: 'Applefff' }] },
        )).toBe(true);
        expect(rich_text_formatting_equal(
            { runs: [{ text: 'Apple' }, { text: '' }] },
            { runs: [{ text: 'Applefff', style: {} }] },
        )).toBe(true);
    });

    it('detects a changed effective style pattern', () => {
        expect(rich_text_formatting_equal(
            { runs: [{ text: 'Apple', style: { bold: true } }] },
            { runs: [{ text: 'Applefff' }] },
        )).toBe(false);
        expect(rich_text_formatting_equal(
            {
                runs: [
                    { text: 'Ap', style: { bold: true } },
                    { text: 'ple' },
                ],
            },
            {
                runs: [
                    { text: 'Apple' },
                    { text: 'fff', style: { bold: true } },
                ],
            },
        )).toBe(false);
    });

    it('treats plain text edited to or from empty as formatting-neutral', () => {
        expect(rich_text_formatting_equal(
            rich_text_from_plain('Apple'),
            rich_text_from_plain(''),
        )).toBe(true);
        expect(rich_text_formatting_equal(
            rich_text_from_plain(''),
            rich_text_from_plain('Apple'),
        )).toBe(true);
    });

    it('treats styled text edited to or from empty as formatting-neutral', () => {
        const styled = { runs: [{ text: 'Apple', style: { bold: true as const } }] };
        expect(rich_text_formatting_equal(styled, rich_text_from_plain(''))).toBe(true);
        expect(rich_text_formatting_equal(rich_text_from_plain(''), styled)).toBe(true);
    });

    it('does not treat deleting a styled run as changing retained text formatting', () => {
        expect(rich_text_formatting_equal(
            { runs: [
                { text: 'delete', style: { bold: true } },
                { text: 'keep' },
            ] },
            { runs: [{ text: 'keep' }] },
        )).toBe(true);
    });

    it('does not greedily align a deleted repeated character with the wrong style', () => {
        expect(rich_text_formatting_equal(
            { runs: [
                { text: 'A', style: { bold: true } },
                { text: 'A' },
            ] },
            { runs: [{ text: 'A' }] },
        )).toBe(true);
        expect(rich_text_formatting_equal(
            { runs: [{ text: 'A' }] },
            { runs: [
                { text: 'A', style: { bold: true } },
                { text: 'A' },
            ] },
        )).toBe(true);
    });

    it('handles highly skewed changed text without per-character row allocations', () => {
        expect(rich_text_formatting_equal(
            rich_text_from_plain('A'.repeat(100_000)),
            rich_text_from_plain('A'),
        )).toBe(true);
    });

    it('detects a formatting boundary moving within unchanged text', () => {
        expect(rich_text_formatting_equal(
            { runs: [
                { text: 'A', style: { bold: true } },
                { text: 'BC' },
            ] },
            { runs: [
                { text: 'AB', style: { bold: true } },
                { text: 'C' },
            ] },
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

describe('is_matching_rich_text', () => {
    // The text-agreement half is the smuggling boundary: base validation and
    // the CSV serializer see the entry's string sides, while the xlsx writer
    // writes the runs' text — so runs spelling something else would be written
    // past both checks.
    it('requires the concatenated run text to equal the string side', () => {
        expect(is_matching_rich_text({ runs: [{ text: 'ab' }] }, 'ab')).toBe(true);
        expect(is_matching_rich_text({ runs: [{ text: 'ab' }] }, 'ac')).toBe(false);
        expect(is_matching_rich_text(
            { runs: [{ text: 'a' }, { text: 'b', style: { bold: true } }] },
            'ab',
        )).toBe(true);
        expect(is_matching_rich_text({ runs: [] }, '')).toBe(true);
    });

    it('rejects a malformed value before ever comparing text', () => {
        expect(is_matching_rich_text({ runs: 'x' }, '')).toBe(false);
        expect(is_matching_rich_text(null, '')).toBe(false);
        expect(is_matching_rich_text({ runs: [{ text: 'a', style: { bold: 1 } }] }, 'a'))
            .toBe(false);
        expect(is_matching_rich_text({ runs: [{ text: 'a', style: { huge: true } }] }, 'a'))
            .toBe(false);
    });
});
