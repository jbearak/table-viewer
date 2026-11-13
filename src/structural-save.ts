// Structural save (row and column structure design, delivery step 5): the
// host's pure pieces of saving a Worksheet Layout.
//
//   - The prefix-growth test that lets rows appended on disk join a layout
//     instead of conflicting. The basis itself is computed in one place,
//     `current_structural_basis` in `structural-editing-capability.ts`, from
//     `content_digest`, so the basis the webview records at delete time is the
//     one Save and refresh check.
//   - The **receipt** entry for one restructured worksheet, built from the
//     layout's save maps.
//   - The **rekey** of durable view state after the write (or on recovery):
//     cell highlights, row heights, hidden rows, column widths, column
//     visibility, sort keys, filters, and the transform schema, moved from old
//     source coordinates to new ones in one pure transition.
//   - The **shape hint** for an unresolved rekey intent: whether the file's
//     row and column counts agree with what the save would have written.
//
// The controller owns sequencing (persist, plan, intent, stat, write,
// post-write transition, recovery); this module owns only what each step
// computes, so every step is testable without a filesystem.
import { content_digest } from './content-digest';
import {
    appended_rows,
    inserted_rows,
    own_pending_structural_changes,
    type PendingColumn,
    type PendingStructuralChanges,
    type StructuralBasis,
} from './pending-changes';
import {
    append_source_rows_to_layout,
    column_save_map,
    index_column_layout,
    row_save_map,
    source_row_layout,
    type ColumnLayout,
    type RowLayout,
} from './worksheet-layout';
import {
    rebase_cell_highlight_digest,
} from './cell-highlights';
import { parse_cell_key, cell_key } from './cell-key';
import type { SheetMeta } from './data-source/interface';
import { CsvDataSource } from './data-source/csv-source';
import { split_csv_raw_fields } from './data-source/line-index';
import { get_raw_cell_text } from './cell-display';
import {
    pending_changes_for_sheet,
    transform_schema_for_sheet,
    with_pending_changes_for_sheet,
    worksheet_target_index,
    worksheet_target_matches,
    type StructuralRekeyIntent,
    type CellHighlightColor,
    type PendingChangesSaveReceipt,
    type PerFileState,
    type SheetTransformState,
    type WorksheetIdentity,
    type WorksheetIdentityInput,
    type WorksheetStructureReceipt,
    type WorksheetTarget,
} from './types';

// ---------------------------------------------------------------------------
// Structural Basis
// ---------------------------------------------------------------------------

export function structural_bases_equal(
    left: StructuralBasis | undefined,
    right: StructuralBasis | undefined,
): boolean {
    return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;

/**
 * Whether `bytes` end with a record terminator outside any quoted field, read
 * with the same quote rules as `build_line_index`: a `"` opens a quoted field
 * only at a field start, `""` inside one is an escaped quote, and a lone `"`
 * closes it.
 */
export function ends_with_unquoted_record_terminator(bytes: Uint8Array, delimiter: ',' | '\t'): boolean {
    const separator = delimiter.charCodeAt(0);
    let in_quotes = false;
    let field_start = true;
    // A leading UTF-8 BOM is not content: `CsvDataSource` strips it before its
    // own scan, so a `"` right after it opens a quoted field.
    const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    for (let index = start; index < bytes.length; index++) {
        const byte = bytes[index];
        if (in_quotes) {
            if (byte === QUOTE) {
                if (index + 1 < bytes.length && bytes[index + 1] === QUOTE) {
                    index++;
                    continue;
                }
                in_quotes = false;
            }
            continue;
        }
        if (byte === QUOTE && field_start) {
            in_quotes = true;
            field_start = false;
            continue;
        }
        field_start = byte === separator || byte === LF || byte === CR;
    }
    const last = bytes[bytes.length - 1];
    return !in_quotes && (last === LF || last === CR);
}

/** What the prefix-growth test reads of a parsed delimited file. */
export interface DelimitedRecords {
    readonly sourceRowCount: number;
    readonly columnCount: number;
    readonly headerLine: string | undefined;
    /** Raw field text of `count` body rows from `start`. */
    read(start: number, count: number): readonly (readonly string[])[];
}

/**
 * Whether a CSV or TSV file grew only by records appended after the content a
 * Structural Basis recorded ("External changes", step 2): the new file is
 * longer and its first `byteLength` bytes have the recorded digest; that
 * prefix ended with a record terminator outside any quoted field; the parser
 * yields exactly the old records first; and the column count and header are
 * unchanged. `parse` builds the records of a byte range with the viewer's own
 * parser.
 */
export function is_delimited_prefix_growth(
    basis: Extract<StructuralBasis, { kind: 'delimited' }>,
    bytes: Uint8Array,
    delimiter: ',' | '\t',
    parse: (bytes: Uint8Array) => DelimitedRecords,
    window = 10_000,
): boolean {
    if (bytes.byteLength <= basis.byteLength) return false;
    const prefix = bytes.subarray(0, basis.byteLength);
    if (content_digest(prefix) !== basis.digest) return false;
    if (!ends_with_unquoted_record_terminator(prefix, delimiter)) return false;
    const before = parse(prefix);
    const after = parse(bytes);
    if (
        before.sourceRowCount !== basis.sourceRowCount
        || before.columnCount !== basis.sourceColumnCount
        || after.columnCount !== before.columnCount
        || after.headerLine !== before.headerLine
        || after.sourceRowCount <= before.sourceRowCount
    ) return false;
    for (let start = 0; start < before.sourceRowCount; start += window) {
        const count = Math.min(window, before.sourceRowCount - start);
        const old_rows = before.read(start, count);
        const new_rows = after.read(start, count);
        if (old_rows.length !== count || new_rows.length !== count) return false;
        for (let offset = 0; offset < count; offset++) {
            const left = old_rows[offset]!;
            const right = new_rows[offset]!;
            if (left.length !== right.length || left.some((field, column) => field !== right[column])) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Parse delimited bytes the way the viewer opens them (first row as header,
 * no row limit) for the prefix-growth test. Fields are raw text, cut to each
 * record's own field count so `a` and `a,` stay different records.
 */
export function delimited_records_of(bytes: Uint8Array, delimiter: ',' | '\t'): DelimitedRecords {
    const source = new CsvDataSource(bytes, delimiter, Number.MAX_SAFE_INTEGER, { firstRowIsHeader: true });
    const sheet = source.meta().sheets[0]!;
    return {
        sourceRowCount: sheet.sourceRowCount,
        columnCount: sheet.columnCount,
        headerLine: source.headerLine,
        read(start, count) {
            return source.read_rows(0, start, count).rows.map((row, offset) => row
                .slice(0, source.originalColumnCounts[start + offset] ?? row.length)
                .map((cell) => get_raw_cell_text(cell?.raw ?? null)));
        },
    };
}

/** Rows appended on disk join a layout the way saved appends do. */
export const rebase_row_layout_on_growth = append_source_rows_to_layout;

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

export interface WorksheetStructureContext {
    /** First body source row: the Header Row's 1-based number, or 0 without one. */
    readonly bodyStart: number;
    /** Canonical source row count; the body is `[bodyStart, sourceRowCount)`. */
    readonly sourceRowCount: number;
    readonly sourceColumnCount: number;
}

/**
 * The receipt entry for one restructured worksheet, from the layout's save
 * maps: new rows are `bodyStart + bodyIndex`, columns are 0-based, and the
 * column map is the identity while the column layout is the source layout.
 */
export function worksheet_structure_receipt(
    target: WorksheetTarget,
    changes: Pick<PendingStructuralChanges, 'rowLayout' | 'columnLayout'>,
    context: WorksheetStructureContext,
): WorksheetStructureReceipt {
    const body_rows = Math.max(0, context.sourceRowCount - context.bodyStart);
    const rows = row_save_map(changes.rowLayout ?? source_row_layout(context.bodyStart, body_rows));
    const columns = changes.columnLayout === undefined
        ? {
            columnMap: Array.from({ length: context.sourceColumnCount }, (_, column) => column),
            insertedColumns: [],
        }
        : column_save_map(changes.columnLayout);
    return Object.freeze({
        sheetIndex: target.sheetIndex,
        ...(target.sheetName === undefined ? {} : { sheetName: target.sheetName }),
        ...(target.worksheetId === undefined ? {} : { worksheetId: target.worksheetId }),
        rowRuns: Object.freeze(rows.rowRuns.map((run) => Object.freeze({
            from: run.sourceRow,
            count: run.count,
            to: context.bodyStart + run.bodyIndex,
        }))),
        removedRows: Object.freeze(rows.removedRows.map((run) => Object.freeze({
            start: run.start,
            count: run.count,
        }))),
        columnMap: Object.freeze([...columns.columnMap]),
        insertedRows: Object.freeze(rows.insertedRows.map((row) => Object.freeze({
            pendingRowId: row.pendingRowId,
            sourceRow: context.bodyStart + row.bodyIndex,
        }))),
        insertedColumns: Object.freeze(columns.insertedColumns.map((column) => Object.freeze({
            pendingColumnId: column.pendingColumnId,
            column: column.column,
        }))),
    });
}

// ---------------------------------------------------------------------------
// Delimited columns
// ---------------------------------------------------------------------------

/** One live column of a delimited save, in prospective order. */
export type DelimitedLiveColumn =
    | { readonly kind: 'source'; readonly sourceColumn: number }
    | { readonly kind: 'pending'; readonly column: PendingColumn };

/**
 * How a CSV/TSV save writes records under a column layout with a live change
 * ("CSV and TSV"): every record at the prospective width, in live column
 * order, removed columns dropped and Pending Column values taken from the
 * Pending Column; the header line rewritten from its raw fields, so an
 * untouched header field keeps its exact source bytes, quoting included.
 */
export interface DelimitedColumnWriter {
    readonly liveColumns: readonly DelimitedLiveColumn[];
    /** The rewritten header record, without its terminator. */
    header(raw_header_line: string): string;
    /** The live values of one record, given each source column's value. */
    record(row_key: string, source_value: (source_column: number) => string): string[];
}

function quote_delimited_field(value: string, delimiter: ',' | '\t'): string {
    return value.includes(delimiter) || value.includes('\n') || value.includes('\r') || value.includes('"')
        ? `"${value.replace(/"/g, '""')}"`
        : value;
}

/**
 * The writer for a delimited worksheet whose column layout has a live change.
 * Pending Column cells are keyed by row identity (`s:<row>` for a source row,
 * `p:<id>` for a Pending Row); a delimited body starts at row 0, so no fixed
 * row exists. Delimited cells hold text only.
 */
export function delimited_column_writer(
    layout: ColumnLayout,
    pending_columns: readonly PendingColumn[],
    delimiter: ',' | '\t',
): DelimitedColumnWriter {
    const index = index_column_layout(layout);
    const by_id = new Map(pending_columns.map((column) => [column.id, column]));
    const liveColumns: DelimitedLiveColumn[] = [];
    for (const segment of index.segments) {
        if (segment.status !== 'live') continue;
        if (segment.kind === 'source') {
            for (let offset = 0; offset < segment.count; offset++) {
                liveColumns.push(Object.freeze({ kind: 'source', sourceColumn: segment.start + offset }));
            }
            continue;
        }
        const column = by_id.get(segment.id);
        if (column === undefined) throw new Error('A live Pending Column has no content.');
        for (const cell of Object.values(column.cells)) {
            if (cell.valueRuns !== undefined || cell.link || cell.formulaAnchors !== undefined) {
                throw new Error('Delimited Pending Columns cannot contain rich text, hyperlinks, or formula anchors.');
            }
        }
        liveColumns.push(Object.freeze({ kind: 'pending', column }));
    }
    Object.freeze(liveColumns);
    return Object.freeze({
        liveColumns,
        header(raw_header_line: string): string {
            const raw = split_csv_raw_fields(raw_header_line, delimiter);
            return liveColumns.map((live) => live.kind === 'source'
                ? raw[live.sourceColumn] ?? ''
                : quote_delimited_field(live.column.header, delimiter)).join(delimiter);
        },
        record(row_key: string, source_value: (source_column: number) => string): string[] {
            return liveColumns.map((live) => live.kind === 'source'
                ? source_value(live.sourceColumn)
                : live.column.cells[row_key]?.value ?? '');
        },
    });
}

/** Rows after the body's live rows, per the receipt: `H + N`, where the append band starts. */
export function structure_live_row_end(entry: WorksheetStructureReceipt, body_start: number): number {
    let live = entry.insertedRows.length;
    for (const run of entry.rowRuns) live += run.count;
    return body_start + live;
}

/**
 * Map an old canonical source row through a structure entry. Rows before the
 * body map to themselves; removed rows and rows past the old body map to null.
 */
export function structure_row_mapper(entry: WorksheetStructureReceipt): (row: number) => number | null {
    const runs = [...entry.rowRuns].sort((left, right) => left.from - right.from);
    const removed = entry.removedRows;
    let body_start = Infinity;
    let body_end = -Infinity;
    for (const run of runs) {
        body_start = Math.min(body_start, run.from);
        body_end = Math.max(body_end, run.from + run.count);
    }
    for (const run of removed) {
        body_start = Math.min(body_start, run.start);
        body_end = Math.max(body_end, run.start + run.count);
    }
    return (row) => {
        if (!(row >= body_start)) return row;
        if (row >= body_end) return null;
        let low = 0;
        let high = runs.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const run = runs[middle]!;
            if (row < run.from) high = middle - 1;
            else if (row >= run.from + run.count) low = middle + 1;
            else return run.to + (row - run.from);
        }
        return null;
    };
}

/** The first body row of a structure entry, old and new alike (fixed rows never move). */
function structure_body_start(entry: WorksheetStructureReceipt): number | undefined {
    let start: number | undefined;
    for (const run of entry.rowRuns) start = Math.min(start ?? run.from, run.from, run.to);
    for (const run of entry.removedRows) start = Math.min(start ?? run.start, run.start);
    for (const row of entry.insertedRows) start = Math.min(start ?? row.sourceRow, row.sourceRow);
    return start;
}

// ---------------------------------------------------------------------------
// Rekey
// ---------------------------------------------------------------------------

export interface StructuralRekeyOptions {
    /** The workbook's worksheets, to resolve receipt targets to positional slots. */
    readonly sheets: readonly WorksheetIdentityInput[];
    /** Digest of the bytes the save wrote; highlights are rebased onto it. */
    readonly afterDigest: string;
    /**
     * The transform schema of a restructured worksheet as it is after the save,
     * so rekeyed sorts, filters, and visibility survive the reload.
     */
    readonly schemaAfter: (sheet_index: number) => string | undefined;
    /** The accepted payload of a saved worksheet, for Pending Row and Column state. */
    readonly payload: (target: WorksheetTarget) => PendingStructuralChanges | undefined;
    /** Column name for an announcement, by old source column. */
    readonly columnName?: (sheet_index: number, column: number) => string | undefined;
}

export interface StructuralRekeyResult {
    readonly state: PerFileState;
    /** Toolbar announcements for sorts and filters dropped on removed columns. */
    readonly announcements: readonly string[];
}

function sheet_slot<T>(values: readonly (T | undefined)[] | undefined, index: number): T | undefined {
    return values?.[index];
}

function with_slot<T>(
    values: readonly (T | undefined)[] | undefined,
    index: number,
    value: T | undefined,
): (T | undefined)[] {
    const next = [...(values ?? [])];
    while (next.length <= index) next.push(undefined);
    next[index] = value;
    return next;
}

function remap_number_record(
    record: Readonly<Record<number, number>> | undefined,
    map: (key: number) => number | null,
): Record<number, number> {
    const next: Record<number, number> = {};
    for (const [key, value] of Object.entries(record ?? {})) {
        const mapped = map(Number(key));
        if (mapped !== null) next[mapped] = value;
    }
    return next;
}

function column_mapper(entry: WorksheetStructureReceipt | undefined): (column: number) => number | null {
    if (entry === undefined) return (column) => column;
    return (column) => column < entry.columnMap.length ? entry.columnMap[column] ?? null : column;
}

/**
 * Apply a save receipt to durable view state: the post-write rekey and the
 * recovery's "It finished". Structurally saved worksheets have every
 * source-keyed annotation moved through their row and column maps, dropping
 * removed rows and columns and adding Pending Row and Pending Column state at
 * their new coordinates. Every worksheet in the receipt has its tail removals
 * dropped and its appended rows' highlights and heights placed, as the
 * append-only post-write rebase does. Highlights are rebased onto the written
 * digest.
 */
export function apply_structural_rekey(
    state: PerFileState,
    receipt: PendingChangesSaveReceipt,
    options: StructuralRekeyOptions,
): StructuralRekeyResult {
    const announcements: string[] = [];
    let highlights = rebase_cell_highlight_digest(state.cellHighlights, options.afterDigest);
    let rowHeights = state.rowHeights;
    let columnWidths = state.columnWidths;
    let transforms = state.transforms;
    let columnVisibility = state.columnVisibility;

    const touched = new Map<number, WorksheetTarget>();
    for (const entry of [
        ...(receipt.structure ?? []),
        ...receipt.appendedRows,
        ...receipt.removedSourceRows,
    ]) {
        const index = worksheet_target_index(options.sheets, entry);
        if (index !== undefined && !touched.has(index)) touched.set(index, entry);
    }

    for (const [sheet_index, target] of touched) {
        const entry = receipt.structure?.find((candidate) => worksheet_target_matches(candidate, target)
            || worksheet_target_matches(target, candidate));
        const tail = new Set(receipt.removedSourceRows
            .filter((candidate) => worksheet_target_index(options.sheets, candidate) === sheet_index)
            .flatMap((candidate) => candidate.sourceRows));
        const structural_row = entry === undefined ? undefined : structure_row_mapper(entry);
        const map_row = (row: number): number | null => tail.has(row)
            ? null
            : structural_row === undefined ? row : structural_row(row);
        const map_column = column_mapper(entry);
        const payload = options.payload(target);
        const assignments = receipt.appendedRows.filter((assignment) =>
            worksheet_target_index(options.sheets, assignment) === sheet_index);

        // Cell highlights.
        const sheet_highlights = highlights?.sheets[sheet_index];
        const cells: Record<string, CellHighlightColor> = {};
        if (sheet_highlights !== undefined) {
            for (const [key, color] of Object.entries(sheet_highlights.cells)) {
                const coordinate = parse_cell_key(key);
                if (coordinate === undefined) continue;
                const row = map_row(coordinate.sourceRow);
                const column = map_column(coordinate.sourceColumn);
                if (row !== null && column !== null) cells[cell_key(row, column)] = color;
            }
        }
        const heights = entry === undefined && tail.size === 0
            ? { ...(sheet_slot(rowHeights, sheet_index) ?? {}) }
            : remap_number_record(sheet_slot(rowHeights, sheet_index), map_row);
        const inserted = new Map(inserted_rows(payload).map((row) => [row.id, row]));
        for (const placed of entry?.insertedRows ?? []) {
            const row = inserted.get(placed.pendingRowId);
            if (row === undefined) continue;
            for (const [column, color] of Object.entries(row.highlights ?? {})) {
                const mapped = map_column(Number(column));
                if (mapped !== null) cells[cell_key(placed.sourceRow, mapped)] = color;
            }
            const template = payload?.formatTemplates.find((candidate) => candidate.id === row.formatTemplateId);
            const height = row.viewerRowHeight
                ?? (template?.format.kind === 'xlsx' ? template.format.viewerRowHeight : undefined);
            if (height !== undefined) heights[placed.sourceRow] = height;
        }
        const appended = new Map(appended_rows(payload).map((row) => [row.id, row]));
        for (const assignment of assignments) {
            const row = appended.get(assignment.pendingRowId);
            const row_highlights = assignment.savedRow?.highlights ?? row?.highlights ?? {};
            for (const [column, color] of Object.entries(row_highlights)) {
                const mapped = map_column(Number(column));
                if (mapped !== null) cells[cell_key(assignment.sourceRow, mapped)] = color;
            }
            const template = payload?.formatTemplates.find((candidate) => candidate.id === row?.formatTemplateId);
            const height = assignment.savedRow?.viewerRowHeight
                ?? row?.viewerRowHeight
                ?? (template?.format.kind === 'xlsx' ? template.format.viewerRowHeight : undefined);
            if (height !== undefined) heights[assignment.sourceRow] = height;
        }
        const pending_columns = new Map((payload?.pendingColumns ?? []).map((column) => [column.id, column]));
        for (const placed of entry?.insertedColumns ?? []) {
            const column = pending_columns.get(placed.pendingColumnId);
            if (column === undefined) continue;
            for (const [key, color] of Object.entries(column.highlights ?? {})) {
                const row = pending_column_cell_row(key, map_row, entry!, sheet_index);
                if (row !== null) cells[cell_key(row, placed.column)] = color;
            }
        }
        const schema_after = entry === undefined ? undefined : options.schemaAfter(sheet_index);
        if (highlights !== undefined || Object.keys(cells).length > 0) {
            const schema = schema_after ?? sheet_highlights?.schema;
            if (schema !== undefined) {
                const sheets = [...(highlights?.sheets ?? [])];
                while (sheets.length <= sheet_index) sheets.push(undefined);
                sheets[sheet_index] = Object.keys(cells).length > 0 ? { schema, cells } : undefined;
                highlights = { sourceDigest: options.afterDigest, sheets };
            }
        }
        rowHeights = with_slot(rowHeights, sheet_index, Object.keys(heights).length > 0 ? heights : undefined);

        if (entry === undefined) continue;

        // Column widths, with Pending Column widths at their new columns.
        const widths = remap_number_record(sheet_slot(columnWidths, sheet_index), map_column);
        for (const placed of entry.insertedColumns) {
            const width = pending_columns.get(placed.pendingColumnId)?.viewerWidth;
            if (width !== undefined) widths[placed.column] = width;
        }
        if (sheet_slot(columnWidths, sheet_index) !== undefined || Object.keys(widths).length > 0) {
            columnWidths = with_slot(columnWidths, sheet_index, Object.keys(widths).length > 0 ? widths : undefined);
        }

        // Hidden rows, sorts, filters, and the transform schema.
        const transform = sheet_slot(transforms, sheet_index);
        if (transform !== undefined) {
            const name = (column: number) => options.columnName?.(sheet_index, column) ?? `column ${column + 1}`;
            const sort = transform.sort.flatMap((key) => {
                const column = map_column(key.colIndex);
                if (column === null) {
                    announcements.push(`Removed the sort on ${name(key.colIndex)} because the column was deleted.`);
                    return [];
                }
                return [{ ...key, colIndex: column }];
            });
            const filters = transform.filters.flatMap((filter) => {
                const column = map_column(filter.colIndex);
                if (column === null) {
                    announcements.push(`Removed the filter on ${name(filter.colIndex)} because the column was deleted.`);
                    return [];
                }
                return [{ ...filter, colIndex: column }];
            });
            const hidden = transform.hiddenRows === undefined
                ? undefined
                : [...new Set(transform.hiddenRows.flatMap((row) => {
                    const mapped = map_row(row);
                    return mapped === null ? [] : [mapped];
                }))].sort((left, right) => left - right);
            const next: SheetTransformState = {
                ...transform,
                sort,
                filters,
                ...(hidden === undefined ? {} : { hiddenRows: hidden }),
                ...(schema_after === undefined || transform.schema === undefined ? {} : { schema: schema_after }),
            };
            transforms = with_slot(transforms, sheet_index, next);
        }

        // Column visibility.
        const visibility = sheet_slot(columnVisibility, sheet_index);
        if (visibility !== undefined) {
            const remap = (columns: readonly number[] | undefined) => columns === undefined
                ? undefined
                : [...new Set(columns.flatMap((column) => {
                    const mapped = map_column(column);
                    return mapped === null ? [] : [mapped];
                }))].sort((left, right) => left - right);
            const visible = remap(visibility.visibleColumns);
            columnVisibility = with_slot(columnVisibility, sheet_index, {
                ...visibility,
                ...(visibility.hiddenColumns === undefined ? {} : { hiddenColumns: remap(visibility.hiddenColumns) }),
                // A visible-columns list names what to show; a new column is shown.
                ...(visible === undefined ? {} : {
                    visibleColumns: [...new Set([
                        ...visible,
                        ...entry.insertedColumns.map((column) => column.column),
                    ])].sort((left, right) => left - right),
                }),
                ...(schema_after === undefined || visibility.schema === undefined ? {} : { schema: schema_after }),
            });
        }
    }

    return {
        state: {
            ...state,
            ...(highlights === undefined ? {} : { cellHighlights: highlights }),
            ...(rowHeights === undefined ? {} : { rowHeights }),
            ...(columnWidths === undefined ? {} : { columnWidths }),
            ...(transforms === undefined ? {} : { transforms }),
            ...(columnVisibility === undefined ? {} : { columnVisibility }),
        },
        announcements: Object.freeze(announcements),
    };
}

/** A Pending Column cell key (`s:`, `p:`, `f:`) mapped to its new canonical row. */
function pending_column_cell_row(
    key: string,
    map_row: (row: number) => number | null,
    entry: WorksheetStructureReceipt,
    _sheet_index: number,
): number | null {
    const separator = key.indexOf(':');
    const kind = key.slice(0, separator);
    const rest = key.slice(separator + 1);
    if (kind === 's') return map_row(Number(rest));
    if (kind === 'f') return Number(rest);
    return entry.insertedRows.find((row) => row.pendingRowId === rest)?.sourceRow ?? null;
}

// ---------------------------------------------------------------------------
// Recovery hint
// ---------------------------------------------------------------------------

/**
 * Whether the file's worksheets have the shape the receipt says the save
 * wrote: per restructured worksheet, the canonical row count (live body rows
 * plus that worksheet's appended rows) and the column count, and the headers
 * of inserted columns where the payload names them. Used only to choose the
 * default action of an unresolved intent.
 */
export function structural_receipt_shape_matches(
    receipt: PendingChangesSaveReceipt,
    sheets: readonly (WorksheetIdentity & Pick<SheetMeta, 'sourceRowCount' | 'columnCount' | 'columnNames'>)[],
    payload: (target: WorksheetTarget) => PendingStructuralChanges | undefined,
): boolean {
    for (const entry of receipt.structure ?? []) {
        const index = worksheet_target_index(sheets, entry);
        const sheet = index === undefined ? undefined : sheets[index];
        if (sheet === undefined) return false;
        const body_start = structure_body_start(entry) ?? 0;
        const appended = receipt.appendedRows.filter((assignment) =>
            worksheet_target_index(sheets, assignment) === index).length;
        if (sheet.sourceRowCount !== structure_live_row_end(entry, body_start) + appended) return false;
        const columns = entry.columnMap.filter((column) => column !== null).length + entry.insertedColumns.length;
        if (sheet.columnCount !== columns) return false;
        const pending = new Map((payload(entry)?.pendingColumns ?? []).map((column) => [column.id, column]));
        for (const placed of entry.insertedColumns) {
            const header = pending.get(placed.pendingColumnId)?.header;
            if (header !== undefined && sheet.columnNames !== undefined
                && sheet.columnNames[placed.column] !== header) return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Rekey intent transitions
// ---------------------------------------------------------------------------

/**
 * Prefix of the sheet name a retired payload is parked under when the user
 * says an unresolved save finished. Square brackets cannot appear in an Excel
 * worksheet name and CSV's one worksheet is `Sheet1`, so a parked slot never
 * resolves to a worksheet; the existing parked-slot rules keep it durable and
 * out of every projection until the next successful save drops it.
 */
export const PARKED_STRUCTURAL_PAYLOAD_PREFIX = '[Unconfirmed save] ';

export function is_parked_structural_payload(slot: { readonly sheetName?: string } | undefined): boolean {
    return slot?.sheetName?.startsWith(PARKED_STRUCTURAL_PAYLOAD_PREFIX) === true;
}

/** The stored Pending Changes of one worksheet of `state`, owned, or undefined. */
export function structural_payload_for(
    state: PerFileState,
    sheets: readonly WorksheetIdentityInput[],
    target: WorksheetTarget,
): PendingStructuralChanges | undefined {
    const index = worksheet_target_index(sheets, target) ?? target.sheetIndex;
    const slot = pending_changes_for_sheet(state.pendingEdits, index, target.sheetName, target.worksheetId);
    return slot === undefined ? undefined : own_pending_structural_changes(slot);
}

/**
 * The transform schema a restructured worksheet will have once the file is
 * reread: the sheet's own schema with its column names moved through the
 * column map and Pending Column headers placed at their new columns.
 */
export function prospective_transform_schema(
    sheet: Pick<SheetMeta, 'name' | 'columnCount' | 'columnNames'>,
    entry: WorksheetStructureReceipt,
    payload: PendingStructuralChanges | undefined,
): string {
    const identity = entry.insertedColumns.length === 0
        && entry.columnMap.length === sheet.columnCount
        && entry.columnMap.every((column, index) => column === index);
    if (identity) return transform_schema_for_sheet(sheet as SheetMeta);
    const count = entry.columnMap.filter((column) => column !== null).length + entry.insertedColumns.length;
    let names: string[] | undefined;
    if (sheet.columnNames !== undefined) {
        names = new Array<string>(count).fill('');
        entry.columnMap.forEach((column, source) => {
            if (column !== null) names![column] = sheet.columnNames?.[source] ?? '';
        });
        const headers = new Map((payload?.pendingColumns ?? []).map((column) => [column.id, column.header]));
        for (const placed of entry.insertedColumns) names[placed.column] = headers.get(placed.pendingColumnId) ?? '';
    }
    return transform_schema_for_sheet({
        ...sheet,
        columnCount: count,
        columnNames: names,
    } as SheetMeta);
}

export interface StructuralRekeyTransitionOptions {
    /** Whether a listed worksheet's stored payload is still the accepted one. */
    readonly retire: (worksheet: StructuralRekeyIntent['worksheets'][number]) => boolean;
    /** Park, rather than delete, a retired payload ("It finished" on an unresolved intent). */
    readonly park?: boolean;
    readonly schemaAfter: StructuralRekeyOptions['schemaAfter'];
    readonly columnName?: StructuralRekeyOptions['columnName'];
}

/**
 * The post-write transition, and recovery's "It finished": apply the intent's
 * rekey, retire the accepted payload of each listed worksheet that `retire`
 * accepts, and clear the intent, as one state.
 */
export function structural_rekey_transition(
    current: PerFileState,
    intent: StructuralRekeyIntent,
    sheets: readonly WorksheetIdentityInput[],
    options: StructuralRekeyTransitionOptions,
): StructuralRekeyResult | undefined {
    // Never retire an intent whose rekey cannot be applied: every worksheet it
    // names must resolve in the workbook it is applied against. Without one
    // (a disposed panel, a workbook that lost the sheet), the intent stays
    // stored for the next load.
    const targets = [
        ...(intent.receipt.structure ?? []),
        ...intent.receipt.appendedRows,
        ...intent.receipt.removedSourceRows,
        ...intent.worksheets,
    ];
    if (targets.some((target) => worksheet_target_index(sheets, target) === undefined)) return undefined;
    const rekeyed = apply_structural_rekey(current, intent.receipt, {
        sheets,
        afterDigest: intent.afterDigest,
        schemaAfter: options.schemaAfter,
        payload: (target) => structural_payload_for(current, sheets, target),
        columnName: options.columnName,
    });
    let pending = rekeyed.state.pendingEdits;
    for (const worksheet of intent.worksheets) {
        if (!options.retire(worksheet)) continue;
        const index = worksheet_target_index(sheets, worksheet) ?? worksheet.sheetIndex;
        const slot = pending_changes_for_sheet(pending, index, worksheet.sheetName, worksheet.worksheetId);
        if (slot === undefined) continue;
        pending = with_pending_changes_for_sheet(pending, index, undefined, worksheet.sheetName, worksheet.worksheetId);
        if (options.park) {
            const { sheetName, worksheetId: _id, ...rest } = slot;
            const parked = {
                ...rest,
                sheetName: `${PARKED_STRUCTURAL_PAYLOAD_PREFIX}${sheetName ?? 'Sheet1'}`,
            };
            const next = [...(pending ?? [])];
            let free = next.findIndex((candidate) => candidate === undefined);
            if (free === -1) free = next.push(undefined) - 1;
            next[free] = parked;
            pending = next;
        }
    }
    const { structuralRekeyIntent: _intent, pendingEdits: _pending, ...rest } = rekeyed.state;
    return {
        state: pending === undefined ? rest : { ...rest, pendingEdits: pending },
        announcements: rekeyed.announcements,
    };
}

/** Recovery's "It didn't finish", and every known pre-write abort: clear the intent, keep the payload. */
export function without_structural_rekey_intent(current: PerFileState, save_id?: string): PerFileState {
    if (current.structuralRekeyIntent === undefined) return current;
    if (save_id !== undefined && current.structuralRekeyIntent.saveId !== save_id) return current;
    const { structuralRekeyIntent: _intent, ...rest } = current;
    return rest;
}

/** Drop payloads parked by an "It finished" choice; the next successful save ends their recovery window. */
export function without_parked_structural_payloads(current: PerFileState): PerFileState {
    if (!current.pendingEdits?.some(is_parked_structural_payload)) return current;
    const pending = current.pendingEdits.map((slot) => is_parked_structural_payload(slot) ? undefined : slot);
    while (pending.length > 0 && pending[pending.length - 1] === undefined) pending.pop();
    const { pendingEdits: _pending, ...rest } = current;
    return pending.length === 0 ? rest : { ...rest, pendingEdits: pending };
}

/** Worksheet indexes a stored intent restructured, resolved against `sheets`. */
export function structurally_affected_sheets(
    intent: StructuralRekeyIntent,
    sheets: readonly WorksheetIdentityInput[],
): readonly number[] {
    return (intent.receipt.structure ?? []).flatMap((entry) => {
        const index = worksheet_target_index(sheets, entry);
        return index === undefined ? [] : [index];
    });
}

/** Re-exported for planners that need the shapes beside the maps. */
export type { ColumnLayout, RowLayout };
