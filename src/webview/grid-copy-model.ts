import type { RenderedCell } from '../data-source/interface';
import type { MergeRange } from '../types';

/** Rectangular selection in grid coordinates (Glide's Rectangle shape). */
export interface SelectionRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface TsvResult {
    /** Tab/newline-joined cell text for the clipboard. */
    text: string;
    /**
     * True when the result is incomplete: either a selected row's page was not
     * resident (emitted as blanks) or the selection exceeded `max_rows`.
     */
    truncated: boolean;
}

/** Default cap so a runaway "select all" copy can't blow up the clipboard. */
const DEFAULT_MAX_ROWS = 100_000;

/**
 * Returns true when (row, col) falls inside a merge range but is NOT the
 * anchor (top-left) cell. Such cells render blank in the grid, so copying
 * them should likewise emit nothing while the anchor keeps the merged text.
 */
function is_merge_hidden(row: number, col: number, merges: MergeRange[]): boolean {
    for (const m of merges) {
        if (
            row >= m.startRow &&
            row <= m.endRow &&
            col >= m.startCol &&
            col <= m.endCol &&
            !(row === m.startRow && col === m.startCol)
        ) {
            return true;
        }
    }
    return false;
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
    merges: MergeRange[],
    show_formatting: boolean,
    max_rows: number = DEFAULT_MAX_ROWS,
): TsvResult {
    let truncated = false;
    const row_limit = Math.min(rect.height, max_rows);
    if (row_limit < rect.height) truncated = true;

    const lines: string[] = [];
    for (let r = 0; r < row_limit; r++) {
        const abs_row = rect.y + r;
        const row = get_row(abs_row);
        const cells: string[] = [];
        for (let c = 0; c < rect.width; c++) {
            const abs_col = rect.x + c;
            if (row === undefined) {
                truncated = true;
                cells.push('');
                continue;
            }
            if (is_merge_hidden(abs_row, abs_col, merges)) {
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

    return { text: lines.join('\n'), truncated };
}
