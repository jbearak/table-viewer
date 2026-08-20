// Pure compare-session core for git table diffs. No vscode imports: everything
// here operates on DataSource/WorkbookMeta values so it is unit-testable with
// in-memory fixtures and shareable across hosts.
import {
    read_source_rows_indexed,
    type DataSource,
    type RowWindow,
    type SheetMeta,
    type WorkbookMeta,
} from '../data-source/interface';
import { get_raw_cell_text } from '../cell-display';

export type SheetPairStatus = SheetPairing['status'];

/**
 * One entry per sheet of the *modified* workbook (in its sheet order), followed
 * by any original-only sheets. A discriminated union so a pairing cannot claim
 * a status without the indexes that status implies.
 */
export type SheetPairing =
    | {
        readonly status: 'matched';
        readonly name: string;
        readonly modifiedIndex: number;
        readonly originalIndex: number;
    }
    | { readonly status: 'added'; readonly name: string; readonly modifiedIndex: number }
    | { readonly status: 'deleted'; readonly name: string; readonly originalIndex: number };

/**
 * Pair worksheets positionally-independently: by stable `worksheetId` when both
 * sides expose one, otherwise by exact name. Each original sheet is consumed at
 * most once. Modified-only sheets are `added`; original-only sheets `deleted`.
 */
export function pair_sheets(
    original: WorkbookMeta,
    modified: WorkbookMeta,
): SheetPairing[] {
    const unclaimed = new Set(original.sheets.map((_, index) => index));
    const by_worksheet_id = new Map<string, number>();
    const by_name = new Map<string, number>();
    original.sheets.forEach((sheet, index) => {
        if (sheet.worksheetId !== undefined && !by_worksheet_id.has(sheet.worksheetId)) {
            by_worksheet_id.set(sheet.worksheetId, index);
        }
        if (!by_name.has(sheet.name)) by_name.set(sheet.name, index);
    });
    const claim = (index: number | undefined): number | undefined => {
        if (index === undefined || !unclaimed.has(index)) return undefined;
        unclaimed.delete(index);
        return index;
    };

    const pairings: SheetPairing[] = modified.sheets.map((sheet, modified_index) => {
        // Name fallback only when identity is genuinely unknown: two sheets that
        // both expose stable worksheetIds that differ are different sheets, and a
        // shared name must not glue them into a bogus cell diff.
        const name_candidate = by_name.get(sheet.name);
        const name_conflicts = sheet.worksheetId !== undefined
            && name_candidate !== undefined
            && original.sheets[name_candidate].worksheetId !== undefined;
        const original_index = claim(
            sheet.worksheetId !== undefined
                ? by_worksheet_id.get(sheet.worksheetId)
                : undefined,
        ) ?? (name_conflicts ? undefined : claim(name_candidate));
        return original_index === undefined
            ? { status: 'added', name: sheet.name, modifiedIndex: modified_index }
            : {
                status: 'matched',
                name: sheet.name,
                modifiedIndex: modified_index,
                originalIndex: original_index,
            };
    });
    for (const original_index of unclaimed) {
        pairings.push({
            status: 'deleted',
            name: original.sheets[original_index].name,
            originalIndex: original_index,
        });
    }
    return pairings;
}

/**
 * Compare promoted column headers of a matched sheet pair. Both CSV and Excel
 * sources can promote the first row into `columnNames`, taking it out of the
 * grid's row space — so a header-only edit is invisible to `diff_row_window`.
 * Returns the changed column indexes with the original header text (`''` when
 * the column had no name or did not exist).
 */
export function diff_column_names(
    original_sheet: Pick<SheetMeta, 'columnNames' | 'columnCount'>,
    modified_sheet: Pick<SheetMeta, 'columnNames' | 'columnCount'>,
): { col: number; base: string }[] {
    const column_count = Math.max(
        original_sheet.columnCount,
        modified_sheet.columnCount,
    );
    const changed: { col: number; base: string }[] = [];
    for (let col = 0; col < column_count; col++) {
        const base = original_sheet.columnNames?.[col] ?? '';
        if (base !== (modified_sheet.columnNames?.[col] ?? '')) {
            changed.push({ col, base });
        }
    }
    return changed;
}

/** A cell whose text differs between the sides; `base` is the original text. */
export interface ChangedCell {
    readonly row: number;
    readonly col: number;
    readonly base: string;
}

export type CompareRowStatus = 'same' | 'added' | 'deleted';

/**
 * Sparse per-page diff. `rowStatus[i]` describes absolute row `startRow + i` of
 * the unified grid (whose row count is `max(original, modified)` row counts):
 * `added` rows exist only in the modified side, `deleted` rows only in the
 * original. `changedCells` carries only differing cells — including, for
 * `deleted` rows, the original cell texts so the band can show what was removed.
 */
export interface CompareDiffWindow {
    readonly startRow: number;
    readonly rowStatus: CompareRowStatus[];
    readonly changedCells: ChangedCell[];
}

/**
 * Positional diff for an arbitrary set of unified-grid rows (a transformed
 * page's `sourceRows`). One batched indexed read per side, so cost stays
 * bounded by the page even when a sort/filter fragments it. `rowStatus[i]`
 * and `changedCells[*].row` are positional: they name `rows[i]`, not the
 * display slot — callers map positions back themselves.
 */
export function diff_rows_indexed(
    original: DataSource,
    modified: DataSource,
    pairing: SheetPairing,
    rows: ArrayLike<number>,
): CompareDiffWindow {
    if (pairing.status !== 'matched') {
        throw new Error('diff_rows_indexed requires a matched sheet pairing.');
    }
    const original_sheet = original.meta().sheets[pairing.originalIndex];
    const modified_sheet = modified.meta().sheets[pairing.modifiedIndex];
    if (!original_sheet || !modified_sheet) {
        throw new RangeError('sheet pairing indexes a missing sheet');
    }
    const read_side = (
        source: DataSource,
        sheet_index: number,
        row_count: number,
    ): ReadonlyMap<number, RowWindow['rows'][number]> => {
        const in_range: number[] = [];
        for (let position = 0; position < rows.length; position++) {
            const row = rows[position];
            if (row >= 0 && row < row_count) in_range.push(row);
        }
        const side_rows = in_range.length > 0
            ? read_source_rows_indexed(source, sheet_index, in_range).rows
            : [];
        return new Map(in_range.map((row, position) => [row, side_rows[position] ?? []]));
    };
    const original_rows = read_side(original, pairing.originalIndex, original_sheet.rowCount);
    const modified_rows = read_side(modified, pairing.modifiedIndex, modified_sheet.rowCount);

    const row_status: CompareRowStatus[] = [];
    const changed_cells: ChangedCell[] = [];
    const column_count = Math.max(original_sheet.columnCount, modified_sheet.columnCount);
    for (let position = 0; position < rows.length; position++) {
        const row = rows[position];
        const in_original = row < original_sheet.rowCount;
        const in_modified = row < modified_sheet.rowCount;
        if (!in_original || !in_modified) {
            row_status.push(in_modified ? 'added' : 'deleted');
            if (!in_modified) {
                // Removed row: ship the original texts so the band shows them.
                const original_row = original_rows.get(row) ?? [];
                for (let col = 0; col < column_count; col++) {
                    const base = raw_text(original_row[col]);
                    if (base !== '') changed_cells.push({ row: position, col, base });
                }
            }
            continue;
        }
        row_status.push('same');
        const original_row = original_rows.get(row) ?? [];
        const modified_row = modified_rows.get(row) ?? [];
        for (let col = 0; col < column_count; col++) {
            const base = raw_text(original_row[col]);
            if (base !== raw_text(modified_row[col])) {
                changed_cells.push({ row: position, col, base });
            }
        }
    }
    return { startRow: 0, rowStatus: row_status, changedCells: changed_cells };
}

function raw_text(cell: { raw: string | null } | null | undefined): string {
    return get_raw_cell_text(cell?.raw ?? null);
}

/**
 * Positionally compare one page of a matched sheet pair (row N vs row N of the
 * two sides' projected row spaces). Lazy: reads only the requested window from
 * each side, so cost is bounded by the page, never the file.
 *
 * Promoted header rows (CSV first row, Excel first-row header) are column
 * names, not grid rows, so header edits are not reported here — callers use
 * `diff_column_names` for those.
 */
export function diff_row_window(
    original: DataSource,
    modified: DataSource,
    pairing: SheetPairing,
    start_row: number,
    count: number,
): CompareDiffWindow {
    if (pairing.status !== 'matched') {
        throw new Error('diff_row_window requires a matched sheet pairing.');
    }
    const original_sheet = original.meta().sheets[pairing.originalIndex];
    const modified_sheet = modified.meta().sheets[pairing.modifiedIndex];
    if (!original_sheet || !modified_sheet) {
        throw new RangeError('sheet pairing indexes a missing sheet');
    }
    const total_rows = Math.max(original_sheet.rowCount, modified_sheet.rowCount);
    const first = Math.max(0, start_row);
    const end = Math.min(total_rows, first + count);

    const read_side = (
        source: DataSource,
        sheet_index: number,
        row_count: number,
    ) => {
        const side_end = Math.min(end, row_count);
        return side_end > first
            ? source.read_rows(sheet_index, first, side_end - first).rows
            : [];
    };
    const original_rows = read_side(original, pairing.originalIndex, original_sheet.rowCount);
    const modified_rows = read_side(modified, pairing.modifiedIndex, modified_sheet.rowCount);

    const row_status: CompareRowStatus[] = [];
    const changed_cells: ChangedCell[] = [];
    const column_count = Math.max(original_sheet.columnCount, modified_sheet.columnCount);
    for (let row = first; row < end; row++) {
        const in_original = row < original_sheet.rowCount;
        const in_modified = row < modified_sheet.rowCount;
        if (!in_original || !in_modified) {
            row_status.push(in_modified ? 'added' : 'deleted');
            if (!in_modified) {
                // Removed row: ship the original texts so the band shows them.
                const original_row = original_rows[row - first] ?? [];
                for (let col = 0; col < column_count; col++) {
                    const base = raw_text(original_row[col]);
                    if (base !== '') changed_cells.push({ row, col, base });
                }
            }
            continue;
        }
        row_status.push('same');
        const original_row = original_rows[row - first] ?? [];
        const modified_row = modified_rows[row - first] ?? [];
        for (let col = 0; col < column_count; col++) {
            const base = raw_text(original_row[col]);
            if (base !== raw_text(modified_row[col])) {
                changed_cells.push({ row, col, base });
            }
        }
    }
    return { startRow: first, rowStatus: row_status, changedCells: changed_cells };
}
