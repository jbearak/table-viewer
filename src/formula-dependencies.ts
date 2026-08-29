import type {
    PackedFormulaDependencies,
    PackedStructuredFormulaReferences,
} from './data-source/interface';
import {
    MAX_WORKBOOK_FORMULAS,
    MAX_WORKBOOK_FORMULA_REFERENCES,
    MAX_WORKBOOK_FORMULA_RANGES,
    assert_safe_xlsx_formula_text,
} from './spreadsheet-safety';
import { parse_cell_key } from './cell-key';
import {
    is_xlsx_formula_text,
    structured_formula_references,
    workbook_a1_formula_references,
} from './xlsx-formula';

const MAX_ROW = 1_048_576;
const MAX_COLUMN = 16_384;
const DEPENDENCY_STRIDE = 7;
const RANGE_STRIDE = 5;
const EXACT_STRIDE = 3;
const COLUMN_TREE_LEAVES = MAX_COLUMN;
const RANGE_INDEX_BLOCK_SIZE = 32;
export const STRUCTURED_REFERENCE_STRIDE = 5;

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

export interface WorkbookFormulaEdit extends WorkbookCellAddress {
    readonly value: string;
    /** Exact classification chosen by the eventual XLSX writer. */
    readonly writesFormula: boolean;
}

export interface WorkbookFormulaPlan {
    readonly sheetCount: number;
    readonly impact: WorkbookFormulaImpact;
    readonly targets: readonly WorkbookCellAddress[];
    /** The edited workbook would exceed the calculation/rendering admission cap. */
    readonly formulaLimitExceeded: boolean;
}

export interface WorkbookFormulaPlanningOptions {
    readonly graph?: WorkbookFormulaGraph;
    readonly impact?: WorkbookFormulaImpact;
    readonly includePending?: boolean;
}

export interface WorkbookFormulaEditBatch {
    readonly sheetIndex: number;
    readonly values: Readonly<Record<string, string>>;
    /** Exact writer classification without copying the save payload. */
    readonly isFormulaValue?: (key: string, value: string) => boolean;
}

/**
 * Validate the final formula/reference budgets without copying a large save payload.
 * Source formulas overwritten by an edit are removed before the replacement text is
 * counted, so replacing formulas does not consume the limits twice.
 */
export function assert_safe_workbook_formula_edits(
    sheets: readonly {
        readonly name: string;
        readonly formulaDependencies?: PackedFormulaDependencies;
        readonly structuredFormulaReferences?: PackedStructuredFormulaReferences;
        readonly formulaCells?: readonly number[];
    }[],
    batches: readonly WorkbookFormulaEditBatch[],
): void {
    const values_by_sheet = new Map<number, WorkbookFormulaEditBatch['values']>();
    for (const batch of batches) values_by_sheet.set(batch.sheetIndex, batch.values);

    const edited_source_formulas = sheets.map(() => new Set<number>());
    let source_formula_count = 0;
    sheets.forEach((sheet, sheetIndex) => {
        const packed = sheet.formulaCells ?? [];
        source_formula_count += validate_formula_cells(packed);
        const values = values_by_sheet.get(sheetIndex);
        if (!values) return;
        for (let offset = 0; offset + 1 < packed.length; offset += 2) {
            const row = packed[offset];
            const column = packed[offset + 1];
            if (Object.hasOwn(values, `${row}:${column}`)) {
                edited_source_formulas[sheetIndex].add(cell_number(row, column));
            }
        }
    });

    let edited_formula_count = 0;
    for (const batch of batches) {
        if (batch.sheetIndex < 0 || batch.sheetIndex >= sheets.length) continue;
        for (const key in batch.values) {
            if (!Object.hasOwn(batch.values, key)) continue;
            const value = batch.values[key];
            const cell = parse_cell_key(key);
            if (
                !cell
                || !valid_coordinate(cell.sourceRow, cell.sourceColumn)
                || !(batch.isFormulaValue?.(key, value) ?? is_xlsx_formula_text(value))
            ) continue;
            assert_safe_xlsx_formula_text(value);
            edited_formula_count += 1;
        }
    }
    const final_formula_count = source_formula_count
        - edited_source_formulas.reduce((count, edited) => count + edited.size, 0)
        + edited_formula_count;
    if (final_formula_count > MAX_WORKBOOK_FORMULAS) {
        throw new Error('Workbook would contain too many formulas to save safely.');
    }
    const overwritten_formula_count = edited_source_formulas.reduce(
        (count, edited) => count + edited.size,
        0,
    );
    if (overwritten_formula_count === 0 && edited_formula_count === 0) return;

    let final_reference_count = 0;
    let final_range_count = 0;
    sheets.forEach((sheet, sheetIndex) => {
        const dependencies = sheet.formulaDependencies ?? [];
        const edited = edited_source_formulas[sheetIndex];
        for (let offset = 0; offset + DEPENDENCY_STRIDE <= dependencies.length;
            offset += DEPENDENCY_STRIDE) {
            if (edited.has(cell_number(dependencies[offset], dependencies[offset + 1]))) {
                continue;
            }
            final_reference_count += 1;
            if (
                dependencies[offset + 3] !== dependencies[offset + 5]
                || dependencies[offset + 4] !== dependencies[offset + 6]
            ) final_range_count += 1;
        }
        const structured = sheet.structuredFormulaReferences?.references ?? [];
        if (structured.length % STRUCTURED_REFERENCE_STRIDE !== 0) {
            throw new Error('Malformed packed structured formula references');
        }
        for (let offset = 0; offset < structured.length;
            offset += STRUCTURED_REFERENCE_STRIDE) {
            if (edited.has(cell_number(structured[offset], structured[offset + 1]))) continue;
            final_reference_count += 1;
            if (structured[offset + 3] === 0) final_range_count += 1;
        }
    });
    const assert_reference_budgets = (): void => {
        if (final_reference_count > MAX_WORKBOOK_FORMULA_REFERENCES) {
            throw new Error(
                'Workbook has too many formula references to open safely '
                + `(max ${MAX_WORKBOOK_FORMULA_REFERENCES.toLocaleString()})`,
            );
        }
        if (final_range_count > MAX_WORKBOOK_FORMULA_RANGES) {
            throw new Error(
                'Workbook has too many formula ranges to index safely '
                + `(max ${MAX_WORKBOOK_FORMULA_RANGES.toLocaleString()})`,
            );
        }
    };
    assert_reference_budgets();
    const sheet_names = sheets.map((sheet) => sheet.name);
    for (const batch of batches) {
        if (batch.sheetIndex < 0 || batch.sheetIndex >= sheets.length) continue;
        for (const key in batch.values) {
            if (!Object.hasOwn(batch.values, key)) continue;
            const value = batch.values[key];
            const cell = parse_cell_key(key);
            if (
                !cell
                || !valid_coordinate(cell.sourceRow, cell.sourceColumn)
                || !(batch.isFormulaValue?.(key, value) ?? is_xlsx_formula_text(value))
            ) continue;
            const references = workbook_a1_formula_references(
                value,
                batch.sheetIndex,
                sheet_names,
            );
            final_reference_count += references.length;
            for (const reference of references) {
                if (
                    reference.firstRow !== reference.lastRow
                    || reference.firstColumn !== reference.lastColumn
                ) final_range_count += 1;
            }
            const structured = structured_formula_references(value);
            final_reference_count += structured.length;
            final_range_count += structured.filter((reference) => !reference.intersection).length;
            assert_reference_budgets();
        }
    }
}

/** Mark every source formula stale when an edit set is too large to traverse live. */
export function all_workbook_formula_cells_impact(
    sheets: readonly { readonly formulaCells?: readonly number[] }[],
): WorkbookFormulaImpact {
    const affected_by_sheet = sheets.map((sheet) => {
        const affected = new Set<number>();
        const packed = sheet.formulaCells ?? [];
        for (let offset = 0; offset + 1 < packed.length; offset += 2) {
            const row = packed[offset];
            const column = packed[offset + 1];
            if (valid_coordinate(row, column)) affected.add(cell_number(row, column));
        }
        return affected;
    });
    const projections = new Map<number, FormulaSheetImpact>();
    const empty: FormulaSheetImpact = {
        size: 0,
        has: () => false,
        *keys() {},
        *cells() {},
    };
    return {
        size: affected_by_sheet.reduce((size, affected) => size + affected.size, 0),
        forSheet(sheetIndex) {
            const existing = projections.get(sheetIndex);
            if (existing) return existing;
            const affected = affected_by_sheet[sheetIndex];
            if (!affected || affected.size === 0) return empty;
            const projection: FormulaSheetImpact = {
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
            projections.set(sheetIndex, projection);
            return projection;
        },
    };
}

function impact_with_added_cells(
    base: WorkbookFormulaImpact,
    added_by_sheet: ReadonlyMap<number, ReadonlySet<number>>,
): WorkbookFormulaImpact {
    let added_size = 0;
    for (const [sheetIndex, added] of added_by_sheet) {
        const existing = base.forSheet(sheetIndex);
        for (const number of added) {
            if (!existing.has(
                Math.floor(number / MAX_COLUMN),
                number % MAX_COLUMN,
            )) added_size += 1;
        }
    }
    if (added_size === 0) return base;
    const projections = new Map<number, FormulaSheetImpact>();
    return {
        size: base.size + added_size,
        forSheet(sheetIndex) {
            const projected = projections.get(sheetIndex);
            if (projected) return projected;
            const existing = base.forSheet(sheetIndex);
            const added = added_by_sheet.get(sheetIndex);
            if (!added || added.size === 0) return existing;
            let sheet_added_size = 0;
            for (const number of added) {
                if (!existing.has(
                    Math.floor(number / MAX_COLUMN),
                    number % MAX_COLUMN,
                )) sheet_added_size += 1;
            }
            const created: FormulaSheetImpact = {
                size: existing.size + sheet_added_size,
                has: (row, column) => existing.has(row, column)
                    || added.has(cell_number(row, column)),
                *keys() {
                    yield* existing.keys();
                    for (const number of added) {
                        const row = Math.floor(number / MAX_COLUMN);
                        const column = number % MAX_COLUMN;
                        if (!existing.has(row, column)) yield `${row}:${column}`;
                    }
                },
                *cells() {
                    yield* existing.cells();
                    for (const number of added) {
                        const row = Math.floor(number / MAX_COLUMN);
                        const column = number % MAX_COLUMN;
                        if (!existing.has(row, column)) yield { row, column };
                    }
                },
            };
            projections.set(sheetIndex, created);
            return created;
        },
    };
}

/** Project packed pending formula pairs without leaking their storage layout. */
export function pending_workbook_formula_targets(
    sheets: readonly { readonly pendingFormulaCells?: readonly number[] }[],
): readonly WorkbookCellAddress[] {
    const targets: WorkbookCellAddress[] = [];
    sheets.forEach((sheet, sheetIndex) => {
        const pending = sheet.pendingFormulaCells ?? [];
        for (let offset = 0; offset + 1 < pending.length; offset += 2) {
            const row = pending[offset];
            const column = pending[offset + 1];
            if (valid_coordinate(row, column)) targets.push({ sheetIndex, row, column });
        }
    });
    return targets;
}

interface CompiledSourceSheet {
    readonly exact: Uint32Array;
    readonly ranges: Uint32Array;
    readonly rangeIndex: CompiledRangeIndex;
}

class IndexedRowIntervals {
    private readonly ids: Uint32Array;
    private readonly block_tree_base: number;
    private readonly block_max: Int32Array;

    constructor(range_ids: number[], private readonly ranges: Uint32Array) {
        range_ids.sort((left, right) => {
            const left_offset = left * RANGE_STRIDE;
            const right_offset = right * RANGE_STRIDE;
            return (ranges[left_offset] - ranges[right_offset])
                || (ranges[left_offset + 2] - ranges[right_offset + 2])
                || (left - right);
        });
        this.ids = Uint32Array.from(range_ids);
        const block_count = Math.ceil(this.ids.length / RANGE_INDEX_BLOCK_SIZE);
        let tree_base = 1;
        while (tree_base < block_count) tree_base *= 2;
        this.block_tree_base = tree_base;
        this.block_max = new Int32Array(tree_base * 2).fill(-1);
        for (let block = 0; block < block_count; block += 1) {
            this.block_max[tree_base + block] = this.max_for_block(block, undefined);
        }
        for (let node = tree_base - 1; node > 0; node -= 1) {
            this.block_max[node] = Math.max(
                this.block_max[node * 2],
                this.block_max[node * 2 + 1],
            );
        }
    }

    createState(): Int32Array {
        return this.block_max.slice();
    }

    visit(
        row: number,
        consumed: Uint8Array,
        block_max: Int32Array,
        accept: (range_id: number) => void,
    ): void {
        const limit = this.first_starting_after(row);
        const complete_blocks = Math.floor(limit / RANGE_INDEX_BLOCK_SIZE);
        while (true) {
            const block = this.find_block(
                block_max,
                1,
                0,
                this.block_tree_base,
                complete_blocks,
                row,
            );
            if (block < 0) break;
            this.visit_block(block, row, consumed, block_max, accept);
        }
        if (limit % RANGE_INDEX_BLOCK_SIZE !== 0) {
            const block = complete_blocks;
            const start = block * RANGE_INDEX_BLOCK_SIZE;
            for (let position = start; position < limit; position += 1) {
                const range_id = this.ids[position];
                if (consumed[range_id]) continue;
                const offset = range_id * RANGE_STRIDE;
                if (this.ranges[offset + 2] < row) continue;
                consumed[range_id] = 1;
                accept(range_id);
            }
            this.update_block(block, consumed, block_max);
        }
    }

    private first_starting_after(row: number): number {
        let low = 0;
        let high = this.ids.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (this.ranges[this.ids[middle] * RANGE_STRIDE] <= row) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    private find_block(
        block_max: Int32Array,
        node: number,
        first: number,
        last: number,
        limit: number,
        row: number,
    ): number {
        if (first >= limit || block_max[node] < row) return -1;
        if (last - first === 1) return first;
        const middle = (first + last) >>> 1;
        const left = this.find_block(block_max, node * 2, first, middle, limit, row);
        return left >= 0
            ? left
            : this.find_block(block_max, node * 2 + 1, middle, last, limit, row);
    }

    private visit_block(
        block: number,
        row: number,
        consumed: Uint8Array,
        block_max: Int32Array,
        accept: (range_id: number) => void,
    ): void {
        const first = block * RANGE_INDEX_BLOCK_SIZE;
        const last = Math.min(first + RANGE_INDEX_BLOCK_SIZE, this.ids.length);
        for (let position = first; position < last; position += 1) {
            const range_id = this.ids[position];
            if (consumed[range_id]) continue;
            const offset = range_id * RANGE_STRIDE;
            if (this.ranges[offset + 2] < row) continue;
            consumed[range_id] = 1;
            accept(range_id);
        }
        this.update_block(block, consumed, block_max);
    }

    private max_for_block(block: number, consumed: Uint8Array | undefined): number {
        const first = block * RANGE_INDEX_BLOCK_SIZE;
        const last = Math.min(first + RANGE_INDEX_BLOCK_SIZE, this.ids.length);
        let max = -1;
        for (let position = first; position < last; position += 1) {
            const range_id = this.ids[position];
            if (consumed?.[range_id]) continue;
            max = Math.max(max, this.ranges[range_id * RANGE_STRIDE + 2]);
        }
        return max;
    }

    private update_block(
        block: number,
        consumed: Uint8Array,
        block_max: Int32Array,
    ): void {
        let node = this.block_tree_base + block;
        block_max[node] = this.max_for_block(block, consumed);
        while (node > 1) {
            node >>>= 1;
            block_max[node] = Math.max(
                block_max[node * 2],
                block_max[node * 2 + 1],
            );
        }
    }
}

class CompiledRangeIndex {
    private readonly nodes: ReadonlyMap<number, IndexedRowIntervals>;

    constructor(private readonly ranges: Uint32Array) {
        const range_ids_by_node = new Map<number, number[]>();
        for (let range_id = 0; range_id < ranges.length / RANGE_STRIDE; range_id += 1) {
            const offset = range_id * RANGE_STRIDE;
            let first = COLUMN_TREE_LEAVES + ranges[offset + 1];
            let last = COLUMN_TREE_LEAVES + ranges[offset + 3];
            while (first <= last) {
                if ((first & 1) === 1) {
                    const ids = range_ids_by_node.get(first) ?? [];
                    ids.push(range_id);
                    range_ids_by_node.set(first, ids);
                    first += 1;
                }
                if ((last & 1) === 0) {
                    const ids = range_ids_by_node.get(last) ?? [];
                    ids.push(range_id);
                    range_ids_by_node.set(last, ids);
                    last -= 1;
                }
                first >>>= 1;
                last >>>= 1;
            }
        }
        this.nodes = new Map([...range_ids_by_node].map(([node, ids]) => [
            node,
            new IndexedRowIntervals(ids, ranges),
        ]));
    }

    createState(): ReadonlyMap<number, Int32Array> {
        return new Map([...this.nodes].map(([index, node]) => [
            index,
            node.createState(),
        ]));
    }

    visit(
        row: number,
        column: number,
        consumed: Uint8Array,
        state: ReadonlyMap<number, Int32Array>,
        accept: (range_id: number) => void,
    ): void {
        let node = COLUMN_TREE_LEAVES + column;
        while (node > 0) {
            const intervals = this.nodes.get(node);
            const block_max = state.get(node);
            if (intervals && block_max) intervals.visit(row, consumed, block_max, accept);
            node >>>= 1;
        }
    }
}

function valid_coordinate(row: number, column: number): boolean {
    return Number.isSafeInteger(row) && row >= 0 && row < MAX_ROW
        && Number.isSafeInteger(column) && column >= 0 && column < MAX_COLUMN;
}

function cell_number(row: number, column: number): number {
    return row * MAX_COLUMN + column;
}

function validate_formula_cells(packed: readonly number[]): number {
    if (packed.length % 2 !== 0) throw new Error('Malformed packed formula cells');
    let previous = -1;
    for (let offset = 0; offset < packed.length; offset += 2) {
        const row = packed[offset];
        const column = packed[offset + 1];
        if (!valid_coordinate(row, column)) throw new Error('Malformed packed formula cells');
        const number = cell_number(row, column);
        if (number <= previous) throw new Error('Malformed packed formula cells');
        previous = number;
    }
    return packed.length / 2;
}

interface FormulaDependencySheet {
    readonly formulaDependencies?: PackedFormulaDependencies;
    readonly structuredFormulaReferences?: PackedStructuredFormulaReferences;
    readonly formulaCells?: readonly number[];
    readonly sourceRowCount?: number;
    readonly columnNames?: readonly string[];
    readonly excelFirstRowHeader?: { readonly active: boolean; readonly sourceRow?: number };
}

function resolved_structured_dependencies(
    sheets: readonly FormulaDependencySheet[],
    formula_sheet: number,
): number[] {
    const packed = sheets[formula_sheet].structuredFormulaReferences;
    if (!packed) return [];
    if (packed.references.length % STRUCTURED_REFERENCE_STRIDE !== 0) {
        throw new Error('Malformed packed structured formula references');
    }
    const dependencies: number[] = [];
    for (let offset = 0; offset < packed.references.length;
        offset += STRUCTURED_REFERENCE_STRIDE) {
        const formula_row = packed.references[offset];
        const formula_column = packed.references[offset + 1];
        const source_sheet = packed.references[offset + 2];
        const intersection = packed.references[offset + 3];
        const name_index = packed.references[offset + 4];
        if (
            !valid_coordinate(formula_row, formula_column)
            || !Number.isSafeInteger(source_sheet)
            || source_sheet < 0
            || source_sheet >= sheets.length
            || (intersection !== 0 && intersection !== 1)
            || !Number.isSafeInteger(name_index)
            || name_index < 0
            || name_index >= packed.names.length
        ) throw new Error('Malformed packed structured formula reference');
        const source = sheets[source_sheet];
        if (!source.excelFirstRowHeader?.active || !source.columnNames) continue;
        const matches: number[] = [];
        for (let column = 0; column < source.columnNames.length; column += 1) {
            if (source.columnNames[column].localeCompare(
                packed.names[name_index], undefined, { sensitivity: 'accent' },
            ) === 0) matches.push(column);
        }
        if (matches.length !== 1) continue;
        const header_row = source.excelFirstRowHeader.sourceRow ?? 0;
        const source_row_count = source.sourceRowCount ?? 0;
        const first_row = intersection === 1 ? formula_row : header_row + 1;
        const last_row = intersection === 1 ? formula_row : source_row_count - 1;
        if (
            first_row <= header_row
            || first_row < 0
            || last_row < first_row
            || last_row >= source_row_count
        ) continue;
        dependencies.push(
            formula_row,
            formula_column,
            source_sheet,
            first_row,
            matches[0],
            last_row,
            matches[0],
        );
    }
    return dependencies;
}

/** Compile the packed topology once for one immutable workbook snapshot. */
export function compile_workbook_formula_graph(
    sheets: readonly FormulaDependencySheet[],
): WorkbookFormulaGraph {
    const formula_sheets: number[] = [];
    const formula_rows: number[] = [];
    const formula_columns: number[] = [];
    const formula_ordinals = new Map<number, Map<number, number>>();
    const exact_by_sheet = sheets.map(() => [] as number[]);
    const ranges_by_sheet = sheets.map(() => [] as number[]);
    let range_count = 0;
    let formula_cell_count = 0;

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
        formula_cell_count += validate_formula_cells(sheet.formulaCells ?? []);
        if (formula_cell_count > MAX_WORKBOOK_FORMULAS) {
            throw new Error(
                'Workbook has too many formulas to calculate safely '
                + `(max ${MAX_WORKBOOK_FORMULAS.toLocaleString()})`,
            );
        }
        const dependencies = [
            ...(sheet.formulaDependencies ?? []),
            ...resolved_structured_dependencies(sheets, formula_sheet),
        ];
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
                range_count += 1;
                if (range_count > MAX_WORKBOOK_FORMULA_RANGES) {
                    throw new Error(
                        'Workbook has too many formula ranges to index safely '
                        + `(max ${MAX_WORKBOOK_FORMULA_RANGES.toLocaleString()})`,
                    );
                }
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
        const packed_ranges = Uint32Array.from(ranges);
        return {
            exact: sorted_exact,
            ranges: packed_ranges,
            rangeIndex: new CompiledRangeIndex(packed_ranges),
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
            const consumed_ranges = sources.map(
                (source) => new Uint8Array(source.ranges.length / RANGE_STRIDE),
            );
            const range_index_states: Array<ReadonlyMap<number, Int32Array> | undefined>
                = new Array(sources.length);
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
            const visit_range = (source: CompiledSourceSheet, range_id: number): void => {
                const offset = range_id * RANGE_STRIDE;
                enqueue_formula(source.ranges[offset + 4]);
            };
            const visit_exact = (source: CompiledSourceSheet, cell: WorkbookCellAddress): void => {
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
            };
            let wave_start = 0;
            while (wave_start < queue.length) {
                // Close exact edges before touching ranges. Deep exact chains
                // then become one point wave instead of repeating the spatial
                // query once per link.
                const points_by_sheet = new Map<number, WorkbookCellAddress[]>();
                let exact_cursor = wave_start;
                while (exact_cursor < queue.length) {
                    const cell = queue[exact_cursor];
                    visit_exact(sources[cell.sheetIndex], cell);
                    const points = points_by_sheet.get(cell.sheetIndex) ?? [];
                    points.push(cell);
                    points_by_sheet.set(cell.sheetIndex, points);
                    exact_cursor += 1;
                }
                const wave_end = queue.length;
                for (const [sheet_index, points] of points_by_sheet) {
                    const source = sources[sheet_index];
                    if (source.ranges.length === 0) continue;
                    const range_index_state = range_index_states[sheet_index]
                        ?? source.rangeIndex.createState();
                    range_index_states[sheet_index] = range_index_state;
                    for (const cell of points) {
                        source.rangeIndex.visit(
                            cell.row,
                            cell.column,
                            consumed_ranges[sheet_index],
                            range_index_state,
                            (id) => visit_range(source, id),
                        );
                    }
                }
                wave_start = wave_end;
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

/**
 * Name every formula whose displayed or saved cache must be recalculated.
 * Callers may reuse a compiled graph and root-only impact so ordinary typing
 * changes values without recompiling or retraversing immutable topology.
 */
export function plan_workbook_formula_recalculation(
    sheets: readonly (FormulaDependencySheet & {
        readonly pendingFormulaCells?: readonly number[];
    })[],
    edits: readonly WorkbookFormulaEdit[],
    options: WorkbookFormulaPlanningOptions = {},
): WorkbookFormulaPlan {
    const dependency_impact = options.impact
        ?? (options.graph ?? compile_workbook_formula_graph(sheets)).invalidatedBy(edits);
    const targets = new Map<string, WorkbookCellAddress>();
    const edited_formula_cells = new Map<number, Set<number>>();
    let target_limit_exceeded = false;
    sheets.forEach((sheet, sheetIndex) => {
        for (const { row, column } of dependency_impact.forSheet(sheetIndex).cells()) {
            if (targets.size >= MAX_WORKBOOK_FORMULAS) {
                target_limit_exceeded = true;
                break;
            }
            targets.set(`${sheetIndex}:${row}:${column}`, { sheetIndex, row, column });
        }
    });
    if (options.includePending) {
        for (const target of pending_workbook_formula_targets(sheets)) {
            const key = `${target.sheetIndex}:${target.row}:${target.column}`;
            if (targets.has(key)) continue;
            if (targets.size >= MAX_WORKBOOK_FORMULAS) {
                target_limit_exceeded = true;
                break;
            }
            targets.set(key, target);
        }
    }
    let final_formula_count = sheets.reduce(
        (count, sheet) => count + Math.floor((sheet.formulaCells?.length ?? 0) / 2),
        0,
    );
    const source_has_formula = (edit: WorkbookFormulaEdit): boolean => {
        const packed = sheets[edit.sheetIndex]?.formulaCells ?? [];
        const wanted = cell_number(edit.row, edit.column);
        let low = 0;
        let high = Math.floor(packed.length / 2);
        while (low < high) {
            const middle = (low + high) >>> 1;
            const offset = middle * 2;
            const existing = cell_number(packed[offset], packed[offset + 1]);
            if (existing < wanted) low = middle + 1;
            else high = middle;
        }
        return low < packed.length / 2
            && packed[low * 2] === edit.row
            && packed[low * 2 + 1] === edit.column;
    };
    for (const edit of edits) {
        const is_formula = edit.writesFormula;
        const was_formula = source_has_formula(edit);
        if (is_formula !== was_formula) final_formula_count += is_formula ? 1 : -1;
        if (is_formula) {
            const edited = edited_formula_cells.get(edit.sheetIndex) ?? new Set<number>();
            edited.add(cell_number(edit.row, edit.column));
            edited_formula_cells.set(edit.sheetIndex, edited);
            const key = `${edit.sheetIndex}:${edit.row}:${edit.column}`;
            if (targets.has(key)) continue;
            if (targets.size >= MAX_WORKBOOK_FORMULAS) {
                target_limit_exceeded = true;
                continue;
            }
            targets.set(key, {
                sheetIndex: edit.sheetIndex,
                row: edit.row,
                column: edit.column,
            });
        }
    }
    const impact = impact_with_added_cells(dependency_impact, edited_formula_cells);
    return {
        sheetCount: sheets.length,
        impact,
        formulaLimitExceeded: target_limit_exceeded
            || final_formula_count > MAX_WORKBOOK_FORMULAS,
        targets: [...targets.values()].sort((left, right) =>
            (left.sheetIndex - right.sheetIndex)
            || (left.row - right.row)
            || (left.column - right.column)),
    };
}
