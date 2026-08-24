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
    read_source_raw_columns_async,
    read_source_raw_rows_indexed_async,
    read_source_rows_indexed,
    type ColumnFilterMetadata,
    type DataSource,
    type IndexedRows,
    type RawCell,
    type RawColumnWindow,
    type RenderedCell,
    type RowWindow,
    type SheetMeta,
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
import { cells_exactly_equal, get_raw_cell_text } from '../cell-display';
import type { MergeRange } from '../types';
import {
    ABSENT,
    align_sheet,
    identity_alignment,
    type AlignedRow,
    type AlignSheetOptions,
    type SheetAlignment,
} from './row-alignment';

/**
 * A sheet with its first-row-header capability withheld.
 *
 * The wrapper is deliberately not an ExcelHeaderDataSource (see the file
 * header), so the controller refuses every `setExcelFirstRowHeader` it is sent.
 * Reporting the capability anyway put a live Header Row button in front of the
 * user whose only possible outcome was the refusal dialog — and, because a
 * pending header request blocks transforms and column-visibility work until it
 * settles, the refusal also stalled the next thing they tried.
 *
 * Withheld here rather than filtered in the webview so there is one answer to
 * "can this sheet promote a header row", and it is the source's.
 */
function compare_abort_error(): Error {
    const error = new Error('Compare diff was cancelled.');
    error.name = 'AbortError';
    return error;
}

function is_abort_error(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

interface DiffWaiter {
    readonly isCancelled: () => boolean;
}

interface InFlightDiff {
    readonly epoch: number;
    readonly waiters: Set<DiffWaiter>;
    terminal: boolean;
    cancelled: boolean;
    promise?: Promise<CompareDiffWindow>;
}

function without_header_capability(sheet: SheetMeta): SheetMeta {
    if (sheet.excelFirstRowHeader === undefined) return sheet;
    const { excelFirstRowHeader: _withheld, ...rest } = sheet;
    return rest;
}

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
    const matched = pairings.filter(
        (pairing): pairing is Extract<SheetPairing, { status: 'matched' }> =>
            pairing.status === 'matched',
    );
    // Progress is reported over the whole workbook, not per sheet: a bar that
    // restarts at each worksheet reads as though the work were going backwards.
    const original_meta = original.meta();
    const modified_meta = modified.meta();
    const workbook_rows = matched.reduce(
        (total, pairing) => total
            + original_meta.sheets[pairing.originalIndex].rowCount
            + modified_meta.sheets[pairing.modifiedIndex].rowCount,
        0,
    );
    let scanned_before = 0;
    const alignments = new Map<number, SheetAlignment>();
    for (const pairing of matched) {
        const sheet_rows = original_meta.sheets[pairing.originalIndex].rowCount
            + modified_meta.sheets[pairing.modifiedIndex].rowCount;
        const on_progress = options.onProgress;
        alignments.set(
            pairing.modifiedIndex,
            await align_sheet(original, modified, pairing, {
                ...options,
                ...(on_progress
                    ? {
                        onProgress: (scanned: number) =>
                            on_progress(scanned_before + scanned, workbook_rows),
                    }
                    : {}),
            }),
        );
        scanned_before += sheet_rows;
        options.onProgress?.(scanned_before, workbook_rows);
    }
    return alignments;
}

/**
 * Move a modified-side sheet's merges into unified-grid row space.
 *
 * The unified grid interleaves deleted original rows among the modified ones,
 * so a merge anchored at modified row 1 may render two rows lower. Left
 * unprojected it covered whatever happened to sit at its old numbers — the
 * wrong cells, and visibly so once a deletion lands above it.
 *
 * A merge whose rows are split apart by an interleaved deletion is dropped
 * rather than stretched over the gap: widening it would silently swallow a
 * deleted row into a block that never contained it, which reads as a data
 * change rather than a layout one. Returns the input array unchanged when
 * nothing moves, so the caller can keep the original sheet object.
 */
function project_merges(
    merges: readonly MergeRange[],
    rows: readonly { readonly modified: number }[],
): MergeRange[] {
    if (merges.length === 0) return merges as MergeRange[];
    const grid_row_by_modified = new Map<number, number>();
    rows.forEach((row, grid_row) => {
        if (row.modified !== ABSENT) grid_row_by_modified.set(row.modified, grid_row);
    });
    const projected: MergeRange[] = [];
    let moved = false;
    for (const merge of merges) {
        const start = grid_row_by_modified.get(merge.startRow);
        const end = grid_row_by_modified.get(merge.endRow);
        // Contiguity is what says no deleted row was interleaved inside it.
        if (start === undefined || end === undefined
            || end - start !== merge.endRow - merge.startRow) {
            moved = true;
            continue;
        }
        if (start !== merge.startRow) moved = true;
        projected.push({ ...merge, startRow: start, endRow: end });
    }
    return moved ? projected : merges as MergeRange[];
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
    private readonly diff_in_flight = new Map<string, InFlightDiff>();
    private closed = false;
    private lifecycle_epoch = 0;
    /** Aligned unified rows per *grid* sheet index, for matched sheets. Absent
     *  for added/deleted sheets, which are one-sided and need no alignment. */
    private readonly alignments: ReadonlyMap<number, SheetAlignment>;
    /** Only caller-supplied alignments have authoritative changed-row sets. The
     *  positional fallback uses an empty synthetic set even when cells differ. */
    private readonly supplied_alignment_sheets: ReadonlySet<number>;
    private readonly alignment_changed_row_lookup_cache = new Map<number, ReadonlySet<number>>();
    /** True when any matched sheet fell back to positional alignment, so the
     *  host can say so rather than present an all-changed grid as a finding. */
    readonly degraded: boolean;
    /** True when any matched sheet had more unpaired rows than the move search
     *  will score, so some moves are still reported as a deletion plus an
     *  addition. The alignment is correct; it is not the whole answer about
     *  moves, and a window that stayed quiet would imply it was. */
    readonly moveSearchTruncated: boolean;
    /** Grid row -> canonical row, for deleted rows only, per matched sheet. */
    private readonly deleted_canonical_rows: ReadonlyMap<number, ReadonlyMap<number, number>>;
    private readonly grid_row_by_modified_cache = new Map<number, ReadonlyMap<number, number>>();
    /** Memoized {@link changed_grid_rows}. Alignments never change after
     *  construction, but PanelCore asks again on every transform recompute —
     *  so without this, each sort or filter rescans every row of the sheet. */
    private readonly changed_grid_rows_cache = new Map<number, readonly number[]>();
    /** Memoized moved-row membership per sheet. Built once instead of per page
     *  request: a re-sorted sheet can mark nearly every row moved, and
     *  `compute_diff` runs on every viewport page that misses its cache. */
    private readonly moved_row_lookup_cache = new Map<number, ReadonlySet<number>>();
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
        // Preserve which entries were supplied before filling the map. A supplied
        // alignment's changedRowIndices came from an exact count pass; the
        // constructor fallback's identical-looking empty array proves nothing.
        this.supplied_alignment_sheets = new Set(
            [...this.matched_by_modified_index.keys()].filter((index) => alignments.has(index)),
        );
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
                    changedCells: 0,
                    changedRowIndices: [],
                    movedRowIndices: [],
                    moveSearchTruncated: false,
                    degraded: true,
                },
            ]),
        );
        this.degraded = [...this.alignments.values()].some(
            (alignment) => alignment.degraded);
        this.moveSearchTruncated = [...this.alignments.values()].some(
            (alignment) => alignment.moveSearchTruncated);
        this.padded_meta = {
            ...modified_meta,
            // Either side can carry formatting: a deleted row is served from
            // the original, so a comparison of an unformatted modified file
            // against a formatted original still renders formatted cells, and
            // a consumer told otherwise would not ask for them.
            hasFormatting: modified_meta.hasFormatting || this.original_meta.hasFormatting,
            sheets: [...modified_meta.sheets.map((sheet, sheet_index) => {
                sheet = without_header_capability(sheet);
                const pairing = this.matched_by_modified_index.get(sheet_index);
                if (!pairing) return sheet;
                const original_sheet = original_sheets[pairing.originalIndex];
                // The unified grid is exactly the aligned rows: paired rows plus
                // one-sided ones, in order. With a positional alignment this is
                // max(original, modified) — the old padding — and with a content
                // alignment it interleaves inserts and deletions where they
                // actually happened.
                const alignment = this.alignments.get(sheet_index)!;
                const row_count = alignment.rows.length;
                const column_count = Math.max(sheet.columnCount, original_sheet.columnCount);
                const merges = project_merges(sheet.merges, alignment.rows);
                return row_count === sheet.rowCount
                    && column_count === sheet.columnCount
                    && merges === sheet.merges
                    ? sheet
                    : {
                        ...sheet,
                        rowCount: row_count,
                        merges,
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
                without_header_capability(original_sheets[pairing.originalIndex])),
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
    change_counts(): {
        addedRows: number;
        deletedRows: number;
        movedRows: number;
        changedCells: number;
    } {
        let added = 0;
        let deleted = 0;
        let moved = 0;
        let changed_cells = 0;
        for (const alignment of this.alignments.values()) {
            added += alignment.addedRows;
            deleted += alignment.deletedRows;
            moved += alignment.movedRowIndices.length;
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
            movedRows: moved,
            changedCells: changed_cells,
        };
    }

    /**
     * Grid rows that are added, deleted, or have at least one changed cell, in
     * grid order — the row set behind the "only changed rows" filter. Every row
     * of a one-sided sheet qualifies.
     */
    changed_grid_rows(sheet_index: number): readonly number[] {
        const cached = this.changed_grid_rows_cache.get(sheet_index);
        if (cached) return cached;
        const computed = this.compute_changed_grid_rows(sheet_index);
        this.changed_grid_rows_cache.set(sheet_index, computed);
        return computed;
    }

    /** Moved grid rows of a sheet as a membership set, built at most once. */
    private moved_rows_of(sheet_index: number): ReadonlySet<number> {
        const cached = this.moved_row_lookup_cache.get(sheet_index);
        if (cached) return cached;
        const built = new Set(this.alignments.get(sheet_index)?.movedRowIndices ?? []);
        this.moved_row_lookup_cache.set(sheet_index, built);
        return built;
    }

    /** Paired rows a caller-supplied alignment proved changed. Undefined means
     *  the positional fallback must still compare every paired row. */
    private proven_changed_rows_of(sheet_index: number): ReadonlySet<number> | undefined {
        if (!this.supplied_alignment_sheets.has(sheet_index)) return undefined;
        const cached = this.alignment_changed_row_lookup_cache.get(sheet_index);
        if (cached) return cached;
        const built = new Set(this.alignments.get(sheet_index)?.changedRowIndices ?? []);
        this.alignment_changed_row_lookup_cache.set(sheet_index, built);
        return built;
    }

    private compute_changed_grid_rows(sheet_index: number): readonly number[] {
        const alignment = this.alignments.get(sheet_index);
        if (!alignment) {
            const sheet = this.padded_meta.sheets[sheet_index];
            return sheet
                ? Array.from({ length: sheet.rowCount }, (_, row) => row)
                : [];
        }
        // Collected rather than re-diffed: the alignment pass already compared
        // every paired row. Moved rows are a third source, and not optional —
        // a purely moved row is neither one-sided nor in `changedRowIndices`,
        // so without it the row vanishes from the one view where someone
        // hunting changes would most expect to find it. The Set also
        // deduplicates a moved-and-edited row, which is in two of the three.
        //
        // All three sources are already ascending, so a cursor merge would be
        // O(n) against this O(n log n). Measured at a million rows: 4 ms
        // versus 29 ms — once, behind the memo above, on a sheet whose
        // alignment took seconds. Not worth the cursor bookkeeping.
        const rows = new Set<number>(alignment.changedRowIndices);
        alignment.rows.forEach((row, grid_row) => {
            if (row.original === ABSENT || row.modified === ABSENT) rows.add(grid_row);
        });
        for (const grid_row of alignment.movedRowIndices) rows.add(grid_row);
        return [...rows].sort((left, right) => left - right);
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

    column_filter_metadata(
        sheet_index: number,
        column_index: number,
    ): ColumnFilterMetadata | undefined {
        const deleted_index = this.deleted_original_index(sheet_index);
        if (deleted_index !== undefined) {
            const sheet = this.original_meta.sheets[deleted_index];
            return column_index < sheet.columnCount
                ? this.original.column_filter_metadata?.(deleted_index, column_index)
                : undefined;
        }
        const modified_sheet = this.modified_meta.sheets[sheet_index];
        const modified = modified_sheet && column_index < modified_sheet.columnCount
            ? this.modified.column_filter_metadata?.(sheet_index, column_index)
            : undefined;
        if (modified !== undefined) return modified;
        const pairing = this.matched_by_modified_index.get(sheet_index);
        if (pairing === undefined) return undefined;
        const original_sheet = this.original_meta.sheets[pairing.originalIndex];
        return column_index < original_sheet.columnCount
            ? this.original.column_filter_metadata?.(
                pairing.originalIndex,
                column_index,
            )
            : undefined;
    }

    async column_filter_metadata_async(
        sheet_index: number,
        column_index: number,
        is_cancelled: () => boolean,
    ): Promise<ColumnFilterMetadata | undefined> {
        const deleted_index = this.deleted_original_index(sheet_index);
        if (deleted_index !== undefined) {
            const sheet = this.original_meta.sheets[deleted_index];
            if (column_index >= sheet.columnCount) return undefined;
            return this.original.column_filter_metadata_async
                ? this.original.column_filter_metadata_async(
                    deleted_index,
                    column_index,
                    is_cancelled,
                )
                : this.original.column_filter_metadata?.(deleted_index, column_index);
        }
        const modified_sheet = this.modified_meta.sheets[sheet_index];
        const modified = modified_sheet && column_index < modified_sheet.columnCount
            ? this.modified.column_filter_metadata_async
                ? await this.modified.column_filter_metadata_async(
                    sheet_index,
                    column_index,
                    is_cancelled,
                )
                : this.modified.column_filter_metadata?.(sheet_index, column_index)
            : undefined;
        if (modified !== undefined || is_cancelled()) return modified;
        const pairing = this.matched_by_modified_index.get(sheet_index);
        if (pairing === undefined) return undefined;
        const original_sheet = this.original_meta.sheets[pairing.originalIndex];
        if (column_index >= original_sheet.columnCount) return undefined;
        return this.original.column_filter_metadata_async
            ? this.original.column_filter_metadata_async(
                pairing.originalIndex,
                column_index,
                is_cancelled,
            )
            : this.original.column_filter_metadata?.(
                pairing.originalIndex,
                column_index,
            );
    }

    /**
     * Diff for an arbitrary set of grid rows. `rowStatus[i]` and
     * `changedCells[*].row` are positional: they name `rows[i]`, not the
     * display slot. LRU-cached by the exact row set, mirroring the core's page
     * cache: a renderer re-requesting a page must not reread and re-compare
     * both sides.
     */
    async diff_rows(
        sheet_index: number,
        rows: readonly number[],
        is_cancelled: () => boolean = () => false,
    ): Promise<CompareDiffWindow | undefined> {
        if (this.closed || is_cancelled()) throw compare_abort_error();
        if (this.deleted_original_index(sheet_index) !== undefined) {
            // A deleted sheet is one all-deleted band; the rows themselves
            // carry the original content, so there are no changed cells.
            return {
                startRow: 0,
                rowStatus: Array.from(rows, () => 'deleted' as const),
                changedCells: [],
            };
        }
        if (this.sheetStatuses[sheet_index] === 'added') {
            // The mirror of the deleted case, and it has to be stated: an added
            // sheet has no original to align against, so it has no alignment
            // and would otherwise fall through to `undefined` — painting a
            // wholly new sheet as ordinary unchanged rows, while the tab badge
            // and the summary both call it added.
            return {
                startRow: 0,
                rowStatus: Array.from(rows, () => 'added' as const),
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
            if (this.closed || is_cancelled()) throw compare_abort_error();
            return cached;
        }

        const waiter: DiffWaiter = { isCancelled: is_cancelled };
        let operation = this.diff_in_flight.get(key);
        // Do not attach fresh work to an operation already committed to aborting.
        // Its sibling read may still be settling, but it can no longer produce a
        // usable page even if a live waiter appears now.
        if (
            operation !== undefined
            && (operation.terminal || this.shared_diff_cancelled(operation))
        ) {
            operation = undefined;
        }
        if (operation === undefined) {
            const created: InFlightDiff = {
                epoch: this.lifecycle_epoch,
                waiters: new Set([waiter]),
                terminal: false,
                cancelled: false,
            };
            this.diff_in_flight.set(key, created);
            const shared_is_cancelled = () => this.shared_diff_cancelled(created);
            // Schedule source work after the operation record is complete. Built-in
            // sources do not re-enter diff_rows, but this also makes coalescing
            // correct for a third-party source that does so from a read callback.
            created.promise = Promise.resolve().then(() => {
                if (shared_is_cancelled()) throw compare_abort_error();
                return this.compute_diff(
                    sheet_index,
                    alignment,
                    rows,
                    shared_is_cancelled,
                    () => { created.terminal = true; },
                );
            }).then((window) => {
                if (shared_is_cancelled()) throw compare_abort_error();
                this.cache_diff(key, window, created.epoch);
                return window;
            }).catch((error) => {
                created.terminal = true;
                throw error;
            }).finally(() => {
                if (this.diff_in_flight.get(key) === created) {
                    this.diff_in_flight.delete(key);
                }
            });
            operation = created;
        } else {
            operation.waiters.add(waiter);
        }

        try {
            const window = await operation.promise!;
            if (
                this.closed
                || this.lifecycle_epoch !== operation.epoch
                || is_cancelled()
            ) throw compare_abort_error();
            return window;
        } finally {
            operation.waiters.delete(waiter);
        }
    }

    private shared_diff_cancelled(operation: InFlightDiff): boolean {
        if (operation.cancelled) return true;
        const cancelled = this.closed
            || this.lifecycle_epoch !== operation.epoch
            || operation.waiters.size === 0
            || [...operation.waiters].every((waiter) => waiter.isCancelled());
        if (cancelled) {
            operation.cancelled = true;
            operation.terminal = true;
        }
        return cancelled;
    }

    private cache_diff(key: string, window: CompareDiffWindow, epoch: number): void {
        if (this.closed || this.lifecycle_epoch !== epoch) return;
        this.diff_cache.set(key, window);
        while (this.diff_cache.size > CompareDataSource.MAX_CACHED_DIFF_PAGES) {
            const oldest = this.diff_cache.keys().next().value;
            if (oldest === undefined) break;
            this.diff_cache.delete(oldest);
        }
    }

    /**
     * Compare the two sides of each requested grid row, through the alignment.
     * Rows present on only one side are added/deleted outright; paired rows are
     * read from both sides in one batch each and compared cell by cell.
     */
    private async compute_diff(
        sheet_index: number,
        alignment: readonly AlignedRow[],
        rows: readonly number[],
        is_cancelled: () => boolean,
        mark_terminal: () => void,
    ): Promise<CompareDiffWindow> {
        const pairing = this.matched_by_modified_index.get(sheet_index)!;
        const original_sheet = this.original_meta.sheets[pairing.originalIndex];
        const modified_sheet = this.modified_meta.sheets[sheet_index];
        const column_count = Math.max(original_sheet.columnCount, modified_sheet.columnCount);
        const moved = this.moved_rows_of(sheet_index);
        const proven_changed = this.proven_changed_rows_of(sheet_index);
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
            // A moved row is an ordinary two-index row. A supplied alignment has
            // already compared it and may prove it unchanged; a fallback has not.
            row_status.push(moved.has(grid_row) ? 'moved' : 'same');
            if (proven_changed !== undefined && !proven_changed.has(grid_row)) return;
            paired_positions.push(position);
            original_rows.push(aligned.original);
            modified_rows.push(aligned.modified);
        });
        const changed_cells: ChangedCell[] = [];
        if (paired_positions.length > 0) {
            const { original: original_batch, modified: modified_batch } =
                await this.read_diff_raw_batches(
                    pairing.originalIndex,
                    original_rows,
                    sheet_index,
                    modified_rows,
                    is_cancelled,
                    mark_terminal,
                );
            const pending: {
                readonly pairedIndex: number;
                readonly row: number;
                readonly col: number;
                readonly base: string;
            }[] = [];
            for (let index = 0; index < paired_positions.length; index++) {
                if (is_cancelled()) throw compare_abort_error();
                const position = paired_positions[index];
                const original_row = original_batch[index] ?? [];
                const modified_row = modified_batch[index] ?? [];
                for (let col = 0; col < column_count; col++) {
                    // Compare on raw identity, which is lossless for binary strLs.
                    // Formatting is acquired only for changed original rows below.
                    const equal = cells_exactly_equal(
                        original_row[col],
                        modified_row[col],
                        is_cancelled,
                    );
                    if (typeof equal === 'boolean' ? equal : await equal) continue;
                    pending.push({
                        pairedIndex: index,
                        row: position,
                        col,
                        base: get_raw_cell_text(original_row[col]?.raw ?? null),
                    });
                }
            }
            if (pending.length > 0) {
                if (is_cancelled()) throw compare_abort_error();
                const changed_paired_indices = [...new Set(
                    pending.map((cell) => cell.pairedIndex),
                )];
                const rendered_original = read_source_rows_indexed(
                    this.original,
                    pairing.originalIndex,
                    changed_paired_indices.map((index) => original_rows[index]),
                ).rows;
                if (is_cancelled()) throw compare_abort_error();
                const rendered_by_paired_index = new Map<number, (RenderedCell | null)[]>(
                    changed_paired_indices.map((paired_index, position) => [
                        paired_index,
                        rendered_original[position] ?? [],
                    ]),
                );
                for (const changed of pending) {
                    const rendered = rendered_by_paired_index.get(changed.pairedIndex)?.[
                        changed.col];
                    changed_cells.push({
                        row: changed.row,
                        col: changed.col,
                        base: changed.base,
                        formattedBase: rendered?.formatted ?? changed.base,
                    });
                }
            }
        }
        return { startRow: 0, rowStatus: row_status, changedCells: changed_cells };
    }

    /** Start both raw side reads before awaiting either. A failure trips the
     *  sibling's cancellation predicate, but both promises are observed to
     *  settlement before the substantive failure is propagated. */
    private async read_diff_raw_batches(
        original_sheet_index: number,
        original_rows: readonly number[],
        modified_sheet_index: number,
        modified_rows: readonly number[],
        is_cancelled: () => boolean,
        mark_terminal: () => void,
    ): Promise<{
        readonly original: (RawCell | null)[][];
        readonly modified: (RawCell | null)[][];
    }> {
        let peer_failed = false;
        const read_is_cancelled = () => peer_failed || is_cancelled();
        const original_read = read_source_raw_rows_indexed_async(
            this.original,
            original_sheet_index,
            original_rows,
            read_is_cancelled,
        );
        const modified_read = read_source_raw_rows_indexed_async(
            this.modified,
            modified_sheet_index,
            modified_rows,
            read_is_cancelled,
        );
        const observe = async <T>(promise: Promise<T>): Promise<T> => {
            try {
                return await promise;
            } catch (error) {
                peer_failed = true;
                mark_terminal();
                throw error;
            }
        };
        const [original_result, modified_result] = await Promise.allSettled([
            observe(original_read),
            observe(modified_read),
        ]);
        if (is_cancelled()) throw compare_abort_error();
        const failures = [original_result, modified_result].filter(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        const substantive = failures.find((failure) => !is_abort_error(failure.reason));
        if (substantive !== undefined) throw substantive.reason;
        if (failures.length > 0) throw failures[0].reason;
        if (original_result.status !== 'fulfilled' || modified_result.status !== 'fulfilled') {
            throw compare_abort_error();
        }
        return {
            original: original_result.value.rows,
            modified: modified_result.value.rows,
        };
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

    async read_raw_columns_async(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<RawColumnWindow> {
        const sheet = this.padded_meta.sheets[sheet_index];
        if (!sheet) throw new RangeError(`sheet index ${sheet_index} out of range`);
        for (const column of column_indices) {
            if (!Number.isInteger(column) || column < 0 || column >= sheet.columnCount) {
                throw new RangeError(
                    `column index ${column} out of range (${sheet.columnCount} columns)`,
                );
            }
        }
        const start = Math.max(0, Math.min(start_row, sheet.rowCount));
        const end = Math.min(sheet.rowCount, start + Math.max(0, count));
        const deleted_index = this.deleted_original_index(sheet_index);
        if (deleted_index !== undefined) {
            return read_source_raw_columns_async(
                this.original,
                deleted_index,
                start,
                end - start,
                column_indices,
                is_cancelled,
            );
        }
        const alignment = this.alignment_of(sheet_index);
        if (!alignment) {
            return read_source_raw_columns_async(
                this.modified,
                sheet_index,
                start,
                end - start,
                column_indices,
                is_cancelled,
            );
        }

        const pairing = this.matched_by_modified_index.get(sheet_index)!;
        const modified_rows: number[] = [];
        const original_rows: number[] = [];
        for (let row = start; row < end; row++) {
            const aligned = alignment[row];
            if (!aligned) continue;
            if (aligned.modified !== ABSENT) modified_rows.push(aligned.modified);
            else original_rows.push(aligned.original);
        }
        const [modified_batch, original_batch] = await Promise.all([
            this.read_side_raw_columns(
                this.modified,
                sheet_index,
                modified_rows,
                column_indices,
                is_cancelled,
            ),
            this.read_side_raw_columns(
                this.original,
                pairing.originalIndex,
                original_rows,
                column_indices,
                is_cancelled,
            ),
        ]);
        let modified_position = 0;
        let original_position = 0;
        const rows: (RawCell | null)[][] = [];
        for (let row = start; row < end; row++) {
            const aligned = alignment[row];
            if (!aligned) {
                rows.push(column_indices.map(() => null));
            } else if (aligned.modified !== ABSENT) {
                rows.push(modified_batch[modified_position++] ?? []);
            } else {
                rows.push(original_batch[original_position++] ?? []);
            }
        }
        return { startRow: start, rows };
    }

    /** Read arbitrary rows from one side while retaining a compact column
     * projection and filling columns that exist only on the other side. */
    private async read_side_raw_columns(
        source: DataSource,
        sheet_index: number,
        row_indices: readonly number[],
        column_indices: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<(RawCell | null)[][]> {
        if (row_indices.length === 0) return [];
        const column_count = source.meta().sheets[sheet_index].columnCount;
        const valid_columns: number[] = [];
        const result_positions: number[] = [];
        column_indices.forEach((column, position) => {
            if (column < column_count) {
                valid_columns.push(column);
                result_positions.push(position);
            }
        });
        if (valid_columns.length === 0) {
            return row_indices.map(() => column_indices.map(() => null));
        }

        const materialized = new Map<number, (RawCell | null)[]>();
        const unique = [...new Set(row_indices)].sort((left, right) => left - right);
        let position = 0;
        while (position < unique.length) {
            const start = unique[position];
            let run_length = 1;
            while (
                position + run_length < unique.length
                && unique[position + run_length] === start + run_length
            ) run_length += 1;
            const window = await read_source_raw_columns_async(
                source,
                sheet_index,
                start,
                run_length,
                valid_columns,
                is_cancelled,
            );
            window.rows.forEach((row, offset) => {
                const projected = column_indices.map((): RawCell | null => null);
                result_positions.forEach((result_position, index) => {
                    projected[result_position] = row[index] ?? null;
                });
                materialized.set(start + offset, projected);
            });
            position += run_length;
        }
        return row_indices.map((row) => materialized.get(row)!);
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
        if (!alignment) {
            // An unaligned sheet is still a modified-side sheet — an added
            // worksheet has no original to align against but can carry header
            // promotion or hidden rows, so its projection is not the identity.
            return this.modified.source_row_indices
                ? this.modified.source_row_indices(sheet_index, projected_rows)
                : Uint32Array.from(projected_rows);
        }
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
        if (!alignment) {
            return this.modified.projected_row_index
                ? this.modified.projected_row_index(sheet_index, source_row)
                : source_row;
        }
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
        if (this.closed) return;
        this.closed = true;
        this.lifecycle_epoch += 1;
        this.diff_cache.clear();
        this.diff_in_flight.clear();
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
