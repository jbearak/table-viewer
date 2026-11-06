/**
 * The column header tooltip: the physical Excel column of a promoted header
 * row, and the details a `.dta` or Parquet source gives for the column
 * (variable label, type, value label set, and footer statistics), one per
 * line.
 */
import type { ColumnDetails } from '../data-source/interface';
import { clamp_tooltip_text } from './cell-overflow-model';
import { column_letter } from './grid-model';
import { split_lines } from './line-breaks';

/** Widest the estimate goes; matches `.cell-overflow-tooltip`'s max-width. */
const HEADER_TOOLTIP_MAX_WIDTH_PX = 480;
const HEADER_TOOLTIP_MIN_WIDTH_PX = 80;
const HEADER_TOOLTIP_CHARACTER_PX = 7;
const HEADER_TOOLTIP_FIRST_LINE_PX = 28;
const HEADER_TOOLTIP_LINE_PX = 16;

/**
 * The tooltip text for source column `source_column`, or null for none.
 * `excel_header_active` says the sheet's first row is promoted to headers;
 * `details` is the column's entry in `SheetMeta.columnDetails`.
 */
export function header_tooltip_text(
    source_column: number,
    excel_header_active: boolean,
    details: ColumnDetails | null | undefined,
): string | null {
    const lines: string[] = [];
    if (excel_header_active) lines.push(`Excel column ${column_letter(source_column)}`);
    if (details) {
        if (details.label) lines.push(details.label);
        if (details.type) lines.push(details.type);
        if (details.valueLabels) lines.push(`Value labels: ${details.valueLabels}`);
        if (details.statistics) lines.push(details.statistics);
    }
    return lines.length === 0 ? null : clamp_tooltip_text(lines.join('\n'));
}

/**
 * Estimated size of the tooltip for `text`, for its first placement: the
 * longest line's width, up to the tooltip's max-width, and a line height per
 * line. The grid shell re-measures the mounted tooltip and moves it.
 */
export function header_tooltip_size(text: string): { width: number; height: number } {
    const lines = split_lines(text);
    const longest = lines.reduce((widest, line) => Math.max(widest, line.length), 0);
    return {
        width: Math.min(
            HEADER_TOOLTIP_MAX_WIDTH_PX,
            Math.max(HEADER_TOOLTIP_MIN_WIDTH_PX, longest * HEADER_TOOLTIP_CHARACTER_PX),
        ),
        height: HEADER_TOOLTIP_FIRST_LINE_PX + (lines.length - 1) * HEADER_TOOLTIP_LINE_PX,
    };
}
