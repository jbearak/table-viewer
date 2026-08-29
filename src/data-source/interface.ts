import type { MergeRange } from '../types';
import type { RichCellFields } from '../cell-content';
import type { XlsxCellFormatFields } from '../spreadsheet-format';

/** Deferred lossless identity for a source value whose display-safe raw text is
 * bounded. Capabilities live behind symbols so row/filter/compare protocols can
 * serialize cells without ever carrying functions or promises. */
export interface DeferredCellIdentity {
    cachedKey(): string | undefined;
    resolveKey(is_cancelled: () => boolean): Promise<string>;
    exactlyEquals?(
        other: DeferredCellIdentity,
        is_cancelled: () => boolean,
    ): boolean | Promise<boolean> | undefined;
}

export const DEFERRED_COMPARISON_IDENTITY: unique symbol = Symbol(
    'table-viewer.deferred-comparison-identity',
);
export const DEFERRED_FILTER_IDENTITY: unique symbol = Symbol(
    'table-viewer.deferred-filter-identity',
);

interface DeferredIdentityFields {
    [DEFERRED_COMPARISON_IDENTITY]?: DeferredCellIdentity;
    [DEFERRED_FILTER_IDENTITY]?: DeferredCellIdentity;
}

/** Webview-facing cell. Identical shape to the old CellData so the renderer
 *  is format-agnostic. `raw` is the raw value rendered to string (numbers/bools
 *  become their string form — acceptable: copy + edit-base both String() it).
 *  The rich fields are shared with CellData via RichCellFields; only Excel
 *  sources set them, so CSV cells keep their exact legacy shape. */
export interface RenderedCell extends
    RichCellFields,
    XlsxCellFormatFields,
    DeferredIdentityFields {
    raw: string | null;       // null = empty cell
    formatted: string;        // display text (== raw for CSV)
    /** Effective A1 formula, including the leading `=` used by the editor. */
    formula?: string;
    /** The formula has no cached result that Table Viewer can display. */
    formulaResultPending?: true;
    /** Underlying finite numeric scalar when display-safe `raw` is text. */
    numericRaw?: number;
    bold: boolean;
    italic: boolean;
    /** Original scalar category retained for correct numeric sorting. */
    rawType?: 'string' | 'number' | 'boolean' | 'date' | 'error' | 'empty';
    /** Internal identity used by comparisons when display-safe `raw` is lossy. */
    comparisonKey?: string;
    /** Canonical filter identity when display-safe `raw` is lossy. Matching and
     * persistence use this value; the raw preview remains user-facing text. */
    filterKey?: string;
    /** Source byte size of the canonical raw value when its display preview is
     * bounded. Filter analysis uses this before materializing a large identity. */
    rawByteLength?: number;
}

export type RawCell = Pick<
    RenderedCell,
    'raw' | 'rawType' | 'comparisonKey' | 'filterKey' | 'rawByteLength'
> & DeferredIdentityFields;

/** Optional source semantics for one filter column. The histogram scan owns raw
 * identity; a source may add labels and a categorical default without changing
 * sorting or matching away from those canonical raw values. */
export interface ColumnFilterMetadata {
    /** Raw values are source-defined category codes rather than measurements. */
    categoricalCodes?: boolean;
    /** User-facing label for one canonical nonblank raw value, when attached. */
    valueLabel?(raw: string): string | undefined;
}

/**
 * Formula references packed seven numbers at a time on the worksheet that owns
 * the formula:
 * `[formulaRow, formulaColumn, sourceSheetIndex,
 * firstRow, firstColumn, lastRow, lastColumn]`.
 * Coordinates use canonical physical source space. One flat array per sheet
 * avoids an object or inner-array allocation for every reference.
 */
export type PackedFormulaDependencies = readonly number[];
/**
 * Header Row references use an interned name table plus records packed five
 * numbers at a time: `[formulaRow, formulaColumn, sourceSheetIndex,
 * intersectionFlag, nameIndex]`.
 */
export interface PackedStructuredFormulaReferences {
    readonly names: readonly string[];
    readonly references: readonly number[];
}
/**
 * All formula coordinates, packed `[row, column]` in strictly increasing
 * row-major order. Pairs are unique; graph compilation validates this seam.
 */
export type PackedFormulaCells = readonly number[];
/** Formula cells with no trustworthy cached result, packed `[row, column]`. */
export type PackedPendingFormulaCells = readonly number[];

export interface RowWindow {
    startRow: number;                 // 0-based, absolute
    rows: (RenderedCell | null)[][];  // rows[i][col]; outer length <= requested count
}

/** Full rendered rows selected by absolute source index. Rows are returned in
 * exactly the requested order; repeated indices produce repeated rows. */
export interface IndexedRows {
    rows: (RenderedCell | null)[][];
}

/** A compact projection of a row window onto caller-selected columns.
 * `rows[i][j]` is the cell from `column_indices[j]`; cells from other columns
 * are never materialized. */
export interface RawColumnWindow {
    startRow: number;
    rows: (RawCell | null)[][];
}

/** Raw cells selected by arbitrary source row and column indices. Both dimensions
 * are returned in exactly the requested order, including duplicates. */
export interface IndexedRawColumns {
    rows: (RawCell | null)[][];
}

export interface ColumnWindow {
    startRow: number;
    rows: (RenderedCell | null)[][];
}

export type ExcelHeaderOverride = 'on' | 'off';

export interface ExcelFirstRowHeaderMeta {
    /** `auto` means the detector decides; explicit modes are persisted overrides. */
    mode: 'auto' | ExcelHeaderOverride;
    detected: boolean;
    active: boolean;
    /** Whether the physical sheet currently has a first row that can be promoted. */
    available: boolean;
    /** Canonical source row currently promoted. Present only while active. */
    sourceRow?: number;
}

export interface SheetMeta {
    name: string;
    /** Stable format-neutral worksheet identity when the source exposes one. */
    worksheetId?: string;
    /** The file has no worksheets of its own — a delimited file is one grid,
     *  and `name` is a placeholder the reader invented rather than anything the
     *  user chose. Comparison pairs such a sheet against a workbook's first
     *  worksheet instead of matching on that invented name. */
    unnamedSingleSheet?: boolean;
    /** Rows exposed by this DataSource after logical projections such as headers. */
    rowCount: number;
    /** Size of the stable canonical row space in the underlying physical source. */
    sourceRowCount: number;
    columnCount: number;
    /** Approximate encoded bytes per physical row, when cheaply known. Used to
     * bound page/cache/copy work for byte-heavy formats in addition to cells. */
    estimatedRowBytes?: number;
    merges: MergeRange[];             // from types.ts (rowSpan + colSpan)
    hasFormatting: boolean;
    /** Workbook-resolved A1 references used to invalidate cached formula results. */
    formulaDependencies?: PackedFormulaDependencies;
    structuredFormulaReferences?: PackedStructuredFormulaReferences;
    /** Every formula coordinate, including formulas with no references. */
    formulaCells?: PackedFormulaCells;
    /** Formula coordinates whose source file has no result cache. */
    pendingFormulaCells?: PackedPendingFormulaCells;
    /** Per-column header titles. Length === columnCount; a blank entry means
     *  "no name" and the renderer falls back to the column letter. */
    columnNames?: string[];
    /** Editable source text for the promoted header cells. */
    columnHeaderEditTexts?: string[];
    /** Whether each promoted header coordinate is a merge anchor or an ordinary cell. */
    columnHeaderEditable?: boolean[];
    /** Present only for Excel sheets that support first-row header projection. */
    excelFirstRowHeader?: ExcelFirstRowHeaderMeta;
}

export interface WorkbookMeta {
    sheets: SheetMeta[];
    hasFormatting: boolean;
}

export interface DataSource {
    /** Workbook structure only — no cell data. Cheap; safe to call repeatedly. */
    meta(): WorkbookMeta;
    /** Re-hash a descriptor-backed source for operations that must prove the
     * physical bytes still match the adopted source without a whole-file read. */
    physical_content_matches?(
        expected_digest: string,
        is_cancelled: () => boolean,
    ): Promise<boolean>;
    /** Map projected rows exposed by this DataSource to canonical source rows.
     * Optional identity default for sources without a row projection. */
    source_row_indices?(
        sheet_index: number,
        projected_rows: ArrayLike<number>,
    ): Uint32Array;
    /** Map one canonical source row back into this DataSource's projected row
     * space. Returns undefined when the source row is excluded by the projection. */
    projected_row_index?(
        sheet_index: number,
        source_row: number,
    ): number | undefined;
    /** Opaque identity for one sheet's projected-to-source row mapping. Sources
     * with a non-identity mapping must implement this to prove that two rebuilt
     * instances expose the same display-row identities. */
    row_projection_signature?(sheet_index: number): string | undefined;
    /** Materialize a window of rows for one sheet. count may overshoot rowCount. */
    read_rows(sheet_index: number, start_row: number, count: number): RowWindow;
    /** Materialize arbitrary absolute rows in requested order without reading
     * the sparse span between them. Optional for third-party/test sources;
     * callers use read_source_rows_indexed for a compatibility fallback. */
    read_rows_indexed?(
        sheet_index: number,
        row_indices: ArrayLike<number>,
    ): IndexedRows;
    /** Cancellable arbitrary-row rendered read for sources whose formatting may
     * lazily traverse large backing sections. Bounded sources may omit it. */
    read_rows_indexed_async?(
        sheet_index: number,
        row_indices: ArrayLike<number>,
        is_cancelled: () => boolean,
    ): Promise<IndexedRows>;
    /** Materialize only the requested columns, in the supplied order. Optional
     *  for third-party/test sources; callers use read_source_columns for a
     *  compatibility fallback. */
    read_columns?(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow;
    /**
     * Read canonical physical source rows without applying a row projection.
     * Formula coordinates use this space. Projection adapters such as promoted
     * Excel headers implement it by delegating to their underlying source.
     */
    read_canonical_columns?(
        sheet_index: number,
        start_source_row: number,
        count: number,
        column_indices: readonly number[],
    ): ColumnWindow;
    /** Materialize only raw values for the requested columns. Optional for
     * third-party/test sources; callers use read_source_raw_columns for a
     * compatibility fallback through the fully rendered read path. */
    read_raw_columns?(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
    ): RawColumnWindow;
    /** Async raw projection for sources whose lazy decode may traverse a large
     * backing section. Implementations must check cancellation during bounded
     * work, not merely before and after one synchronous full-section scan. */
    read_raw_columns_async?(
        sheet_index: number,
        start_row: number,
        count: number,
        column_indices: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<RawColumnWindow>;
    /** Native arbitrary-row/column projection for sparse analysis and compare
     * reads. The adapter validates indices before invoking this capability. */
    read_raw_columns_indexed_async?(
        sheet_index: number,
        row_indices: ArrayLike<number>,
        column_indices: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<IndexedRawColumns>;
    /** Optional source semantics used by filter analysis. This must not change
     * raw identity: labels are display-only and category codes remain raw keys. */
    column_filter_metadata?(
        sheet_index: number,
        column_index: number,
    ): ColumnFilterMetadata | undefined;
    /** Cancellable metadata path for sources that lazily scan a backing section. */
    column_filter_metadata_async?(
        sheet_index: number,
        column_index: number,
        is_cancelled: () => boolean,
    ): Promise<ColumnFilterMetadata | undefined>;
    /** Release buffers/handles. */
    close(): void;

    // --- Optional diagnostics, read polymorphically by panel-core ---
    // Kept optional so each source only carries what applies to its format.

    /** Set when the source was truncated (e.g. CSV beyond max_rows). */
    truncationMessage?: string;
    /** Parse-time warnings to surface to the user (xlsx/xls). */
    warnings?: string[];
    /** CSV save path: per-row field counts before padding, capped to kept rows. */
    originalColumnCounts?: number[];
    /** CSV save path: the verbatim first line (header), terminator stripped, when
     *  the source consumed row 0 as column names. The save path re-prepends it so
     *  the header survives a round-trip even though it is not a grid data row. */
    headerLine?: string;
    /** CSV save path: detected line terminator, so re-serialization round-trips. */
    lineEnding?: '\r\n' | '\r' | '\n';
}

/** Return a comparable row-projection identity. Omitting all row-mapping
 * methods is the DataSource contract's identity mapping; a custom mapper that
 * supplies no signature deliberately cannot prove stability across rebuilds. */
export function source_row_projection_signature(
    source: DataSource,
    sheet_index: number,
): string | undefined {
    if (!source.meta().sheets[sheet_index]) return undefined;
    if (source.row_projection_signature) {
        return source.row_projection_signature(sheet_index);
    }
    return source.source_row_indices || source.projected_row_index
        ? undefined
        : 'data-source:identity:v1';
}

/** Map projected DataSource rows to canonical source rows. Identity sources
 * need not implement source_row_indices explicitly. */
export function read_source_row_indices(
    source: DataSource,
    sheet_index: number,
    projected_rows: ArrayLike<number>,
): Uint32Array {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) throw new RangeError(`sheet index ${sheet_index} out of range`);
    for (let position = 0; position < projected_rows.length; position++) {
        const row = projected_rows[position];
        if (!Number.isInteger(row) || row < 0 || row >= sheet.rowCount) {
            throw new RangeError(`row index ${row} out of range (${sheet.rowCount} rows)`);
        }
    }
    const source_rows = source.source_row_indices
        ? source.source_row_indices(sheet_index, projected_rows)
        : Uint32Array.from(projected_rows);
    if (source_rows.length !== projected_rows.length) {
        throw new RangeError('source row mapping length does not match projected rows');
    }
    for (const row of source_rows) {
        if (!Number.isInteger(row) || row < 0 || row >= sheet.sourceRowCount) {
            throw new RangeError(
                `source row ${row} out of range (${sheet.sourceRowCount} rows)`,
            );
        }
    }
    return source_rows;
}

/** Map one canonical source row into the DataSource's projected row space. */
export function projected_row_for_source(
    source: DataSource,
    sheet_index: number,
    source_row: number,
): number | undefined {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) throw new RangeError(`sheet index ${sheet_index} out of range`);
    if (
        !Number.isInteger(source_row)
        || source_row < 0
        || source_row >= sheet.sourceRowCount
    ) return undefined;
    const projected = source.projected_row_index
        ? source.projected_row_index(sheet_index, source_row)
        : source_row < sheet.rowCount ? source_row : undefined;
    if (projected === undefined) return undefined;
    if (!Number.isInteger(projected) || projected < 0 || projected >= sheet.rowCount) {
        throw new RangeError(`projected row ${projected} out of range (${sheet.rowCount} rows)`);
    }
    return projected;
}

function validate_row_indices(
    source: DataSource,
    sheet_index: number,
    row_indices: ArrayLike<number>,
): SheetMeta {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) throw new RangeError(`sheet index ${sheet_index} out of range`);
    for (let position = 0; position < row_indices.length; position++) {
        const row = row_indices[position];
        if (!Number.isInteger(row) || row < 0 || row >= sheet.rowCount) {
            throw new RangeError(`row index ${row} out of range (${sheet.rowCount} rows)`);
        }
    }
    return sheet;
}

function validate_column_indices(
    sheet: SheetMeta,
    column_indices: ArrayLike<number>,
): void {
    for (let position = 0; position < column_indices.length; position++) {
        const column = column_indices[position];
        if (!Number.isInteger(column) || column < 0 || column >= sheet.columnCount) {
            throw new RangeError(
                `column index ${column} out of range (${sheet.columnCount} columns)`,
            );
        }
    }
}

const INDEXED_RUNS_PER_YIELD = 128;
const MAX_SYNC_RENDERED_ROWS_PER_READ = 4_096;
const MAX_SYNC_MATERIALIZED_CELLS_PER_READ = 65_536;

function max_sync_rows_per_read(column_count: number): number {
    return Math.min(
        MAX_SYNC_RENDERED_ROWS_PER_READ,
        Math.max(
            1,
            Math.floor(MAX_SYNC_MATERIALIZED_CELLS_PER_READ / column_count),
        ),
    );
}

async function yield_to_event_loop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

async function read_indexed_row_chunks_async<Cell>(
    row_indices: ArrayLike<number>,
    read_chunk: (rows: readonly number[]) => (Cell | null)[][],
    is_cancelled: () => boolean,
    max_rows_per_read: number,
): Promise<(Cell | null)[][]> {
    const rows: (Cell | null)[][] = [];
    let position = 0;
    while (position < row_indices.length) {
        if (is_cancelled()) throw new DOMException('Operation cancelled', 'AbortError');
        const count = Math.min(max_rows_per_read, row_indices.length - position);
        const requested = Array.from(
            { length: count },
            (_, offset) => row_indices[position + offset],
        );
        rows.push(...read_chunk(requested));
        position += count;
        if (position < row_indices.length) await yield_to_event_loop();
    }
    return rows;
}

async function read_row_range_chunks_async<Cell>(
    start_row: number,
    count: number,
    read_chunk: (start: number, count: number) => {
        startRow: number;
        rows: (Cell | null)[][];
    },
    is_cancelled: () => boolean,
    max_rows_per_read: number,
): Promise<{ startRow: number; rows: (Cell | null)[][] }> {
    if (count <= max_rows_per_read) return read_chunk(start_row, count);

    const rows: (Cell | null)[][] = [];
    let result_start = start_row;
    let position = 0;
    while (position < count) {
        if (is_cancelled()) throw new DOMException('Operation cancelled', 'AbortError');
        const chunk_count = Math.min(max_rows_per_read, count - position);
        const window = read_chunk(start_row + position, chunk_count);
        if (position === 0) result_start = window.startRow;
        rows.push(...window.rows);
        position += chunk_count;
        if (window.rows.length < chunk_count) break;
        if (position < count) await yield_to_event_loop();
    }
    if (is_cancelled()) throw new DOMException('Operation cancelled', 'AbortError');
    return { startRow: result_start, rows };
}

function read_adjacent_row_runs<Cell>(
    row_indices: ArrayLike<number>,
    read_run: (start: number, count: number) => (Cell | null)[][],
): (Cell | null)[][] {
    const rows: (Cell | null)[][] = [];
    let position = 0;
    while (position < row_indices.length) {
        const start = row_indices[position];
        let count = 1;
        while (
            position + count < row_indices.length
            && row_indices[position + count] === start + count
        ) count += 1;
        const run = read_run(start, count);
        for (let offset = 0; offset < count; offset++) rows.push(run[offset] ?? []);
        position += count;
    }
    return rows;
}

async function read_adjacent_row_runs_async<Cell>(
    row_indices: ArrayLike<number>,
    read_run: (start: number, count: number) => (Cell | null)[][],
    is_cancelled: () => boolean,
    max_rows_per_read: number,
): Promise<(Cell | null)[][]> {
    const rows: (Cell | null)[][] = [];
    let position = 0;
    let runs_since_yield = 0;
    while (position < row_indices.length) {
        if (is_cancelled()) throw new DOMException('Operation cancelled', 'AbortError');
        const start = row_indices[position];
        let count = 1;
        while (
            count < max_rows_per_read
            && position + count < row_indices.length
            && row_indices[position + count] === start + count
        ) count += 1;
        const run = read_run(start, count);
        for (let offset = 0; offset < count; offset++) rows.push(run[offset] ?? []);
        position += count;
        runs_since_yield += 1;
        if (
            position < row_indices.length
            && (
                count === max_rows_per_read
                || runs_since_yield >= INDEXED_RUNS_PER_YIELD
            )
        ) {
            runs_since_yield = 0;
            await yield_to_event_loop();
        }
    }
    return rows;
}

/** Read arbitrary rows in requested order. Legacy sources are read as adjacent
 * ascending runs: this may make several small read_rows calls, but never reads
 * across gaps merely to reduce the call count. */
export function read_source_rows_indexed(
    source: DataSource,
    sheet_index: number,
    row_indices: ArrayLike<number>,
): IndexedRows {
    validate_row_indices(source, sheet_index, row_indices);
    if (row_indices.length === 0) return { rows: [] };
    if (source.read_rows_indexed) {
        return source.read_rows_indexed(sheet_index, row_indices);
    }
    return {
        rows: read_adjacent_row_runs(
            row_indices,
            (start, count) => source.read_rows(sheet_index, start, count).rows,
        ),
    };
}

async function read_source_rows_indexed_validated_async(
    source: DataSource,
    sheet_index: number,
    row_indices: ArrayLike<number>,
    is_cancelled: () => boolean,
    max_sync_rows_per_read: number,
): Promise<IndexedRows> {
    if (row_indices.length === 0) return { rows: [] };
    const result = source.read_rows_indexed_async
        ? await source.read_rows_indexed_async(sheet_index, row_indices, is_cancelled)
        : source.read_rows_indexed
            ? {
                rows: await read_indexed_row_chunks_async(
                    row_indices,
                    (rows) => source.read_rows_indexed!(sheet_index, rows).rows,
                    is_cancelled,
                    max_sync_rows_per_read,
                ),
            }
            : {
                rows: await read_adjacent_row_runs_async(
                    row_indices,
                    (start, count) => source.read_rows(sheet_index, start, count).rows,
                    is_cancelled,
                    max_sync_rows_per_read,
                ),
            };
    if (is_cancelled()) throw new DOMException('Operation cancelled', 'AbortError');
    return result;
}

/** Prefer a source's cancellable rendered path. Legacy sources fall back to
 * bounded synchronous chunks with cancellation checkpoints between them. */
export async function read_source_rows_indexed_async(
    source: DataSource,
    sheet_index: number,
    row_indices: ArrayLike<number>,
    is_cancelled: () => boolean,
): Promise<IndexedRows> {
    if (is_cancelled()) throw new DOMException('Operation cancelled', 'AbortError');
    const sheet = validate_row_indices(source, sheet_index, row_indices);
    return read_source_rows_indexed_validated_async(
        source,
        sheet_index,
        row_indices,
        is_cancelled,
        max_sync_rows_per_read(sheet.columnCount),
    );
}

/** Read a compact column projection, falling back to full rows for legacy
 * DataSource implementations. Concrete built-in sources implement the
 * selective path so transforms do not materialize unrelated cells. */
export function read_source_columns(
    source: DataSource,
    sheet_index: number,
    start_row: number,
    count: number,
    column_indices: readonly number[],
): ColumnWindow {
    if (source.read_columns) {
        return source.read_columns(
            sheet_index,
            start_row,
            count,
            column_indices,
        );
    }
    const window = source.read_rows(sheet_index, start_row, count);
    return {
        startRow: window.startRow,
        rows: window.rows.map((row) => column_indices.map((column) => row[column] ?? null)),
    };
}

/** Read raw values for a compact column projection. Sources may bypass display
 * formatting; legacy implementations fall back to their fully rendered cells. */
export function read_source_raw_columns(
    source: DataSource,
    sheet_index: number,
    start_row: number,
    count: number,
    column_indices: readonly number[],
): RawColumnWindow {
    if (source.read_raw_columns) {
        return source.read_raw_columns(
            sheet_index,
            start_row,
            count,
            column_indices,
        );
    }
    const window = read_source_columns(
        source,
        sheet_index,
        start_row,
        count,
        column_indices,
    );
    return window;
}

/** Prefer a source's cancellable lazy-decode path. Synchronous compatibility
 * readers are split by both row and materialized-cell work. */
export async function read_source_raw_columns_async(
    source: DataSource,
    sheet_index: number,
    start_row: number,
    count: number,
    column_indices: readonly number[],
    is_cancelled: () => boolean,
): Promise<RawColumnWindow> {
    if (source.read_raw_columns_async) {
        return source.read_raw_columns_async(
            sheet_index,
            start_row,
            count,
            column_indices,
            is_cancelled,
        );
    }

    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) throw new RangeError(`sheet index ${sheet_index} out of range`);
    const materialized_columns = source.read_raw_columns || source.read_columns
        ? column_indices.length
        : sheet.columnCount;
    return read_row_range_chunks_async(
        start_row,
        count,
        (start, chunk_count) => read_source_raw_columns(
            source,
            sheet_index,
            start,
            chunk_count,
            column_indices,
        ),
        is_cancelled,
        max_sync_rows_per_read(materialized_columns),
    );
}

/** Read full rows as raw values while preserving each source row's width. */
export function read_source_raw_rows(
    source: DataSource,
    sheet_index: number,
    start_row: number,
    count: number,
): RawColumnWindow {
    if (source.read_raw_columns) {
        const sheet = source.meta().sheets[sheet_index];
        if (!sheet) throw new RangeError(`sheet index ${sheet_index} out of range`);
        return source.read_raw_columns(
            sheet_index,
            start_row,
            count,
            Array.from({ length: sheet.columnCount }, (_, index) => index),
        );
    }
    const window = source.read_rows(sheet_index, start_row, count);
    return window;
}

export async function read_source_raw_rows_async(
    source: DataSource,
    sheet_index: number,
    start_row: number,
    count: number,
    is_cancelled: () => boolean,
): Promise<RawColumnWindow> {
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) throw new RangeError(`sheet index ${sheet_index} out of range`);
    if (source.read_raw_columns_async) {
        return source.read_raw_columns_async(
            sheet_index,
            start_row,
            count,
            Array.from({ length: sheet.columnCount }, (_, index) => index),
            is_cancelled,
        );
    }
    return read_row_range_chunks_async(
        start_row,
        count,
        (start, chunk_count) => read_source_raw_rows(
            source,
            sheet_index,
            start,
            chunk_count,
        ),
        is_cancelled,
        max_sync_rows_per_read(sheet.columnCount),
    );
}

/** Read arbitrary rows as raw values. Adjacent requested rows share one range
 * read; sparse gaps and repeated rows retain the indexed-reader semantics. */
export function read_source_raw_rows_indexed(
    source: DataSource,
    sheet_index: number,
    row_indices: ArrayLike<number>,
): { rows: (RawCell | null)[][] } {
    validate_row_indices(source, sheet_index, row_indices);
    if (row_indices.length === 0) return { rows: [] };
    if (!source.read_raw_columns) {
        return read_source_rows_indexed(source, sheet_index, row_indices);
    }
    const requested = Array.from(row_indices);
    const materialized = new Map<number, (RawCell | null)[]>();
    const unique = [...new Set(requested)].sort((a, b) => a - b);
    const rows = read_adjacent_row_runs(
        unique,
        (start, count) => read_source_raw_rows(
            source,
            sheet_index,
            start,
            count,
        ).rows,
    );
    unique.forEach((row, index) => materialized.set(row, rows[index]));
    return { rows: requested.map((row) => materialized.get(row)!) };
}

/** Read arbitrary rows and columns while preserving both requested dimensions.
 * Native sparse sources receive one complete request. The compatibility path
 * bounds synchronous adjacent-run chunks and restores duplicate/reordered rows. */
export async function read_source_raw_columns_indexed_async(
    source: DataSource,
    sheet_index: number,
    row_indices: ArrayLike<number>,
    column_indices: readonly number[],
    is_cancelled: () => boolean,
): Promise<IndexedRawColumns> {
    if (is_cancelled()) throw new DOMException('Operation cancelled', 'AbortError');
    const sheet = validate_row_indices(source, sheet_index, row_indices);
    validate_column_indices(sheet, column_indices);
    if (row_indices.length === 0) return { rows: [] };
    if (column_indices.length === 0) {
        return { rows: Array.from({ length: row_indices.length }, () => []) };
    }
    if (source.read_raw_columns_indexed_async) {
        const result = await source.read_raw_columns_indexed_async(
            sheet_index,
            row_indices,
            column_indices,
            is_cancelled,
        );
        if (is_cancelled()) throw new DOMException('Operation cancelled', 'AbortError');
        return result;
    }

    const requested = Array.from(row_indices);
    const materialized = new Map<number, (RawCell | null)[]>();
    const unique = [...new Set(requested)].sort((a, b) => a - b);
    const synchronous_columns_per_row = source.read_raw_columns || source.read_columns
        ? column_indices.length
        : sheet.columnCount;
    const max_rows_per_read = source.read_raw_columns_async
        ? Number.POSITIVE_INFINITY
        : max_sync_rows_per_read(synchronous_columns_per_row);
    let position = 0;
    let runs_since_yield = 0;
    while (position < unique.length) {
        if (is_cancelled()) throw new DOMException('Operation cancelled', 'AbortError');
        const start = unique[position];
        let count = 1;
        while (
            count < max_rows_per_read
            && position + count < unique.length
            && unique[position + count] === start + count
        ) count += 1;
        const rows = (await read_source_raw_columns_async(
            source,
            sheet_index,
            start,
            count,
            column_indices,
            is_cancelled,
        )).rows;
        for (let offset = 0; offset < count; offset++) {
            materialized.set(start + offset, rows[offset] ?? []);
        }
        position += count;
        runs_since_yield += 1;
        if (
            position < unique.length
            && (
                count === max_rows_per_read
                || runs_since_yield >= INDEXED_RUNS_PER_YIELD
            )
        ) {
            runs_since_yield = 0;
            await yield_to_event_loop();
        }
    }
    if (is_cancelled()) throw new DOMException('Operation cancelled', 'AbortError');
    return { rows: requested.map((row) => materialized.get(row)!) };
}

export async function read_source_raw_rows_indexed_async(
    source: DataSource,
    sheet_index: number,
    row_indices: ArrayLike<number>,
    is_cancelled: () => boolean,
): Promise<IndexedRawColumns> {
    if (
        !source.read_raw_columns_indexed_async
        && !source.read_raw_columns_async
        && !source.read_raw_columns
    ) {
        if (is_cancelled()) throw new DOMException('Operation cancelled', 'AbortError');
        const sheet = validate_row_indices(source, sheet_index, row_indices);
        return read_source_rows_indexed_validated_async(
            source,
            sheet_index,
            row_indices,
            is_cancelled,
            max_sync_rows_per_read(sheet.columnCount),
        );
    }
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) throw new RangeError(`sheet index ${sheet_index} out of range`);
    return read_source_raw_columns_indexed_async(
        source,
        sheet_index,
        row_indices,
        Array.from({ length: sheet.columnCount }, (_, index) => index),
        is_cancelled,
    );
}
