import type { WorkbookMeta } from './data-source/interface';
import {
    MAX_HIGHLIGHTED_CELLS_PER_FILE,
    apply_cell_highlight_patch,
    cell_highlight_key,
    count_cell_highlights,
    parse_cell_highlight_key,
    sanitize_cell_highlight_color,
    sanitize_cell_highlight_state,
} from './cell-highlights';
import type {
    CellHighlightColor,
    CellHighlightMutation,
    CellHighlightSelection,
    CellHighlightState,
} from './types';

export interface CellHighlightCommandContext {
    readonly current: CellHighlightState | undefined;
    readonly meta: WorkbookMeta;
    readonly sourceDigest: string;
    readonly mapDisplayRowsToSource: (
        sheetIndex: number,
        displayRows: CellHighlightSelection['displayRows'],
    ) => Uint32Array;
    readonly displayRowForSource: (
        sheetIndex: number,
        sourceRow: number,
    ) => number | undefined;
}

export interface CellHighlightCommandInput {
    readonly sheetIndex: number;
    readonly sheetName: string;
    readonly selection: CellHighlightSelection;
    readonly mutation: CellHighlightMutation;
}

export type CellHighlightMutationPlan =
    | {
        readonly type: 'applied';
        readonly state: CellHighlightState | undefined;
        readonly affectedCells: number;
    }
    | { readonly type: 'rejected'; readonly error: string };

/** Purely validate, canonicalize, and apply one compact highlight mutation. */
export function plan_cell_highlight_mutation(
    input: CellHighlightCommandInput,
    context: CellHighlightCommandContext,
): CellHighlightMutationPlan {
    const sheet = context.meta.sheets[input.sheetIndex];
    if (!sheet || sheet.name !== input.sheetName) {
        return reject('The selected worksheet no longer matches this request.');
    }
    if (!context.sourceDigest) return reject('The physical workbook basis is unavailable.');

    const rows = validate_intervals(input.selection.displayRows);
    if (!rows.ok) return reject(rows.error);
    const columns = validate_columns(input.selection.sourceColumns, sheet.columnCount);
    if (!columns.ok) return reject(columns.error);
    const mutation = input.mutation as unknown;
    if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
        return reject('The cell highlight mutation is invalid.');
    }
    const mutation_type = (mutation as { type?: unknown }).type;
    const set_color = mutation_type === 'set'
        ? sanitize_cell_highlight_color((mutation as { color?: unknown }).color)
        : undefined;
    if (mutation_type !== 'clear' && (mutation_type !== 'set' || set_color === undefined)) {
        return reject('The cell highlight mutation is invalid.');
    }

    const current = sanitize_cell_highlight_state(context.current);
    const cells: Record<string, CellHighlightColor | null> = {};
    let affected_cells = 0;
    if (mutation_type === 'clear') {
        // Clears never expand the selected display rows. Reverse-map only the
        // sparse highlighted rows and test interval membership.
        const selected_columns = new Set(columns.values);
        const existing = current?.sheets[input.sheetIndex]?.cells ?? {};
        for (const key of Object.keys(existing)) {
            const coordinates = parse_cell_highlight_key(key);
            if (!coordinates || !selected_columns.has(coordinates.sourceColumn)) continue;
            const display_row = context.displayRowForSource(
                input.sheetIndex,
                coordinates.sourceRow,
            );
            if (
                display_row !== undefined
                && display_row_in_intervals(display_row, input.selection.displayRows)
            ) {
                cells[key] = null;
                affected_cells += 1;
            }
        }
    } else {
        const selected_count = rows.count * columns.values.length;
        if (!Number.isSafeInteger(selected_count)) {
            return reject('The selected cell range is too large.');
        }
        if (selected_count > MAX_HIGHLIGHTED_CELLS_PER_FILE) {
            return reject(
                `A file may contain at most ${MAX_HIGHLIGHTED_CELLS_PER_FILE} highlighted cells.`,
            );
        }
        let source_rows: Uint32Array;
        try {
            source_rows = context.mapDisplayRowsToSource(
                input.sheetIndex,
                input.selection.displayRows,
            );
        } catch {
            return reject('The selected rows no longer exist in this table view.');
        }
        if (source_rows.length !== rows.count) {
            return reject('The selected rows no longer match this table view.');
        }
        affected_cells = selected_count;
        for (const source_row of source_rows) {
            if (
                !Number.isSafeInteger(source_row)
                || source_row < 0
                || source_row >= sheet.sourceRowCount
            ) return reject('The selected rows no longer match the physical worksheet.');
            for (const source_column of columns.values) {
                cells[cell_highlight_key(source_row, source_column)] = set_color!;
            }
        }
        const existing_count = count_cell_highlights(current);
        const existing_sheet = current?.sheets[input.sheetIndex]?.cells ?? {};
        let additions = 0;
        for (const key of Object.keys(cells)) {
            if (existing_sheet[key] === undefined) additions += 1;
        }
        if (
            additions > 0
            && existing_count + additions > MAX_HIGHLIGHTED_CELLS_PER_FILE
        ) {
            return reject(
                `A file may contain at most ${MAX_HIGHLIGHTED_CELLS_PER_FILE} highlighted cells.`,
            );
        }
    }

    try {
        return {
            type: 'applied',
            state: apply_cell_highlight_patch(
                current,
                { sheetIndex: input.sheetIndex, cells },
                context.meta,
                context.sourceDigest,
            ),
            affectedCells: affected_cells,
        };
    } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
    }
}

function reject(error: string): Extract<CellHighlightMutationPlan, { type: 'rejected' }> {
    return { type: 'rejected', error };
}

function display_row_in_intervals(
    row: number,
    intervals: CellHighlightSelection['displayRows'],
): boolean {
    let low = 0;
    let high = intervals.length - 1;
    while (low <= high) {
        const middle = (low + high) >>> 1;
        const interval = intervals[middle];
        if (row < interval.start) high = middle - 1;
        else if (row > interval.end) low = middle + 1;
        else return true;
    }
    return false;
}

function validate_intervals(
    intervals: readonly { start: number; end: number }[],
): { ok: true; count: number } | { ok: false; error: string } {
    if (!Array.isArray(intervals) || intervals.length === 0) {
        return { ok: false, error: 'Select at least one row to highlight.' };
    }
    let count = 0;
    let previous_end = -2;
    for (const interval of intervals) {
        if (
            !interval
            || !Number.isSafeInteger(interval.start)
            || !Number.isSafeInteger(interval.end)
            || interval.start < 0
            || interval.end < interval.start
        ) return { ok: false, error: 'The selected row intervals are invalid.' };
        if (interval.start <= previous_end + 1) {
            return { ok: false, error: 'The selected row intervals must be sorted, disjoint, and compact.' };
        }
        const length = interval.end - interval.start + 1;
        if (!Number.isSafeInteger(count + length)) {
            return { ok: false, error: 'The selected row range is too large.' };
        }
        count += length;
        previous_end = interval.end;
    }
    return { ok: true, count };
}

function validate_columns(
    columns: readonly number[],
    column_count: number,
): { ok: true; values: number[] } | { ok: false; error: string } {
    if (!Array.isArray(columns) || columns.length === 0) {
        return { ok: false, error: 'Select at least one column to highlight.' };
    }
    const values: number[] = [];
    let previous = -1;
    for (const column of columns) {
        if (
            !Number.isSafeInteger(column)
            || column < 0
            || column >= column_count
            || column <= previous
        ) return { ok: false, error: 'The selected source columns must be sorted, unique, and in range.' };
        values.push(column);
        previous = column;
    }
    return { ok: true, values };
}
