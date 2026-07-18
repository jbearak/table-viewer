import { describe, it, expect } from 'vitest';
import {
    canvas_font,
    fit_column_width,
    fit_column_widths,
    measurable_from_rendered,
    MIN_COLUMN_WIDTH,
    COLUMN_PADDING,
    type MeasurableCell,
} from '../webview/fit-column-model';
import type { RenderedCell } from '../data-source/interface';

const cell = (text: string, bold = false, italic = false): MeasurableCell => ({
    text,
    bold,
    italic,
});

// Fake measure: 10px per character, +50px when bold (heavier glyphs), italic
// free. Scaled so realistic strings clear MIN_COLUMN_WIDTH and the max+padding
// path is genuinely exercised without a real canvas.
const fake_measure = (c: MeasurableCell): number =>
    c.text.length * 10 + (c.bold ? 50 : 0);

describe('canvas_font', () => {
    it('emits just size + family for a plain cell', () => {
        expect(canvas_font(false, false, 'Menlo')).toBe('13px Menlo');
    });

    it('prefixes the 600 weight for bold', () => {
        expect(canvas_font(true, false, 'Menlo')).toBe('600 13px Menlo');
    });

    it('prefixes italic for italic', () => {
        expect(canvas_font(false, true, 'Menlo')).toBe('italic 13px Menlo');
    });

    it('combines italic then weight for bold + italic', () => {
        expect(canvas_font(true, true, 'Menlo')).toBe('italic 600 13px Menlo');
    });

    it('honours a custom font size', () => {
        expect(canvas_font(false, false, 'Arial', 11)).toBe('11px Arial');
    });
});

describe('fit_column_width', () => {
    it('returns the minimum width for an empty column', () => {
        expect(fit_column_width([], fake_measure)).toBe(MIN_COLUMN_WIDTH);
    });

    it('takes the widest cell plus padding', () => {
        // "wide-ish text" = 13 chars → 130 + COLUMN_PADDING.
        const out = fit_column_width(
            [cell('short'), cell('wide-ish text'), cell('mid')],
            fake_measure,
        );
        expect(out).toBe(130 + COLUMN_PADDING);
    });

    it('measures bold cells at their heavier width', () => {
        // bold "abcd" → 40 + 50 = 90, beats plain "abcdef" → 60.
        const out = fit_column_width(
            [cell('abcdef'), cell('abcd', true)],
            fake_measure,
        );
        expect(out).toBe(90 + COLUMN_PADDING);
    });

    it('never drops below the minimum even for tiny content', () => {
        expect(fit_column_width([cell('x')], fake_measure)).toBe(MIN_COLUMN_WIDTH);
    });

    it('honours custom min and padding', () => {
        expect(fit_column_width([cell('abcde')], fake_measure, 0, 2)).toBe(52);
    });
});

describe('fit_column_widths', () => {
    it('fits each column independently across the sampled rows', () => {
        const sample: (MeasurableCell | null)[][] = [
            [cell('a'), cell('longer value')],
            [cell('bb'), cell('x')],
        ];
        const out = fit_column_widths(sample, [0, 1], fake_measure);
        expect(out).toEqual({
            0: MIN_COLUMN_WIDTH, // widest is "bb" (20px) → below min
            1: 'longer value'.length * 10 + COLUMN_PADDING,
        });
    });

    it('skips null cells and still fits the rest of the column', () => {
        const sample: (MeasurableCell | null)[][] = [
            [null, cell('present')],
            [cell('abc'), null],
        ];
        const out = fit_column_widths(sample, [0, 1], fake_measure);
        expect(out[1]).toBe('present'.length * 10 + COLUMN_PADDING);
    });

    it('gives a column with no sampled content the minimum width', () => {
        const sample: (MeasurableCell | null)[][] = [[cell('a'), null]];
        const out = fit_column_widths(sample, [0, 1], fake_measure);
        expect(out[1]).toBe(MIN_COLUMN_WIDTH);
    });

    it('returns an entry for every requested source column', () => {
        const out = fit_column_widths([[cell('a')]], [0, 1, 2], fake_measure);
        expect(Object.keys(out).sort()).toEqual(['0', '1', '2']);
    });

    it('measures visible source columns and returns source-keyed widths', () => {
        const measured: string[] = [];
        const measure = (value: MeasurableCell) => {
            measured.push(value.text);
            return fake_measure(value);
        };
        const out = fit_column_widths(
            [[cell('a'), cell('hidden widest value'), cell('visible c')]],
            [0, 2],
            measure,
        );
        expect(Object.keys(out).sort()).toEqual(['0', '2']);
        expect(measured).toEqual(['a', 'visible c']);
        expect(out[2]).toBe('visible c'.length * 10 + COLUMN_PADDING);
    });

    it('returns no widths when all columns are hidden', () => {
        expect(fit_column_widths([[cell('a')]], [], fake_measure)).toEqual({});
    });
});

describe('measurable_from_rendered', () => {
    const rendered = (over: Partial<RenderedCell>): RenderedCell => ({
        raw: '1000',
        formatted: '$1,000',
        bold: true,
        italic: true,
        ...over,
    });

    it('passes through null', () => {
        expect(measurable_from_rendered(null, true)).toBeNull();
    });

    it('measures the formatted text + styles when formatting is on', () => {
        expect(measurable_from_rendered(rendered({}), true)).toEqual({
            text: '$1,000',
            bold: true,
            italic: true,
        });
    });

    it('measures the raw text and drops styles when formatting is off', () => {
        expect(measurable_from_rendered(rendered({}), false)).toEqual({
            text: '1000',
            bold: false,
            italic: false,
        });
    });

    it('treats a null raw value as empty text', () => {
        expect(
            measurable_from_rendered(rendered({ raw: null }), false),
        ).toEqual({ text: '', bold: false, italic: false });
    });
});
