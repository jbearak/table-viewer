import { cell_key, parse_cell_key } from './cell-key';
import type { FormulaDependency } from './data-source/interface';

interface FormulaRangeDependency {
    readonly formulaKey: string;
    readonly firstRow: number;
    readonly firstColumn: number;
    readonly lastRow: number;
    readonly lastColumn: number;
}

export interface FormulaDependencyIndex {
    readonly cells: ReadonlyMap<string, readonly string[]>;
    readonly rangesByColumn: ReadonlyMap<number, readonly FormulaRangeDependency[]>;
    readonly rangesByRow: ReadonlyMap<number, readonly FormulaRangeDependency[]>;
    readonly broadRanges: readonly FormulaRangeDependency[];
}

const RANGE_BUCKET_SPAN = 64;

function valid_coordinate(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

/** Build the reverse lookup once per worksheet snapshot. */
export function build_formula_dependency_index(
    dependencies: readonly FormulaDependency[] | undefined,
): FormulaDependencyIndex {
    const cells = new Map<string, Set<string>>();
    const ranges_by_column = new Map<number, FormulaRangeDependency[]>();
    const ranges_by_row = new Map<number, FormulaRangeDependency[]>();
    const broad_ranges: FormulaRangeDependency[] = [];
    for (const dependency of dependencies ?? []) {
        if (
            dependency.length !== 6
            || dependency.some((value) => !valid_coordinate(value))
        ) continue;
        const [formula_row, formula_column, first_row, first_column, last_row, last_column] =
            dependency;
        if (first_row > last_row || first_column > last_column) continue;
        const formula_key = cell_key(formula_row, formula_column);
        if (first_row === last_row && first_column === last_column) {
            const referenced_key = cell_key(first_row, first_column);
            const formulas = cells.get(referenced_key) ?? new Set<string>();
            formulas.add(formula_key);
            cells.set(referenced_key, formulas);
        } else {
            const range = {
                formulaKey: formula_key,
                firstRow: first_row,
                firstColumn: first_column,
                lastRow: last_row,
                lastColumn: last_column,
            };
            const width = last_column - first_column + 1;
            const height = last_row - first_row + 1;
            if (width <= RANGE_BUCKET_SPAN) {
                for (let column = first_column; column <= last_column; column++) {
                    const bucket = ranges_by_column.get(column) ?? [];
                    bucket.push(range);
                    ranges_by_column.set(column, bucket);
                }
            } else if (height <= RANGE_BUCKET_SPAN) {
                for (let row = first_row; row <= last_row; row++) {
                    const bucket = ranges_by_row.get(row) ?? [];
                    bucket.push(range);
                    ranges_by_row.set(row, bucket);
                }
            } else {
                broad_ranges.push(range);
            }
        }
    }
    return {
        cells: new Map([...cells].map(([key, formulas]) => [key, [...formulas]])),
        rangesByColumn: ranges_by_column,
        rangesByRow: ranges_by_row,
        broadRanges: broad_ranges,
    };
}

/**
 * Return every formula whose cached result became stale, including formulas
 * reached through another stale formula. Cycles stop at the first visited cell.
 */
export function transitive_formula_dependents(
    index: FormulaDependencyIndex,
    changed_keys: Iterable<string>,
): Set<string> {
    const queued = new Set<string>();
    const queue: { key: string; row: number; column: number }[] = [];
    for (const key of changed_keys) {
        const coordinates = parse_cell_key(key);
        if (!coordinates || queued.has(key)) continue;
        queued.add(key);
        queue.push({
            key,
            row: coordinates.sourceRow,
            column: coordinates.sourceColumn,
        });
    }

    const affected = new Set<string>();
    const enqueue_formula = (formula_key: string) => {
        if (affected.has(formula_key)) return;
        affected.add(formula_key);
        if (queued.has(formula_key)) return;
        const coordinates = parse_cell_key(formula_key);
        if (!coordinates) return;
        queued.add(formula_key);
        queue.push({
            key: formula_key,
            row: coordinates.sourceRow,
            column: coordinates.sourceColumn,
        });
    };

    for (let cursor = 0; cursor < queue.length; cursor++) {
        const changed = queue[cursor];
        for (const formula_key of index.cells.get(changed.key) ?? []) {
            enqueue_formula(formula_key);
        }
        const ranges = [
            ...(index.rangesByColumn.get(changed.column) ?? []),
            ...(index.rangesByRow.get(changed.row) ?? []),
            ...index.broadRanges,
        ];
        for (const range of ranges) {
            if (
                changed.row >= range.firstRow
                && changed.row <= range.lastRow
                && changed.column >= range.firstColumn
                && changed.column <= range.lastColumn
            ) enqueue_formula(range.formulaKey);
        }
    }
    return affected;
}
