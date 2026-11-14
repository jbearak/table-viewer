import {
    read_source_columns,
    type DataSource,
    type RenderedCell,
} from './data-source/interface';
import {
    UNKNOWN_XLSX_FORMULA_RESULT,
    a1_formula_reference_at,
    formula_ref_error_count,
    is_xlsx_formula_text,
    structured_formula_reference_at,
} from './xlsx-formula';
import { number_format_is_date } from './spreadsheet-format';
import {
    classify_xlsx_cell_value,
    iso_to_serial,
    xlsx_runs_require_inline_string,
} from './xlsx-cell-value';
import type { RichTextRun } from './cell-content';
import { cell_whole_style } from './cell-edit-model';
import {
    formula_anchor_context,
    formula_anchor_workbook,
    prospective_column_count,
    prospective_row_count,
    unrenderable_formula_reason,
    type FormulaAnchorWorkbook,
    type UnrenderableFormulaReason,
} from './formula-anchor-layout';
import { render_formula, type FormulaAnchors } from './formula-anchors';
import {
    MAX_PENDING_APPENDED_ROWS,
    MAX_PENDING_ROW_ID_LENGTH,
    own_column_layout,
    own_formula_anchors,
    own_row_layout,
    type PendingRowId,
} from './pending-changes';
import {
    validate_column_layout,
    validate_row_layout,
    type ColumnLayout,
    type RowLayout,
} from './worksheet-layout';
import { is_plain_record } from './plain-record';

const MAX_RANGE_CELLS_PER_READ = 8_192;
const MAX_RANGE_COLUMNS_PER_READ = 256;
const PARSER_WORK_PER_CHECKPOINT = 1_024;
// Excel's documented formula-text limit, plus the editor's leading '='.
const MAX_CALCULATED_FORMULA_LENGTH = 8_193;
// A save runs on the extension host. Keep its cache-refresh fallback below one
// broad event-loop stall; formulas left unfinished have their stale caches
// removed and Excel recalculates them when the saved workbook opens.
const MAX_SYNCHRONOUS_CALCULATION_WORK = 262_144;
const CALCULATION_WORK_EXHAUSTED = Symbol('calculation-work-exhausted');

export interface FormulaCalculationAddress {
    readonly sheetIndex: number;
    readonly row: number;
    readonly column: number;
}

export interface FormulaCalculationEdit extends FormulaCalculationAddress {
    readonly value: string;
    /** Exact classification chosen by the eventual XLSX writer. */
    readonly writesFormula: boolean;
    readonly runs?: readonly RichTextRun[];
    /** Stored Formula Anchors of a formula edit; rendered only when the request carries `layouts`. */
    readonly formulaAnchors?: FormulaAnchors;
}

/**
 * One worksheet's Worksheet Layout, as the calculator reads it. When a request
 * carries layouts, every address in it is prospective: the 0-based row and
 * column the cell will occupy after save, as the grid displays it.
 */
export interface FormulaCalculationLayout {
    /** H: the Header Row's 1-based number, or 0 without one. */
    readonly bodyStart: number;
    /** Absent means the source layout. */
    readonly rowLayout?: RowLayout;
    /** Absent means the source layout. */
    readonly columnLayout?: ColumnLayout;
    /** Live Pending Appended Rows, in `createdOrder`. */
    readonly band: readonly PendingRowId[];
    /** Source rows of Pending Tail Removals. */
    readonly tailRemovedSourceRows?: readonly number[];
}

const LAYOUT_KEYS = new Set(['bodyStart', 'rowLayout', 'columnLayout', 'band', 'tailRemovedSourceRows']);

function own_formula_calculation_layout(
    value: unknown,
    sheet: { readonly sourceRowCount: number; readonly columnCount: number },
): FormulaCalculationLayout | undefined {
    if (!is_plain_record(value) || Object.keys(value).some((key) => !LAYOUT_KEYS.has(key))) return undefined;
    const whole = (entry: unknown, minimum: number, maximum: number): entry is number =>
        Number.isSafeInteger(entry) && (entry as number) >= minimum && (entry as number) <= maximum;
    if (!whole(value.bodyStart, 0, sheet.sourceRowCount)) return undefined;
    const body_start = value.bodyStart;
    if (
        !Array.isArray(value.band)
        || value.band.length > MAX_PENDING_APPENDED_ROWS
        || value.band.some((id) => typeof id !== 'string' || id.length === 0
            || id.length > MAX_PENDING_ROW_ID_LENGTH)
        || new Set(value.band).size !== value.band.length
    ) return undefined;
    const band = Object.freeze([...value.band as string[]]);
    const tail = value.tailRemovedSourceRows;
    if (tail !== undefined && (
        !Array.isArray(tail)
        || tail.length > MAX_PENDING_APPENDED_ROWS
        || tail.some((row) => !whole(row, body_start, sheet.sourceRowCount - 1))
    )) return undefined;
    let rowLayout: RowLayout | undefined;
    if (value.rowLayout !== undefined) {
        rowLayout = own_row_layout(value.rowLayout);
        const discarded = new Set(rowLayout.discardedPendingRows.map((row) => row.id));
        let created = rowLayout.discardedPendingRows.reduce(
            (maximum, row) => Math.max(maximum, row.createdOrder + 1), 0);
        const inserted = rowLayout.runs.flatMap((run) => run.kind === 'pending'
            ? run.ids.filter((id) => !discarded.has(id))
            : []);
        const error = validate_row_layout(rowLayout, {
            bodyStart: body_start,
            bodyRowCount: sheet.sourceRowCount - body_start,
            pendingRows: [
                ...inserted.map((id) => ({ id, origin: 'insert' as const, createdOrder: created++ })),
                ...band.map((id) => ({ id, createdOrder: created++ })),
            ],
            mintedAsInsert: () => true,
        });
        if (error !== undefined) return undefined;
    }
    let columnLayout: ColumnLayout | undefined;
    if (value.columnLayout !== undefined) {
        columnLayout = own_column_layout(value.columnLayout);
        const discarded = new Set(columnLayout.discardedPendingColumns.map((column) => column.id));
        let created = columnLayout.discardedPendingColumns.reduce(
            (maximum, column) => Math.max(maximum, column.createdOrder + 1), 0);
        const error = validate_column_layout(columnLayout, {
            sourceColumnCount: sheet.columnCount,
            pendingColumns: columnLayout.columns.flatMap((column) =>
                column.kind === 'pending' && !discarded.has(column.pendingColumnId)
                    ? [{ id: column.pendingColumnId, createdOrder: created++ }]
                    : []),
        });
        if (error !== undefined) return undefined;
    }
    return Object.freeze({
        bodyStart: body_start,
        ...(rowLayout === undefined ? {} : { rowLayout }),
        ...(columnLayout === undefined ? {} : { columnLayout }),
        band,
        ...(tail === undefined ? {} : { tailRemovedSourceRows: Object.freeze([...tail as number[]]) }),
    });
}

/**
 * Own the layouts of a calculation request from the wire, one per worksheet,
 * each checked against its worksheet; `undefined` when any is malformed.
 */
export function own_formula_calculation_layouts(
    value: unknown,
    sheets: readonly { readonly sourceRowCount: number; readonly columnCount: number }[],
): readonly FormulaCalculationLayout[] | undefined {
    if (!Array.isArray(value) || value.length !== sheets.length) return undefined;
    try {
        const owned = value.map((entry, index) => own_formula_calculation_layout(entry, sheets[index]));
        return owned.every((entry) => entry !== undefined)
            ? Object.freeze(owned as FormulaCalculationLayout[])
            : undefined;
    } catch {
        return undefined;
    }
}

/** Whether every edit's Formula Anchors, when present, are valid for its value. */
export function formula_calculation_edit_anchors_valid(
    edits: readonly FormulaCalculationEdit[],
): boolean {
    return edits.every((edit) => edit.formulaAnchors === undefined
        || own_formula_anchors(edit.formulaAnchors, edit.value) !== undefined);
}

export type FormulaCalculationError =
    | 'unsupported function'
    | 'parse error'
    /** The formula holds `#REF!`: something it referred to was deleted. */
    | 'invalid reference'
    | 'cycle'
    | 'numeric error'
    | 'unknown column'
    | 'ambiguous column'
    | 'Header Row is off'
    | 'row outside worksheet body'
    | 'range cannot be displayed'
    /** A construct no layout change can adjust touches a worksheet with one. */
    | UnrenderableFormulaReason;

/** A calculation always settles as either a numeric value or a specific failure. */
export type FormulaCalculationResult = FormulaCalculationAddress & (
    | { readonly value: string; readonly error?: never }
    | { readonly value?: never; readonly error: FormulaCalculationError }
);

export interface FormulaCalculationRequest {
    readonly edits: readonly FormulaCalculationEdit[];
    readonly targets: readonly FormulaCalculationAddress[];
    /** Final worksheet extents while structural edits are still provisional. */
    readonly prospectiveRowCounts?: readonly number[];
    /** Physical rows whose old cells must read as blank before replacement edits apply. */
    readonly removedRows?: readonly {
        readonly sheetIndex: number;
        readonly row: number;
    }[];
    /**
     * One layout per worksheet. When present, every address is prospective,
     * formulas render from their anchors for these layouts before they are
     * evaluated, and `prospectiveRowCounts` and `removedRows` are ignored:
     * removed rows and columns have no prospective address, so they are not
     * addressable.
     */
    readonly layouts?: readonly FormulaCalculationLayout[];
}

export interface FormulaCalculationSchedule {
    /** Stop before doing more source reads when this request has become stale. */
    readonly isCancelled: () => boolean;
    /** Scheduling seam used by the host and deterministic unit tests. */
    readonly yieldControl?: () => Promise<void>;
    /** Maximum wall-clock work between scheduling points. */
    readonly workSliceMs?: number;
}

type CalculationSteps<T> = Generator<void, T, void>;

type Scalar =
    | { readonly kind: 'number'; readonly value: number }
    | { readonly kind: 'boolean'; readonly value: 0 | 1 }
    | { readonly kind: 'blank' }
    | { readonly kind: 'text'; readonly value: string }
    | { readonly kind: 'unknown'; readonly error: FormulaCalculationError };

interface RangeValue {
    readonly kind: 'range';
    readonly sheetIndex: number;
    readonly firstRow: number;
    readonly firstColumn: number;
    readonly lastRow: number;
    readonly lastColumn: number;
}

type FormulaValue = Scalar | RangeValue;

const PARSE_ERROR: Scalar = Object.freeze({ kind: 'unknown', error: 'parse error' });
const UNSUPPORTED_FUNCTION: Scalar = Object.freeze({
    kind: 'unknown', error: 'unsupported function',
});
const INVALID_REFERENCE: Scalar = Object.freeze({ kind: 'unknown', error: 'invalid reference' });
const CYCLE: Scalar = Object.freeze({ kind: 'unknown', error: 'cycle' });
const NUMERIC_ERROR: Scalar = Object.freeze({ kind: 'unknown', error: 'numeric error' });
const UNKNOWN_COLUMN: Scalar = Object.freeze({ kind: 'unknown', error: 'unknown column' });
const AMBIGUOUS_COLUMN: Scalar = Object.freeze({ kind: 'unknown', error: 'ambiguous column' });
const HEADER_ROW_OFF: Scalar = Object.freeze({ kind: 'unknown', error: 'Header Row is off' });
const ROW_OUTSIDE_BODY: Scalar = Object.freeze({
    kind: 'unknown', error: 'row outside worksheet body',
});
const RANGE_NOT_DISPLAYABLE: Scalar = Object.freeze({
    kind: 'unknown', error: 'range cannot be displayed',
});
const BLANK: Scalar = Object.freeze({ kind: 'blank' });

function address_key(address: FormulaCalculationAddress): string {
    return `${address.sheetIndex}:${address.row}:${address.column}`;
}

function finite_number(value: number): Scalar {
    return Number.isFinite(value) ? { kind: 'number', value } : NUMERIC_ERROR;
}

function numeric_text(value: string): number | undefined {
    const trimmed = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        return undefined;
    }
    const number = Number(trimmed);
    const mantissa = trimmed.replace(/[eE][+-]?\d+$/, '').replace(/[+-]/, '').replace('.', '');
    const significant_digits = mantissa.replace(/^0+/, '').length;
    const underflowed = number === 0
        && /[1-9]/.test(trimmed.replace(/[eE][+-]?\d+$/, ''));
    return Number.isFinite(number) && !underflowed && significant_digits <= 15
        ? number
        : undefined;
}

function scalar_from_cell(cell: RenderedCell | null | undefined): Scalar {
    if (!cell || cell.raw === null || cell.raw === '' || cell.rawType === 'empty') return BLANK;
    if (cell.rawType === 'number' || cell.rawType === 'date') {
        const value = cell.numericRaw ?? Number(cell.raw);
        return finite_number(value);
    }
    if (cell.rawType === 'error') return NUMERIC_ERROR;
    if (cell.rawType === 'boolean') {
        if (cell.raw === '1' || cell.raw.toUpperCase() === 'TRUE') {
            return { kind: 'boolean', value: 1 };
        }
        if (cell.raw === '0' || cell.raw.toUpperCase() === 'FALSE') {
            return { kind: 'boolean', value: 0 };
        }
        return NUMERIC_ERROR;
    }
    return { kind: 'text', value: cell.raw };
}

function scalar_from_edit(
    edit: FormulaCalculationEdit,
    cell: RenderedCell | null | undefined,
): Scalar {
    const { value } = edit;
    if (
        edit.runs !== undefined
        && edit.runs.length > 0
        && xlsx_runs_require_inline_string(
            edit.runs,
            cell ? cell_whole_style(cell) : undefined,
        )
    ) return { kind: 'text', value };
    let date_mode: 0 | 1 = cell?.numberFormat?.date1904 ? 1 : 0;
    if (
        date_mode === 0
        && cell?.xlsxIsoDate === true
        && cell.numericRaw !== undefined
        && typeof cell.raw === 'string'
    ) {
        const serial_1904 = iso_to_serial(cell.raw, 1);
        if (
            serial_1904 !== null
            && Math.abs(serial_1904 - cell.numericRaw) < 1e-9
        ) date_mode = 1;
    }
    const classified = classify_xlsx_cell_value(value, {
        datemode: date_mode,
        was_boolean: cell?.rawType === 'boolean',
        was_iso_date: cell?.xlsxIsoDate === true,
        is_date_style: (serial) => cell?.numberFormat !== undefined
            && number_format_is_date(cell.numberFormat, serial),
    });
    if (classified.kind === 'empty') return BLANK;
    if (classified.kind === 'boolean') {
        return { kind: 'boolean', value: classified.text === '1' ? 1 : 0 };
    }
    if (classified.kind === 'number') return finite_number(Number(classified.text));
    if (classified.kind === 'iso-date') {
        const serial = iso_to_serial(classified.text, date_mode);
        return serial === null ? { kind: 'text', value } : finite_number(serial);
    }
    return { kind: 'text', value: classified.text };
}

function arithmetic_number(value: FormulaValue): number | Scalar {
    if (value.kind === 'number') return value.value;
    if (value.kind === 'boolean') return value.value;
    if (value.kind === 'blank') return 0;
    if (value.kind === 'text') {
        const number = numeric_text(value.value);
        return number === undefined ? NUMERIC_ERROR : number;
    }
    if (value.kind === 'unknown') return value;
    return NUMERIC_ERROR;
}

function arithmetic_error(value: number | Scalar): Scalar | undefined {
    return typeof value === 'number' ? undefined : value;
}

function result_text(value: number): string {
    // Excel stores at most 15 significant decimal digits. Trimming at the same
    // point also keeps ordinary expressions such as 0.1+0.2 out of the UI as a
    // JavaScript implementation detail.
    return String(Number(value.toPrecision(15)));
}

/**
 * The workbook a calculation request's layouts describe, as Formula Anchors
 * render against it: each worksheet's layout, append band, and Pending Tail
 * Removals, with no cell content.
 */
export function formula_calculation_workbook(
    sheets: readonly {
        readonly name: string;
        readonly worksheetId?: string;
        readonly sourceRowCount: number;
        readonly columnCount: number;
    }[],
    layouts: readonly FormulaCalculationLayout[],
): FormulaAnchorWorkbook {
    return formula_anchor_workbook('xlsx', sheets.map((sheet, sheetIndex) => ({
        target: {
            sheetIndex,
            sheetName: sheet.name,
            ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
        },
        name: sheet.name,
        bodyStart: layouts[sheetIndex].bodyStart,
        sourceRowCount: sheet.sourceRowCount,
        sourceColumnCount: sheet.columnCount,
        changes: {
            appendedRows: layouts[sheetIndex].band.map((id, createdOrder) => ({
                id,
                cells: {},
                formatTemplateId: '',
                createdOrder,
            })),
            tailRemovals: (layouts[sheetIndex].tailRemovedSourceRows ?? []).map((sourceRow) => ({
                appendHistoryId: '',
                sourceRow,
                savedFingerprint: '',
                savedRow: { cells: {}, format: { kind: 'none' } },
            })),
            ...(layouts[sheetIndex].rowLayout === undefined
                ? {}
                : { rowLayout: layouts[sheetIndex].rowLayout }),
            ...(layouts[sheetIndex].columnLayout === undefined
                ? {}
                : { columnLayout: layouts[sheetIndex].columnLayout }),
        },
    })));
}

/**
 * Calculate selected formulas against canonical workbook coordinates.
 *
 * The interface names only edits and targets. Formula parsing, recursion,
 * cross-sheet lookup, range streaming, memoization, and error containment stay
 * behind this seam. Memory is O(targets + edits + one 8K-cell range chunk),
 * not O(the workbook or the request's point-reference count).
 */
function* calculate_workbook_formula_steps(
    source: DataSource,
    request: FormulaCalculationRequest,
    max_work?: number,
): CalculationSteps<readonly FormulaCalculationResult[]> {
    const sheets = source.meta().sheets;
    const layouts = request.layouts !== undefined && request.layouts.length === sheets.length
        ? request.layouts
        : undefined;
    // The prospective cell accessor: every address maps through the layouts
    // to an identity, and only a source identity reads the file.
    const workbook: FormulaAnchorWorkbook | undefined = layouts === undefined
        ? undefined
        : formula_calculation_workbook(sheets, layouts);
    const row_counts = sheets.map((sheet, sheet_index) => workbook !== undefined
        ? prospective_row_count(workbook.worksheets[sheet_index])
        : request.prospectiveRowCounts?.[sheet_index] ?? sheet.sourceRowCount);
    const column_counts = sheets.map((sheet, sheet_index) => workbook !== undefined
        ? prospective_column_count(workbook.worksheets[sheet_index])
        : sheet.columnCount);
    /** Source column of each prospective column; `undefined` for a Pending Column. */
    const source_columns = sheets.map((sheet, sheet_index) => {
        if (workbook === undefined) return undefined;
        return Array.from({ length: column_counts[sheet_index] }, (_, column) => {
            const identity = workbook.worksheets[sheet_index].columns.identity_at(column + 1);
            return identity?.kind === 'source' ? identity.sourceColumn : undefined;
        });
    });
    /** Header names in prospective column order; a Pending Column has no source name. */
    const column_names = sheets.map((sheet, sheet_index) => {
        const mapped = source_columns[sheet_index];
        if (mapped === undefined || sheet.columnNames === undefined) return sheet.columnNames;
        return mapped.map((column) => column === undefined ? '' : sheet.columnNames![column] ?? '');
    });
    /** Source row of a prospective row, or `undefined` for a Pending Row or an empty row. */
    const source_row_of = (sheet_index: number, row: number): number | undefined => {
        if (workbook === undefined) return row;
        const rows = workbook.worksheets[sheet_index].rows;
        if (row < rows.fixedCount) return row;
        const identity = rows.identity_at(row + 1);
        return identity?.kind === 'source' ? identity.sourceRow : undefined;
    };
    const removed_rows = new Set(workbook !== undefined ? [] : (request.removedRows ?? []).map(
        ({ sheetIndex, row }) => `${sheetIndex}:${row}`,
    ));
    const sheet_names = sheets.map((sheet) => sheet.name);
    const sheet_lookup = new Map(sheet_names.map((name, index) => [name.toUpperCase(), index]));
    const edits = new Map(request.edits.map((edit) => [address_key(edit), edit]));
    const pending_header_names = new Map<string, string>();
    const header_name_counts = sheets.map((_sheet, sheet_index) => {
        const counts = new Map<string, number>();
        for (const name of column_names[sheet_index] ?? []) {
            const key = name.toLocaleLowerCase();
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return counts;
    });
    for (const edit of request.edits) {
        const sheet = sheets[edit.sheetIndex];
        const header_row = sheet?.excelFirstRowHeader?.sourceRow ?? 0;
        if (
            sheet?.excelFirstRowHeader?.active === true
            && edit.row === header_row
            && edit.column >= 0
            && edit.column < (column_names[edit.sheetIndex]?.length ?? 0)
            && !edit.writesFormula
        ) pending_header_names.set(`${edit.sheetIndex}:${edit.column}`, edit.value.trim());
    }
    const targets = new Set(request.targets.map(address_key));
    const memo = new Map<string, Scalar>();
    const visiting = new Set<string>();
    let parser_work = 0;
    let work_remaining = max_work;

    const consume_work = (units: number): void => {
        if (work_remaining === undefined) return;
        if (units > work_remaining) throw CALCULATION_WORK_EXHAUSTED;
        work_remaining -= units;
    };

    const parser_checkpoint = function* (): CalculationSteps<void> {
        parser_work += 1;
        if (parser_work >= PARSER_WORK_PER_CHECKPOINT) {
            parser_work = 0;
            yield;
        }
    };

    const valid_address = (address: FormulaCalculationAddress): boolean => {
        const sheet = sheets[address.sheetIndex];
        return sheet !== undefined
            && Number.isInteger(address.row)
            && address.row >= 0
            && address.row < row_counts[address.sheetIndex]
            && Number.isInteger(address.column)
            && address.column >= 0
            && address.column < column_counts[address.sheetIndex];
    };

    const read_cells = (
        sheet_index: number,
        start_row: number,
        count: number,
        columns: readonly number[],
    ): (RenderedCell | null)[][] => {
        consume_work(count * columns.length);
        const rows = Array.from(
            { length: count },
            () => columns.map(() => null as RenderedCell | null),
        );
        if (workbook !== undefined) {
            read_prospective_cells(sheet_index, start_row, columns, rows);
            return rows;
        }
        const physical_row_count = sheets[sheet_index]?.sourceRowCount ?? 0;
        const physical_count = Math.max(
            0,
            Math.min(count, physical_row_count - start_row),
        );
        if (physical_count > 0) {
            const canonical = source.read_canonical_columns?.(
                sheet_index, start_row, physical_count, columns,
            );
            const physical_rows = (canonical ?? read_source_columns(
                source, sheet_index, start_row, physical_count, columns,
            )).rows;
            for (let offset = 0; offset < physical_count; offset += 1) {
                if (!removed_rows.has(`${sheet_index}:${start_row + offset}`)) {
                    rows[offset] = physical_rows[offset] ?? rows[offset];
                }
            }
        }
        return rows;
    };

    /**
     * Fill `rows` (prospective rows from `start_row`, prospective `columns`)
     * from the file: each run of prospective rows whose source rows are
     * consecutive is one read of the source columns those columns map to.
     * Pending Rows, Pending Columns, and empty rows stay blank.
     */
    const read_prospective_cells = (
        sheet_index: number,
        start_row: number,
        columns: readonly number[],
        rows: (RenderedCell | null)[][],
    ): void => {
        const mapped = columns.map((column) => source_columns[sheet_index]?.[column]);
        const read_columns = [...new Set(mapped.filter((column): column is number => column !== undefined))];
        if (read_columns.length === 0) return;
        const position = new Map(read_columns.map((column, index) => [column, index]));
        const physical_row_count = sheets[sheet_index]?.sourceRowCount ?? 0;
        let offset = 0;
        while (offset < rows.length) {
            const first = source_row_of(sheet_index, start_row + offset);
            if (first === undefined || first >= physical_row_count) {
                offset += 1;
                continue;
            }
            let length = 1;
            while (offset + length < rows.length
                && source_row_of(sheet_index, start_row + offset + length) === first + length
                && first + length < physical_row_count) length += 1;
            const canonical = source.read_canonical_columns?.(sheet_index, first, length, read_columns);
            const physical_rows = (canonical ?? read_source_columns(
                source, sheet_index, first, length, read_columns,
            )).rows;
            for (let index = 0; index < length; index += 1) {
                const physical = physical_rows[index];
                if (physical === undefined) continue;
                rows[offset + index] = mapped.map((column) =>
                    column === undefined ? null : physical[position.get(column)!] ?? null);
            }
            offset += length;
        }
    };

    const read_cell = (address: FormulaCalculationAddress): RenderedCell | null | undefined => (
        read_cells(address.sheetIndex, address.row, 1, [address.column])[0]?.[0]
    );

    /**
     * The text a formula evaluates as: rendered from its anchors for the
     * request's layouts, implicit anchors for a source formula. Without
     * layouts it is the stored text.
     */
    const rendered_formula = (
        text: string,
        anchors: FormulaAnchors | undefined,
        sheet_index: number,
    ): string | Scalar => {
        if (workbook === undefined) return text;
        try {
            const rendered = render_formula(text, anchors, formula_anchor_context(workbook, sheet_index));
            return rendered.kind === 'rendered'
                ? rendered.text
                : { kind: 'unknown', error: unrenderable_formula_reason(rendered.issue) };
        } catch {
            return PARSE_ERROR;
        }
    };

    let evaluate_cell!: (
        address: FormulaCalculationAddress,
        supplied?: RenderedCell | null,
    ) => CalculationSteps<Scalar>;

    class Parser {
        private offset = 1;

        constructor(
            private readonly formula: string,
            private readonly formula_sheet_index: number,
            private readonly formula_row: number,
        ) {}

        *parse(): CalculationSteps<Scalar> {
            if (
                !is_xlsx_formula_text(this.formula)
                || this.formula.length > MAX_CALCULATED_FORMULA_LENGTH
            ) return PARSE_ERROR;
            // Excel evaluates any formula holding `#REF!` to that error, and
            // no function the calculator supports can catch one.
            if (formula_ref_error_count(this.formula) > 0) return INVALID_REFERENCE;
            consume_work(this.formula.length);
            const value = yield* this.additive();
            yield* this.whitespace();
            if (this.offset !== this.formula.length || value.kind === 'range') {
                if (this.offset === this.formula.length && value.kind === 'range') {
                    return RANGE_NOT_DISPLAYABLE;
                }
                return value.kind === 'unknown' && value.error === 'unsupported function'
                    ? value
                    : PARSE_ERROR;
            }
            return value;
        }

        private *whitespace(): CalculationSteps<void> {
            let scanned = 0;
            while (/\s/.test(this.formula[this.offset] ?? '')) {
                this.offset += 1;
                scanned += 1;
                if (scanned >= PARSER_WORK_PER_CHECKPOINT) {
                    scanned = 0;
                    yield;
                }
            }
        }

        private *additive(): CalculationSteps<FormulaValue> {
            let left = yield* this.multiplicative();
            while (true) {
                yield* this.whitespace();
                const operator = this.formula[this.offset];
                if (operator !== '+' && operator !== '-') return left;
                this.offset += 1;
                const right = yield* this.multiplicative();
                const a = arithmetic_number(left);
                const b = arithmetic_number(right);
                left = arithmetic_error(a) ?? arithmetic_error(b)
                    ?? finite_number(operator === '+' ? (a as number) + (b as number)
                        : (a as number) - (b as number));
            }
        }

        private *multiplicative(): CalculationSteps<FormulaValue> {
            let left = yield* this.power();
            while (true) {
                yield* this.whitespace();
                const operator = this.formula[this.offset];
                if (operator !== '*' && operator !== '/') return left;
                this.offset += 1;
                const right = yield* this.power();
                const a = arithmetic_number(left);
                const b = arithmetic_number(right);
                left = arithmetic_error(a) ?? arithmetic_error(b)
                    ?? (operator === '/' && b === 0
                        ? NUMERIC_ERROR
                        : finite_number(operator === '*'
                            ? (a as number) * (b as number)
                            : (a as number) / (b as number)));
            }
        }

        private *power(): CalculationSteps<FormulaValue> {
            let left = yield* this.unary();
            while (true) {
                yield* this.whitespace();
                if (this.formula[this.offset] !== '^') return left;
                this.offset += 1;
                const right = yield* this.unary();
                const a = arithmetic_number(left);
                const b = arithmetic_number(right);
                left = arithmetic_error(a) ?? arithmetic_error(b)
                    ?? finite_number((a as number) ** (b as number));
            }
        }

        private *unary(): CalculationSteps<FormulaValue> {
            yield* this.whitespace();
            const operator = this.formula[this.offset];
            if (operator === '+' || operator === '-') {
                this.offset += 1;
                const value = arithmetic_number(yield* this.unary());
                return arithmetic_error(value)
                    ?? finite_number(operator === '-' ? -(value as number) : value as number);
            }
            let value = yield* this.primary();
            yield* this.whitespace();
            while (this.formula[this.offset] === '%') {
                const number = arithmetic_number(value);
                value = arithmetic_error(number) ?? finite_number((number as number) / 100);
                this.offset += 1;
                yield* parser_checkpoint();
                yield* this.whitespace();
            }
            return value;
        }

        private *primary(): CalculationSteps<FormulaValue> {
            yield* parser_checkpoint();
            yield* this.whitespace();
            if (this.formula[this.offset] === '(') {
                this.offset += 1;
                const value = yield* this.additive();
                yield* this.whitespace();
                if (this.formula[this.offset] !== ')') return PARSE_ERROR;
                this.offset += 1;
                return value;
            }

            const structured = structured_formula_reference_at(this.formula, this.offset);
            if (structured) {
                this.offset += structured.length;
                const ref = structured.reference;
                const source_sheet = ref.sheetName === undefined
                    ? this.formula_sheet_index
                    : sheets.findIndex((sheet) => sheet.name.localeCompare(
                        ref.sheetName!, undefined, { sensitivity: 'accent' },
                    ) === 0);
                if (source_sheet < 0) return PARSE_ERROR;
                const sheet = sheets[source_sheet];
                const names = column_names[source_sheet];
                if (!sheet.excelFirstRowHeader?.active || !names) {
                    return HEADER_ROW_OFF;
                }
                const matches: number[] = [];
                for (let column = 0; column < names.length; column += 1) {
                    const original = names[column];
                    // A Pending Column has no source header to match.
                    if (source_columns[source_sheet] !== undefined
                        && source_columns[source_sheet]![column] === undefined) continue;
                    const pending = pending_header_names.get(`${source_sheet}:${column}`);
                    const original_is_unique = header_name_counts[source_sheet]
                        .get(original.toLocaleLowerCase()) === 1;
                    if (
                        (pending ?? original).localeCompare(
                            ref.columnName, undefined, { sensitivity: 'accent' },
                        ) === 0
                        || (pending !== undefined && original_is_unique && original.localeCompare(
                            ref.columnName, undefined, { sensitivity: 'accent' },
                        ) === 0)
                    ) matches.push(column);
                }
                if (matches.length === 0) return UNKNOWN_COLUMN;
                if (matches.length > 1) return AMBIGUOUS_COLUMN;
                const header_row = sheet.excelFirstRowHeader.sourceRow ?? 0;
                if (ref.intersection) {
                    if (this.formula_row <= header_row
                        || this.formula_row >= row_counts[source_sheet]) {
                        return ROW_OUTSIDE_BODY;
                    }
                    return yield* evaluate_cell({
                        sheetIndex: source_sheet,
                        row: this.formula_row,
                        column: matches[0],
                    });
                }
                return {
                    kind: 'range',
                    sheetIndex: source_sheet,
                    firstRow: header_row + 1,
                    firstColumn: matches[0],
                    lastRow: row_counts[source_sheet] - 1,
                    lastColumn: matches[0],
                };
            }

            const reference = a1_formula_reference_at(this.formula, this.offset);
            if (reference) {
                this.offset += reference.length;
                const ref = reference.reference;
                const source_sheet = ref.sheetName === undefined
                    ? this.formula_sheet_index
                    : sheet_lookup.get(ref.sheetName.toUpperCase());
                if (source_sheet === undefined) return PARSE_ERROR;
                const sheet = sheets[source_sheet];
                if (!sheet) return PARSE_ERROR;
                const first_row = Math.max(0, ref.firstRow);
                const first_column = Math.max(0, ref.firstColumn);
                const last_row = Math.min(ref.lastRow, row_counts[source_sheet] - 1);
                const last_column = Math.min(ref.lastColumn, column_counts[source_sheet] - 1);
                const single_cell = ref.firstRow === ref.lastRow
                    && ref.firstColumn === ref.lastColumn;
                if (single_cell && (first_row > last_row || first_column > last_column)) {
                    return BLANK;
                }
                if (single_cell) {
                    return yield* evaluate_cell({
                        sheetIndex: source_sheet,
                        row: first_row,
                        column: first_column,
                    });
                }
                return {
                    kind: 'range',
                    sheetIndex: source_sheet,
                    firstRow: first_row,
                    firstColumn: first_column,
                    lastRow: last_row,
                    lastColumn: last_column,
                };
            }

            const number = this.formula.slice(this.offset).match(
                /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/,
            );
            if (number) {
                this.offset += number[0].length;
                return finite_number(Number(number[0]));
            }

            const identifier = this.formula.slice(this.offset).match(/^([A-Za-z_][A-Za-z0-9_.]*)/);
            if (!identifier) return PARSE_ERROR;
            this.offset += identifier[0].length;
            yield* this.whitespace();
            if (this.formula[this.offset] !== '(') return PARSE_ERROR;
            this.offset += 1;
            return yield* this.call(identifier[1].toUpperCase());
        }

        private *call(name: string): CalculationSteps<FormulaValue> {
            if (name !== 'SUM' && name !== 'AVERAGE') {
                // Consume nothing else. The outer full-input check will reject
                // this formula without accidentally recognizing references
                // inside an unsupported function as a partial calculation.
                return UNSUPPORTED_FUNCTION;
            }
            let total = 0;
            let count = 0;
            let calculation_error: Scalar | undefined;
            yield* this.whitespace();
            if (this.formula[this.offset] === ')') {
                this.offset += 1;
                return name === 'SUM' ? finite_number(0) : NUMERIC_ERROR;
            }
            while (true) {
                const argument = yield* this.additive();
                const error = argument.kind === 'range'
                    ? yield* this.aggregate_range(argument, (number) => {
                        total += number;
                        count += 1;
                    })
                    : argument.kind === 'number'
                    ? (total += argument.value, count += 1, undefined)
                    : argument.kind === 'unknown' ? argument : undefined;
                calculation_error ??= error;
                if (!Number.isFinite(total)) return NUMERIC_ERROR;
                yield* this.whitespace();
                if (this.formula[this.offset] === ')') {
                    this.offset += 1;
                    break;
                }
                if (this.formula[this.offset] !== ',') return PARSE_ERROR;
                this.offset += 1;
            }
            if (calculation_error) return calculation_error;
            return name === 'AVERAGE'
                ? count === 0 ? NUMERIC_ERROR : finite_number(total / count)
                : finite_number(total);
        }

        private *aggregate_range(
            range: RangeValue,
            accept: (number: number) => void,
        ): CalculationSteps<Scalar | undefined> {
            for (
                let column_start = range.firstColumn;
                column_start <= range.lastColumn;
                column_start += MAX_RANGE_COLUMNS_PER_READ
            ) {
                const column_count = Math.min(
                    MAX_RANGE_COLUMNS_PER_READ,
                    range.lastColumn - column_start + 1,
                );
                const columns = Array.from({ length: column_count }, (_, i) => column_start + i);
                const rows_per_read = Math.max(1, Math.floor(MAX_RANGE_CELLS_PER_READ / column_count));
                for (
                    let row_start = range.firstRow;
                    row_start <= range.lastRow;
                    row_start += rows_per_read
                ) {
                    const row_count = Math.min(rows_per_read, range.lastRow - row_start + 1);
                    const rows = read_cells(range.sheetIndex, row_start, row_count, columns);
                    for (let row_offset = 0; row_offset < row_count; row_offset += 1) {
                        for (let column_offset = 0; column_offset < columns.length; column_offset += 1) {
                            const address = {
                                sheetIndex: range.sheetIndex,
                                row: row_start + row_offset,
                                column: columns[column_offset],
                            };
                            const scalar = yield* evaluate_cell(
                                address,
                                rows[row_offset]?.[column_offset] ?? null,
                            );
                            if (scalar.kind === 'unknown') return scalar;
                            if (scalar.kind === 'number') accept(scalar.value);
                        }
                    }
                    yield;
                }
            }
            return undefined;
        }
    }

    evaluate_cell = function* (address, supplied): CalculationSteps<Scalar> {
        if (!valid_address(address)) return PARSE_ERROR;
        const key = address_key(address);
        const cached = memo.get(key);
        if (cached) return cached;
        if (visiting.has(key)) return CYCLE;

        const edit = edits.get(key);
        const cell = supplied === undefined ? read_cell(address) : supplied;
        const stored_formula = edit?.writesFormula === true
            ? edit.value
            : edit === undefined ? cell?.formula : undefined;
        const rendered = stored_formula === undefined
            ? undefined
            : rendered_formula(stored_formula, edit?.formulaAnchors, address.sheetIndex);
        if (rendered !== undefined && typeof rendered !== 'string') {
            memo.set(key, rendered);
            return rendered;
        }
        const formula = rendered;
        // Some OOXML formula producers (notably what-if data tables) expose a
        // dependency target but no evaluable formula text. A requested target
        // without source text is opaque, not the cached literal currently in
        // its `<v>`; returning that literal would preserve the stale cache.
        if (edit === undefined && targets.has(key) && formula === undefined) {
            memo.set(key, UNSUPPORTED_FUNCTION);
            return UNSUPPORTED_FUNCTION;
        }
        const evaluates_formula = formula !== undefined
            && (edit !== undefined || targets.has(key) || cell?.formulaResultPending === true);
        if (evaluates_formula) {
            visiting.add(key);
            const value = yield* new Parser(formula, address.sheetIndex, address.row).parse();
            visiting.delete(key);
            memo.set(key, value);
            return value;
        }
        const value = edit === undefined ? scalar_from_cell(cell) : scalar_from_edit(edit, cell);
        // Retain request-owned edits and targets, but not ordinary source
        // literals. A legal request can contain a million distinct point
        // references; memoizing those values would turn calculation into a
        // second in-memory copy of that part of the workbook. Formula values
        // were handled above and remain memoized for recursive dependents.
        if (edit !== undefined || targets.has(key)) memo.set(key, value);
        return value;
    };

    const results: FormulaCalculationResult[] = [];
    for (const target of request.targets) {
        let calculated: Scalar;
        try {
            calculated = yield* evaluate_cell(target);
        } catch (error) {
            if (error === CALCULATION_WORK_EXHAUSTED) return results;
            throw error;
        }
        results.push(calculated.kind === 'number'
            ? { ...target, value: result_text(calculated.value) }
            : { ...target, error: calculated.kind === 'unknown'
                ? calculated.error
                : 'numeric error' });
        yield;
    }
    return results;
}

/** Calculate synchronously for save planning and focused callers. */
export function calculate_workbook_formulas(
    source: DataSource,
    request: FormulaCalculationRequest,
): readonly FormulaCalculationResult[] {
    const steps = calculate_workbook_formula_steps(source, request);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
}

/**
 * Calculate as much trustworthy cache data as a synchronous save can afford.
 * Missing results intentionally mean "invalidate only" to the XLSX write-plan
 * factory, so work beyond the budget is delegated to Excel after reopen.
 */
export function calculate_workbook_formulas_bounded(
    source: DataSource,
    request: FormulaCalculationRequest,
): readonly FormulaCalculationResult[] {
    const steps = calculate_workbook_formula_steps(
        source,
        request,
        MAX_SYNCHRONOUS_CALCULATION_WORK,
    );
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
}

/**
 * Calculate without monopolizing the host event loop. Range reads stay bounded,
 * and stale live requests stop between chunks instead of finishing discarded work.
 */
export async function calculate_workbook_formulas_cooperatively(
    source: DataSource,
    request: FormulaCalculationRequest,
    schedule: FormulaCalculationSchedule,
): Promise<readonly FormulaCalculationResult[] | undefined> {
    const steps = calculate_workbook_formula_steps(source, request);
    const work_slice_ms = Math.max(0, schedule.workSliceMs ?? 8);
    const yield_control = schedule.yieldControl ?? (() => new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0);
    }));
    if (schedule.isCancelled()) return undefined;
    let slice_started = performance.now();
    let step = steps.next();
    while (!step.done) {
        if (schedule.isCancelled()) return undefined;
        if (performance.now() - slice_started >= work_slice_ms) {
            await yield_control();
            if (schedule.isCancelled()) return undefined;
            slice_started = performance.now();
        }
        step = steps.next();
    }
    return schedule.isCancelled() ? undefined : step.value;
}

/** Wire/UI spelling for a missing calculation. */
export function displayed_formula_result(result: FormulaCalculationResult): string {
    return result.value
        ?? `${UNKNOWN_XLSX_FORMULA_RESULT} (${result.error})`;
}
