import { describe, expect, it } from 'vitest';
import {
    fit_height_for_lines,
    fit_row_height,
    lines_to_last_visible,
    source_height_runs,
    type RowFitMetrics,
} from '../webview/fit-row-model';
import { text_overflows_cell } from '../webview/cell-overflow-model';
import {
    default_row_height_for_font,
    line_height_for_font,
    MAX_ROW_HEIGHT_PX,
} from '../webview/row-heights';

/** Glide's theme numbers at the 13px base font; em is what Chromium reports. */
const metrics = (font_size_px = 13, em_height = 12.5): RowFitMetrics => ({
    em_height,
    line_height_ratio: 1.4,
    cell_vertical_padding: 3,
    tooltip_line_height: line_height_for_font(font_size_px),
    default_row_height: default_row_height_for_font(font_size_px),
});

/** `drawMultiLineText`'s clip rule for `lines` lines in a row of height `h`. */
const painter_clips = (lines: number, h: number, m: RowFitMetrics): boolean =>
    m.em_height + m.line_height_ratio * m.em_height * (lines - 1)
        + m.cell_vertical_padding > h;

describe('fit_height_for_lines', () => {
    it('keeps the default for content on one line', () => {
        expect(fit_height_for_lines(0, metrics())).toBe(24);
        expect(fit_height_for_lines(1, metrics())).toBe(24);
        expect(fit_height_for_lines(1, metrics(20, 19))).toBe(default_row_height_for_font(20));
    });

    it('neither clips when painted nor reads as truncated to the tooltip', () => {
        for (const font_size_px of [11, 13, 16, 20]) {
            // em from 0.9× to 1.25× the font size covers the fonts Chromium
            // reports for the grid's families.
            for (const em_ratio of [0.9, 1, 1.25]) {
                const m = metrics(font_size_px, font_size_px * em_ratio);
                for (let lines = 2; lines <= 40; lines += 1) {
                    const height = fit_height_for_lines(lines, m);
                    expect(painter_clips(lines, height, m)).toBe(false);
                    // The tooltip's vertical check, fed a text whose every hard
                    // line fits the width, so only the height decides.
                    const text = Array.from({ length: lines }, () => 'x').join('\n');
                    expect(text_overflows_cell(text, 200, () => 10, {
                        cell_height: height,
                        line_height: m.tooltip_line_height,
                        wrapping: true,
                    })).toBe(false);
                }
            }
        }
    });

    it('is a whole pixel and grows with each line', () => {
        let previous = fit_height_for_lines(1, metrics());
        for (let lines = 2; lines <= 10; lines += 1) {
            const height = fit_height_for_lines(lines, metrics());
            expect(Number.isInteger(height)).toBe(true);
            expect(height).toBeGreaterThan(previous);
            previous = height;
        }
    });

    it('is clamped like every stored height', () => {
        expect(fit_height_for_lines(100_000, metrics())).toBe(MAX_ROW_HEIGHT_PX);
    });
});

describe('fit_row_height', () => {
    /** Cells with these wrapped line counts, each painting all of its text at the default height iff it has one line. */
    const lines = (...counts: number[]) => counts.map((count) => ({ lines: count, fits_default: count <= 1 }));

    it('fits the cell that needs the most height', () => {
        expect(fit_row_height(lines(1, 3, 2), metrics())).toBe(fit_height_for_lines(3, metrics()));
        expect(fit_row_height([], metrics())).toBe(24);
    });

    it('keeps the default while every cell paints all of its text there', () => {
        // Two wrapped lines, yet whole on one line at the default height (into the right padding).
        expect(fit_row_height([{ lines: 2, fits_default: true }], metrics())).toBe(24);
    });

    it('grows for a cell cut at the default height, and then wraps every cell', () => {
        // One line by measure, but cut at the default height: two lines.
        expect(fit_row_height([{ lines: 1, fits_default: false }], metrics()))
            .toBe(fit_height_for_lines(2, metrics()));
        // The row grows, so a cell that fit unwrapped wraps too.
        expect(fit_row_height([{ lines: 1, fits_default: false }, { lines: 3, fits_default: true }], metrics()))
            .toBe(fit_height_for_lines(3, metrics()));
    });

    it('judges each cell in its own font', () => {
        // Two lines in a font with a much larger em need more than three in the base font.
        const tall = { lines: 2, fits_default: false, em_height: 40 };
        expect(fit_row_height([...lines(3), tall], metrics()))
            .toBe(fit_height_for_lines(2, metrics(13, 40)));
        expect(fit_row_height([tall], metrics())).toBeGreaterThan(fit_height_for_lines(3, metrics()));
    });

    it('wraps every cell of a row kept above the default', () => {
        // Whole on one line at 24px, but a vertical merge keeps the row at 25,
        // where the cell wraps to two lines.
        expect(fit_row_height([{ lines: 2, fits_default: true }], metrics(), 25))
            .toBe(fit_height_for_lines(2, metrics()));
    });

    it('shrinks a tall row to its content unless told to keep its height', () => {
        expect(fit_row_height(lines(1), metrics())).toBe(24);
        expect(fit_row_height(lines(1), metrics(), 80)).toBe(80);
        expect(fit_row_height(lines(10), metrics(), 30)).toBe(fit_height_for_lines(10, metrics()));
    });
});

describe('source_height_runs', () => {
    it('sorts display-ordered rows by source row and runs equal heights', () => {
        expect(source_height_runs([
            { source_row: 7, height: 60 },
            { source_row: 5, height: 60 },
            { source_row: 6, height: 60 },
            { source_row: 9, height: null },
            { source_row: 8, height: null },
            { source_row: 2, height: 42 },
        ])).toEqual([
            { start: 2, end: 2, height: 42 },
            { start: 5, end: 7, height: 60 },
            { start: 8, end: 9, height: null },
        ]);
    });

    it('splits a run where the height or the rows change', () => {
        expect(source_height_runs([
            { source_row: 1, height: 42 },
            { source_row: 2, height: 60 },
            { source_row: 4, height: 60 },
        ])).toEqual([
            { start: 1, end: 1, height: 42 },
            { start: 2, end: 2, height: 60 },
            { start: 4, end: 4, height: 60 },
        ]);
        expect(source_height_runs([])).toEqual([]);
    });
});

describe('lines_to_last_visible', () => {
    const visible = (line: string) => /\S/.test(line);
    it('counts through the last line that paints something, and at least one', () => {
        expect(lines_to_last_visible(['a', '', 'b', '', ' '], visible)).toBe(3);
        expect(lines_to_last_visible(['', ''], visible)).toBe(1);
        expect(lines_to_last_visible([], visible)).toBe(1);
    });
});
