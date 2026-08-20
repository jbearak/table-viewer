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
    diff_row_window,
    diff_rows_indexed,
    pair_sheets,
    type CompareDiffWindow,
    type SheetPairing,
    type SheetPairStatus,
} from './compare-source';

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
    private static readonly MAX_CACHED_DIFF_PAGES = 64;
    private readonly diff_cache = new Map<string, CompareDiffWindow>();

    constructor(
        private readonly modified: DataSource,
        private readonly original: DataSource,
    ) {
        this.pairings = pair_sheets(original.meta(), modified.meta());
        this.matched_by_modified_index = new Map(
            this.pairings.flatMap((pairing) =>
                pairing.status === 'matched' ? [[pairing.modifiedIndex, pairing]] : []),
        );
        const original_sheets = original.meta().sheets;
        const modified_meta = modified.meta();
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
        this.padded_meta = {
            ...modified_meta,
            sheets: [...modified_meta.sheets.map((sheet, sheet_index) => {
                const pairing = this.matched_by_modified_index.get(sheet_index);
                if (!pairing) return sheet;
                const original_sheet = original_sheets[pairing.originalIndex];
                const row_count = Math.max(sheet.rowCount, original_sheet.rowCount);
                const column_count = Math.max(sheet.columnCount, original_sheet.columnCount);
                return row_count === sheet.rowCount && column_count === sheet.columnCount
                    ? sheet
                    : {
                        ...sheet,
                        rowCount: row_count,
                        // Padded (deleted-band) rows get their own canonical rows
                        // appended after the modified side's, so their mapping
                        // can never collide with a real row's.
                        sourceRowCount:
                            sheet.sourceRowCount + (row_count - sheet.rowCount),
                        columnCount: column_count,
                    };
            }),
            ...this.deleted_pairings.map((pairing) =>
                original_sheets[pairing.originalIndex]),
            ],
        };
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
        const pairing = this.matched_by_modified_index.get(sheet_index);
        if (!pairing) return undefined;
        return diff_row_window(this.original, this.modified, pairing, start_row, count);
    }

    /**
     * Positional diff for an arbitrary set of grid rows (a transformed page).
     * `rowStatus[i]`/`changedCells[*].row` name position `i` of `rows`.
     * LRU-cached by the exact row set, mirroring the core's page cache: a
     * renderer re-requesting a page must not reread and re-compare both sides.
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
        const pairing = this.matched_by_modified_index.get(sheet_index);
        if (!pairing) return undefined;
        const key = `${sheet_index}:${rows.join(',')}`;
        const cached = this.diff_cache.get(key);
        if (cached !== undefined) {
            this.diff_cache.delete(key);
            this.diff_cache.set(key, cached);
            return cached;
        }
        const window = diff_rows_indexed(this.original, this.modified, pairing, rows);
        this.diff_cache.set(key, window);
        while (this.diff_cache.size > CompareDataSource.MAX_CACHED_DIFF_PAGES) {
            const oldest = this.diff_cache.keys().next().value;
            if (oldest === undefined) break;
            this.diff_cache.delete(oldest);
        }
        return window;
    }

    /**
     * Original-side rows for a matched sheet's deleted band (padded rows beyond
     * the modified side's rowCount — positional alignment, so the band row and
     * the original row share the same index). Undefined when the sheet has no
     * matched original, whose padded rows can then only render blank.
     */
    private read_original_band(
        sheet_index: number,
        start_row: number,
        count: number,
    ): RowWindow['rows'] | undefined {
        const pairing = this.matched_by_modified_index.get(sheet_index);
        if (!pairing) return undefined;
        const original_sheet = this.original.meta().sheets[pairing.originalIndex];
        if (!original_sheet) return undefined;
        const end = Math.min(start_row + count, original_sheet.rowCount);
        if (end <= start_row) return undefined;
        return this.original.read_rows(pairing.originalIndex, start_row, end - start_row).rows;
    }

    /** Indexed variant of {@link read_original_band}: one batched original-side
     *  read, positionally matching `rows` (out-of-range rows come back empty). */
    private read_original_band_indexed(
        sheet_index: number,
        rows: readonly number[],
    ): RowWindow['rows'] | undefined {
        const pairing = this.matched_by_modified_index.get(sheet_index);
        if (!pairing) return undefined;
        const original_sheet = this.original.meta().sheets[pairing.originalIndex];
        if (!original_sheet) return undefined;
        const in_range = rows.filter((row) => row >= 0 && row < original_sheet.rowCount);
        const batched = in_range.length > 0
            ? read_source_rows_indexed(this.original, pairing.originalIndex, in_range).rows
            : [];
        let batched_position = 0;
        return rows.map((row) =>
            row >= 0 && row < original_sheet.rowCount
                ? batched[batched_position++] ?? []
                : []);
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        const deleted_index = this.deleted_original_index(sheet_index);
        if (deleted_index !== undefined) {
            return this.original.read_rows(deleted_index, start_row, count);
        }
        const real = this.modified.meta().sheets[sheet_index];
        const padded = this.padded_meta.sheets[sheet_index];
        if (!real || !padded) return this.modified.read_rows(sheet_index, start_row, count);
        const start = Math.max(0, Math.min(start_row, padded.rowCount));
        const end = Math.min(padded.rowCount, start + count);
        const real_end = Math.min(end, real.rowCount);
        const rows = real_end > start
            ? this.modified.read_rows(sheet_index, start, real_end - start).rows.slice()
            : [];
        // Deleted-band rows (beyond the modified side) carry the *original*
        // content: the grid, filters, sorting, copy, and auto-fit must all see
        // the removed text, not blanks under a painted band.
        const band_start = Math.max(start, real.rowCount);
        if (end > band_start) {
            const original_rows = this.read_original_band(sheet_index, band_start, end - band_start);
            for (let row = band_start; row < end; row++) {
                rows.push(original_rows?.[row - band_start] ?? []);
            }
        }
        return { startRow: start, rows };
    }

    read_rows_indexed(sheet_index: number, row_indices: ArrayLike<number>): IndexedRows {
        const deleted_index = this.deleted_original_index(sheet_index);
        if (deleted_index !== undefined) {
            return read_source_rows_indexed(this.original, deleted_index, row_indices);
        }
        const real = this.modified.meta().sheets[sheet_index];
        // One batched read per side keeps the underlying sources' indexed
        // batching; padded (deleted-band) positions read the *original* rows so
        // transforms and copies see the removed text the grid shows.
        const in_range: number[] = [];
        const band_rows: number[] = [];
        for (let position = 0; position < row_indices.length; position++) {
            const row = row_indices[position];
            if (real && row < real.rowCount) in_range.push(row);
            else band_rows.push(row);
        }
        const batched = in_range.length > 0
            ? read_source_rows_indexed(this.modified, sheet_index, in_range).rows
            : [];
        const band = band_rows.length > 0
            ? this.read_original_band_indexed(sheet_index, band_rows)
            : undefined;
        const rows: RowWindow['rows'] = [];
        let batched_position = 0;
        let band_position = 0;
        for (let position = 0; position < row_indices.length; position++) {
            const row = row_indices[position];
            rows.push(
                real && row < real.rowCount
                    ? batched[batched_position++] ?? []
                    : band?.[band_position++] ?? [],
            );
        }
        return { rows };
    }

    /**
     * Forward the modified side's projected↔canonical row mapping so wrapping
     * (e.g.) an ExcelHeaderDataSource keeps header promotion intact. Padded
     * deleted-band rows map to canonical rows appended after the modified
     * side's real ones (see the sourceRowCount padding above), so they stay
     * stable and collision-free.
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
        const real = this.modified.meta().sheets[sheet_index];
        if (!real) return Uint32Array.from(projected_rows);
        const result = new Uint32Array(projected_rows.length);
        const real_positions: number[] = [];
        const real_rows: number[] = [];
        for (let position = 0; position < projected_rows.length; position++) {
            const row = projected_rows[position];
            if (row < real.rowCount) {
                real_positions.push(position);
                real_rows.push(row);
            } else {
                result[position] = real.sourceRowCount + (row - real.rowCount);
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
        const real = this.modified.meta().sheets[sheet_index];
        if (!real) return source_row;
        if (source_row >= real.sourceRowCount) {
            const padded_row = real.rowCount + (source_row - real.sourceRowCount);
            const padded = this.padded_meta.sheets[sheet_index];
            return padded && padded_row < padded.rowCount ? padded_row : undefined;
        }
        return this.modified.projected_row_index
            ? this.modified.projected_row_index(sheet_index, source_row)
            : source_row;
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
