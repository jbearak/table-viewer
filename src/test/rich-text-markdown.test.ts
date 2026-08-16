import { describe, it, expect } from 'vitest';
import { markdown_to_rich_text, rich_text_to_markdown } from '../rich-text-markdown';
import { normalize_rich_text, type RichText } from '../cell-content';

const rt = (...runs: RichText['runs'][number][]): RichText => ({ runs });

describe('rich_text_to_markdown', () => {
    it('serializes plain text unchanged', () => {
        expect(rich_text_to_markdown(rt({ text: 'hello world' }))).toBe('hello world');
    });

    it('serializes each style', () => {
        expect(rich_text_to_markdown(rt({ text: 'b', style: { bold: true } }))).toBe('**b**');
        expect(rich_text_to_markdown(rt({ text: 'i', style: { italic: true } }))).toBe('*i*');
        expect(rich_text_to_markdown(rt({ text: 'u', style: { underline: true } }))).toBe('<u>u</u>');
        expect(rich_text_to_markdown(rt({ text: 's', style: { strikethrough: true } }))).toBe('~~s~~');
    });

    it('uses canonical nesting order (bold > italic > underline > strike)', () => {
        expect(rich_text_to_markdown(rt({
            text: 'x',
            style: { bold: true, italic: true, underline: true, strikethrough: true },
        }))).toBe('***<u>~~x~~</u>***');
    });

    it('keeps shared styles open across runs', () => {
        expect(rich_text_to_markdown(rt(
            { text: 'a', style: { bold: true } },
            { text: 'b', style: { bold: true, italic: true } },
            { text: 'c', style: { bold: true } },
        ))).toBe('**a*b*c**');
    });

    it('escapes literal markup characters', () => {
        expect(rich_text_to_markdown(rt({ text: '2*3 ~ <u> \\ >' }))).toBe('2\\*3 \\~ \\<u\\> \\\\ \\>');
    });

    it('serializes empty rich text as empty string', () => {
        expect(rich_text_to_markdown({ runs: [] })).toBe('');
    });

    it('preserves newlines', () => {
        expect(rich_text_to_markdown(rt({ text: 'a\nb', style: { bold: true } }))).toBe('**a\nb**');
    });
});

describe('markdown_to_rich_text', () => {
    it('parses plain text', () => {
        expect(markdown_to_rich_text('hello')).toEqual({ runs: [{ text: 'hello' }] });
    });

    it('parses each construct', () => {
        expect(markdown_to_rich_text('**b**')).toEqual({ runs: [{ text: 'b', style: { bold: true } }] });
        expect(markdown_to_rich_text('*i*')).toEqual({ runs: [{ text: 'i', style: { italic: true } }] });
        expect(markdown_to_rich_text('<u>u</u>')).toEqual({ runs: [{ text: 'u', style: { underline: true } }] });
        expect(markdown_to_rich_text('~~s~~')).toEqual({ runs: [{ text: 's', style: { strikethrough: true } }] });
    });

    it('parses nesting', () => {
        expect(markdown_to_rich_text('**a*b*c**')).toEqual({
            runs: [
                { text: 'a', style: { bold: true } },
                { text: 'b', style: { bold: true, italic: true } },
                { text: 'c', style: { bold: true } },
            ],
        });
    });

    it('parses ***bold italic***', () => {
        expect(markdown_to_rich_text('***x***')).toEqual({
            runs: [{ text: 'x', style: { bold: true, italic: true } }],
        });
    });

    it('treats unmatched delimiters as literal text', () => {
        expect(markdown_to_rich_text('a * b')).toEqual({ runs: [{ text: 'a * b' }] });
        expect(markdown_to_rich_text('**unclosed')).toEqual({ runs: [{ text: '**unclosed' }] });
        expect(markdown_to_rich_text('<u>unclosed')).toEqual({ runs: [{ text: '<u>unclosed' }] });
        expect(markdown_to_rich_text('stray</u>')).toEqual({ runs: [{ text: 'stray</u>' }] });
        expect(markdown_to_rich_text('~~half')).toEqual({ runs: [{ text: '~~half' }] });
    });

    it('keeps styles of matched delimiters around an unmatched one', () => {
        expect(markdown_to_rich_text('**a *b**')).toEqual({
            runs: [{ text: 'a *b', style: { bold: true } }],
        });
    });

    it('decodes escapes', () => {
        expect(markdown_to_rich_text('2\\*3 \\~ \\<u\\> \\\\')).toEqual({ runs: [{ text: '2*3 ~ <u> \\' }] });
    });

    it('a lone trailing backslash is literal', () => {
        expect(markdown_to_rich_text('a\\')).toEqual({ runs: [{ text: 'a\\' }] });
    });

    it('leaves other markdown constructs literal', () => {
        expect(markdown_to_rich_text('[label](https://x) `code` # heading')).toEqual({
            runs: [{ text: '[label](https://x) `code` # heading' }],
        });
    });

    it('a run of four stars mid-word is literal (matches CommonMark)', () => {
        expect(markdown_to_rich_text('a****b')).toEqual({ runs: [{ text: 'a****b' }] });
    });

    it('an empty span between separate delimiters is normalized away', () => {
        expect(markdown_to_rich_text('a<u></u>b')).toEqual({ runs: [{ text: 'ab' }] });
    });

    it('parses empty string', () => {
        expect(markdown_to_rich_text('')).toEqual({ runs: [] });
    });

    it('handles newlines inside formatting', () => {
        expect(markdown_to_rich_text('**a\nb**')).toEqual({
            runs: [{ text: 'a\nb', style: { bold: true } }],
        });
    });

    it('handles unicode around delimiters', () => {
        expect(markdown_to_rich_text('**🎉📊**')).toEqual({
            runs: [{ text: '🎉📊', style: { bold: true } }],
        });
    });
});

describe('round-trip invariants', () => {
    const cases: RichText[] = [
        { runs: [] },
        { runs: [{ text: 'plain' }] },
        { runs: [{ text: 'a *literal* star' }] },
        { runs: [{ text: 'pre' }, { text: 'bold', style: { bold: true } }, { text: 'post' }] },
        {
            runs: [
                { text: 'a', style: { bold: true, italic: true } },
                { text: 'b', style: { italic: true } },
                { text: 'c', style: { underline: true, strikethrough: true } },
            ],
        },
        { runs: [{ text: '~<>\\*', style: { strikethrough: true } }] },
        { runs: [{ text: 'line1\nline2', style: { underline: true } }] },
        {
            runs: [
                { text: 'all', style: { bold: true, italic: true, underline: true, strikethrough: true } },
            ],
        },
        // Style transitions whose delimiters land adjacent: a**b*c*** must
        // parse back as bold "b" + bold-italic "c", not bold "b*c".
        {
            runs: [
                { text: 'a' },
                { text: 'b', style: { bold: true } },
                { text: 'c', style: { bold: true, italic: true } },
            ],
        },
        {
            runs: [
                { text: 'a', style: { italic: true } },
                { text: 'b', style: { bold: true, italic: true } },
                { text: 'c', style: { bold: true } },
            ],
        },
    ];

    it('markdown_to_rich_text(rich_text_to_markdown(x)) === normalize(x)', () => {
        for (const value of cases) {
            const md = rich_text_to_markdown(value);
            expect(markdown_to_rich_text(md)).toEqual(normalize_rich_text(value));
        }
    });

    it('serialize(parse(serialize(x))) === serialize(x)', () => {
        for (const value of cases) {
            const md = rich_text_to_markdown(value);
            expect(rich_text_to_markdown(markdown_to_rich_text(md))).toBe(md);
        }
    });

    it('boundary whitespace round-trips its text (styles move off the space)', () => {
        // CommonMark flanking makes "** x**" unparseable, so the serializer
        // emits boundary whitespace outside the delimiters. Text must be
        // preserved exactly; bold moves off the spaces.
        const value: RichText = { runs: [{ text: ' x ', style: { bold: true } }] };
        const md = rich_text_to_markdown(value);
        expect(md).toBe(' **x** ');
        expect(markdown_to_rich_text(md)).toEqual({
            runs: [{ text: ' ' }, { text: 'x', style: { bold: true } }, { text: ' ' }],
        });
    });

    it('an all-whitespace styled run keeps its text', () => {
        const value: RichText = {
            runs: [{ text: 'a', style: { bold: true } }, { text: ' ' }, { text: 'b', style: { bold: true } }],
        };
        const md = rich_text_to_markdown(value);
        expect(markdown_to_rich_text(md)).toEqual(normalize_rich_text(value));
        const spaced: RichText = { runs: [{ text: '  ', style: { italic: true } }] };
        expect(markdown_to_rich_text(rich_text_to_markdown(spaced))).toEqual({ runs: [{ text: '  ' }] });
    });

    it('exhaustive: every 3-run sequence over 5 styles round-trips', () => {
        // Runs "a","b","c" each carrying one of: plain, bold, italic,
        // bold+italic, strike — 125 sequences covering every adjacent style
        // transition the serializer can emit (incl. merged star runs).
        const styles = [
            undefined,
            { bold: true as const },
            { italic: true as const },
            { bold: true as const, italic: true as const },
            { strikethrough: true as const },
        ];
        const texts = ['a', 'b', 'c'];
        for (const s0 of styles) for (const s1 of styles) for (const s2 of styles) {
            const value: RichText = {
                runs: [s0, s1, s2].map((style, i) =>
                    style ? { text: texts[i], style } : { text: texts[i] }),
            };
            const md = rich_text_to_markdown(value);
            expect(markdown_to_rich_text(md), `via ${JSON.stringify(md)}`)
                .toEqual(normalize_rich_text(value));
        }
    });

    it('all 16 style combinations round-trip', () => {
        for (let mask = 0; mask < 16; mask++) {
            const style = {
                ...(mask & 1 ? { bold: true as const } : {}),
                ...(mask & 2 ? { italic: true as const } : {}),
                ...(mask & 4 ? { underline: true as const } : {}),
                ...(mask & 8 ? { strikethrough: true as const } : {}),
            };
            const value: RichText = { runs: [{ text: 'x', ...(mask ? { style } : {}) }] };
            const md = rich_text_to_markdown(value);
            expect(markdown_to_rich_text(md)).toEqual(normalize_rich_text(value));
        }
    });
});
