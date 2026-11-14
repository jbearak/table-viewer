/**
 * The Save warnings' list of formulas that might render differently from Excel
 * (design "Rendering formulas", "Where this differs from Excel"): every
 * formula of the workbook, source formulas and pending ones alike, whose
 * range references `formula_divergence_flags` flags for the current layouts.
 *
 * The same pass lists the formulas Save will write `#REF!` into because a
 * row or column they name was deleted, so the Save warnings can name what
 * was deleted, and then the formulas that use their results, directly or
 * through others, which end up as errors too.
 *
 * Source formula text lives only in the host's source, so the host runs this;
 * the webview sends the same layouts and prospective edits it sends the
 * calculator. The webview asks after layout changes settle, debounced and
 * keyed to the layouts and edits, and the host runs it cooperatively and
 * drops a run a newer question supersedes.
 */
import { read_source_columns, type DataSource } from './data-source/interface';
import { formula_ref_error_count, workbook_a1_formula_references } from './xlsx-formula';
import {
    calculate_workbook_formula_steps,
    formula_calculation_workbook,
    type FormulaCalculationAddress,
    type FormulaCalculationEdit,
    type FormulaCalculationError,
    type FormulaCalculationLayout,
    type FormulaCalculationResult,
    type FormulaCalculationSchedule,
} from './formula-calculation';
import {
    formula_anchor_context,
    prospective_cell_at,
    prospective_column_of,
    prospective_row_of,
    type FormulaAnchorWorkbook,
} from './formula-anchor-layout';
import {
    compile_workbook_formula_graph,
    type WorkbookCellAddress,
    type WorkbookFormulaGraph,
} from './formula-dependencies';
import {
    formula_deleted_references,
    formula_divergence_flags,
    render_formula,
    type FormulaDivergenceReason,
} from './formula-anchors';
import type { RowIdentity } from './pending-changes';
import type { ColumnIdentity } from './worksheet-layout';

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
    /** The formula as written: the file's text, or the pending text as typed. */
    readonly written: string;
    readonly classes: readonly FormulaDivergenceClass[];
    /** Whether either flagged axis is rows, columns, or both. */
    readonly axes: readonly ('row' | 'column')[];
}

/**
 * One formula that Save writes `#REF!` into because a row or column it names
 * was deleted, for one worksheet whose deletion it names.
 */
export interface FormulaDeletedItem {
    /** The worksheet whose deleted rows or columns the formula names. */
    readonly targetSheetIndex: number;
    /** Where the formula is: its worksheet and 0-based prospective cell. */
    readonly sheetIndex: number;
    readonly row: number;
    readonly column: number;
    /** The formula as Save writes it, with `#REF!` in place of each deleted reference. */
    readonly formula: string;
    /** The formula as written. */
    readonly written: string;
    /** The deleted rows and columns of the target worksheet the formula names. */
    readonly rows: readonly RowIdentity[];
    readonly columns: readonly ColumnIdentity[];
}

/**
 * What a formula that uses a `#REF!` formula's result shows after Save:
 *
 * - `ref`: the calculator evaluates it to `#REF!`, as Excel will;
 * - `unchecked`: it uses one through something the calculator doesn't
 *   evaluate (a function other than SUM or AVERAGE, text, a comparison), so
 *   it might show an error and might not. A formula that catches errors
 *   (IFERROR, ISERROR, ISREF, …) is neither.
 */
export type FormulaDependentResult = 'ref' | 'unchecked';

/**
 * One formula that uses the result of a formula Save writes `#REF!` into,
 * directly or through other formulas, on any worksheet.
 */
export interface FormulaDependentItem {
    /** Where the formula is: its worksheet and 0-based prospective cell. */
    readonly sheetIndex: number;
    readonly row: number;
    readonly column: number;
    /** The formula as it renders for the current layouts. */
    readonly formula: string;
    /** The formula as written. */
    readonly written: string;
    readonly result: FormulaDependentResult;
}

export interface FormulaTargetCount {
    readonly targetSheetIndex: number;
    readonly formulas: number;
}

/**
 * Distinct formula cells per Save warning, including those past the item cap.
 * Unlike the per-worksheet counts, a formula naming two worksheets counts once.
 */
export interface FormulaDivergenceTotals {
    /** Formulas that will show `#REF!`. */
    readonly deleted: number;
    /** Formulas flagged `moved`, `refilled`, or `discarded` on some worksheet they name. */
    readonly changedRanges: number;
    /** Formulas flagged `unadjustable` on some worksheet they name; Save refuses them. */
    readonly unadjustable: number;
    /** Formulas that use a `#REF!` formula's result and evaluate to `#REF!` themselves. */
    readonly refDependents: number;
    /** Formulas that use a `#REF!` formula's result in a way the calculator can't evaluate. */
    readonly uncheckedDependents: number;
}

export interface FormulaDivergenceReview {
    /** Flagged formulas, per target worksheet, at most `MAX_FORMULA_DIVERGENCE_ITEMS` overall. */
    readonly items: readonly FormulaDivergenceItem[];
    /** Every flagged formula per target worksheet, including those past the item cap. */
    readonly counts: readonly FormulaTargetCount[];
    /** Formulas that will show `#REF!`, per target worksheet, at most `MAX_FORMULA_DIVERGENCE_ITEMS` overall. */
    readonly deleted: readonly FormulaDeletedItem[];
    /** Every such formula per target worksheet, including those past the item cap. */
    readonly deletedCounts: readonly FormulaTargetCount[];
    /**
     * Formulas that use the results of those in `deleted`, `ref` before
     * `unchecked`, each in worksheet and cell order. They share the item cap
     * with `deleted`: together they list at most `MAX_FORMULA_DIVERGENCE_ITEMS`
     * formula cells.
     */
    readonly dependents: readonly FormulaDependentItem[];
    readonly totals: FormulaDivergenceTotals;
}

/** Items listed per kind in the Save warnings; the counts and totals still cover every formula. */
export const MAX_FORMULA_DIVERGENCE_ITEMS = 500;

type ReviewSteps<T> = Generator<void, T, void>;

/** Formulas checked between scheduling points. */
const FORMULAS_PER_STEP = 256;

/**
 * Functions that catch an error or test for one instead of passing it on.
 * A formula calling one is not claimed as broken, and its result does not
 * carry `#REF!` on to the formulas that use it. Matched in the text, since
 * the calculator doesn't evaluate them.
 */
const CATCHES_ERRORS = /(?:^|[^A-Za-z0-9_.])(?:_xlfn\.)?(?:IFERROR|IFNA|ERROR\.TYPE|AGGREGATE|IS(?:ERROR|ERR|NA|REF|BLANK|NUMBER|TEXT|NONTEXT|LOGICAL|FORMULA))\s*\(/i;

/**
 * What the calculator returns for a formula it can't evaluate: one that
 * uses a `#REF!` result this way might show an error after Save.
 */
const UNCHECKED_ERRORS: ReadonlySet<FormulaCalculationError> = new Set(['unsupported function', 'parse error']);

/** The source dependency graph of a workbook snapshot, compiled once per metadata. */
const formula_graphs = new WeakMap<object, WorkbookFormulaGraph | null>();

function formula_graph_of(sheets: ReturnType<DataSource['meta']>['sheets']): WorkbookFormulaGraph | undefined {
    let graph = formula_graphs.get(sheets);
    if (graph === undefined) {
        try {
            graph = compile_workbook_formula_graph(sheets);
        } catch {
            graph = null;
        }
        formula_graphs.set(sheets, graph);
    }
    return graph ?? undefined;
}

function address_key(address: FormulaCalculationAddress): string {
    return `${address.sheetIndex}:${address.row}:${address.column}`;
}

function by_cell(left: FormulaCalculationAddress, right: FormulaCalculationAddress): number {
    return (left.sheetIndex - right.sheetIndex) || (left.row - right.row) || (left.column - right.column);
}

/** A formula Save writes `#REF!` into, with its source cell when it is a source formula. */
interface DirectFormula extends FormulaCalculationAddress {
    readonly source: WorkbookCellAddress | undefined;
}

interface DependentReview {
    readonly items: readonly FormulaDependentItem[];
    readonly ref: number;
    readonly unchecked: number;
}

/**
 * The formulas that use the results of `direct`, the formulas Save writes
 * `#REF!` into, and what each evaluates to after Save.
 *
 * Which formulas use them comes from the workbook's source dependency graph,
 * the one the grid recalculates by, transitively and across worksheets;
 * pending formulas are checked by evaluation, and one found to break adds its
 * own dependents. What each shows comes from the calculator, run on the same
 * edits and layouts as the grid's prospective results: `#REF!` only when the
 * calculator gets `#REF!`. Formulas that catch errors, and formulas whose own
 * text already held `#REF!`, are left out of the calculation (`untargeted`),
 * so they keep their stored results and pass nothing on.
 */
function* dependent_steps(
    source: DataSource,
    workbook: FormulaAnchorWorkbook,
    edits: readonly FormulaCalculationEdit[],
    layouts: readonly FormulaCalculationLayout[],
    direct: ReadonlyMap<string, DirectFormula>,
    untargeted: ReadonlySet<string>,
    cap: number,
): ReviewSteps<DependentReview> {
    const sheets = source.meta().sheets;
    const graph = formula_graph_of(sheets);
    const edit_at = new Map(edits.map((edit) => [address_key(edit), edit]));
    const source_address = (address: FormulaCalculationAddress): WorkbookCellAddress | undefined => {
        const worksheet = workbook.worksheets[address.sheetIndex];
        const cell = worksheet === undefined ? undefined : prospective_cell_at(worksheet, address.row, address.column);
        if (cell === undefined || cell.column.kind !== 'source') return undefined;
        if (cell.row.kind !== 'source' && cell.row.kind !== 'fixed') return undefined;
        return { sheetIndex: address.sheetIndex, row: cell.row.sourceRow, column: cell.column.sourceColumn };
    };
    const roots = new Map<string, WorkbookCellAddress>();
    const add_root = (address: FormulaCalculationAddress, known?: WorkbookCellAddress): boolean => {
        const cell = known ?? source_address(address);
        if (cell === undefined) return false;
        const key = address_key(cell);
        if (roots.has(key)) return false;
        roots.set(key, cell);
        return true;
    };
    // Each formula that breaks is `#REF!` after Save, which is all the
    // calculator needs to know: it needn't render them again.
    // A pending formula that catches errors reads as blank, so it passes
    // nothing on, like a source one left out of the targets.
    const calculation_edits: FormulaCalculationEdit[] = edits.flatMap((edit) => {
        const key = address_key(edit);
        if (!untargeted.has(key)) return direct.has(key) ? [] : [edit];
        if (!edit.writesFormula) return [edit];
        return [{ sheetIndex: edit.sheetIndex, row: edit.row, column: edit.column, value: '', writesFormula: false }];
    });
    let since_yield = 0;
    const breaking_cells: FormulaCalculationAddress[] = [];
    for (const [key, formula] of direct) {
        if (untargeted.has(key)) continue;
        breaking_cells.push(formula);
        add_root(formula, formula.source);
        calculation_edits.push({
            sheetIndex: formula.sheetIndex,
            row: formula.row,
            column: formula.column,
            value: '=#REF!',
            writesFormula: true,
        });
        if (++since_yield >= FORMULAS_PER_STEP * 8) {
            since_yield = 0;
            yield;
        }
    }
    const pending = edits.filter((edit) => {
        const key = address_key(edit);
        return edit.writesFormula && !direct.has(key) && !untargeted.has(key);
    }).map(({ sheetIndex, row, column }) => ({ sheetIndex, row, column }));
    // The calculator answers each target in order, so `calculated[i]` is what
    // `targets[i]` shows; the first `from_graph` targets are source formulas
    // the graph says use a broken one.
    let targets: FormulaCalculationAddress[] = [];
    let calculated: readonly FormulaCalculationResult[] = [];
    let from_graph = 0;
    while (true) {
        const used = new Map<string, FormulaCalculationAddress>();
        if (graph !== undefined && roots.size > 0) {
            const impact = yield* graph.invalidatedBySteps(roots.values());
            for (let sheetIndex = 0; sheetIndex < workbook.worksheets.length; sheetIndex += 1) {
                const worksheet = workbook.worksheets[sheetIndex]!;
                for (const cell of impact.forSheet(sheetIndex).cells()) {
                    if (++since_yield >= FORMULAS_PER_STEP * 8) {
                        since_yield = 0;
                        yield;
                    }
                    const row = prospective_row_of(worksheet, { kind: 'source', sourceRow: cell.row });
                    const column = prospective_column_of(worksheet, { kind: 'source', sourceColumn: cell.column });
                    if (row === undefined || column === undefined) continue;
                    const key = `${sheetIndex}:${row}:${column}`;
                    // An edited cell holds the edit, checked with the pending formulas.
                    if (direct.has(key) || untargeted.has(key) || edit_at.has(key)) continue;
                    used.set(key, { sheetIndex, row, column });
                }
            }
        }
        if (used.size === 0 && pending.length === 0) return { items: [], ref: 0, unchecked: 0 };
        // The traversal and the calculator's setup each take a slice on a large workbook.
        yield;
        targets = [...used.values(), ...pending];
        from_graph = used.size;
        calculated = yield* calculate_workbook_formula_steps(source, { edits: calculation_edits, targets, layouts });
        // A pending formula that breaks passes it on to the source formulas that use its cell.
        let grew = false;
        for (let index = from_graph; index < targets.length; index += 1) {
            if (calculated[index]?.error === 'invalid reference' && add_root(targets[index]!)) grew = true;
        }
        if (!grew) break;
    }
    const ref: FormulaCalculationAddress[] = [];
    const unchecked: FormulaCalculationAddress[] = [];
    const unchecked_pending: FormulaCalculationAddress[] = [];
    for (let index = 0; index < targets.length; index += 1) {
        if (++since_yield >= FORMULAS_PER_STEP * 8) {
            since_yield = 0;
            yield;
        }
        const error = calculated[index]?.error;
        if (error === 'invalid reference') ref.push(targets[index]!);
        else if (error !== undefined && UNCHECKED_ERRORS.has(error)) {
            (index < from_graph ? unchecked : unchecked_pending).push(targets[index]!);
        }
    }
    // The graph knows only source formulas. A pending formula the calculator
    // can't evaluate counts when its own references reach a broken formula.
    if (unchecked_pending.length > 0) {
        const broken = new Map<number, FormulaCalculationAddress[]>();
        for (const address of [...breaking_cells, ...ref, ...unchecked]) {
            const cells = broken.get(address.sheetIndex) ?? [];
            cells.push(address);
            broken.set(address.sheetIndex, cells);
        }
        const sheet_names = sheets.map((sheet) => sheet.name);
        for (const address of unchecked_pending) {
            const edit = edit_at.get(address_key(address))!;
            let text = edit.value;
            try {
                const rendered = render_formula(text, edit.formulaAnchors, formula_anchor_context(workbook, address.sheetIndex));
                if (rendered.kind === 'rendered') text = rendered.text;
            } catch {
                // Keep the stored text.
            }
            const uses_broken = workbook_a1_formula_references(text, address.sheetIndex, sheet_names).some((reference) =>
                (broken.get(reference.sourceSheetIndex) ?? []).some((cell) =>
                    cell.row >= reference.firstRow && cell.row <= reference.lastRow
                    && cell.column >= reference.firstColumn && cell.column <= reference.lastColumn));
            if (uses_broken) unchecked.push(address);
            yield;
        }
    }
    ref.sort(by_cell);
    unchecked.sort(by_cell);
    const items: FormulaDependentItem[] = [];
    const listed = [
        ...ref.map((address) => ({ address, result: 'ref' as const })),
        ...unchecked.map((address) => ({ address, result: 'unchecked' as const })),
    ].slice(0, Math.max(0, cap));
    for (const { address, result } of listed) {
        const edit = edit_at.get(address_key(address));
        let written = edit?.value;
        if (written === undefined) {
            const cell = source_address(address);
            if (cell === undefined) continue;
            const read = source.read_canonical_columns?.(cell.sheetIndex, cell.row, 1, [cell.column])
                ?? read_source_columns(source, cell.sheetIndex, cell.row, 1, [cell.column]);
            written = read.rows[0]?.[0]?.formula;
        }
        if (written === undefined) continue;
        let formula = written;
        try {
            const rendered = render_formula(written, edit?.formulaAnchors, formula_anchor_context(workbook, address.sheetIndex));
            if (rendered.kind === 'rendered') formula = rendered.text;
        } catch {
            // Keep the stored text.
        }
        items.push(Object.freeze({ ...address, formula, written, result }));
        if (items.length % FORMULAS_PER_STEP === 0) yield;
    }
    return { items, ref: ref.length, unchecked: unchecked.length };
}

function* review_steps(
    source: DataSource,
    edits: readonly FormulaCalculationEdit[],
    layouts: readonly FormulaCalculationLayout[],
): ReviewSteps<FormulaDivergenceReview> {
    const sheets = source.meta().sheets;
    const workbook = formula_calculation_workbook(sheets, layouts);
    const items: FormulaDivergenceItem[] = [];
    const counts = new Map<number, number>();
    const deleted: FormulaDeletedItem[] = [];
    const deleted_counts = new Map<number, number>();
    const totals = { deleted: 0, changedRanges: 0, unadjustable: 0, refDependents: 0, uncheckedDependents: 0 };
    // Formulas Save writes #REF! into, and formulas whose results don't carry
    // #REF! on: those that catch errors, and those whose text already held it.
    const direct = new Map<string, DirectFormula>();
    const untargeted = new Set<string>();
    const overridden = new Set(edits.map((edit) => `${edit.sheetIndex}:${edit.row}:${edit.column}`));
    let checked = 0;
    const check = (
        sheet_index: number,
        row: number,
        column: number,
        text: string,
        anchors: FormulaCalculationEdit['formulaAnchors'],
        /** The source cell of a source formula. */
        source_cell?: WorkbookCellAddress,
    ): void => {
        checked += 1;
        if (CATCHES_ERRORS.test(text) || (text.includes('#REF!') && formula_ref_error_count(text) > 0)) {
            untargeted.add(`${sheet_index}:${row}:${column}`);
        }
        const context = formula_anchor_context(workbook, sheet_index);
        let flags;
        let deletions;
        try {
            flags = formula_divergence_flags(text, anchors, context);
        } catch {
            return;
        }
        try {
            deletions = formula_deleted_references(text, anchors, context);
        } catch {
            deletions = [];
        }
        if (flags.length === 0 && deletions.length === 0) return;
        let rendered = text;
        try {
            const result = render_formula(text, anchors, context);
            if (result.kind === 'rendered') rendered = result.text;
        } catch {
            // Keep the stored text.
        }
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
        const classes = new Set([...by_target.values()].flatMap((entry) => [...entry.classes]));
        if ([...classes].some((name) => name !== 'unadjustable')) totals.changedRanges += 1;
        if (classes.has('unadjustable')) totals.unadjustable += 1;
        for (const [target, entry] of [...by_target].sort(([left], [right]) => left - right)) {
            counts.set(target, (counts.get(target) ?? 0) + 1);
            if (items.length >= MAX_FORMULA_DIVERGENCE_ITEMS) continue;
            items.push(Object.freeze({
                targetSheetIndex: target,
                sheetIndex: sheet_index,
                row,
                column,
                formula: rendered,
                written: text,
                classes: Object.freeze(FORMULA_DIVERGENCE_CLASSES.filter((name) => entry.classes.has(name))),
                axes: Object.freeze((['row', 'column'] as const).filter((axis) => entry.axes.has(axis))),
            }));
        }
        const deleted_by_target = new Map<number, { rows: Map<string, RowIdentity>; columns: Map<string, ColumnIdentity> }>();
        for (const deletion of deletions) {
            const entry = deleted_by_target.get(deletion.worksheet)
                ?? { rows: new Map<string, RowIdentity>(), columns: new Map<string, ColumnIdentity>() };
            for (const identity of deletion.rows) entry.rows.set(JSON.stringify(identity), identity);
            for (const identity of deletion.columns) entry.columns.set(JSON.stringify(identity), identity);
            deleted_by_target.set(deletion.worksheet, entry);
        }
        if (deleted_by_target.size > 0) {
            totals.deleted += 1;
            direct.set(`${sheet_index}:${row}:${column}`, { sheetIndex: sheet_index, row, column, source: source_cell });
        }
        for (const [target, entry] of [...deleted_by_target].sort(([left], [right]) => left - right)) {
            deleted_counts.set(target, (deleted_counts.get(target) ?? 0) + 1);
            if (deleted.length >= MAX_FORMULA_DIVERGENCE_ITEMS) continue;
            deleted.push(Object.freeze({
                targetSheetIndex: target,
                sheetIndex: sheet_index,
                row,
                column,
                formula: rendered,
                written: text,
                rows: Object.freeze([...entry.rows.values()]),
                columns: Object.freeze([...entry.columns.values()]),
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
                if (text !== undefined) {
                    check(sheet_index, row, entry.column, text, undefined,
                        { sheetIndex: sheet_index, row: source_row, column: entry.source_column });
                }
            });
            if (checked >= FORMULAS_PER_STEP) {
                checked = 0;
                yield;
            }
        }
    }
    let dependents: readonly FormulaDependentItem[] = [];
    if (direct.size > 0) {
        const listed = new Set(deleted.map(address_key)).size;
        const found = yield* dependent_steps(
            source, workbook, edits, layouts, direct, untargeted, MAX_FORMULA_DIVERGENCE_ITEMS - listed);
        dependents = found.items;
        totals.refDependents = found.ref;
        totals.uncheckedDependents = found.unchecked;
    }
    const by_target = (totals: Map<number, number>) => Object.freeze([...totals]
        .sort(([left], [right]) => left - right)
        .map(([targetSheetIndex, formulas]) => Object.freeze({ targetSheetIndex, formulas })));
    return Object.freeze({
        items: Object.freeze(items),
        counts: by_target(counts),
        deleted: Object.freeze(deleted),
        deletedCounts: by_target(deleted_counts),
        dependents: Object.freeze(dependents),
        totals: Object.freeze(totals),
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
