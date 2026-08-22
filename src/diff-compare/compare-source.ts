// Pure compare-session core for compare sessions (Git table diffs and
// file-to-file comparison alike). No vscode imports: everything
// here operates on DataSource/WorkbookMeta values so it is unit-testable with
// in-memory fixtures and shareable across hosts.
import {
    type DataSource,
    type SheetMeta,
    type WorkbookMeta,
} from '../data-source/interface';

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

/** The delimited-vs-workbook case: sheet 0 pairs, the workbook's rest are
 *  one-sided in whichever direction the workbook sits. */
function pair_first_sheets(
    original: WorkbookMeta,
    modified: WorkbookMeta,
): SheetPairing[] {
    const pairings: SheetPairing[] = [{
        status: 'matched',
        name: modified.sheets[0].name,
        modifiedIndex: 0,
        originalIndex: 0,
    }];
    for (let index = 1; index < modified.sheets.length; index++) {
        pairings.push({
            status: 'added',
            name: modified.sheets[index].name,
            modifiedIndex: index,
        });
    }
    for (let index = 1; index < original.sheets.length; index++) {
        pairings.push({
            status: 'deleted',
            name: original.sheets[index].name,
            originalIndex: index,
        });
    }
    return pairings;
}

/**
 * Pair worksheets positionally-independently: by stable `worksheetId` when both
 * sides expose one, otherwise by exact name. Each original sheet is consumed at
 * most once. Modified-only sheets are `added`; original-only sheets `deleted`.
 *
 * One exception, for comparing a delimited file against a workbook: a CSV or
 * TSV is a single unnamed sheet the reader calls `Sheet1`, so name matching
 * reports it and every worksheet as one-sided unless the workbook happens to
 * have a sheet by that name. Pairing it with the workbook's first sheet is what
 * the user asked for by choosing the two files, and what the dialog promises.
 */
export function pair_sheets(
    original: WorkbookMeta,
    modified: WorkbookMeta,
): SheetPairing[] {
    if (original.sheets.length > 0 && modified.sheets.length > 0) {
        // Asked of the source rather than inferred from a missing worksheetId:
        // .xls exposes no worksheet identity either, so inferring it made a
        // one-sheet .xls indistinguishable from a CSV and left the two of them
        // pairing on the placeholder name that started the problem.
        const delimited = (meta: WorkbookMeta) =>
            meta.sheets.length === 1 && meta.sheets[0].unnamedSingleSheet === true;
        // Only when exactly one side is delimited: two delimited sides already
        // pair by their shared placeholder name, and two workbooks must keep
        // identity-based pairing or an inserted first sheet would glue
        // unrelated worksheets together.
        if (delimited(original) !== delimited(modified)) {
            return pair_first_sheets(original, modified);
        }
    }
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
 * grid's row space — so a header-only edit is invisible to the row comparison.
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

/** `moved` is a paired row that the aligner re-matched across a change of
 *  position. It is a *pairing provenance*, not a content verdict: a moved row
 *  may also carry changed cells, and reports both. */
export type CompareRowStatus = 'same' | 'added' | 'deleted' | 'moved';

/**
 * Sparse per-page diff. `rowStatus[i]` describes absolute row `startRow + i` of
 * the unified grid, whose rows follow the sheet alignment rather than
 * positional padding — interleaved deletions and additions can make it longer
 * than either side. `added` rows exist only in the modified side, `deleted`
 * rows only in the original. `changedCells` carries only differing cells of rows present on both
 * sides; `deleted` rows need none — the grid rows themselves carry the original
 * content (see CompareDataSource.read_rows), struck through by row status.
 */
export interface CompareDiffWindow {
    readonly startRow: number;
    readonly rowStatus: CompareRowStatus[];
    readonly changedCells: ChangedCell[];
}
