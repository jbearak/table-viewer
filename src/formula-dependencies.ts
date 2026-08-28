import type { PackedFormulaDependencies } from './data-source/interface';

const MAX_ROW = 1_048_576;
const MAX_COLUMN = 16_384;
const DEPENDENCY_STRIDE = 7;
const RANGE_STRIDE = 5;
const EXACT_STRIDE = 3;
const RANGE_BUCKET_SPAN = 64;

export interface WorkbookCellAddress {
    readonly sheetIndex: number;
    readonly row: number;
    readonly column: number;
}

export interface FormulaSheetImpact {
    readonly size: number;
    has(row: number, column: number): boolean;
    keys(): IterableIterator<string>;
    cells(): IterableIterator<{ readonly row: number; readonly column: number }>;
}

export interface WorkbookFormulaImpact {
    readonly size: number;
    forSheet(sheetIndex: number): FormulaSheetImpact;
}

export interface WorkbookFormulaGraph {
    invalidatedBy(changed: Iterable<WorkbookCellAddress>): WorkbookFormulaImpact;
}

interface CompiledSourceSheet {
    readonly exact: Uint32Array;
    readonly ranges: Uint32Array;
    readonly rangesByColumn: ReadonlyMap<number, Uint32Array>;
    readonly rangesByRow: ReadonlyMap<number, Uint32Array>;
    readonly broadRanges: Uint32Array;
}

function valid_coordinate(row: number, column: number): boolean {
    return Number.isSafeInteger(row) && row >= 0 && row < MAX_ROW
        && Number.isSafeInteger(column) && column >= 0 && column < MAX_COLUMN;
}

function cell_number(row: number, column: number): number {
    return row * MAX_COLUMN + column;
}

function compile_bucket_map(source: Map<number, number[]>): ReadonlyMap<number, Uint32Array> {
    return new Map([...source].map(([key, values]) => [key, Uint32Array.from(values)]));
}

/** Compile the packed topology once for one immutable workbook snapshot. */
export function compile_workbook_formula_graph(
    sheets: readonly { readonly formulaDependencies?: PackedFormulaDependencies }[],
): WorkbookFormulaGraph {
    const formula_sheets: number[] = [];
    const formula_rows: number[] = [];
    const formula_columns: number[] = [];
    const formula_ordinals = new Map<number, Map<number, number>>();
    const exact_by_sheet = sheets.map(() => [] as number[]);
    const ranges_by_sheet = sheets.map(() => [] as number[]);

    const formula_ordinal = (sheet: number, row: number, column: number): number => {
        let by_cell = formula_ordinals.get(sheet);
        if (!by_cell) {
            by_cell = new Map();
            formula_ordinals.set(sheet, by_cell);
        }
        const number = cell_number(row, column);
        const existing = by_cell.get(number);
        if (existing !== undefined) return existing;
        const ordinal = formula_sheets.length;
        by_cell.set(number, ordinal);
        formula_sheets.push(sheet);
        formula_rows.push(row);
        formula_columns.push(column);
        return ordinal;
    };

    sheets.forEach((sheet, formula_sheet) => {
        const dependencies = sheet.formulaDependencies ?? [];
        if (dependencies.length % DEPENDENCY_STRIDE !== 0) {
            throw new Error('Malformed packed formula dependencies');
        }
        for (let offset = 0; offset < dependencies.length; offset += DEPENDENCY_STRIDE) {
            const formula_row = dependencies[offset];
            const formula_column = dependencies[offset + 1];
            const source_sheet = dependencies[offset + 2];
            const first_row = dependencies[offset + 3];
            const first_column = dependencies[offset + 4];
            const last_row = dependencies[offset + 5];
            const last_column = dependencies[offset + 6];
            if (
                !valid_coordinate(formula_row, formula_column)
                || !Number.isSafeInteger(source_sheet)
                || source_sheet < 0
                || source_sheet >= sheets.length
                || !valid_coordinate(first_row, first_column)
                || !valid_coordinate(last_row, last_column)
                || first_row > last_row
                || first_column > last_column
            ) throw new Error('Malformed packed formula dependency record');
            const ordinal = formula_ordinal(formula_sheet, formula_row, formula_column);
            if (first_row === last_row && first_column === last_column) {
                exact_by_sheet[source_sheet].push(first_row, first_column, ordinal);
            } else {
                ranges_by_sheet[source_sheet].push(
                    first_row, first_column, last_row, last_column, ordinal,
                );
            }
        }
    });

    const sources = sheets.map((_, sheet_index): CompiledSourceSheet => {
        const exact = exact_by_sheet[sheet_index];
        const exact_order = Array.from(
            { length: exact.length / EXACT_STRIDE },
            (_, index) => index,
        );
        exact_order.sort((left, right) => {
            const left_offset = left * EXACT_STRIDE;
            const right_offset = right * EXACT_STRIDE;
            return (exact[left_offset] - exact[right_offset])
                || (exact[left_offset + 1] - exact[right_offset + 1])
                || (exact[left_offset + 2] - exact[right_offset + 2]);
        });
        const sorted_exact = new Uint32Array(exact.length);
        exact_order.forEach((record, target) => {
            const source_offset = record * EXACT_STRIDE;
            const target_offset = target * EXACT_STRIDE;
            sorted_exact[target_offset] = exact[source_offset];
            sorted_exact[target_offset + 1] = exact[source_offset + 1];
            sorted_exact[target_offset + 2] = exact[source_offset + 2];
        });

        const ranges = ranges_by_sheet[sheet_index];
        const by_column = new Map<number, number[]>();
        const by_row = new Map<number, number[]>();
        const broad: number[] = [];
        for (let offset = 0, range_id = 0; offset < ranges.length;
            offset += RANGE_STRIDE, range_id += 1) {
            const first_row = ranges[offset];
            const first_column = ranges[offset + 1];
            const last_row = ranges[offset + 2];
            const last_column = ranges[offset + 3];
            const width = last_column - first_column + 1;
            const height = last_row - first_row + 1;
            if (width <= RANGE_BUCKET_SPAN) {
                for (let column = first_column; column <= last_column; column += 1) {
                    const bucket = by_column.get(column) ?? [];
                    bucket.push(range_id);
                    by_column.set(column, bucket);
                }
            } else if (height <= RANGE_BUCKET_SPAN) {
                for (let row = first_row; row <= last_row; row += 1) {
                    const bucket = by_row.get(row) ?? [];
                    bucket.push(range_id);
                    by_row.set(row, bucket);
                }
            } else {
                broad.push(range_id);
            }
        }
        return {
            exact: sorted_exact,
            ranges: Uint32Array.from(ranges),
            rangesByColumn: compile_bucket_map(by_column),
            rangesByRow: compile_bucket_map(by_row),
            broadRanges: Uint32Array.from(broad),
        };
    });
    const formula_sheets_array = Uint32Array.from(formula_sheets);
    const formula_rows_array = Uint32Array.from(formula_rows);
    const formula_columns_array = Uint32Array.from(formula_columns);
    // Drop the allocation-heavy build structures before the graph enters the
    // edit session. Only typed coordinate/index arrays survive on the hot path.
    formula_ordinals.clear();
    formula_sheets.length = 0;
    formula_rows.length = 0;
    formula_columns.length = 0;
    exact_by_sheet.length = 0;
    ranges_by_sheet.length = 0;

    return {
        invalidatedBy(changed) {
            const queued_by_sheet = new Map<number, Set<number>>();
            const queue: WorkbookCellAddress[] = [];
            const enqueue_cell = (cell: WorkbookCellAddress): boolean => {
                if (
                    !Number.isSafeInteger(cell.sheetIndex)
                    || cell.sheetIndex < 0
                    || cell.sheetIndex >= sources.length
                    || !valid_coordinate(cell.row, cell.column)
                ) return false;
                const number = cell_number(cell.row, cell.column);
                const queued = queued_by_sheet.get(cell.sheetIndex) ?? new Set<number>();
                if (queued.has(number)) return false;
                queued.add(number);
                queued_by_sheet.set(cell.sheetIndex, queued);
                queue.push(cell);
                return true;
            };
            for (const cell of changed) enqueue_cell(cell);

            const visited = new Uint8Array(formula_sheets_array.length);
            const affected_by_sheet = new Map<number, Set<number>>();
            let affected_size = 0;
            const enqueue_formula = (ordinal: number): void => {
                if (visited[ordinal]) return;
                visited[ordinal] = 1;
                affected_size += 1;
                const sheet = formula_sheets_array[ordinal];
                const row = formula_rows_array[ordinal];
                const column = formula_columns_array[ordinal];
                const affected = affected_by_sheet.get(sheet) ?? new Set<number>();
                affected.add(cell_number(row, column));
                affected_by_sheet.set(sheet, affected);
                enqueue_cell({ sheetIndex: sheet, row, column });
            };
            const visit_range = (
                source: CompiledSourceSheet,
                range_id: number,
                row: number,
                column: number,
            ): void => {
                const offset = range_id * RANGE_STRIDE;
                if (
                    row >= source.ranges[offset]
                    && row <= source.ranges[offset + 2]
                    && column >= source.ranges[offset + 1]
                    && column <= source.ranges[offset + 3]
                ) enqueue_formula(source.ranges[offset + 4]);
            };

            for (let cursor = 0; cursor < queue.length; cursor += 1) {
                const cell = queue[cursor];
                const source = sources[cell.sheetIndex];
                let low = 0;
                let high = source.exact.length / EXACT_STRIDE;
                while (low < high) {
                    const middle = (low + high) >>> 1;
                    const offset = middle * EXACT_STRIDE;
                    const before = source.exact[offset] < cell.row
                        || (source.exact[offset] === cell.row
                            && source.exact[offset + 1] < cell.column);
                    if (before) low = middle + 1;
                    else high = middle;
                }
                for (let record = low; record < source.exact.length / EXACT_STRIDE; record += 1) {
                    const offset = record * EXACT_STRIDE;
                    if (
                        source.exact[offset] !== cell.row
                        || source.exact[offset + 1] !== cell.column
                    ) break;
                    enqueue_formula(source.exact[offset + 2]);
                }
                for (const id of source.rangesByColumn.get(cell.column) ?? []) {
                    visit_range(source, id, cell.row, cell.column);
                }
                for (const id of source.rangesByRow.get(cell.row) ?? []) {
                    visit_range(source, id, cell.row, cell.column);
                }
                for (const id of source.broadRanges) {
                    visit_range(source, id, cell.row, cell.column);
                }
            }

            const empty: FormulaSheetImpact = {
                size: 0,
                has: () => false,
                *keys() {},
                *cells() {},
            };
            const projections = new Map<number, FormulaSheetImpact>();
            return {
                size: affected_size,
                forSheet(sheetIndex) {
                    const projected = projections.get(sheetIndex);
                    if (projected) return projected;
                    const affected = affected_by_sheet.get(sheetIndex);
                    if (!affected) return empty;
                    const created: FormulaSheetImpact = {
                        size: affected.size,
                        has: (row, column) => affected.has(cell_number(row, column)),
                        *keys() {
                            for (const number of affected) {
                                yield `${Math.floor(number / MAX_COLUMN)}:${number % MAX_COLUMN}`;
                            }
                        },
                        *cells() {
                            for (const number of affected) {
                                yield {
                                    row: Math.floor(number / MAX_COLUMN),
                                    column: number % MAX_COLUMN,
                                };
                            }
                        },
                    };
                    projections.set(sheetIndex, created);
                    return created;
                },
            };
        },
    };
}
