// The hidden rows a Header Row change leaves.
//
// With an explicit header the Header Row is not stored as a row number: it is
// the first source row that is not hidden. So a header change and the hidden
// rows it writes are one computation, and two callers have to agree on it: the
// host's planner, inside the durable write, and the window, which predicts
// what replaying a header step would leave before it asks. It is a pure leaf:
// no imports from the webview or the host.

/** Source rows to hide and to show in the same write. */
export interface HiddenRowChange {
    readonly hide: readonly number[];
    readonly show: readonly number[];
}

/** `rows` reduced to unique integers in `[0, source_row_count)`, ascending. */
export function in_range_rows(
    rows: readonly number[] | undefined,
    source_row_count: number,
): number[] {
    const kept = new Set<number>();
    for (const row of rows ?? []) {
        if (Number.isInteger(row) && row >= 0 && row < source_row_count) kept.add(row);
    }
    return [...kept].sort((left, right) => left - right);
}

/**
 * The first source row that is not hidden, or undefined when every row is.
 *
 * Header authority is only constructed over the physical XLS/XLSX sources,
 * whose canonical source IDs are their zero-based physical row positions.
 */
export function first_non_hidden_source_row(
    source_row_count: number,
    hidden_rows: readonly number[] | undefined,
): number | undefined {
    if (!Array.isArray(hidden_rows)) return source_row_count > 0 ? 0 : undefined;
    let candidate = 0;
    for (const row of hidden_rows) {
        if (!Number.isInteger(row) || row < candidate) continue;
        if (row !== candidate) break;
        candidate += 1;
    }
    return candidate < source_row_count ? candidate : undefined;
}

/**
 * The hidden rows that make `header_source_row` the Header Row: every row
 * above it, plus the rows below it that `current` hides. Undefined when the
 * row is not in the worksheet, is itself hidden, or the set would pass
 * `limit`.
 */
export function hidden_rows_before_header(
    current: readonly number[] | undefined,
    header_source_row: number,
    source_row_count: number,
    limit: number,
): number[] | undefined {
    if (
        !Number.isInteger(header_source_row)
        || header_source_row < 0
        || header_source_row >= source_row_count
    ) return undefined;
    const suffix: number[] = [];
    let previous = -1;
    for (const row of current ?? []) {
        if (!Number.isInteger(row) || row < 0 || row >= source_row_count) continue;
        if (row === header_source_row) return undefined;
        if (row > header_source_row && row !== previous) suffix.push(row);
        previous = row;
    }
    if (header_source_row + suffix.length > limit) {
        return undefined;
    }
    const hidden_rows = Array.from(
        { length: header_source_row },
        (_, row) => row,
    );
    for (const row of suffix) hidden_rows.push(row);
    return hidden_rows;
}

/**
 * The hidden rows a header target leaves, from the hidden rows as they are.
 *
 * In this order: remove `show`; add `hide`; drop rows at or past the end of
 * the worksheet. Then, with a `headerSourceRow` that is a row, that row comes
 * out of the set (so a row that is hidden now can be made the header) and the
 * set becomes "every row above the header, plus the hidden rows below it".
 * With `headerSourceRow: null` ("on, with no row to use") the set must leave
 * no row unhidden.
 *
 * Ascending and unique. Undefined when the target cannot be had: the header
 * row is not in the worksheet, a `null` header would leave a row unhidden, or
 * the set would pass `limit`.
 */
export function hidden_rows_after_header_change(
    current: readonly number[] | undefined,
    change: HiddenRowChange & {
        readonly sourceRowCount: number;
        readonly headerSourceRow?: number | null;
        readonly limit: number;
    },
): number[] | undefined {
    const { sourceRowCount, headerSourceRow, limit } = change;
    const next = new Set(in_range_rows(current, sourceRowCount));
    for (const row of change.show) next.delete(row);
    for (const row of in_range_rows(change.hide, sourceRowCount)) next.add(row);
    if (typeof headerSourceRow === 'number') {
        next.delete(headerSourceRow);
        return hidden_rows_before_header(
            [...next].sort((left, right) => left - right),
            headerSourceRow,
            sourceRowCount,
            limit,
        );
    }
    const hidden_rows = [...next].sort((left, right) => left - right);
    if (hidden_rows.length > limit) return undefined;
    if (
        headerSourceRow === null
        && first_non_hidden_source_row(sourceRowCount, hidden_rows) !== undefined
    ) return undefined;
    return hidden_rows;
}

/** The rows in `after` and not in `before`, and the reverse; both ascending. */
export function hidden_row_difference(
    before: readonly number[],
    after: readonly number[],
): { readonly hidden: number[]; readonly shown: number[] } {
    const was = new Set(before);
    const is = new Set(after);
    return {
        hidden: after.filter((row) => !was.has(row)),
        shown: before.filter((row) => !is.has(row)),
    };
}
