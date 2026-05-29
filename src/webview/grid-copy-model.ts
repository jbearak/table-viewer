import type { RenderedCell } from '../data-source/interface';
import type { MergeIndex } from './merge-index';

/** Rectangular selection in grid coordinates (Glide's Rectangle shape). */
export interface SelectionRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Why a copy came back incomplete:
 * - `row-cap`: the selection had more rows than `max_rows`, so trailing rows
 *   were dropped entirely.
 * - `non-resident`: at least one selected row's page wasn't loaded, so it was
 *   emitted as blank columns.
 */
export type TruncationReason = 'row-cap' | 'non-resident';

export interface TsvResult {
    /** Tab/newline-joined cell text for the clipboard. */
    text: string;
    /**
     * True when the result is incomplete: either a selected row's page was not
     * resident (emitted as blanks) or the selection exceeded `max_rows`.
     */
    truncated: boolean;
    /** Why the copy was clipped, or null when it was complete. */
    truncationReason: TruncationReason | null;
}

/** Default cap so a runaway "select all" copy can't blow up the clipboard. */
export const DEFAULT_MAX_ROWS = 100_000;

/**
 * Builds a user-facing warning explaining why a copied selection was clipped,
 * or null when nothing was clipped. Pure so it can be unit-tested and reused by
 * the host message-surfacing path.
 */
export function copy_truncation_message(
    reason: TruncationReason | null,
): string | null {
    switch (reason) {
        case 'row-cap':
            return `Copied data was clipped: only the first ${DEFAULT_MAX_ROWS.toLocaleString(
                'en-US',
            )} rows of the selection were copied (copy limit).`;
        case 'non-resident':
            return 'Copied data was clipped: rows beyond the loaded range were blank. Scroll through the selection to load it, then copy again.';
        default:
            return null;
    }
}

/**
 * Serializes a rectangular selection to TSV (tabs between columns, newlines
 * between rows) by reading cells from the paged loader.
 *
 * - Merge-hidden cells emit empty strings; the merge anchor keeps its text.
 * - Rows whose page isn't resident (`get_row` returns undefined) emit blank
 *   columns and flag `truncated`.
 * - The row count is capped at `max_rows`; exceeding it flags `truncated`.
 */
export function format_selection_tsv(
    rect: SelectionRect,
    get_row: (row: number) => (RenderedCell | null)[] | undefined,
    merge_index: MergeIndex,
    show_formatting: boolean,
    max_rows: number = DEFAULT_MAX_ROWS,
): TsvResult {
    let truncated = false;
    // Row-cap wins over non-resident: capped rows are never read, so the cap is
    // the most actionable reason to surface when both apply.
    let cap_truncated = false;
    let non_resident = false;
    const row_limit = Math.min(rect.height, max_rows);
    if (row_limit < rect.height) {
        truncated = true;
        cap_truncated = true;
    }

    const lines: string[] = [];
    for (let r = 0; r < row_limit; r++) {
        const abs_row = rect.y + r;
        const row = get_row(abs_row);
        const cells: string[] = [];
        for (let c = 0; c < rect.width; c++) {
            const abs_col = rect.x + c;
            if (row === undefined) {
                truncated = true;
                non_resident = true;
                cells.push('');
                continue;
            }
            if (merge_index.is_covered(abs_row, abs_col)) {
                cells.push('');
                continue;
            }
            const cell = row[abs_col] ?? null;
            if (cell === null) {
                cells.push('');
                continue;
            }
            const text = show_formatting ? cell.formatted : cell.raw ?? '';
            cells.push(text);
        }
        lines.push(cells.join('\t'));
    }

    const truncationReason: TruncationReason | null = cap_truncated
        ? 'row-cap'
        : non_resident
            ? 'non-resident'
            : null;
    return { text: lines.join('\n'), truncated, truncationReason };
}
