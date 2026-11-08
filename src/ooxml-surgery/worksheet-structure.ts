// XLSX worksheet restructure stage: the pure, formula-free part of delivery
// step 9 of the row and column structure design ("Physical write", steps 1-4).
//
// Given one worksheet part and its Worksheet Layout, `restructure_worksheet`
// rewrites the part into prospective coordinates:
//
//   - `sheetData` is cut into row and cell byte slices and reassembled in
//     prospective order: fixed rows, the live row layout, then the live append
//     band. Only `r` attributes change (and `spans` is dropped); every other
//     byte of a slice is copied unchanged. New rows and Pending Column cells are
//     written from their format templates.
//   - The rest of the part follows the coverage table: `<dimension>`, `<cols>`,
//     `<mergeCells>`, `<hyperlinks>` refs, conditional-formatting and
//     data-validation `sqref`s, `<autoFilter>`, `<sortState>`, `<sheetViews>`,
//     `<rowBreaks>`/`<colBreaks>`, and `<ignoredErrors>`.
//   - It returns a coordinate map, so later stages address cell edits,
//     hyperlink edits, and formula-cache invalidations in prospective
//     coordinates explicitly, never by accident in source ones.
//
// Like xlsx-cell-write.ts, this never deserializes the worksheet into a model:
// untouched elements are copied through byte for byte. Unlike it, it refuses
// any worksheet child it does not know how to shift (the coverage table plus the
// coordinate-free list), so a stale coordinate can never be written silently
// even if the save-time support scan were skipped.
//
// Hand-off to the formula stage (a later slice, which needs the formula-anchors
// module):
//
//   - Cell `<f>` bytes are left exactly as they were, including a shared
//     master's `ref`. `shared_formula_groups` lists every shared group whose
//     cells changed coordinates, with each cell's old and new position and
//     whether the group kept its relative positions; that stage re-renders the
//     master's `ref` for a group that kept them, and unshares any other.
//   - Conditional-formatting and data-validation formulas are not touched. Their
//     `sqref`s are rewritten here by cell-set semantics, and `rule_ranges`
//     reports, per rule, the old and new cell sets that the split-by-meaning
//     algorithm needs. A rule with relative references on a layout that moves
//     rows or columns is flagged `needsFormulaStage` rather than guessed at.
//   - Hyperlink `location`s, defined names, and other worksheets' formulas are
//     not touched.
//
// Coordinates: every row and column here is 0-based and physical. A worksheet's
// body starts at `bodyStart` (the Header Row's 1-based number, or 0 without
// one), matching worksheet-layout.ts, whose canonical source rows are these
// physical rows.
import type { PendingColumnFormat, PendingRowId } from '../pending-changes';
import {
    column_save_map,
    index_column_layout,
    index_row_layout,
    row_save_map,
    type AxisLayoutIndex,
    type ColumnLayout,
    type ColumnSaveMap,
    type PendingColumnId,
    type RowLayout,
    type RowSaveMap,
} from '../worksheet-layout';
import {
    apply_utf8_splices,
    col_index_to_letter,
    writable_worksheet_sheet_data,
} from '../xlsx-cell-write';
import {
    direct_child_elements,
    find_first_element_by_local_name,
    get_tag_attr,
    index_of_bytes,
    letter_to_index,
    opening_tag_text,
    scan_rows,
    utf8_text,
    type QualifiedElementSpan,
    type Span,
} from '../ooxml-worksheet-scan';
import {
    decode_xml,
    encode_xml_attr,
    get_attr,
    remove_attr,
    replace_attr_value,
} from '../ooxml-xml';
import { translate_a1_formula } from '../xlsx-formula';
import type { XlsxAppendedRowShell } from './types';

const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;
const SPREADSHEETML_NAMESPACES: ReadonlySet<string> = new Set([
    'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const RELATIONSHIP_NAMESPACES: ReadonlySet<string> = new Set([
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A Pending Row's format: the append template shape (`XlsxAppendedRowShell`
 * without its row). `cellStyleIndexes` is indexed by **source** column and has
 * one entry per source column; the writer places each style in the column's
 * prospective position.
 */
export type XlsxRowFormat = Omit<XlsxAppendedRowShell, 'row'>;

/** A Pending Column's inherited format: a source column, or none. */
export type XlsxColumnFormat = Exclude<PendingColumnFormat, { readonly kind: 'none' }>;

/**
 * The worksheet's layouts, as the save planner holds them after validating
 * them. The writer derives its row and column maps from `row_save_map` and
 * `column_save_map`, and reads the full layouts too, because interval
 * semantics (`<autoFilter>`, `<sortState>`, `<sheetView>`) needs the position
 * of a removed corner's tombstone, which the save maps do not carry.
 */
export interface WorksheetStructureLayout {
    /** First body row: the Header Row's 1-based number, or 0 without one. Rows above it are fixed. */
    readonly bodyStart: number;
    readonly rowLayout: RowLayout;
    readonly columnLayout: ColumnLayout;
}

export interface WorksheetRestructureRequest {
    readonly worksheet_xml: Uint8Array;
    readonly layout: WorksheetStructureLayout;
    /** Format of every live Pending Inserted Row in the row layout. */
    readonly inserted_row_formats: ReadonlyMap<PendingRowId, XlsxRowFormat>;
    /** The live append band, in `createdOrder`: one format per Pending Appended Row. */
    readonly appended_row_formats: readonly XlsxRowFormat[];
    /** Format of every live Pending Column in the column layout. */
    readonly inserted_column_formats: ReadonlyMap<PendingColumnId, XlsxColumnFormat>;
}

/** An inclusive, 0-based cell rectangle. */
export interface CellRange {
    readonly firstRow: number;
    readonly firstColumn: number;
    readonly lastRow: number;
    readonly lastColumn: number;
}

/**
 * Old physical coordinates to prospective ones. Later save stages take this
 * explicitly, so none of them can address a source coordinate by accident.
 */
export interface WorksheetCoordinateMap {
    readonly bodyStart: number;
    /** Prospective rows: fixed rows, live layout rows, then the append band. */
    readonly rowCount: number;
    /** Prospective live columns. */
    readonly columnCount: number;
    readonly rowSaveMap: RowSaveMap;
    readonly columnSaveMap: ColumnSaveMap;
    /**
     * New row of an old physical row: fixed rows keep theirs, body rows follow
     * the layout, rows past the body shift by the body's change in size. Null
     * for a removed row or one pushed past the sheet's last row.
     */
    row(old_row: number): number | null;
    /** Like `row`, for columns. */
    column(old_column: number): number | null;
    /** New row of a live Pending Inserted Row. */
    inserted_row(id: PendingRowId): number | undefined;
    /** New row of the `ordinal`-th (0-based) live Pending Appended Row. */
    appended_row(ordinal: number): number | undefined;
    /** New column of a live Pending Column. */
    inserted_column(id: PendingColumnId): number | undefined;
}

/** One conditional-formatting element or data-validation rule, for the formula stage. */
export interface RestructuredRuleRange {
    readonly kind: 'conditionalFormatting' | 'dataValidation';
    /** Index among the part's elements of this kind, in source document order. */
    readonly index: number;
    readonly oldCells: readonly CellRange[];
    /** Empty when every covered cell was removed; the element was then dropped. */
    readonly newCells: readonly CellRange[];
    /** The rule's formula texts, decoded, without a leading `=`. */
    readonly formulas: readonly string[];
    /**
     * A formula has relative references and the layout moves rows or columns
     * on that axis, so one rewritten rule may not keep every cell's meaning.
     */
    readonly needsFormulaStage: boolean;
}

export interface SharedFormulaCellMove {
    readonly row: number;
    readonly column: number;
    /** Null when the cell was removed. */
    readonly to: { readonly row: number; readonly column: number } | null;
    readonly master: boolean;
}

/** A shared formula group some of whose cells changed coordinates. */
export interface SharedFormulaGroupChange {
    /** The group's `si`. */
    readonly sharedIndex: string;
    readonly cells: readonly SharedFormulaCellMove[];
    /** Every cell survived and all moved by one offset, so only the master's `ref` needs re-rendering. */
    readonly relativePositionsKept: boolean;
}

export interface WorksheetRestructureResult {
    readonly worksheet_xml: Uint8Array;
    readonly coordinates: WorksheetCoordinateMap;
    /**
     * Relationship ids referenced only by hyperlinks this stage dropped. The
     * caller removes those relationships if they are hyperlink relationships.
     */
    readonly removed_relationship_ids: readonly string[];
    readonly rule_ranges: readonly RestructuredRuleRange[];
    readonly shared_formula_groups: readonly SharedFormulaGroupChange[];
}

export type WorksheetStructureRefusalCode =
    | 'unsupported-worksheet-content'
    | 'missing-row-reference'
    | 'invalid-row-reference'
    | 'invalid-structure-reference'
    | 'grouped-formula'
    | 'non-rectangular-merge'
    | 'filtered-column-outside-range'
    | 'content-past-sheet-end';

/** A worksheet this stage cannot restructure without risking a wrong result. */
export class WorksheetStructureRefusalError extends Error {
    readonly code: WorksheetStructureRefusalCode;
    readonly detail?: string;

    constructor(code: WorksheetStructureRefusalCode, message: string, detail?: string) {
        super(message);
        this.name = 'WorksheetStructureRefusalError';
        this.code = code;
        this.detail = detail;
    }
}

function refuse(code: WorksheetStructureRefusalCode, detail?: string): never {
    const messages: Record<WorksheetStructureRefusalCode, string> = {
        'unsupported-worksheet-content':
            `Can't restructure this sheet: it contains ${detail}, which Table Viewer can't shift yet.`,
        'missing-row-reference':
            "Can't restructure this sheet: a row's position is implied rather than written.",
        'invalid-row-reference':
            `Can't restructure this sheet: a row has an invalid number (${detail}).`,
        'invalid-structure-reference':
            `Can't restructure this sheet: ${detail} has a cell reference Table Viewer can't read.`,
        'grouped-formula':
            `Can't restructure this sheet: cell ${detail} has an array formula or a data table.`,
        'non-rectangular-merge':
            `Can't save these row and column changes: the merged cell ${detail} would no longer be a rectangle.`,
        'filtered-column-outside-range':
            "Can't move a filtered column outside the sheet's filter range.",
        'content-past-sheet-end':
            "Can't save these row and column changes: they would push cells past the end of the sheet.",
    };
    throw new WorksheetStructureRefusalError(code, messages[code], detail);
}

// ---------------------------------------------------------------------------
// Intervals and cell references
// ---------------------------------------------------------------------------

/** Half-open `[start, end)`. */
interface Span1 {
    readonly start: number;
    readonly end: number;
}

/** Sort and merge overlapping or adjacent spans. */
function canonical_spans(spans: readonly Span1[]): Span1[] {
    const sorted = spans.filter((span) => span.end > span.start)
        .slice().sort((left, right) => left.start - right.start);
    const out: Span1[] = [];
    for (const span of sorted) {
        const last = out[out.length - 1];
        if (last !== undefined && span.start <= last.end) {
            if (span.end > last.end) out[out.length - 1] = { start: last.start, end: span.end };
        } else {
            out.push(span);
        }
    }
    return out;
}

function spans_contain(spans: readonly Span1[], value: number): boolean {
    let low = 0;
    let high = spans.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (spans[middle].end <= value) low = middle + 1;
        else high = middle;
    }
    return low < spans.length && spans[low].start <= value;
}

function spans_equal(left: readonly Span1[], right: readonly Span1[]): boolean {
    return left.length === right.length
        && left.every((span, index) => span.start === right[index].start && span.end === right[index].end);
}

function intersect_spans(left: readonly Span1[], right: readonly Span1[]): Span1[] {
    const out: Span1[] = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
        const start = Math.max(left[i].start, right[j].start);
        const end = Math.min(left[i].end, right[j].end);
        if (start < end) out.push({ start, end });
        if (left[i].end < right[j].end) i++;
        else j++;
    }
    return out;
}

const CELL_RE = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;

function parse_cell(text: string): { row: number; column: number } | null {
    const match = CELL_RE.exec(text);
    if (match === null) return null;
    const column = letter_to_index(match[1]);
    const row = Number(match[2]) - 1;
    return column < MAX_COLUMNS && row < MAX_ROWS ? { row, column } : null;
}

/** `A1` or `A1:B2` (corners in either order), normalized. */
function parse_range(text: string): CellRange | null {
    const parts = text.split(':');
    if (parts.length > 2) return null;
    const first = parse_cell(parts[0]);
    const last = parts.length === 2 ? parse_cell(parts[1]) : first;
    if (first === null || last === null) return null;
    return {
        firstRow: Math.min(first.row, last.row),
        firstColumn: Math.min(first.column, last.column),
        lastRow: Math.max(first.row, last.row),
        lastColumn: Math.max(first.column, last.column),
    };
}

/** A space-separated `sqref`; null when empty or any entry is unreadable. */
function parse_sqref(text: string): CellRange[] | null {
    const entries = text.split(/[\t\n\r ]+/).filter((entry) => entry !== '');
    if (entries.length === 0) return null;
    const ranges: CellRange[] = [];
    for (const entry of entries) {
        const range = parse_range(entry);
        if (range === null) return null;
        ranges.push(range);
    }
    return ranges;
}

function cell_text(row: number, column: number): string {
    return `${col_index_to_letter(column)}${row + 1}`;
}

function range_text(range: CellRange): string {
    const first = cell_text(range.firstRow, range.firstColumn);
    return range.firstRow === range.lastRow && range.firstColumn === range.lastColumn
        ? first
        : `${first}:${cell_text(range.lastRow, range.lastColumn)}`;
}

function sqref_text(ranges: readonly CellRange[]): string {
    return ranges.map(range_text).join(' ');
}

// ---------------------------------------------------------------------------
// Axis maps
// ---------------------------------------------------------------------------

/** `count` consecutive old coordinates starting at `from` land at consecutive new ones starting at `to`. */
interface Piece {
    readonly from: number;
    readonly to: number;
    readonly count: number;
}

/**
 * Everything the writer asks of one axis. Rows have `fixed` rows above the
 * body; columns have none. Old coordinates past the source extent are
 * **trailing**: they shift by the axis's change in live size.
 *
 * Cell placement (`cell`) uses plain trailing shifts. Ranges (cell-set and
 * interval semantics) additionally pin the last row or column of the sheet,
 * the formula renderer's `edge` anchor, so a whole-column rule such as
 * `A1:A1048576` keeps reaching the last row after a delete or an insert.
 */
interface AxisMap {
    readonly limit: number;
    readonly fixed: number;
    readonly sourceEnd: number;
    readonly live: number;
    /** Some source run is out of ascending order. */
    readonly moved: boolean;
    /** Sorted by `from`: fixed, live layout runs, trailing. */
    readonly cellPieces: readonly Piece[];
    /** Sorted by `from`: like `cellPieces`, with the edge pinned. */
    readonly rangePieces: readonly Piece[];
    /** New spans with no old coordinate that join a set when both neighbors are in it: Pending entries, plus the space a shrink vacates before the edge. */
    readonly joinBlocks: readonly Span1[];
    /** `joinBlocks` without Pending entries. */
    readonly vacatedBlocks: readonly Span1[];
    cell(old: number): number | null;
    /** Interval semantics over old `[first, last]`: the first and last new coordinates of the live members, or null for `#REF!`. */
    interval(first: number, last: number): { first: number; last: number } | null;
}

function piece_at(pieces: readonly Piece[], old: number): number | null {
    let low = 0;
    let high = pieces.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (pieces[middle].from <= old) low = middle + 1;
        else high = middle;
    }
    const piece = pieces[low - 1];
    return piece !== undefined && old < piece.from + piece.count ? piece.to + old - piece.from : null;
}

function group_consecutive(values: readonly number[]): Span1[] {
    return canonical_spans(values.map((value) => ({ start: value, end: value + 1 })));
}

function build_axis<I>(
    limit: number,
    fixed: number,
    index: AxisLayoutIndex<I>,
    source_identity: (source: number) => I,
    live_pieces: readonly Piece[],
    inserted: readonly number[],
): AxisMap {
    let source_count = 0;
    let source_start = Infinity;
    for (const segment of index.segments) {
        if (segment.kind !== 'source') continue;
        source_count += segment.count;
        source_start = Math.min(source_start, segment.start);
    }
    if (source_count > 0 && source_start !== fixed) {
        throw new TypeError('The layout does not start at the first body row or column.');
    }
    const source_end = fixed + source_count;
    const live = index.liveCount;
    const entries = index.entryCount;
    if (fixed + live > limit) refuse('content-past-sheet-end');
    const live_end = fixed + live;

    const head: Piece[] = fixed > 0 ? [{ from: 0, to: 0, count: fixed }] : [];
    const cell_pieces = [...head, ...live_pieces];
    const trailing_count = Math.min(limit - source_end, limit - live_end);
    if (trailing_count > 0) cell_pieces.push({ from: source_end, to: live_end, count: trailing_count });
    cell_pieces.sort((left, right) => left.from - right.from);

    // The edge exists when the last coordinate is past the source and the live
    // body does not itself reach it.
    const edge = source_end <= limit - 1 && live_end <= limit - 1;
    const range_pieces = [...head, ...live_pieces];
    const vacated: Span1[] = [];
    let range_trailing = 0;
    if (edge) {
        range_trailing = Math.max(0, Math.min(limit - 1 - source_end, limit - 1 - live_end));
        if (range_trailing > 0) range_pieces.push({ from: source_end, to: live_end, count: range_trailing });
        range_pieces.push({ from: limit - 1, to: limit - 1, count: 1 });
        if (live_end + range_trailing < limit - 1) {
            vacated.push({ start: live_end + range_trailing, end: limit - 1 });
        }
    }
    range_pieces.sort((left, right) => left.from - right.from);
    const join_blocks = canonical_spans([...group_consecutive(inserted), ...vacated]);

    const layout_end = fixed + entries;
    const extended_position = (old: number): number => {
        if (old < fixed) return old;
        if (old < source_end) return fixed + index.position_of(source_identity(old))!;
        return layout_end + (old - source_end);
    };
    const new_of_identity = (identity: I | undefined): number | null => {
        if (identity === undefined) return null;
        const body_index = index.body_index_of(identity);
        return body_index === undefined ? null : fixed + body_index - 1;
    };
    const trailing_bound = edge ? limit - 1 : limit;
    const tail = (offset: number): number | null => {
        if (edge && source_end + offset === limit - 1) return limit - 1;
        const value = live_end + offset;
        return value < trailing_bound ? value : null;
    };
    const first_live = (low: number, high: number): number | null => {
        if (low < fixed) return low;
        if (low < layout_end) {
            const found = new_of_identity(index.first_live_between(
                low - fixed, Math.min(high, layout_end - 1) - fixed));
            if (found !== null) return found;
        }
        if (high < layout_end) return null;
        const first = Math.max(low, layout_end) - layout_end;
        const last = high - layout_end;
        const value = tail(first);
        if (value !== null) return value;
        const edge_offset = limit - 1 - source_end;
        return edge && edge_offset >= first && edge_offset <= last ? limit - 1 : null;
    };
    const last_live = (low: number, high: number): number | null => {
        if (high >= layout_end) {
            const first = Math.max(low, layout_end) - layout_end;
            const last = high - layout_end;
            const value = tail(last);
            if (value !== null) return value;
            const largest = Math.min(last, trailing_bound - 1 - live_end);
            if (largest >= first) return live_end + largest;
        }
        if (low < layout_end && high >= fixed) {
            const found = new_of_identity(index.last_live_between(
                Math.max(low, fixed) - fixed, Math.min(high, layout_end - 1) - fixed));
            if (found !== null) return found;
        }
        return low < fixed ? Math.min(high, fixed - 1) : null;
    };

    return {
        limit,
        fixed,
        sourceEnd: source_end,
        live,
        moved: index.hasOutOfOrderRun,
        cellPieces: cell_pieces,
        rangePieces: range_pieces,
        joinBlocks: join_blocks,
        vacatedBlocks: vacated,
        cell: (old) => Number.isSafeInteger(old) && old >= 0 && old < limit ? piece_at(cell_pieces, old) : null,
        interval: (first, last) => {
            const a = extended_position(first);
            const b = extended_position(last);
            const low = Math.min(a, b);
            const high = Math.max(a, b);
            const start = first_live(low, high);
            const end = last_live(low, high);
            return start === null || end === null ? null : { first: start, last: end };
        },
    };
}

function pieces_of_runs(entries: readonly { from: number; to: number; count: number }[]): Piece[] {
    return entries.filter((entry) => entry.count > 0).map((entry) => Object.freeze({ ...entry }));
}

interface WorksheetAxes {
    readonly rows: AxisMap;
    readonly columns: AxisMap;
    readonly coordinates: WorksheetCoordinateMap;
}

function build_axes(layout: WorksheetStructureLayout, appended_row_count: number): WorksheetAxes {
    const body_start = layout.bodyStart;
    if (!Number.isSafeInteger(body_start) || body_start < 0 || body_start > MAX_ROWS) {
        throw new TypeError('Invalid worksheet body start.');
    }
    if (!Number.isSafeInteger(appended_row_count) || appended_row_count < 0) {
        throw new TypeError('Invalid appended row count.');
    }
    const row_map = row_save_map(layout.rowLayout);
    const column_map = column_save_map(layout.columnLayout);
    const row_index = index_row_layout(layout.rowLayout);
    const column_index = index_column_layout(layout.columnLayout);

    const inserted_rows = new Map<PendingRowId, number>();
    for (const row of row_map.insertedRows) inserted_rows.set(row.pendingRowId, body_start + row.bodyIndex);
    const rows = build_axis(
        MAX_ROWS,
        body_start,
        row_index,
        (sourceRow) => ({ kind: 'source' as const, sourceRow }),
        pieces_of_runs(row_map.rowRuns.map((run) => ({
            from: run.sourceRow,
            to: body_start + run.bodyIndex,
            count: run.count,
        }))),
        [...inserted_rows.values()],
    );
    const row_count = body_start + rows.live + appended_row_count;
    if (row_count > MAX_ROWS) refuse('content-past-sheet-end');

    const column_runs: { from: number; to: number; count: number }[] = [];
    column_map.columnMap.forEach((to, from) => {
        if (to === null) return;
        const last = column_runs[column_runs.length - 1];
        if (last !== undefined && last.from + last.count === from && last.to + last.count === to) last.count++;
        else column_runs.push({ from, to, count: 1 });
    });
    const inserted_columns = new Map<PendingColumnId, number>();
    for (const column of column_map.insertedColumns) inserted_columns.set(column.pendingColumnId, column.column);
    const columns = build_axis(
        MAX_COLUMNS,
        0,
        column_index,
        (sourceColumn) => ({ kind: 'source' as const, sourceColumn }),
        pieces_of_runs(column_runs),
        [...inserted_columns.values()],
    );

    const coordinates: WorksheetCoordinateMap = Object.freeze({
        bodyStart: body_start,
        rowCount: row_count,
        columnCount: columns.live,
        rowSaveMap: row_map,
        columnSaveMap: column_map,
        row: rows.cell,
        column: columns.cell,
        inserted_row: (id: PendingRowId) => inserted_rows.get(id),
        appended_row: (ordinal: number) => Number.isSafeInteger(ordinal) && ordinal >= 0
            && ordinal < appended_row_count
            ? body_start + rows.live + ordinal
            : undefined,
        inserted_column: (id: PendingColumnId) => inserted_columns.get(id),
    });
    return { rows, columns, coordinates };
}

/**
 * The coordinate map a restructure with this layout produces, without
 * rewriting anything: for planners that need prospective coordinates before
 * or apart from the write.
 */
export function worksheet_coordinate_map(
    layout: WorksheetStructureLayout,
    appended_row_count: number,
): WorksheetCoordinateMap {
    return build_axes(layout, appended_row_count).coordinates;
}

// ---------------------------------------------------------------------------
// Cell-set semantics
// ---------------------------------------------------------------------------

/** Old spans through `pieces`, in new coordinates. */
function map_spans(pieces: readonly Piece[], spans: readonly Span1[]): Span1[] {
    const out: Span1[] = [];
    for (const span of spans) {
        let low = 0;
        let high = pieces.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (pieces[middle].from + pieces[middle].count <= span.start) low = middle + 1;
            else high = middle;
        }
        for (let at = low; at < pieces.length && pieces[at].from < span.end; at++) {
            const piece = pieces[at];
            const start = Math.max(span.start, piece.from);
            const end = Math.min(span.end, piece.from + piece.count);
            if (start < end) out.push({ start: piece.to + start - piece.from, end: piece.to + end - piece.from });
        }
    }
    return canonical_spans(out);
}

/** Add each block whose neighbors on both sides are in `spans`. */
function join_blocks(spans: readonly Span1[], blocks: readonly Span1[], limit: number): Span1[] {
    if (spans.length === 0 || blocks.length === 0) return [...spans];
    const low = spans[0].start;
    const high = spans[spans.length - 1].end;
    const added: Span1[] = [];
    for (const block of blocks) {
        if (block.end < low || block.start > high) continue;
        if (block.start > 0 && block.end < limit
            && spans_contain(spans, block.start - 1) && spans_contain(spans, block.end)) {
            added.push(block);
        }
    }
    return added.length === 0 ? [...spans] : canonical_spans([...spans, ...added]);
}

/** Rows `[start, end)` that all cover the same columns. */
interface Band {
    readonly start: number;
    readonly end: number;
    readonly columns: readonly Span1[];
}

/** A union of rectangles as row bands, merged where adjacent bands cover equal columns. */
function bands_of_ranges(ranges: readonly CellRange[]): Band[] {
    const cuts = [...new Set(ranges.flatMap((range) => [range.firstRow, range.lastRow + 1]))]
        .sort((left, right) => left - right);
    const bands: Band[] = [];
    for (let at = 0; at + 1 < cuts.length; at++) {
        const start = cuts[at];
        const end = cuts[at + 1];
        const columns = canonical_spans(ranges
            .filter((range) => range.firstRow <= start && range.lastRow >= end - 1)
            .map((range) => ({ start: range.firstColumn, end: range.lastColumn + 1 })));
        if (columns.length > 0) push_band(bands, { start, end, columns });
    }
    return bands;
}

function push_band(bands: Band[], band: Band): void {
    const last = bands[bands.length - 1];
    if (last !== undefined && last.end === band.start && spans_equal(last.columns, band.columns)) {
        bands[bands.length - 1] = { start: last.start, end: band.end, columns: last.columns };
    } else {
        bands.push(band);
    }
}

function bands_equal(left: readonly Band[], right: readonly Band[]): boolean {
    return left.length === right.length && left.every((band, index) =>
        band.start === right[index].start && band.end === right[index].end
        && spans_equal(band.columns, right[index].columns));
}

function ranges_of_bands(bands: readonly Band[]): CellRange[] {
    return bands.flatMap((band) => band.columns.map((columns) => ({
        firstRow: band.start,
        firstColumn: columns.start,
        lastRow: band.end - 1,
        lastColumn: columns.end - 1,
    })));
}

function band_at(bands: readonly Band[], row: number): Band | undefined {
    let low = 0;
    let high = bands.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (bands[middle].end <= row) low = middle + 1;
        else high = middle;
    }
    const band = bands[low];
    return band !== undefined && band.start <= row ? band : undefined;
}

interface MappedCells {
    readonly unchanged: boolean;
    readonly ranges: readonly CellRange[];
}

/**
 * Cell-set semantics: each cell follows its row and column, removed cells drop
 * out, and a new row or column joins where its neighbors on both sides along
 * its axis are in the set. Re-encoded as row bands, each band's column spans
 * one rectangle each, in row-major order.
 */
function map_cells(axes: WorksheetAxes, ranges: readonly CellRange[]): MappedCells {
    const old_bands = bands_of_ranges(ranges);
    const column_cache = new Map<string, Span1[]>();
    const mapped: Band[] = [];
    for (const band of old_bands) {
        const key = band.columns.map((span) => `${span.start}-${span.end}`).join(',');
        let columns = column_cache.get(key);
        if (columns === undefined) {
            columns = join_blocks(
                map_spans(axes.columns.rangePieces, band.columns),
                axes.columns.joinBlocks,
                MAX_COLUMNS,
            );
            column_cache.set(key, columns);
        }
        if (columns.length === 0) continue;
        for (const rows of map_spans(axes.rows.rangePieces, [{ start: band.start, end: band.end }])) {
            mapped.push({ start: rows.start, end: rows.end, columns });
        }
    }
    mapped.sort((left, right) => left.start - right.start);
    if (mapped.length > 0) {
        const low = mapped[0].start;
        const high = mapped[mapped.length - 1].end;
        for (const block of axes.rows.joinBlocks) {
            if (block.end < low || block.start > high || block.start === 0 || block.end >= MAX_ROWS) continue;
            const before = band_at(mapped, block.start - 1);
            const after = band_at(mapped, block.end);
            if (before === undefined || after === undefined) continue;
            const columns = intersect_spans(before.columns, after.columns);
            if (columns.length > 0) mapped.push({ start: block.start, end: block.end, columns });
        }
        mapped.sort((left, right) => left.start - right.start);
    }
    const bands: Band[] = [];
    for (const band of mapped) push_band(bands, band);
    return { unchanged: bands_equal(bands, old_bands), ranges: ranges_of_bands(bands) };
}

/** Interval semantics on both axes, or null when either axis renders `#REF!`. */
function map_interval(axes: WorksheetAxes, range: CellRange): CellRange | null {
    const rows = axes.rows.interval(range.firstRow, range.lastRow);
    const columns = axes.columns.interval(range.firstColumn, range.lastColumn);
    if (rows === null || columns === null) return null;
    return { firstRow: rows.first, firstColumn: columns.first, lastRow: rows.last, lastColumn: columns.last };
}

function ranges_equal(left: CellRange, right: CellRange): boolean {
    return left.firstRow === right.firstRow && left.firstColumn === right.firstColumn
        && left.lastRow === right.lastRow && left.lastColumn === right.lastColumn;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

interface Splice {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

function local_name(qname: string): string {
    return qname.slice(qname.lastIndexOf(':') + 1);
}

function qname_prefix(qname: string): string {
    const colon = qname.indexOf(':');
    return colon === -1 ? '' : qname.slice(0, colon);
}

/** Every attribute of one opening tag, decoded, in order. */
function tag_attributes(open: string): { name: string; value: string }[] {
    const out: { name: string; value: string }[] = [];
    let at = 1;
    while (at < open.length && !/[\s/>]/.test(open[at])) at++;
    while (at < open.length) {
        while (at < open.length && /\s/.test(open[at])) at++;
        if (at >= open.length || open[at] === '/' || open[at] === '>') break;
        const name_start = at;
        while (at < open.length && !/[\s=/>]/.test(open[at])) at++;
        const name = open.slice(name_start, at);
        while (at < open.length && /\s/.test(open[at])) at++;
        if (open[at] !== '=') break;
        at++;
        while (at < open.length && /\s/.test(open[at])) at++;
        const quote = open[at];
        if (quote !== '"' && quote !== "'") break;
        const value_end = open.indexOf(quote, at + 1);
        if (value_end === -1) break;
        out.push({ name, value: decode_xml(open.slice(at + 1, value_end)) });
        at = value_end + 1;
    }
    return out;
}

/** Namespace bindings in scope: `''` is the default namespace. */
type Bindings = ReadonlyMap<string, string>;

function extend_bindings(parent: Bindings, open: string): Bindings {
    let out: Map<string, string> | undefined;
    for (const { name, value } of tag_attributes(open)) {
        if (name === 'xmlns' || name.startsWith('xmlns:')) {
            out ??= new Map(parent);
            out.set(name === 'xmlns' ? '' : name.slice(6), value);
        }
    }
    return out ?? parent;
}

function element_text(xml: Uint8Array, element: Span): string {
    return utf8_text(xml, element.start, element.end);
}

/** The element's text with its opening tag replaced. */
function with_open_tag(xml: Uint8Array, element: Span, open: string): string {
    return open + utf8_text(xml, element.inner_start, element.end);
}

function children_named(
    xml: Uint8Array,
    parent: QualifiedElementSpan,
    allowed: readonly string[],
): QualifiedElementSpan[] {
    const children = direct_child_elements(xml, parent.element);
    for (const child of children) {
        if (!allowed.includes(local_name(child.name))) {
            refuse('unsupported-worksheet-content', `a <${child.name}> element inside <${parent.name}>`);
        }
    }
    return children;
}

function required_ranges(open: string, attribute: string, owner: string, single: boolean): CellRange[] {
    const value = get_attr(open, attribute);
    const ranges = value === null ? null : single
        ? (() => {
            const range = parse_range(value.trim());
            return range === null ? null : [range];
        })()
        : parse_sqref(value);
    if (ranges === null) refuse('invalid-structure-reference', `a <${owner}> element`);
    return ranges;
}

function element_inner_text(xml: Uint8Array, element: Span): string {
    return decode_xml(utf8_text(xml, element.inner_start, element.inner_end));
}

/** Text between elements may hold whitespace, comments, and processing instructions, nothing else. */
function assert_trivia(xml: Uint8Array, from: number, to: number, owner: string): void {
    let at = from;
    while (at < to) {
        const code = xml[at];
        if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
            at++;
            continue;
        }
        const text = utf8_text(xml, at, Math.min(to, at + 4));
        if (text.startsWith('<!--')) {
            const close = index_of_bytes(xml, '-->', at + 4);
            if (close === -1 || close + 3 > to) break;
            at = close + 3;
            continue;
        }
        if (text.startsWith('<?')) {
            const close = index_of_bytes(xml, '?>', at + 2);
            if (close === -1 || close + 2 > to) break;
            at = close + 2;
            continue;
        }
        break;
    }
    if (at < to) refuse('unsupported-worksheet-content', `content Table Viewer can't read inside <${owner}>`);
}

// ---------------------------------------------------------------------------
// sheetData
// ---------------------------------------------------------------------------

const ROW_NUMBER_RE = /^[1-9][0-9]{0,6}$/;

interface RowElement {
    readonly name: string;
    readonly span: Span;
    readonly row: number;
    /** Where the gap before this element starts. */
    readonly gapStart: number;
}

/** One logical row's share of one row element: the element's own row, or cells it holds for another row. */
interface Fragment {
    readonly oldRow: number;
    readonly element: number;
    readonly own: boolean;
    readonly cells: number[];
}

interface SheetDataResult {
    readonly splice: Splice | null;
    readonly extent: { minRow: number; minColumn: number; maxRow: number; maxColumn: number } | null;
    readonly sharedGroups: readonly SharedFormulaGroupChange[];
}

function validate_row_format(format: XlsxRowFormat, source_columns: number): void {
    if (format.cellStyleIndexes.length !== source_columns || source_columns === 0 || source_columns > 256) {
        throw new Error('Invalid XLSX pending row width');
    }
    const height = format.height;
    if (height !== undefined && (!Number.isFinite(height) || height <= 0)) {
        throw new Error('Invalid XLSX pending row height');
    }
    if (format.rowStyleIndex !== undefined
        && (!Number.isSafeInteger(format.rowStyleIndex) || format.rowStyleIndex < 0)) {
        throw new Error('Invalid XLSX pending row style');
    }
    for (const flag of [format.thickTop, format.thickBottom, format.phonetic]) {
        if (flag !== undefined && flag !== true) throw new Error('Invalid XLSX pending row-format flag');
    }
    for (const style of format.cellStyleIndexes) {
        if (style !== null && (!Number.isSafeInteger(style) || style < 0)) {
            throw new Error('Invalid XLSX pending cell style');
        }
    }
}

/**
 * A Pending Row written the way `appended_row_xml` writes an append shell:
 * styled empty cells in prospective columns, and the template's safe row
 * attributes.
 */
function pending_row_xml(
    row: number,
    format: XlsxRowFormat,
    cells: readonly { readonly column: number; readonly style: number | null }[],
    prefix: string,
    extent: (row: number, column: number) => void,
): string {
    const written = cells
        .filter(({ style }) => style !== null && !(style === 0 && (format.rowStyleIndex ?? 0) === 0))
        .sort((left, right) => left.column - right.column)
        .map(({ column, style }) => {
            extent(row, column);
            return `<${prefix}c r="${cell_text(row, column)}" s="${style}"/>`;
        })
        .join('');
    const style_attrs = format.rowStyleIndex === undefined
        ? ''
        : ` s="${format.rowStyleIndex}" customFormat="1"`;
    const height_attrs = format.height === undefined ? '' : ` ht="${format.height}" customHeight="1"`;
    const safe_attrs = (format.thickTop === true ? ' thickTop="1"' : '')
        + (format.thickBottom === true ? ' thickBot="1"' : '')
        + (format.phonetic === true ? ' ph="1"' : '');
    return `<${prefix}row r="${row + 1}"${style_attrs}${height_attrs}${safe_attrs}>${written}</${prefix}row>`;
}

function restructure_sheet_data(
    xml: Uint8Array,
    sheet_data: Span,
    sheet_data_name: string,
    axes: WorksheetAxes,
    request: WorksheetRestructureRequest,
    inherited_columns: readonly { readonly column: number; readonly source: number | null }[],
): SheetDataResult {
    const prefix = qname_prefix(sheet_data_name) === '' ? '' : `${qname_prefix(sheet_data_name)}:`;
    const { rows: row_axis, columns: column_axis, coordinates } = axes;
    const source_columns = coordinates.columnSaveMap.columnMap.length;

    // 1. Row elements, in document order, and every cell they hold.
    const elements: RowElement[] = [];
    const self_closing = sheet_data.inner_start === sheet_data.end;
    let gap_start = sheet_data.inner_start;
    if (!self_closing) {
        for (const child of direct_child_elements(xml, sheet_data)) {
            assert_trivia(xml, gap_start, child.element.start, sheet_data_name);
            if (local_name(child.name) !== 'row') {
                refuse('unsupported-worksheet-content', `a <${child.name}> element inside <${sheet_data_name}>`);
            }
            const r = get_tag_attr(xml, child.element.start, child.element.inner_start, 'r');
            if (r === null) refuse('missing-row-reference');
            if (!ROW_NUMBER_RE.test(r) || Number(r) > MAX_ROWS) refuse('invalid-row-reference', r);
            elements.push({ name: child.name, span: child.element, row: Number(r) - 1, gapStart: gap_start });
            gap_start = child.element.end;
        }
        assert_trivia(xml, gap_start, sheet_data.inner_end, sheet_data_name);
    }
    const tail = self_closing ? '' : utf8_text(xml, gap_start, sheet_data.inner_end);
    const element_of = new Map<number, number>();
    elements.forEach((element, at) => element_of.set(element.span.start, at));

    const cell_row: number[] = [];
    const cell_column: number[] = [];
    const cell_start: number[] = [];
    const cell_inner: number[] = [];
    const cell_end: number[] = [];
    const cell_owner: number[] = [];
    if (!self_closing) {
        scan_rows(xml, sheet_data.inner_start, sheet_data.inner_end, {
            on_cell: (row, column, cell, owner) => {
                const element = element_of.get(owner.start);
                if (element === undefined) throw new Error('A cell lies outside every row element');
                cell_row.push(row);
                cell_column.push(column);
                cell_start.push(cell.start);
                cell_inner.push(cell.inner_start);
                cell_end.push(cell.end);
                cell_owner.push(element);
            },
        });
    }

    // 2. Split elements into logical-row fragments; remember, per row, the last
    // cell in each column a Pending Column inherits from (the reader's last-wins).
    const fragments: Fragment[] = [];
    const inherited_sources = new Set(inherited_columns.flatMap(({ source }) => source === null ? [] : [source]));
    const inherited_cell = new Map<number, Map<number, number>>();
    const last_fragment = new Map<number, number>();
    const element_last_cell = new Array<number>(elements.length).fill(-1);
    let cell = 0;
    elements.forEach((element, at) => {
        const own: Fragment = { oldRow: element.row, element: at, own: true, cells: [] };
        const by_row = new Map<number, Fragment>([[element.row, own]]);
        fragments.push(own);
        last_fragment.set(element.row, fragments.length - 1);
        for (; cell < cell_owner.length && cell_owner[cell] === at; cell++) {
            const row = cell_row[cell];
            let fragment = by_row.get(row);
            if (fragment === undefined) {
                fragment = { oldRow: row, element: at, own: false, cells: [] };
                by_row.set(row, fragment);
                fragments.push(fragment);
                last_fragment.set(row, fragments.length - 1);
            }
            fragment.cells.push(cell);
            element_last_cell[at] = cell;
            if (inherited_sources.has(cell_column[cell])) {
                let columns = inherited_cell.get(row);
                if (columns === undefined) {
                    columns = new Map();
                    inherited_cell.set(row, columns);
                }
                columns.set(cell_column[cell], cell);
            }
        }
    });

    // 3. Write every fragment at its new row, cells in new column order.
    let min_row = Infinity;
    let min_column = Infinity;
    let max_row = -1;
    let max_column = -1;
    const extent = (row: number, column: number): void => {
        if (row < min_row) min_row = row;
        if (row > max_row) max_row = row;
        if (column < min_column) min_column = column;
        if (column > max_column) max_column = column;
    };
    const new_column_of = (column: number): number | null => {
        const mapped = column_axis.cell(column);
        if (mapped === null && column >= column_axis.sourceEnd) refuse('content-past-sheet-end');
        return mapped;
    };
    const shared = new Map<string, SharedFormulaCellMove[]>();
    const note_formula = (at: number, new_row: number | null, new_column: number | null): void => {
        if (index_of_bytes(xml, 'f', cell_inner[at], cell_end[at]) === -1) return;
        const formula = find_first_element_by_local_name(xml, 'f', cell_inner[at], cell_end[at]);
        if (formula === null) return;
        const { element } = formula;
        const type = get_tag_attr(xml, element.start, element.inner_start, 't');
        if (type === 'array' || type === 'dataTable') {
            refuse('grouped-formula', cell_text(cell_row[at], cell_column[at]));
        }
        if (type !== 'shared') return;
        const shared_index = get_tag_attr(xml, element.start, element.inner_start, 'si');
        if (shared_index === null) return;
        const moves = shared.get(shared_index) ?? [];
        shared.set(shared_index, moves);
        moves.push({
            row: cell_row[at],
            column: cell_column[at],
            to: new_row === null || new_column === null ? null : { row: new_row, column: new_column },
            master: get_tag_attr(xml, element.start, element.inner_start, 'ref') !== null,
        });
    };

    const items: { row: number; order: number; text: string }[] = [];
    fragments.forEach((fragment, order) => {
        const new_row = row_axis.cell(fragment.oldRow);
        if (new_row === null) {
            if (fragment.oldRow >= row_axis.sourceEnd && fragment.cells.length > 0) refuse('content-past-sheet-end');
            for (const at of fragment.cells) note_formula(at, null, null);
            return;
        }
        const element = elements[fragment.element];
        const written: { column: number; text: string }[] = [];
        for (const at of fragment.cells) {
            const new_column = new_column_of(cell_column[at]);
            note_formula(at, new_row, new_column);
            if (new_column === null) continue;
            const previous_end = at > 0 && cell_owner[at - 1] === fragment.element
                ? cell_end[at - 1]
                : element.span.inner_start;
            const open = utf8_text(xml, cell_start[at], cell_inner[at]);
            written.push({
                column: new_column,
                text: utf8_text(xml, previous_end, cell_start[at])
                    + replace_attr_value(open, 'r', cell_text(new_row, new_column))
                    + utf8_text(xml, cell_inner[at], cell_end[at]),
            });
            extent(new_row, new_column);
        }
        if (last_fragment.get(fragment.oldRow) === order) {
            const sources = inherited_cell.get(fragment.oldRow);
            for (const { column, source } of inherited_columns) {
                const at = source === null ? undefined : sources?.get(source);
                if (at === undefined) continue;
                const style = get_tag_attr(xml, cell_start[at], cell_inner[at], 's');
                if (style === null) continue;
                written.push({
                    column,
                    text: `<${prefix}c r="${cell_text(new_row, column)}" s="${encode_xml_attr(style)}"/>`,
                });
                extent(new_row, column);
            }
        }
        written.sort((left, right) => left.column - right.column);
        const cells = written.map((entry) => entry.text).join('');
        let text: string;
        if (fragment.own) {
            const open = remove_attr(
                replace_attr_value(opening_tag_text(xml, element.span), 'r', String(new_row + 1)),
                'spans',
            );
            const gap = utf8_text(xml, element.gapStart, element.span.start);
            const last_cell = element_last_cell[fragment.element];
            const content_end = element.span.inner_start === element.span.end
                ? element.span.end
                : last_cell === -1 ? element.span.inner_start : cell_end[last_cell];
            if (element.span.inner_start === element.span.end) {
                text = cells === ''
                    ? gap + open
                    : `${gap}${open.replace(/\/\s*>$/, '>')}${cells}</${element.name}>`;
            } else {
                text = gap + open + cells + utf8_text(xml, content_end, element.span.end);
            }
        } else {
            if (cells === '') return;
            text = `<${element.name} r="${new_row + 1}">${cells}</${element.name}>`;
        }
        items.push({ row: new_row, order, text });
    });

    // New rows: Pending Inserted Rows, then the append band.
    const pending_cells = (format: XlsxRowFormat): { column: number; style: number | null }[] => {
        validate_row_format(format, source_columns);
        const cells: { column: number; style: number | null }[] = [];
        format.cellStyleIndexes.forEach((style, source) => {
            const column = coordinates.columnSaveMap.columnMap[source];
            if (column !== null) cells.push({ column, style });
        });
        for (const { column, source } of inherited_columns) {
            if (source !== null) cells.push({ column, style: format.cellStyleIndexes[source] ?? null });
        }
        return cells;
    };
    for (const { pendingRowId } of coordinates.rowSaveMap.insertedRows) {
        const format = request.inserted_row_formats.get(pendingRowId);
        if (format === undefined) throw new Error(`Pending row ${pendingRowId} has no format.`);
        const row = coordinates.inserted_row(pendingRowId)!;
        items.push({ row, order: fragments.length, text: pending_row_xml(row, format, pending_cells(format), prefix, extent) });
    }
    request.appended_row_formats.forEach((format, ordinal) => {
        const row = coordinates.appended_row(ordinal)!;
        items.push({ row, order: fragments.length, text: pending_row_xml(row, format, pending_cells(format), prefix, extent) });
    });
    items.sort((left, right) => left.row - right.row || left.order - right.order);

    const body = items.map((item) => item.text).join('') + tail;
    let splice: Splice | null;
    if (self_closing) {
        splice = items.length === 0 ? null : {
            start: sheet_data.start,
            end: sheet_data.end,
            text: `${opening_tag_text(xml, sheet_data).replace(/\/\s*>$/, '>')}${body}</${sheet_data_name}>`,
        };
    } else {
        splice = { start: sheet_data.inner_start, end: sheet_data.inner_end, text: body };
    }

    const shared_groups: SharedFormulaGroupChange[] = [];
    for (const [shared_index, cells] of shared) {
        const changed = cells.some((entry) =>
            entry.to === null || entry.to.row !== entry.row || entry.to.column !== entry.column);
        if (!changed) continue;
        const first = cells[0];
        const kept = cells.every((entry) => entry.to !== null
            && first.to !== null
            && entry.to.row - entry.row === first.to.row - first.row
            && entry.to.column - entry.column === first.to.column - first.column);
        shared_groups.push(Object.freeze({
            sharedIndex: shared_index,
            cells: Object.freeze(cells.map((entry) => Object.freeze(entry))),
            relativePositionsKept: kept,
        }));
    }
    return {
        splice,
        extent: max_row < 0 ? null : { minRow: min_row, minColumn: min_column, maxRow: max_row, maxColumn: max_column },
        sharedGroups: shared_groups,
    };
}

// ---------------------------------------------------------------------------
// The rest of the worksheet
// ---------------------------------------------------------------------------

const COORDINATE_FREE_CHILDREN: ReadonlySet<string> = new Set([
    'sheetPr', 'sheetFormatPr', 'sheetCalcPr', 'sheetProtection', 'printOptions',
    'pageMargins', 'pageSetup', 'headerFooter', 'phoneticPr',
]);
const COVERED_CHILDREN: ReadonlySet<string> = new Set([
    'dimension', 'sheetViews', 'cols', 'sheetData', 'autoFilter', 'sortState',
    'mergeCells', 'conditionalFormatting', 'dataValidations', 'hyperlinks',
    'rowBreaks', 'colBreaks', 'ignoredErrors',
]);

interface SectionContext {
    readonly xml: Uint8Array;
    readonly axes: WorksheetAxes;
    readonly splices: Splice[];
}

function remove_element(context: SectionContext, element: Span): void {
    context.splices.push({ start: element.start, end: element.end, text: '' });
}

function replace_open_tag(context: SectionContext, element: Span, open: string): void {
    if (open !== opening_tag_text(context.xml, element)) {
        context.splices.push({ start: element.start, end: element.inner_start, text: open });
    }
}

function set_count(open: string, attribute: string, count: number): string {
    return get_attr(open, attribute) === null ? open : replace_attr_value(open, attribute, String(count));
}

function restructure_cols(context: SectionContext, section: QualifiedElementSpan,
    inherited_columns: readonly { readonly column: number; readonly source: number | null }[]): void {
    const { xml, axes } = context;
    const children = children_named(xml, section, ['col']);
    type Entry = { first: number; last: number; template: string; order: number };
    const entries: Entry[] = [];
    let unchanged = true;
    const originals: { first: number; last: number; text: string }[] = [];
    children.forEach((child, order) => {
        const open = opening_tag_text(xml, child.element);
        const min = get_attr(open, 'min');
        const max = get_attr(open, 'max');
        if (min === null || max === null || !/^[1-9][0-9]*$/.test(min) || !/^[1-9][0-9]*$/.test(max)
            || Number(min) > Number(max) || Number(max) > MAX_COLUMNS) {
            refuse('invalid-structure-reference', `a <${child.name}> element`);
        }
        const text = element_text(xml, child.element);
        originals.push({ first: Number(min) - 1, last: Number(max) - 1, text });
        const mapped = join_blocks(
            map_spans(axes.columns.rangePieces, [{ start: Number(min) - 1, end: Number(max) }]),
            axes.columns.vacatedBlocks,
            MAX_COLUMNS,
        );
        if (!(mapped.length === 1 && mapped[0].start === Number(min) - 1 && mapped[0].end === Number(max))) {
            unchanged = false;
        }
        for (const span of mapped) entries.push({ first: span.start, last: span.end - 1, template: text, order });
    });
    for (const { column, source } of inherited_columns) {
        if (source === null) continue;
        let covering: { text: string } | undefined;
        for (const original of originals) {
            if (original.first <= source && source <= original.last) covering = original;
        }
        if (covering === undefined) continue;
        unchanged = false;
        entries.push({ first: column, last: column, template: covering.text, order: children.length });
    }
    if (unchanged) return;
    entries.sort((left, right) => left.first - right.first || left.order - right.order);
    // Ranges re-merge only when everything but `min` and `max` is identical.
    const blank = (text: string): string => replace_attr_value(replace_attr_value(text, 'min', ''), 'max', '');
    const merged: Entry[] = [];
    for (const entry of entries) {
        const last = merged[merged.length - 1];
        if (last !== undefined && last.last + 1 === entry.first && blank(last.template) === blank(entry.template)) {
            merged[merged.length - 1] = { ...last, last: entry.last };
        } else {
            merged.push(entry);
        }
    }
    if (merged.length === 0) {
        remove_element(context, section.element);
        return;
    }
    const text = merged.map((entry) => replace_attr_value(
        replace_attr_value(entry.template, 'min', String(entry.first + 1)),
        'max',
        String(entry.last + 1),
    )).join('');
    context.splices.push(section.element.inner_start === section.element.end
        ? {
            start: section.element.start,
            end: section.element.end,
            text: `${opening_tag_text(xml, section.element).replace(/\/\s*>$/, '>')}${text}</${section.name}>`,
        }
        : { start: section.element.inner_start, end: section.element.inner_end, text });
}

function restructure_merges(context: SectionContext, section: QualifiedElementSpan): void {
    const { xml, axes } = context;
    const local: Splice[] = [];
    let kept = 0;
    let changed = false;
    for (const child of children_named(xml, section, ['mergeCell'])) {
        const open = opening_tag_text(xml, child.element);
        const ranges = required_ranges(open, 'ref', child.name, true);
        const mapped = map_cells(axes, ranges);
        if (mapped.unchanged) {
            kept++;
            continue;
        }
        changed = true;
        const single = mapped.ranges.length === 1
            && mapped.ranges[0].firstRow === mapped.ranges[0].lastRow
            && mapped.ranges[0].firstColumn === mapped.ranges[0].lastColumn;
        if (mapped.ranges.length === 0 || single) {
            local.push({ start: child.element.start, end: child.element.end, text: '' });
            continue;
        }
        if (mapped.ranges.length > 1) refuse('non-rectangular-merge', get_attr(open, 'ref') ?? '');
        kept++;
        local.push({
            start: child.element.start,
            end: child.element.inner_start,
            text: replace_attr_value(open, 'ref', range_text(mapped.ranges[0])),
        });
    }
    if (!changed) return;
    if (kept === 0) {
        remove_element(context, section.element);
        return;
    }
    context.splices.push(...local);
    replace_open_tag(context, section.element, set_count(opening_tag_text(xml, section.element), 'count', kept));
}

function relationship_id(open: string, bindings: Bindings): string | null {
    for (const { name, value } of tag_attributes(open)) {
        if (local_name(name) !== 'id' || qname_prefix(name) === '') continue;
        if (RELATIONSHIP_NAMESPACES.has(bindings.get(qname_prefix(name)) ?? '')) return value;
    }
    return null;
}

function restructure_hyperlinks(
    context: SectionContext,
    section: QualifiedElementSpan,
    bindings: Bindings,
): string[] {
    const { xml, axes } = context;
    const section_bindings = extend_bindings(bindings, opening_tag_text(xml, section.element));
    const local: Splice[] = [];
    const kept_ids = new Set<string>();
    const dropped_ids = new Set<string>();
    let kept = 0;
    let changed = false;
    for (const child of children_named(xml, section, ['hyperlink'])) {
        const open = opening_tag_text(xml, child.element);
        const id = relationship_id(open, extend_bindings(section_bindings, open));
        const ranges = required_ranges(open, 'ref', child.name, true);
        const mapped = map_cells(axes, ranges);
        if (mapped.unchanged) {
            kept++;
            if (id !== null) kept_ids.add(id);
            continue;
        }
        changed = true;
        if (mapped.ranges.length === 0) {
            if (id !== null) dropped_ids.add(id);
            local.push({ start: child.element.start, end: child.element.end, text: '' });
            continue;
        }
        kept++;
        if (id !== null) kept_ids.add(id);
        local.push({
            start: child.element.start,
            end: child.element.end,
            text: mapped.ranges.map((range) =>
                with_open_tag(xml, child.element, replace_attr_value(open, 'ref', range_text(range)))).join(''),
        });
    }
    if (!changed) return [];
    if (kept === 0) remove_element(context, section.element);
    else context.splices.push(...local);
    return [...dropped_ids].filter((id) => !kept_ids.has(id));
}

function rule_needs_formula_stage(axes: WorksheetAxes, formulas: readonly string[]): boolean {
    return formulas.some((formula) =>
        (axes.rows.moved && translate_a1_formula(formula, 1, 0) !== formula)
        || (axes.columns.moved && translate_a1_formula(formula, 0, 1) !== formula));
}

function conditional_formatting_formulas(xml: Uint8Array, section: QualifiedElementSpan): string[] {
    const formulas: string[] = [];
    for (const rule of children_named(xml, section, ['cfRule'])) {
        for (const child of direct_child_elements(xml, rule.element)) {
            const name = local_name(child.name);
            if (name === 'formula') formulas.push(element_inner_text(xml, child.element));
            if (name === 'colorScale' || name === 'dataBar' || name === 'iconSet') {
                for (const value of direct_child_elements(xml, child.element)) {
                    const open = opening_tag_text(xml, value.element);
                    const formula = get_attr(open, 'val');
                    if (local_name(value.name) === 'cfvo' && get_attr(open, 'type') === 'formula' && formula !== null) {
                        formulas.push(formula);
                    }
                }
            }
            if (name === 'extLst') refuse('unsupported-worksheet-content', `a <${child.name}> element inside <${rule.name}>`);
        }
    }
    return formulas;
}

function restructure_conditional_formatting(
    context: SectionContext,
    section: QualifiedElementSpan,
    index: number,
): RestructuredRuleRange {
    const { xml, axes } = context;
    const open = opening_tag_text(xml, section.element);
    const ranges = required_ranges(open, 'sqref', section.name, false);
    const formulas = conditional_formatting_formulas(xml, section);
    const mapped = map_cells(axes, ranges);
    if (!mapped.unchanged) {
        if (mapped.ranges.length === 0) remove_element(context, section.element);
        else replace_open_tag(context, section.element, replace_attr_value(open, 'sqref', sqref_text(mapped.ranges)));
    }
    return Object.freeze({
        kind: 'conditionalFormatting',
        index,
        oldCells: Object.freeze(ranges),
        newCells: Object.freeze(mapped.unchanged ? ranges : mapped.ranges),
        formulas: Object.freeze(formulas),
        needsFormulaStage: rule_needs_formula_stage(axes, formulas),
    });
}

function restructure_data_validations(
    context: SectionContext,
    section: QualifiedElementSpan,
    first_index: number,
): RestructuredRuleRange[] {
    const { xml, axes } = context;
    const local: Splice[] = [];
    const reports: RestructuredRuleRange[] = [];
    let kept = 0;
    let changed = false;
    for (const child of children_named(xml, section, ['dataValidation'])) {
        const open = opening_tag_text(xml, child.element);
        const ranges = required_ranges(open, 'sqref', child.name, false);
        const formulas: string[] = [];
        for (const formula of direct_child_elements(xml, child.element)) {
            const name = local_name(formula.name);
            if (name === 'formula1' || name === 'formula2') formulas.push(element_inner_text(xml, formula.element));
            else refuse('unsupported-worksheet-content', `a <${formula.name}> element inside <${child.name}>`);
        }
        const mapped = map_cells(axes, ranges);
        reports.push(Object.freeze({
            kind: 'dataValidation',
            index: first_index + reports.length,
            oldCells: Object.freeze(ranges),
            newCells: Object.freeze(mapped.unchanged ? ranges : mapped.ranges),
            formulas: Object.freeze(formulas),
            needsFormulaStage: rule_needs_formula_stage(axes, formulas),
        }));
        if (mapped.unchanged) {
            kept++;
            continue;
        }
        changed = true;
        if (mapped.ranges.length === 0) {
            local.push({ start: child.element.start, end: child.element.end, text: '' });
            continue;
        }
        kept++;
        local.push({
            start: child.element.start,
            end: child.element.inner_start,
            text: replace_attr_value(open, 'sqref', sqref_text(mapped.ranges)),
        });
    }
    if (changed) {
        if (kept === 0) {
            remove_element(context, section.element);
        } else {
            context.splices.push(...local);
            replace_open_tag(context, section.element, set_count(opening_tag_text(xml, section.element), 'count', kept));
        }
    }
    return reports;
}

/** Interval semantics on a `ref` attribute: the new ref, or null for `#REF!`. */
function interval_ref(axes: WorksheetAxes, open: string, owner: string): { old: CellRange; next: CellRange | null } {
    const [range] = required_ranges(open, 'ref', owner, true);
    return { old: range, next: map_interval(axes, range) };
}

function restructure_sort_state(context: SectionContext, section: QualifiedElementSpan): void {
    const { xml, axes } = context;
    const open = opening_tag_text(xml, section.element);
    const { old, next } = interval_ref(axes, open, section.name);
    if (next === null) {
        remove_element(context, section.element);
        return;
    }
    if (!ranges_equal(old, next)) replace_open_tag(context, section.element, replace_attr_value(open, 'ref', range_text(next)));
    for (const condition of children_named(xml, section, ['sortCondition'])) {
        const condition_open = opening_tag_text(xml, condition.element);
        const mapped = interval_ref(axes, condition_open, condition.name);
        if (mapped.next === null) remove_element(context, condition.element);
        else if (!ranges_equal(mapped.old, mapped.next)) {
            replace_open_tag(context, condition.element, replace_attr_value(condition_open, 'ref', range_text(mapped.next)));
        }
    }
}

function restructure_auto_filter(context: SectionContext, section: QualifiedElementSpan): void {
    const { xml, axes } = context;
    const open = opening_tag_text(xml, section.element);
    const { old, next } = interval_ref(axes, open, section.name);
    if (next === null) {
        remove_element(context, section.element);
        return;
    }
    if (!ranges_equal(old, next)) replace_open_tag(context, section.element, replace_attr_value(open, 'ref', range_text(next)));
    for (const child of children_named(xml, section, ['filterColumn', 'sortState'])) {
        if (local_name(child.name) === 'sortState') {
            restructure_sort_state(context, child);
            continue;
        }
        const child_open = opening_tag_text(xml, child.element);
        const id = get_attr(child_open, 'colId');
        if (id === null || !/^[0-9]+$/.test(id)) refuse('invalid-structure-reference', `a <${child.name}> element`);
        const column = axes.columns.cell(old.firstColumn + Number(id));
        if (column === null) {
            remove_element(context, child.element);
            continue;
        }
        if (column < next.firstColumn || column > next.lastColumn) refuse('filtered-column-outside-range');
        replace_open_tag(context, child.element, replace_attr_value(child_open, 'colId', String(column - next.firstColumn)));
    }
}

function restructure_sheet_views(context: SectionContext, section: QualifiedElementSpan): void {
    const { xml, axes } = context;
    const first_body = { row: axes.coordinates.bodyStart, column: 0 };
    const map_cell = (text: string, owner: string): { row: number; column: number } => {
        const range = parse_range(text);
        if (range === null || range.firstRow !== range.lastRow || range.firstColumn !== range.lastColumn) {
            refuse('invalid-structure-reference', `a <${owner}> element`);
        }
        const mapped = map_interval(axes, range);
        return mapped === null ? { ...first_body } : { row: mapped.firstRow, column: mapped.firstColumn };
    };
    for (const view of children_named(xml, section, ['sheetView'])) {
        const view_open = opening_tag_text(xml, view.element);
        const top_left = get_attr(view_open, 'topLeftCell');
        if (top_left !== null) {
            const cell = map_cell(top_left, view.name);
            replace_open_tag(context, view.element, replace_attr_value(view_open, 'topLeftCell', cell_text(cell.row, cell.column)));
        }
        for (const child of children_named(xml, view, ['pane', 'selection'])) {
            let open = opening_tag_text(xml, child.element);
            if (local_name(child.name) === 'pane') {
                const pane_top_left = get_attr(open, 'topLeftCell');
                if (pane_top_left !== null) {
                    const cell = map_cell(pane_top_left, child.name);
                    // Frozen panes count rows and columns; a split pane's sizes are twips.
                    const state = get_attr(open, 'state');
                    if (state === 'frozen' || state === 'frozenSplit') {
                        const x = Number(get_attr(open, 'xSplit') ?? '0');
                        const y = Number(get_attr(open, 'ySplit') ?? '0');
                        if (Number.isSafeInteger(y) && cell.row < y) cell.row = y;
                        if (Number.isSafeInteger(x) && cell.column < x) cell.column = x;
                    }
                    open = replace_attr_value(open, 'topLeftCell', cell_text(cell.row, cell.column));
                }
                replace_open_tag(context, child.element, open);
                continue;
            }
            const active = get_attr(open, 'activeCell');
            let active_cell: { row: number; column: number } | undefined;
            if (active !== null) {
                active_cell = map_cell(active, child.name);
                open = replace_attr_value(open, 'activeCell', cell_text(active_cell.row, active_cell.column));
            }
            const sqref = get_attr(open, 'sqref');
            if (sqref !== null) {
                const ranges = parse_sqref(sqref);
                if (ranges === null) refuse('invalid-structure-reference', `a <${child.name}> element`);
                const mapped = ranges.flatMap((range) => {
                    const next = map_interval(axes, range);
                    return next === null ? [] : [next];
                });
                if (mapped.length !== ranges.length) open = remove_attr(open, 'activeCellId');
                const fallback = active_cell ?? first_body;
                const text = mapped.length === 0
                    ? cell_text(fallback.row, fallback.column)
                    : sqref_text(mapped);
                open = replace_attr_value(open, 'sqref', text);
            }
            replace_open_tag(context, child.element, open);
        }
    }
}

function restructure_breaks(context: SectionContext, section: QualifiedElementSpan, axis: AxisMap): void {
    const { xml } = context;
    const local: Splice[] = [];
    let kept = 0;
    let manual = 0;
    let changed = false;
    for (const child of children_named(xml, section, ['brk'])) {
        const open = opening_tag_text(xml, child.element);
        const id = get_attr(open, 'id') ?? '0';
        if (!/^[0-9]+$/.test(id) || Number(id) >= axis.limit) {
            refuse('invalid-structure-reference', `a <${child.name}> element`);
        }
        const next = piece_at(axis.rangePieces, Number(id));
        if (next === null) {
            changed = true;
            local.push({ start: child.element.start, end: child.element.end, text: '' });
            continue;
        }
        kept++;
        const man = get_attr(open, 'man');
        if (man === '1' || man === 'true') manual++;
        if (next !== Number(id)) {
            changed = true;
            local.push({ start: child.element.start, end: child.element.inner_start, text: replace_attr_value(open, 'id', String(next)) });
        }
    }
    if (!changed) return;
    if (kept === 0) {
        remove_element(context, section.element);
        return;
    }
    context.splices.push(...local);
    replace_open_tag(context, section.element, set_count(
        set_count(opening_tag_text(xml, section.element), 'count', kept),
        'manualBreakCount',
        manual,
    ));
}

function restructure_ignored_errors(context: SectionContext, section: QualifiedElementSpan): void {
    const { xml, axes } = context;
    const local: Splice[] = [];
    let kept = 0;
    let changed = false;
    for (const child of children_named(xml, section, ['ignoredError'])) {
        const open = opening_tag_text(xml, child.element);
        const mapped = map_cells(axes, required_ranges(open, 'sqref', child.name, false));
        if (mapped.unchanged) {
            kept++;
            continue;
        }
        changed = true;
        if (mapped.ranges.length === 0) {
            local.push({ start: child.element.start, end: child.element.end, text: '' });
            continue;
        }
        kept++;
        local.push({ start: child.element.start, end: child.element.inner_start, text: replace_attr_value(open, 'sqref', sqref_text(mapped.ranges)) });
    }
    if (!changed) return;
    if (kept === 0) remove_element(context, section.element);
    else context.splices.push(...local);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Rewrite one worksheet part into the prospective coordinates of its layout.
 * Throws `OoxmlRefusalError` for anything the cell writer already refuses and
 * `WorksheetStructureRefusalError` for anything this stage cannot shift.
 */
export function restructure_worksheet(request: WorksheetRestructureRequest): WorksheetRestructureResult {
    const xml = request.worksheet_xml;
    const axes = build_axes(request.layout, request.appended_row_formats.length);
    const { coordinates } = axes;
    const source_columns = coordinates.columnSaveMap.columnMap.length;

    const inherited_columns = coordinates.columnSaveMap.insertedColumns.map(({ pendingColumnId, column }) => {
        const format = request.inserted_column_formats.get(pendingColumnId);
        if (format === undefined) throw new Error(`Pending column ${pendingColumnId} has no format.`);
        if (format.kind === 'default') return { column, source: null };
        if (format.kind !== 'source' || !Number.isSafeInteger(format.sourceColumn)
            || format.sourceColumn < 0 || format.sourceColumn >= source_columns) {
            throw new Error(`Pending column ${pendingColumnId} has an invalid format.`);
        }
        return { column, source: format.sourceColumn };
    });
    for (const { pendingRowId } of coordinates.rowSaveMap.insertedRows) {
        if (!request.inserted_row_formats.has(pendingRowId)) {
            throw new Error(`Pending row ${pendingRowId} has no format.`);
        }
    }

    // Same refusals, and the same authoritative sheetData, as every cell write.
    const { name: sheet_data_name, element: sheet_data } = writable_worksheet_sheet_data(xml);
    const root = find_first_element_by_local_name(xml, 'worksheet');
    if (root === null) throw new Error('Worksheet has no worksheet element');
    const root_open = opening_tag_text(xml, root.element);
    let root_bindings = extend_bindings(new Map(), root_open);
    if (!root_bindings.has('') && qname_prefix(root.name) === '') {
        root_bindings = new Map([...root_bindings, ['', [...SPREADSHEETML_NAMESPACES][0]]]);
    }

    const children = direct_child_elements(xml, root.element);
    for (const child of children) {
        const name = local_name(child.name);
        const namespace = extend_bindings(root_bindings, opening_tag_text(xml, child.element))
            .get(qname_prefix(child.name));
        if (!SPREADSHEETML_NAMESPACES.has(namespace ?? '')
            || (!COORDINATE_FREE_CHILDREN.has(name) && !COVERED_CHILDREN.has(name))) {
            refuse('unsupported-worksheet-content', `a <${child.name}> element`);
        }
    }

    const splices: Splice[] = [];
    const context: SectionContext = { xml, axes, splices };
    const sheet = restructure_sheet_data(xml, sheet_data, sheet_data_name, axes, request, inherited_columns);
    if (sheet.splice !== null) splices.push(sheet.splice);

    const removed_relationship_ids: string[] = [];
    const rule_ranges: RestructuredRuleRange[] = [];
    let conditional_index = 0;
    let validation_index = 0;
    for (const child of children) {
        switch (local_name(child.name)) {
            case 'dimension': {
                const open = opening_tag_text(xml, child.element);
                if (get_attr(open, 'ref') === null) break;
                const extent = sheet.extent;
                const last_row = Math.max(extent?.maxRow ?? 0, coordinates.rowCount - 1);
                const last_column = Math.max(extent?.maxColumn ?? 0, coordinates.columnCount - 1);
                const first = extent === null ? { row: 0, column: 0 } : { row: extent.minRow, column: extent.minColumn };
                const ref = range_text({
                    firstRow: first.row,
                    firstColumn: first.column,
                    lastRow: Math.max(first.row, last_row),
                    lastColumn: Math.max(first.column, last_column),
                });
                replace_open_tag(context, child.element, replace_attr_value(open, 'ref', ref));
                break;
            }
            case 'sheetViews':
                restructure_sheet_views(context, child);
                break;
            case 'cols':
                restructure_cols(context, child, inherited_columns);
                break;
            case 'autoFilter':
                restructure_auto_filter(context, child);
                break;
            case 'sortState':
                restructure_sort_state(context, child);
                break;
            case 'mergeCells':
                restructure_merges(context, child);
                break;
            case 'conditionalFormatting':
                rule_ranges.push(restructure_conditional_formatting(context, child, conditional_index++));
                break;
            case 'dataValidations': {
                const reports = restructure_data_validations(context, child, validation_index);
                validation_index += reports.length;
                rule_ranges.push(...reports);
                break;
            }
            case 'hyperlinks':
                removed_relationship_ids.push(...restructure_hyperlinks(context, child, root_bindings));
                break;
            case 'rowBreaks':
                restructure_breaks(context, child, axes.rows);
                break;
            case 'colBreaks':
                restructure_breaks(context, child, axes.columns);
                break;
            case 'ignoredErrors':
                restructure_ignored_errors(context, child);
                break;
            default:
                break;
        }
    }

    return Object.freeze({
        worksheet_xml: apply_utf8_splices(xml, splices),
        coordinates,
        removed_relationship_ids: Object.freeze(removed_relationship_ids),
        rule_ranges: Object.freeze(rule_ranges),
        shared_formula_groups: Object.freeze(sheet.sharedGroups),
    });
}
