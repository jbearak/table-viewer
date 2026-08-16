import { describe, it, expect } from 'vitest';
import {
    plain_value,
    rich_value,
    editable_value_text,
    editable_values_equal,
    hyperlink_changes_equal,
    is_valid_rich_text,
    is_valid_editable_value,
    is_valid_hyperlink,
    is_valid_hyperlink_change,
} from '../pending-changes';
import type { RichText } from '../cell-content';

const STYLED: RichText = { runs: [{ text: 'a' }, { text: 'b', style: { bold: true } }] };
const UNSTYLED: RichText = { runs: [{ text: 'ab' }] };

describe('editable_value_text', () => {
    it('returns the plain text of either kind', () => {
        expect(editable_value_text(plain_value('x'))).toBe('x');
        expect(editable_value_text(rich_value(STYLED))).toBe('ab');
    });
});

describe('editable_values_equal', () => {
    it('compares plain to plain and rich to rich', () => {
        expect(editable_values_equal(plain_value('x'), plain_value('x'))).toBe(true);
        expect(editable_values_equal(plain_value('x'), plain_value('y'))).toBe(false);
        expect(editable_values_equal(rich_value(STYLED), rich_value(STYLED))).toBe(true);
        expect(editable_values_equal(rich_value(STYLED), rich_value(UNSTYLED))).toBe(false);
    });

    it('a styled rich value never equals a plain value with the same text', () => {
        expect(editable_values_equal(plain_value('ab'), rich_value(STYLED))).toBe(false);
        expect(editable_values_equal(rich_value(STYLED), plain_value('ab'))).toBe(false);
    });

    it('an unstyled rich value equals the same plain text', () => {
        expect(editable_values_equal(plain_value('ab'), rich_value(UNSTYLED))).toBe(true);
        expect(editable_values_equal(rich_value(UNSTYLED), plain_value('ab'))).toBe(true);
        expect(editable_values_equal(rich_value(UNSTYLED), plain_value('xy'))).toBe(false);
    });
});

describe('hyperlink_changes_equal', () => {
    const ext = { kind: 'external' as const, target: 'https://example.com/' };
    it('compares value and base on both sides, null meaning no link', () => {
        expect(hyperlink_changes_equal({ value: ext, base: null }, { value: { ...ext }, base: null })).toBe(true);
        expect(hyperlink_changes_equal({ value: ext, base: null }, { value: null, base: null })).toBe(false);
        expect(hyperlink_changes_equal({ value: null, base: ext }, { value: null, base: null })).toBe(false);
    });
});

describe('validators', () => {
    it('is_valid_rich_text accepts well-formed runs and rejects junk', () => {
        expect(is_valid_rich_text(STYLED)).toBe(true);
        expect(is_valid_rich_text({ runs: [] })).toBe(true);
        expect(is_valid_rich_text(null)).toBe(false);
        expect(is_valid_rich_text({ runs: 'x' })).toBe(false);
        expect(is_valid_rich_text({ runs: [{ text: 1 }] })).toBe(false);
        expect(is_valid_rich_text({ runs: [{ text: 'a', style: { bold: 'yes' } }] })).toBe(false);
        expect(is_valid_rich_text({ runs: [{ text: 'a', style: { color: true } }] })).toBe(false);
        const too_many = { runs: Array.from({ length: 4097 }, () => ({ text: 'x' })) };
        expect(is_valid_rich_text(too_many)).toBe(false);
    });

    it('is_valid_editable_value dispatches on kind', () => {
        expect(is_valid_editable_value(plain_value('x'))).toBe(true);
        expect(is_valid_editable_value(rich_value(STYLED))).toBe(true);
        expect(is_valid_editable_value({ kind: 'plain', text: 5 })).toBe(false);
        expect(is_valid_editable_value({ kind: 'richText', value: null })).toBe(false);
        expect(is_valid_editable_value({ kind: 'other' })).toBe(false);
    });

    it('is_valid_hyperlink enforces shape and length caps', () => {
        expect(is_valid_hyperlink({ kind: 'external', target: 'https://x.com' })).toBe(true);
        expect(is_valid_hyperlink({ kind: 'internal', location: 'Sheet1!A1', tooltip: 'hi' })).toBe(true);
        expect(is_valid_hyperlink({ kind: 'external', target: '' })).toBe(false);
        expect(is_valid_hyperlink({ kind: 'external', target: 'x'.repeat(8 * 1024 + 1) })).toBe(false);
        expect(is_valid_hyperlink({ kind: 'internal', location: 'x', tooltip: 42 })).toBe(false);
        expect(is_valid_hyperlink({ kind: 'mystery' })).toBe(false);
    });

    it('is_valid_hyperlink_change allows null on either side', () => {
        const ext = { kind: 'external', target: 'https://x.com/' };
        expect(is_valid_hyperlink_change({ value: ext, base: null })).toBe(true);
        expect(is_valid_hyperlink_change({ value: null, base: null })).toBe(true);
        expect(is_valid_hyperlink_change({ value: undefined, base: null })).toBe(false);
        expect(is_valid_hyperlink_change({ value: { kind: 'x' }, base: null })).toBe(false);
    });
});
