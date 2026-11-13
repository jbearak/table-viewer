/**
 * Review Changes' list of formulas that might render differently from Excel
 * (design "Rendering formulas", "Where this differs from Excel"): every
 * formula of the workbook, source formulas and pending ones alike, whose
 * range references `formula_divergence_flags` flags for the current layouts.
 *
 * Source formula text lives only in the host's source, so the host runs this;
 * the webview sends the same layouts and prospective edits it sends the
 * calculator. It runs only when Review Changes asks, never per gesture.
 */
import { read_source_columns, type DataSource } from './data-source/interface';
import { formula_ref_error_count } from './xlsx-formula';
import {
    formula_calculation_workbook,
    type FormulaCalculationEdit,
    type FormulaCalculationLayout,
    type FormulaCalculationSchedule,
} from './formula-calculation';
import {
    formula_anchor_context,
    prospective_cell_at,
    prospective_column_of,
    prospective_row_of,
} from './formula-anchor-layout';
import {
    formula_divergence_flags,
    render_formula,
    type FormulaDivergenceReason,
} from './formula-anchors';

/**
 * The spec's three classes, plus formulas no layout change can adjust:
 *
 * - `moved`: a move carried a range corner, possibly past the other corner
 *   (`cornersCrossed`, `displacedCorner`);
 * - `refilled`: a deleted corner's gap may have been refilled (`tombstoneCorner`);
 * - `discarded`: a corner named a discarded appended row (`discardedCorner`);
 * - `unadjustable`: a construct a layout change can't adjust; Save refuses it.
 */
export type FormulaDivergenceClass = 'moved' | 'refilled' | 'discarded' | 'unadjustable';

export const FORMULA_DIVERGENCE_CLASSES: readonly FormulaDivergenceClass[] =
    Object.freeze(['moved', 'refilled', 'discarded', 'unadjustable']);

export function formula_divergence_class(reason: FormulaDivergenceReason): FormulaDivergenceClass {
    switch (reason) {
        case 'cornersCrossed':
        case 'displacedCorner':
            return 'moved';
        case 'tombstoneCorner':
            return 'refilled';
        case 'discardedCorner':
            return 'discarded';
        case 'unadjustable':
            return 'unadjustable';
    }
}

/** One flagged formula, for one worksheet it names. */
export interface FormulaDivergenceItem {
    /** The worksheet whose layout the flagged references name. */
    readonly targetSheetIndex: number;
    /** Where the formula is: its worksheet and 0-based prospective cell. */
    readonly sheetIndex: number;
    readonly row: number;
    readonly column: number;
    /** The formula as it renders for the current layouts (as written when it can't render). */
    readonly formula: string;
    readonly classes: readonly FormulaDivergenceClass[];
    /** Whether either flagged axis is rows, columns, or both. */
    readonly axes: readonly ('row' | 'column')[];
}

export interface FormulaDivergenceReview {
    /** Flagged formulas, per target worksheet, at most `MAX_FORMULA_DIVERGENCE_ITEMS` overall. */
    readonly items: readonly FormulaDivergenceItem[];
    /** Every flagged formula per target worksheet, including those past the item cap. */
    readonly counts: readonly { readonly targetSheetIndex: number; readonly formulas: number }[];
}

/** Items listed in Review Changes; the counts still cover every flagged formula. */
export const MAX_FORMULA_DIVERGENCE_ITEMS = 500;

type ReviewSteps<T> = Generator<void, T, void>;

/** Formulas checked between scheduling points. */
const FORMULAS_PER_STEP = 256;

function* review_steps(
    source: DataSource,
    edits: readonly FormulaCalculationEdit[],
    layouts: readonly FormulaCalculationLayout[],
): ReviewSteps<FormulaDivergenceReview> {
    const sheets = source.meta().sheets;
    const workbook = formula_calculation_workbook(sheets, layouts);
    const items: FormulaDivergenceItem[] = [];
    const counts = new Map<number, number>();
    const overridden = new Set(edits.map((edit) => `${edit.sheetIndex}:${edit.row}:${edit.column}`));
    let checked = 0;
    const check = (
        sheet_index: number,
        row: number,
        column: number,
        text: string,
        anchors: FormulaCalculationEdit['formulaAnchors'],
    ): void => {
        checked += 1;
        const context = formula_anchor_context(workbook, sheet_index);
        let flags;
        try {
            flags = formula_divergence_flags(text, anchors, context);
        } catch {
            return;
        }
        if (flags.length === 0) return;
        const by_target = new Map<number, { classes: Set<FormulaDivergenceClass>; axes: Set<'row' | 'column'> }>();
        for (const flag of flags) {
            for (const target of flag.worksheets) {
                const entry = by_target.get(target)
                    ?? { classes: new Set<FormulaDivergenceClass>(), axes: new Set<'row' | 'column'>() };
                entry.classes.add(formula_divergence_class(flag.reason));
                entry.axes.add(flag.axis);
                by_target.set(target, entry);
            }
        }
        let rendered = text;
        try {
            const result = render_formula(text, anchors, context);
            if (result.kind === 'rendered') rendered = result.text;
        } catch {
            // Keep the stored text.
        }
        for (const [target, entry] of [...by_target].sort(([left], [right]) => left - right)) {
            counts.set(target, (counts.get(target) ?? 0) + 1);
            if (items.length >= MAX_FORMULA_DIVERGENCE_ITEMS) continue;
            items.push(Object.freeze({
                targetSheetIndex: target,
                sheetIndex: sheet_index,
                row,
                column,
                formula: rendered,
                classes: Object.freeze(FORMULA_DIVERGENCE_CLASSES.filter((name) => entry.classes.has(name))),
                axes: Object.freeze((['row', 'column'] as const).filter((axis) => entry.axes.has(axis))),
            }));
        }
    };
    for (const edit of edits) {
        if (!edit.writesFormula) continue;
        check(edit.sheetIndex, edit.row, edit.column, edit.value, edit.formulaAnchors);
        if (checked % FORMULAS_PER_STEP === 0) yield;
    }
    for (let sheet_index = 0; sheet_index < sheets.length; sheet_index += 1) {
        const cells = sheets[sheet_index]!.formulaCells ?? [];
        const worksheet = workbook.worksheets[sheet_index]!;
        let offset = 0;
        while (offset + 1 < cells.length) {
            // Formula cells are packed row-major: read each row's once.
            const source_row = cells[offset]!;
            const columns: number[] = [];
            while (offset + 1 < cells.length && cells[offset] === source_row) {
                columns.push(cells[offset + 1]!);
                offset += 2;
            }
            const row = prospective_row_of(worksheet, { kind: 'source', sourceRow: source_row });
            if (row === undefined) continue;
            const placed = columns.flatMap((source_column) => {
                const column = prospective_column_of(worksheet, { kind: 'source', sourceColumn: source_column });
                return column === undefined || overridden.has(`${sheet_index}:${row}:${column}`)
                    ? []
                    : [{ source_column, column }];
            });
            if (placed.length === 0) continue;
            const read_columns = placed.map((entry) => entry.source_column);
            const read = source.read_canonical_columns?.(sheet_index, source_row, 1, read_columns)
                ?? read_source_columns(source, sheet_index, source_row, 1, read_columns);
            placed.forEach((entry, index) => {
                const text = read.rows[0]?.[index]?.formula;
                if (text !== undefined) check(sheet_index, row, entry.column, text, undefined);
            });
            if (checked >= FORMULAS_PER_STEP) {
                checked = 0;
                yield;
            }
        }
    }
    return Object.freeze({
        items: Object.freeze(items),
        counts: Object.freeze([...counts].sort(([left], [right]) => left - right)
            .map(([targetSheetIndex, formulas]) => Object.freeze({ targetSheetIndex, formulas }))),
    });
}

/** Synchronous form, for tests. */
export function review_formula_divergence(
    source: DataSource,
    edits: readonly FormulaCalculationEdit[],
    layouts: readonly FormulaCalculationLayout[],
): FormulaDivergenceReview {
    return run_to_end(review_steps(source, edits, layouts));
}

function run_to_end<T>(steps: Generator<void, T, void>): T {
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
}

/** The review, yielding between slices like the calculator; `undefined` once cancelled. */
export async function review_formula_divergence_cooperatively(
    source: DataSource,
    edits: readonly FormulaCalculationEdit[],
    layouts: readonly FormulaCalculationLayout[],
    schedule: FormulaCalculationSchedule,
): Promise<FormulaDivergenceReview | undefined> {
    return run_cooperatively(review_steps(source, edits, layouts), schedule);
}

async function run_cooperatively<T>(
    steps: Generator<void, T, void>,
    schedule: FormulaCalculationSchedule,
): Promise<T | undefined> {
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

// --- Action impact ------------------------------------------------------------

/** One workbook state: the calculator's prospective edits and layouts. */
export interface FormulaImpactState {
    readonly edits: readonly FormulaCalculationEdit[];
    readonly layouts: readonly FormulaCalculationLayout[];
}

/** What an action would do to the workbook's formulas. */
export interface FormulaImpact {
    /** Formulas whose rendered text gains a `#REF!` error token (not one inside a string). */
    readonly ref: number;
    /** Other formulas whose rendered text changes: they point at different rows or columns. */
    readonly moved: number;
}

/**
 * Compare every formula of the workbook as it renders in `before` and in
 * `after`, matched by the row and column identities of its cell, so a cell a
 * layout renumbers is still the same cell. Formulas only one state holds
 * (on a row or column the action drops) are not counted. "4 formulas will
 * show #REF! and 12 will point at different rows or columns."
 */
function* impact_steps(
    source: DataSource,
    before: FormulaImpactState,
    after: FormulaImpactState,
): Generator<void, FormulaImpact, void> {
    const sheets = source.meta().sheets;
    function* rendered(state: FormulaImpactState): Generator<void, Map<string, string>, void> {
        const workbook = formula_calculation_workbook(sheets, state.layouts);
        const out = new Map<string, string>();
        const key_at = (sheet_index: number, row: number, column: number): string | undefined => {
            const cell = prospective_cell_at(workbook.worksheets[sheet_index]!, row, column);
            if (cell === undefined) return undefined;
            const row_key = cell.row.kind === 'fixed'
                ? `s:${cell.row.sourceRow}`
                : cell.row.kind === 'source' ? `s:${cell.row.sourceRow}` : `p:${cell.row.pendingRowId}`;
            const column_key = cell.column.kind === 'source'
                ? `s:${cell.column.sourceColumn}`
                : `p:${cell.column.pendingColumnId}`;
            return `${sheet_index}|${row_key}|${column_key}`;
        };
        const render = (sheet_index: number, text: string, anchors: FormulaCalculationEdit['formulaAnchors']) => {
            try {
                const result = render_formula(text, anchors, formula_anchor_context(workbook, sheet_index));
                return result.kind === 'rendered' ? result.text : text;
            } catch {
                return text;
            }
        };
        const edited = new Set<string>();
        let since_yield = 0;
        for (const edit of state.edits) {
            const key = key_at(edit.sheetIndex, edit.row, edit.column);
            if (key === undefined) continue;
            edited.add(key);
            if (!edit.writesFormula) continue;
            out.set(key, render(edit.sheetIndex, edit.value, edit.formulaAnchors));
            if (++since_yield >= FORMULAS_PER_STEP) {
                since_yield = 0;
                yield;
            }
        }
        for (let sheet_index = 0; sheet_index < sheets.length; sheet_index += 1) {
            const cells = sheets[sheet_index]!.formulaCells ?? [];
            const worksheet = workbook.worksheets[sheet_index]!;
            for (let offset = 0; offset + 1 < cells.length;) {
                const source_row = cells[offset]!;
                const columns: number[] = [];
                while (offset + 1 < cells.length && cells[offset] === source_row) {
                    columns.push(cells[offset + 1]!);
                    offset += 2;
                }
                if (prospective_row_of(worksheet, { kind: 'source', sourceRow: source_row }) === undefined) continue;
                const live = columns.filter((column) => {
                    const key = `${sheet_index}|s:${source_row}|s:${column}`;
                    return !edited.has(key)
                        && prospective_column_of(worksheet, { kind: 'source', sourceColumn: column }) !== undefined;
                });
                if (live.length === 0) continue;
                const read = source.read_canonical_columns?.(sheet_index, source_row, 1, live)
                    ?? read_source_columns(source, sheet_index, source_row, 1, live);
                live.forEach((column, index) => {
                    const text = read.rows[0]?.[index]?.formula;
                    if (text !== undefined) {
                        out.set(`${sheet_index}|s:${source_row}|s:${column}`, render(sheet_index, text, undefined));
                    }
                });
                since_yield += live.length;
                if (since_yield >= FORMULAS_PER_STEP) {
                    since_yield = 0;
                    yield;
                }
            }
        }
        return out;
    }
    const was = yield* rendered(before);
    const will = yield* rendered(after);
    let ref = 0;
    let moved = 0;
    let compared = 0;
    for (const [key, text] of will) {
        // Every visited formula counts toward the batch, unchanged ones too.
        if (++compared % FORMULAS_PER_STEP === 0) yield;
        const previous = was.get(key);
        if (previous === undefined || previous === text) continue;
        if (formula_ref_error_count(text) > formula_ref_error_count(previous)) ref += 1;
        else moved += 1;
    }
    return Object.freeze({ ref, moved });
}

/** Synchronous form, for tests. */
export function review_formula_impact(
    source: DataSource,
    before: FormulaImpactState,
    after: FormulaImpactState,
): FormulaImpact {
    return run_to_end(impact_steps(source, before, after));
}

/** The impact, yielding between slices like the review; `undefined` once cancelled. */
export function review_formula_impact_cooperatively(
    source: DataSource,
    before: FormulaImpactState,
    after: FormulaImpactState,
    schedule: FormulaCalculationSchedule,
): Promise<FormulaImpact | undefined> {
    return run_cooperatively(impact_steps(source, before, after), schedule);
}
