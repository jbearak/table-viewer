import { describe, expect, it } from 'vitest';
import {
    choose_diff_mode,
    is_numeric_text,
    word_count,
    word_diff,
    type DiffWordSegment,
} from '../webview/word-diff';

function joined(segments: readonly DiffWordSegment[], side: 'old' | 'new'): string {
    const keep = side === 'old' ? 'deleted' : 'added';
    return segments
        .filter((s) => s.kind === 'unchanged' || s.kind === keep)
        .map((s) => s.text)
        .join('');
}

describe('word_count', () => {
    it('counts whitespace-delimited words, ignoring edge runs', () => {
        expect(word_count('')).toBe(0);
        expect(word_count('   ')).toBe(0);
        expect(word_count('one')).toBe(1);
        expect(word_count('  two  words \t here ')).toBe(3);
    });
});

describe('is_numeric_text', () => {
    it('accepts the notations Number() parses', () => {
        for (const text of ['42', ' 3.14 ', '-1e3', '0x10']) {
            expect(is_numeric_text(text)).toBe(true);
        }
    });
    it('rejects blank and non-numeric text', () => {
        // A cleared cell is not the number zero, even though Number('') is 0.
        for (const text of ['', '  ', 'abc', '1,000', '1 2']) {
            expect(is_numeric_text(text)).toBe(false);
        }
    });
});

describe('choose_diff_mode', () => {
    it('uses the arrow for numeric cells regardless of length', () => {
        expect(choose_diff_mode('long textual thing here', 'other long words', 'number'))
            .toBe('arrow');
    });
    it('uses the arrow when both sides parse as numbers', () => {
        expect(choose_diff_mode('3.14', '2.71', undefined)).toBe('arrow');
    });
    it('uses the arrow when both sides have at most two words', () => {
        expect(choose_diff_mode('New York', 'Los Angeles', 'string')).toBe('arrow');
        expect(choose_diff_mode('', 'hello', undefined)).toBe('arrow');
    });
    it('uses the inline word diff once either side exceeds two words', () => {
        expect(choose_diff_mode('the quick brown fox', 'the slow brown fox', 'string'))
            .toBe('inline');
        expect(choose_diff_mode('one', 'now three words long', undefined)).toBe('inline');
    });
    it('falls back to the arrow past the token cap', () => {
        const huge = Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ');
        expect(choose_diff_mode(huge, 'entirely different words here', undefined))
            .toBe('arrow');
    });
});

describe('word_diff', () => {
    it('marks identical strings unchanged', () => {
        expect(word_diff('same text here', 'same text here'))
            .toEqual([{ text: 'same text here', kind: 'unchanged' }]);
    });

    it('reproduces each side from its segments', () => {
        const cases: [string, string][] = [
            ['the quick brown fox', 'the slow brown fox'],
            ['', 'all of this was added'],
            ['all of this was deleted', ''],
            ['leading words kept', 'kept'],
            ['a b c', 'c b a'],
            ['tab\tseparated words', 'tab  separated words'],
        ];
        for (const [old_text, new_text] of cases) {
            const segments = word_diff(old_text, new_text);
            expect(joined(segments, 'old')).toBe(old_text);
            expect(joined(segments, 'new')).toBe(new_text);
        }
    });

    it('isolates a single replaced word', () => {
        expect(word_diff('the quick brown fox', 'the slow brown fox')).toEqual([
            { text: 'the ', kind: 'unchanged' },
            { text: 'quick', kind: 'deleted' },
            { text: 'slow', kind: 'added' },
            { text: ' brown fox', kind: 'unchanged' },
        ]);
    });

    it('surfaces a whitespace-only change instead of swallowing it', () => {
        const segments = word_diff('two  spaces here now', 'two spaces here now');
        expect(segments.some((s) => s.kind === 'deleted')).toBe(true);
        expect(segments.some((s) => s.kind === 'added')).toBe(true);
    });

    it('merges adjacent same-kind tokens into one segment', () => {
        expect(word_diff('a b', 'a b c d')).toEqual([
            { text: 'a b', kind: 'unchanged' },
            { text: ' c d', kind: 'added' },
        ]);
    });
});
