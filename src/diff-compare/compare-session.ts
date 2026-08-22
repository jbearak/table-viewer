// Compare-session DataSource wrapper. Pure (no vscode import): binds the
// modified-side source to its git original so one object owns both lifetimes,
// pads matched sheets' row counts to max(original, modified) so trailing
// added/deleted rows render as full grid bands, and answers per-page diffs.
//
// Deliberately NOT an ExcelHeaderDataSource, so the controller's
// `instanceof ExcelHeaderDataSource` mutation paths (first-row-header toggle,
// committed-state override/hidden-row re-application) refuse in compare mode.
// Both sides bake the per-file state in at build time and share projection
// policy; mutating the wrapped modified source afterwards would invalidate
// the padding and pairings computed here at construction.
import {
    read_source_rows_indexed,
    type DataSource,
    type IndexedRows,
    type RowWindow,
    type WorkbookMeta,
} from '../data-source/interface';
import {
    diff_column_names,
    pair_sheets,
    type ChangedCell,
    type CompareDiffWindow,
    type CompareRowStatus,
    type SheetPairing,
    type SheetPairStatus,
} from './compare-source';
import { get_raw_cell_text } from '../cell-display';
import {
    ABSENT,
    align_sheet,
    identity_alignment,
    type AlignedRow,
    type AlignSheetOptions,
    type SheetAlignment,
} from './row-alignment';

/** Alignments for a compare session, keyed by *modified* sheet index. Sheets
 *  without a matched original have none: there is nothing to align them to. */
export type SheetAlignments = ReadonlyMap<number, SheetAlignment>;

/**
 * Align every matched sheet pair of a workbook. Async, so it happens before the
 * (synchronous) CompareDataSource is constructed — the source needs its row
 * mapping fixed at build time, since meta() row counts depend on it.
 */
export async function align_workbook(
    modified: DataSource,
    original: DataSource,
    options: AlignSheetOptions = {},
): Promise<SheetAlignments> {
    const pairings = pair_sheets(original.meta(), modified.meta());
    const alignments = new Map<number, SheetAlignment>();
    for (const pairing of pairings) {
        if (pairing.status !== 'matched') continue;
        alignments.set(
            pairing.modifiedIndex,
            await align_sheet(original, modified, pairing, options),
        );
    }
    return alignments;
}

export class CompareDataSource implements DataSource {
    readonly pairings: SheetPairing[];
    /** Per modified sheet, positionally matching `meta.sheets`; empty for
     *  sheets without a header change or without a matched original. */
    readonly changedColumnNames: readonly (readonly { col: number; base: string }[])[];
    /** Pair status per *grid* sheet, positionally matching `meta().sheets`.
     *  This is the ordering contract (modified sheets first, then deleted
     *  originals appended in pairing order) stated as data, so consumers never
     *  re-derive sheet positions from `pairings`. */
    readonly sheetStatuses: readonly SheetPairStatus[];
    private readonly matched_by_modified_index: ReadonlyMap<
        number,
        Extract<SheetPairing, { status: 'matched' }>
    >;
    /** Original-only sheets, exposed as read-only grid sheets appended after
     *  the modified workbook's, in pairing order. */
    private readonly deleted_pairings: readonly Extract<
        SheetPairing,
        { status: 'deleted' }
    >[];
    private readonly modified_sheet_count: number;
    private readonly padded_meta: WorkbookMeta;
    /** Both sides are immutable after construction (see the module comment),
     *  so their metas are cached here instead of re-asked on every read. */
    private readonly modified_meta: WorkbookMeta;
    private readonly original_meta: WorkbookMeta;
    private static readonly MAX_CACHED_DIFF_PAGES = 64;
    private readonly diff_cache = new Map<string, CompareDiffWindow>();
    /** Aligned unified rows per *grid* sheet index, for matched sheets. Absent
     *  for added/deleted sheets, which are one-sided and need no alignment. */
    private readonly alignments: ReadonlyMap<number, SheetAlignment>;
    /** True when any matched sheet fell back to positional alignment, so the
     *  host can say so rather than present an all-changed grid as a finding. */
    readonly degraded: boolean;
    /** Grid row -> canonical row, for deleted rows only, per matched sheet. */
    private readonly deleted_canonical_rows: ReadonlyMap<number, ReadonlyMap<number, number>>;
    private readonly grid_row_by_modified_cache = new Map<number, ReadonlyMap<number, number>>();
    /** Deleted rows' grid rows per sheet, in canonical-number order. */
    private readonly deleted_grid_rows: ReadonlyMap<number, readonly number[]>;

    constructor(
        private readonly modified: DataSource,
        private readonly original: DataSource,
        alignments: SheetAlignments = new Map(),
    ) {
        this.original_meta = original.meta();
        this.modified_meta = modified.meta();
        this.pairings = pair_sheets(this.original_meta, this.modified_meta);
        this.matched_by_modified_index = new Map(
            this.pairings.flatMap((pairing) =>
                pairing.status === 'matched' ? [[pairing.modifiedIndex, pairing]] : []),
        );
        const original_sheets = this.original_meta.sheets;
        const modified_meta = this.modified_meta;
        this.deleted_pairings = this.pairings.filter(
            (pairing): pairing is Extract<SheetPairing, { status: 'deleted' }> =>
                pairing.status === 'deleted',
        );
        this.modified_sheet_count = modified_meta.sheets.length;
        this.changedColumnNames = [
            ...modified_meta.sheets.map((sheet, sheet_index) => {
                const pairing = this.matched_by_modified_index.get(sheet_index);
                return pairing
                    ? diff_column_names(original_sheets[pairing.originalIndex], sheet)
                    : [];
            }),
            ...this.deleted_pairings.map(() => []),
        ];
        const status_by_modified_index = new Map(
            this.pairings.flatMap((pairing) =>
                pairing.status !== 'deleted' ? [[pairing.modifiedIndex, pairing.status]] : []),
        );
        this.sheetStatuses = [
            ...modified_meta.sheets.map((_, sheet_index) =>
                status_by_modified_index.get(sheet_index) ?? 'added'),
            ...this.deleted_pairings.map(() => 'deleted' as const),
        ];
        // Sheets with no supplied alignment fall back to the positional one, so
        // every matched sheet has an alignment and the rest of this class has a
        // single row-mapping path rather than two.
        this.alignments = new Map(
            [...this.matched_by_modified_index].map(([modified_index, pairing]) => [
                modified_index,
                alignments.get(modified_index) ?? {
                    rows: identity_alignment(
                        original_sheets[pairing.originalIndex].rowCount,
                        modified_meta.sheets[modified_index].rowCount,
                    ),
                    addedRows: 0,
                    deletedRows: 0,
                    changedRows: 0,
                    changedCells: 0,
                    changedRowIndices: [],
                    degraded: true,
                },
            ]),
        );
        this.degraded = [...this.alignments.values()].some(
            (alignment) => alignment.degraded);
        this.padded_meta = {
            ...modified_meta,
            sheets: [...modified_meta.sheets.map((sheet, sheet_index) => {
                const pairing = this.matched_by_modified_index.get(sheet_index);
                if (!pairing) return sheet;
                const original_sheet = original_sheets[pairing.originalIndex];
                // The unified grid is exactly the aligned rows: paired rows plus
                // one-sided ones, in order. With a positional alignment this is
                // max(original, modified) — the old padding — and with a content
                // alignment it interleaves inserts and deletions where they
                // actually happened.
                const row_count = this.alignments.get(sheet_index)!.rows.length;
                const column_count = Math.max(sheet.columnCount, original_sheet.columnCount);
                return row_count === sheet.rowCount && column_count === sheet.columnCount
                    ? sheet
                    : {
                        ...sheet,
                        rowCount: row_count,
                        // Deleted rows get their own canonical rows appended
                        // after the modified side's, so their mapping can never
                        // collide with a real row's.
                        sourceRowCount: sheet.sourceRowCount
                            + this.alignments.get(sheet_index)!.rows.filter(
                                (row) => row.modified === ABSENT).length,
                        columnCount: column_count,
                    };
            }),
            ...this.deleted_pairings.map((pairing) =>
                original_sheets[pairing.originalIndex]),
            ],
        };
        // Canonical row numbers for deleted rows, assigned once in grid order so
        // source_row_indices and projected_row_index agree without recomputing.
        this.deleted_grid_rows = new Map(
            [...this.alignments].map(([sheet_index, alignment]) => [
                sheet_index,
                alignment.rows.flatMap((row, grid_row) =>
                    row.modified === ABSENT ? [grid_row] : []),
            ]),
        );
        this.deleted_canonical_rows = new Map(
            [...this.alignments].map(([sheet_index, alignment]) => {
                const real = modified_meta.sheets[sheet_index];
                const by_grid_row = new Map<number, number>();
                let next = real.sourceRowCount;
                alignment.rows.forEach((row, grid_row) => {
                    if (row.modified === ABSENT) by_grid_row.set(grid_row, next++);
                });
                return [sheet_index, by_grid_row];
            }),
        );
    }

    /** Aligned rows for a matched grid sheet; undefined for one-sided sheets. */
    private alignment_of(sheet_index: number): readonly AlignedRow[] | undefined {
        return this.alignments.get(sheet_index)?.rows;
    }

    /** Per-sheet change totals, for the compare window's counts. */
    changeCounts(): {
        addedRows: number;
        deletedRows: number;
        changedRows: number;
        changedCells: number;
    } {
        let added = 0;
        let deleted = 0;
        let changed_rows = 0;
        let changed_cells = 0;
        for (const alignment of this.alignments.values()) {
            added += alignment.addedRows;
            deleted += alignment.deletedRows;
            changed_rows += alignment.changedRows;
            changed_cells += alignment.changedCells;
        }
        // Sheets present on only one side are whole-sheet changes; their rows
        // are not in any alignment, so they are counted from the meta.
        this.pairings.forEach((pairing) => {
            if (pairing.status === 'added') {
                added += this.modified_meta.sheets[pairing.modifiedIndex].rowCount;
            } else if (pairing.status === 'deleted') {
                deleted += this.original_meta.sheets[pairing.originalIndex].rowCount;
            }
        });
        return {
            addedRows: added,
            deletedRows: deleted,
            changedRows: changed_rows,
            changedCells: changed_cells,
        };
    }

    /**
     * Grid rows that are added, deleted, or have at least one changed cell, in
     * grid order — the row set behind the "only changed rows" filter. Every row
     * of a one-sided sheet qualifies.
     */
    changedGridRows(sheet_index: number): number[] {
        const alignment = this.alignments.get(sheet_index);
        if (!alignment) {
            const sheet = this.padded_meta.sheets[sheet_index];
            return sheet
                ? Array.from({ length: sheet.rowCount }, (_, row) => row)
                : [];
        }
        // Merge the two ascending sources rather than re-diffing: the
        // alignment pass already compared every paired row.
        const one_sided: number[] = [];
        alignment.rows.forEach((row, grid_row) => {
            if (row.original === ABSENT || row.modified === ABSENT) one_sided.push(grid_row);
        });
        const changed = alignment.changedRowIndices;
        const rows: number[] = [];
        let left = 0;
        let right = 0;
        while (left < one_sided.length || right < changed.length) {
            if (right >= changed.length || (left < one_sided.length
                && one_sided[left] < changed[right])) {
                rows.push(one_sided[left++]);
            } else {
                rows.push(changed[right++]);
            }
        }
        return rows;
    }

    /** The original-side sheet index a grid sheet reads from, when the grid
     *  sheet is one of the appended deleted sheets; undefined otherwise. */
    private deleted_original_index(sheet_index: number): number | undefined {
        return sheet_index >= this.modified_sheet_count
            ? this.deleted_pairings[sheet_index - this.modified_sheet_count]?.originalIndex
            : undefined;
    }

    meta(): WorkbookMeta {
        return this.padded_meta;
    }

    /** Per-page diff for the modified sheet at `sheet_index`; undefined for
     *  sheets with no matched original (added sheets have nothing to diff). */
    diff_page(sheet_index: number, start_row: number, count: number): CompareDiffWindow | undefined {
        const alignment = this.alignment_of(sheet_index);
        if (!alignment) return undefined;
        const start = Math.max(0, Math.min(start_row, alignment.length));
        const end = Math.min(alignment.length, start + count);
        const rows: number[] = [];
        for (let row = start; row < end; row++) rows.push(row);
        const window = this.diff_rows(sheet_index, rows);
        return window ? { ...window, startRow: start } : undefined;
    }

    /**
     * Diff for an arbitrary set of grid rows. `rowStatus[i]` and
     * `changedCells[*].row` are positional: they name `rows[i]`, not the
     * display slot. LRU-cached by the exact row set, mirroring the core's page
     * cache: a renderer re-requesting a page must not reread and re-compare
     * both sides.
     */
    diff_rows(sheet_index: number, rows: readonly number[]): CompareDiffWindow | undefined {
        if (this.deleted_original_index(sheet_index) !== undefined) {
            // A deleted sheet is one all-deleted band; the rows themselves
            // carry the original content, so there are no changed cells.
            return {
                startRow: 0,
                rowStatus: Array.from(rows, () => 'deleted' as const),
                changedCells: [],
            };
        }
        const alignment = this.alignment_of(sheet_index);
        if (!alignment) return undefined;
        const key = `${sheet_index}:${rows.join(',')}`;
        const cached = this.diff_cache.get(key);
        if (cached !== undefined) {
            this.diff_cache.delete(key);
            this.diff_cache.set(key, cached);
            return cached;
        }
        const window = this.compute_diff(sheet_index, alignment, rows);
        this.diff_cache.set(key, window);
        while (this.diff_cache.size > CompareDataSource.MAX_CACHED_DIFF_PAGES) {
            const oldest = this.diff_cache.keys().next().value;
            if (oldest === undefined) break;
            this.diff_cache.delete(oldest);
        }
        return window;
    }

    /**
     * Compare the two sides of each requested grid row, through the alignment.
     * Rows present on only one side are added/deleted outright; paired rows are
     * read from both sides in one batch each and compared cell by cell.
     */
    private compute_diff(
        sheet_index: number,
        alignment: readonly AlignedRow[],
        rows: readonly number[],
    ): CompareDiffWindow {
        const pairing = this.matched_by_modified_index.get(sheet_index)!;
        const original_sheet = this.original_meta.sheets[pairing.originalIndex];
        const modified_sheet = this.modified_meta.sheets[sheet_index];
        const column_count = Math.max(original_sheet.columnCount, modified_sheet.columnCount);
        const row_status: CompareRowStatus[] = [];
        const paired_positions: number[] = [];
        const original_rows: number[] = [];
        const modified_rows: number[] = [];
        rows.forEach((grid_row, position) => {
            const aligned = alignment[grid_row];
            if (!aligned) {
                row_status.push('same');
                return;
            }
            if (aligned.modified === ABSENT) {
                row_status.push('deleted');
                return;
            }
            if (aligned.original === ABSENT) {
                row_status.push('added');
                return;
            }
            row_status.push('same');
            paired_positions.push(position);
            original_rows.push(aligned.original);
            modified_rows.push(aligned.modified);
        });
        const changed_cells: ChangedCell[] = [];
        if (paired_positions.length > 0) {
            const original_batch = read_source_rows_indexed(
                this.original, pairing.originalIndex, original_rows).rows;
            const modified_batch = read_source_rows_indexed(
                this.modified, sheet_index, modified_rows).rows;
            paired_positions.forEach((position, index) => {
                const original_row = original_batch[index] ?? [];
                const modified_row = modified_batch[index] ?? [];
                for (let col = 0; col < column_count; col++) {
                    const base = get_raw_cell_text(original_row[col]?.raw ?? null);
                    if (base !== get_raw_cell_text(modified_row[col]?.raw ?? null)) {
                        changed_cells.push({ row: position, col, base });
                    }
                }
            });
        }
        return { startRow: 0, rowStatus: row_status, changedCells: changed_cells };
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        const deleted_index = this.deleted_original_index(sheet_index);
        if (deleted_index !== undefined) {
            return this.original.read_rows(deleted_index, start_row, count);
        }
        const padded = this.padded_meta.sheets[sheet_index];
        if (!padded) return this.modified.read_rows(sheet_index, start_row, count);
        const start = Math.max(0, Math.min(start_row, padded.rowCount));
        const end = Math.min(padded.rowCount, start + count);
        const grid_rows: number[] = [];
        for (let row = start; row < end; row++) grid_rows.push(row);
        return { startRow: start, rows: this.read_aligned_rows(sheet_index, grid_rows) };
    }

    read_rows_indexed(sheet_index: number, row_indices: ArrayLike<number>): IndexedRows {
        const deleted_index = this.deleted_original_index(sheet_index);
        if (deleted_index !== undefined) {
            return read_source_rows_indexed(this.original, deleted_index, row_indices);
        }
        return { rows: this.read_aligned_rows(sheet_index, Array.from(row_indices)) };
    }

    /**
     * Rows for arbitrary grid rows of a matched sheet, each read from whichever
     * side holds it: deleted rows carry the *original* content, so the grid,
     * filters, sorting, copy, and auto-fit all see the removed text rather than
     * blanks under a painted band.
     */
    private read_aligned_rows(
        sheet_index: number,
        grid_rows: readonly number[],
    ): RowWindow['rows'] {
        const alignment = this.alignment_of(sheet_index);
        if (!alignment) {
            return read_source_rows_indexed(this.modified, sheet_index, grid_rows).rows;
        }
        const pairing = this.matched_by_modified_index.get(sheet_index)!;
        // One batched read per side, so an interleaved window still costs two
        // reads rather than two per row.
        const modified_rows: number[] = [];
        const original_rows: number[] = [];
        for (const grid_row of grid_rows) {
            const aligned = alignment[grid_row];
            if (!aligned) continue;
            if (aligned.modified !== ABSENT) modified_rows.push(aligned.modified);
            else original_rows.push(aligned.original);
        }
        const modified_batch = modified_rows.length > 0
            ? read_source_rows_indexed(this.modified, sheet_index, modified_rows).rows
            : [];
        const original_batch = original_rows.length > 0
            ? read_source_rows_indexed(this.original, pairing.originalIndex, original_rows).rows
            : [];
        let modified_position = 0;
        let original_position = 0;
        return grid_rows.map((grid_row) => {
            const aligned = alignment[grid_row];
            if (!aligned) return [];
            return aligned.modified !== ABSENT
                ? modified_batch[modified_position++] ?? []
                : original_batch[original_position++] ?? [];
        });
    }

    /**
     * Forward the modified side's projected↔canonical row mapping so wrapping
     * (e.g.) an ExcelHeaderDataSource keeps header promotion intact. Deleted
     * rows have no modified-side row, so they map to canonical rows appended
     * after the modified side's, where they stay stable and collision-free.
     */
    source_row_indices(
        sheet_index: number,
        projected_rows: ArrayLike<number>,
    ): Uint32Array {
        const deleted_index = this.deleted_original_index(sheet_index);
        if (deleted_index !== undefined) {
            return this.original.source_row_indices
                ? this.original.source_row_indices(deleted_index, projected_rows)
                : Uint32Array.from(projected_rows);
        }
        const alignment = this.alignment_of(sheet_index);
        if (!alignment) return Uint32Array.from(projected_rows);
        const canonical = this.deleted_canonical_rows.get(sheet_index);
        const result = new Uint32Array(projected_rows.length);
        const real_positions: number[] = [];
        const real_rows: number[] = [];
        for (let position = 0; position < projected_rows.length; position++) {
            const grid_row = projected_rows[position];
            const aligned = alignment[grid_row];
            if (aligned && aligned.modified !== ABSENT) {
                real_positions.push(position);
                real_rows.push(aligned.modified);
            } else {
                result[position] = canonical?.get(grid_row) ?? grid_row;
            }
        }
        if (real_rows.length > 0) {
            const mapped = this.modified.source_row_indices
                ? this.modified.source_row_indices(sheet_index, real_rows)
                : Uint32Array.from(real_rows);
            for (let position = 0; position < real_positions.length; position++) {
                result[real_positions[position]] = mapped[position];
            }
        }
        return result;
    }

    projected_row_index(sheet_index: number, source_row: number): number | undefined {
        const deleted_index = this.deleted_original_index(sheet_index);
        if (deleted_index !== undefined) {
            return this.original.projected_row_index
                ? this.original.projected_row_index(deleted_index, source_row)
                : source_row;
        }
        const alignment = this.alignment_of(sheet_index);
        if (!alignment) return source_row;
        const real = this.modified_meta.sheets[sheet_index];
        if (!real) return source_row;
        if (source_row >= real.sourceRowCount) {
            return this.deleted_grid_row(sheet_index, source_row);
        }
        const modified_row = this.modified.projected_row_index
            ? this.modified.projected_row_index(sheet_index, source_row)
            : source_row;
        if (modified_row === undefined) return undefined;
        return this.grid_row_by_modified(sheet_index).get(modified_row);
    }

    /** Modified-side row -> grid row, built lazily per sheet: only the paths
     *  that map *back* into the grid need it, and building it eagerly for every
     *  sheet would cost a map the size of the workbook on open. */
    private grid_row_by_modified(sheet_index: number): ReadonlyMap<number, number> {
        const cached = this.grid_row_by_modified_cache.get(sheet_index);
        if (cached) return cached;
        const built = new Map<number, number>();
        this.alignment_of(sheet_index)?.forEach((row, grid_row) => {
            if (row.modified !== ABSENT) built.set(row.modified, grid_row);
        });
        this.grid_row_by_modified_cache.set(sheet_index, built);
        return built;
    }

    /** The grid row a deleted row's canonical row belongs to. Canonical numbers
     *  are assigned contiguously from `sourceRowCount` in grid order, so this is
     *  an index into the sheet's deleted rows rather than a search. */
    private deleted_grid_row(sheet_index: number, source_row: number): number | undefined {
        return this.deleted_grid_rows.get(sheet_index)?.[
            source_row - this.modified_meta.sheets[sheet_index].sourceRowCount];
    }

    close(): void {
        try {
            this.modified.close();
        } finally {
            this.original.close();
        }
    }

    get truncationMessage(): string | undefined {
        // A truncated original silently degrades the diff (rows beyond its cap
        // read as added), so its message must surface alongside the modified
        // side's.
        const original = this.original.truncationMessage;
        const modified = this.modified.truncationMessage;
        if (modified !== undefined && original !== undefined) {
            return `${modified} (git original: ${original})`;
        }
        return modified
            ?? (original !== undefined ? `Git original: ${original}` : undefined);
    }

    get warnings(): string[] | undefined {
        const original = this.original.warnings?.map(
            (warning) => `Git original: ${warning}`,
        );
        const modified = this.modified.warnings;
        if (!original?.length) return modified;
        return [...(modified ?? []), ...original];
    }
}
