import type { RenderedCell } from '../data-source/interface';
import type { DisplayRowInterval } from '../types';
import type { MergeIndex } from './merge-index';

export function* display_row_indices(
    intervals: readonly DisplayRowInterval[],
): Generator<number> {
    for (const interval of intervals) {
        for (let row = interval.start; row <= interval.end; row++) yield row;
    }
}

/** Display-row selection paired with its ordered canonical source columns. */
export type CopySelection = ({
    y: number;
    height: number;
    row_indices?: never;
    row_count?: never;
} | {
    y?: never;
    height?: never;
    row_indices: Iterable<number>;
    row_count: number;
}) & {
    source_columns: readonly number[];
};

export interface TsvResult {
    /** Tab/newline-joined cell text for the clipboard. */
    text: string;
    /**
     * The selection had more rows than `max_rows`, so trailing rows were
     * dropped entirely.
     */
    rowCapped: boolean;
    /**
     * At least one emitted row's page wasn't resident, so that row was written
     * as blank columns. Independent of `rowCapped`: a copy can hit both at once
     * (some emitted rows blank *and* trailing rows dropped), and both are
     * reported because they describe different damage to the clipboard data.
     */
    nonResident: boolean;
    /**
     * The effective row cap that was applied (the `max_rows` used). Travels with
     * the result so the warning names the real limit rather than the default.
     */
    rowCap: number;
}

/** Default cap so a runaway "select all" copy can't blow up the clipboard. */
export const DEFAULT_MAX_ROWS = 100_000;
/**
 * Whole-sheet copies are also bounded by cell count. A row-only limit is not
 * meaningful for very wide data: 100,000 rows x 5,972 columns would attempt to
 * materialize nearly 600 million cells before writing the clipboard.
 */
export const DEFAULT_MAX_CELLS = 1_000_000;
/** Approximate encoded-data budget for one clipboard serialization. */
export const DEFAULT_MAX_COPY_SOURCE_BYTES = 32 * 1024 * 1024;

/** Maximum whole-sheet rows that fit both the row and total-cell copy caps. */
export function max_copy_rows_for_columns(
    column_count: number,
    max_rows = DEFAULT_MAX_ROWS,
    max_cells = DEFAULT_MAX_CELLS,
    estimated_row_bytes = 0,
    max_source_bytes = DEFAULT_MAX_COPY_SOURCE_BYTES,
): number {
    if (!Number.isFinite(column_count) || column_count <= 0) return 0;
    const columns = Math.max(1, Math.floor(column_count));
    const byte_rows = estimated_row_bytes > 0
        ? Math.max(1, Math.floor(max_source_bytes / estimated_row_bytes))
        : max_rows;
    return Math.min(
        max_rows,
        Math.max(1, Math.floor(max_cells / columns)),
        byte_rows,
    );
}

/**
 * Builds a user-facing warning explaining why a copied selection was clipped,
 * or null when nothing was clipped. When both clip conditions apply they are
 * both surfaced, since each describes a distinct problem with the copied data.
 * Pure so it can be unit-tested and reused by the host message-surfacing path.
 */
export function copy_truncation_message(
    result: Pick<TsvResult, 'rowCapped' | 'nonResident' | 'rowCap'>,
): string | null {
    const clauses: string[] = [];
    if (result.rowCapped) {
        clauses.push(
            `only the first ${result.rowCap.toLocaleString(
                'en-US',
            )} rows of the selection were copied (copy limit)`,
        );
    }
    if (result.nonResident) {
        clauses.push(
            'rows beyond the loaded range were blank — scroll through the selection to load it, then copy again',
        );
    }
    if (clauses.length === 0) {
        return null;
    }
    return `Copied data was clipped: ${clauses.join('; ')}.`;
}

/**
 * Serializes selected display rows and an explicit ordered source-column list to
 * TSV. The source list may be non-contiguous; its order is the clipboard order.
 *
 * - Merge-hidden cells emit empty strings; the merge anchor keeps its text.
 * - Rows whose page isn't resident (`get_row` returns undefined) emit blank
 *   columns and set `nonResident`.
 * - The row count is capped at `max_rows`; exceeding it sets `rowCapped`.
 */
export function format_selection_tsv(
    selection: CopySelection,
    get_row: (row: number) => (RenderedCell | null)[] | undefined,
    merge_index: MergeIndex,
    show_formatting: boolean,
    max_rows: number = DEFAULT_MAX_ROWS,
): TsvResult {
    let non_resident = false;
    const explicit_rows = selection.row_indices;
    const selected_row_count = explicit_rows === undefined
        ? selection.height
        : selection.row_count;
    const row_limit = Math.min(selected_row_count, max_rows);
    const cap_truncated = row_limit < selected_row_count;
    const row_iterator = explicit_rows?.[Symbol.iterator]();

    const lines: string[] = [];
    for (let r = 0; r < row_limit; r++) {
        const next_row = row_iterator?.next();
        if (next_row?.done) break;
        const abs_row = next_row ? next_row.value : selection.y! + r;
        const row = get_row(abs_row);
        const cells: string[] = [];
        for (const source_column of selection.source_columns) {
            if (row === undefined) {
                non_resident = true;
                cells.push('');
                continue;
            }
            if (merge_index.is_covered(abs_row, source_column)) {
                cells.push('');
                continue;
            }
            const cell = row[source_column] ?? null;
            if (cell === null) {
                cells.push('');
                continue;
            }
            const text = show_formatting ? cell.formatted : cell.raw ?? '';
            cells.push(text);
        }
        lines.push(cells.join('\t'));
    }

    return {
        text: lines.join('\n'),
        rowCapped: cap_truncated,
        nonResident: non_resident,
        rowCap: max_rows,
    };
}
