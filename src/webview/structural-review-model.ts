/**
 * Review Changes for row and column structure (design "Saving and
 * discarding" and "Where this differs from Excel"): per worksheet, the counts
 * of rows and columns Save will insert, delete, move, or rename, and the
 * formulas whose ranges might render differently from Excel, grouped by the
 * spec's classes.
 */
import {
    has_live_layout_change,
    inserted_rows,
    type PendingStructuralChanges,
} from '../pending-changes';
import {
    has_live_column_layout_change,
    index_column_layout,
    moved_source_columns,
    moved_source_rows,
    type ColumnLayout,
} from '../worksheet-layout';
import {
    FORMULA_DIVERGENCE_CLASSES,
    type FormulaDivergenceClass,
    type FormulaDivergenceItem,
    type FormulaImpact,
} from '../formula-divergence-review';

export interface WorksheetStructureCounts {
    readonly rows: { readonly inserted: number; readonly deleted: number; readonly moved: number };
    readonly columns: {
        readonly inserted: number;
        readonly deleted: number;
        readonly moved: number;
        readonly renamed: number;
    };
}

/**
 * What Save will do to one worksheet's rows and columns. Inserted counts live
 * Pending Inserted Rows and Pending Columns (appended rows are not inserted);
 * deleted counts Pending Row and Column Removals; moved counts Moved Rows and
 * Columns by the moved-detection rule, as the tint marks them; renamed counts
 * the `renamed_columns` the caller found among live source columns.
 */
export function worksheet_structure_counts(
    changes: PendingStructuralChanges,
    renamed_columns: number,
): WorksheetStructureCounts {
    const row_layout = changes.rowLayout;
    const column_layout = changes.columnLayout;
    const sum = (intervals: readonly { readonly count: number }[]) =>
        intervals.reduce((total, interval) => total + interval.count, 0);
    return Object.freeze({
        rows: Object.freeze({
            inserted: inserted_rows(changes).length,
            deleted: row_layout === undefined ? 0 : sum(row_layout.removedSourceRows),
            moved: row_layout === undefined ? 0 : sum(moved_source_rows(row_layout)),
        }),
        columns: Object.freeze({
            inserted: live_pending_columns(column_layout),
            deleted: column_layout?.removedSourceColumns.length ?? 0,
            moved: column_layout === undefined ? 0 : sum(moved_source_columns(column_layout)),
            renamed: renamed_columns,
        }),
    });
}

function live_pending_columns(layout: ColumnLayout | undefined): number {
    if (layout === undefined) return 0;
    const index = index_column_layout(layout);
    return layout.columns.filter((column) => column.kind === 'pending' && index.is_live(column)).length;
}

/**
 * Live source columns whose Header Row cell has a pending value that differs
 * from the source name: the columns Save will rename. `header_edit` reads the
 * pending value of a source column's header cell, if any.
 */
export function renamed_source_columns(
    column_names: readonly string[] | undefined,
    changes: Pick<PendingStructuralChanges, 'columnLayout'>,
    header_edit: (source_column: number) => string | undefined,
): number {
    if (column_names === undefined) return 0;
    const removed = new Set(changes.columnLayout?.removedSourceColumns ?? []);
    let renamed = 0;
    column_names.forEach((name, column) => {
        if (removed.has(column)) return;
        const edited = header_edit(column);
        if (edited !== undefined && edited.trim() !== name.trim()) renamed += 1;
    });
    return renamed;
}

/** Whether a worksheet belongs in Review Changes' row and column list. */
export function worksheet_needs_structure_review(
    changes: PendingStructuralChanges | undefined,
): boolean {
    return changes !== undefined && has_live_layout_change(changes);
}

function counted(count: number, singular: string, plural: string, verb: string): string {
    return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural} ${verb}`;
}

/**
 * One line per worksheet: "2 rows inserted, 1 row deleted; 1 column renamed."
 * Zero counts are left out; a worksheet with none says "No row or column
 * changes."
 */
export function structure_counts_text(counts: WorksheetStructureCounts): string {
    const rows = ([
        ['inserted', counts.rows.inserted],
        ['deleted', counts.rows.deleted],
        ['moved', counts.rows.moved],
    ] as const).filter(([, count]) => count > 0)
        .map(([verb, count]) => counted(count, 'row', 'rows', verb));
    const columns = ([
        ['inserted', counts.columns.inserted],
        ['deleted', counts.columns.deleted],
        ['moved', counts.columns.moved],
        ['renamed', counts.columns.renamed],
    ] as const).filter(([, count]) => count > 0)
        .map(([verb, count]) => counted(count, 'column', 'columns', verb));
    const parts = [rows.join(', '), columns.join(', ')].filter((part) => part !== '');
    return parts.length === 0 ? 'No row or column changes.' : `${parts.join('; ')}.`;
}

/**
 * The spec's summary: "3 formulas have a range whose first or last row was
 * moved or deleted; check them before saving." The axis words follow the
 * flagged axes.
 */
export function divergence_summary_text(
    formulas: number,
    axes: ReadonlySet<'row' | 'column'>,
): string {
    const axis = axes.has('row') && axes.has('column')
        ? 'row or column'
        : axes.has('column') ? 'column' : 'row';
    return formulas === 1
        ? `1 formula has a range whose first or last ${axis} was moved or deleted; check it before saving.`
        : `${formulas.toLocaleString('en-US')} formulas have a range whose first or last ${axis} was moved or deleted; check them before saving.`;
}

/** Each class's heading in the list. */
export const DIVERGENCE_CLASS_HEADINGS: Readonly<Record<FormulaDivergenceClass, string>> = Object.freeze({
    moved: 'A move carried a corner of the range',
    refilled: 'Rows or columns were inserted or moved beside a deleted corner',
    discarded: 'A corner was on an appended row that was removed',
    unadjustable: "Can't be adjusted for these changes, so Save will refuse them",
});

export interface DivergenceGroup {
    readonly divergenceClass: FormulaDivergenceClass;
    readonly heading: string;
    readonly items: readonly FormulaDivergenceItem[];
}

/** One worksheet's flagged formulas, grouped by class in the spec's order; empty groups left out. */
export function divergence_groups(
    items: readonly FormulaDivergenceItem[],
    target_sheet_index: number,
): readonly DivergenceGroup[] {
    const mine = items.filter((item) => item.targetSheetIndex === target_sheet_index);
    return FORMULA_DIVERGENCE_CLASSES.flatMap((divergence_class) => {
        const members = mine.filter((item) => item.classes.includes(divergence_class));
        return members.length === 0
            ? []
            : [{ divergenceClass: divergence_class, heading: DIVERGENCE_CLASS_HEADINGS[divergence_class], items: members }];
    });
}

/** A0-style address of a 0-based prospective cell, qualified by sheet: `Summary!B4`. */
export function divergence_cell_label(sheet_name: string, row: number, column: number): string {
    let letters = '';
    for (let rest = column + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
        letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
    }
    const quoted = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet_name)
        ? sheet_name
        : `'${sheet_name.replace(/'/g, "''")}'`;
    return `${quoted}!${letters}${row + 1}`;
}

/**
 * The structural conflict notice's count for one action, before the user
 * chooses: "4 formulas will show #REF! and 12 will point at different rows or columns."
 * Undefined when the action changes no formula.
 */
export function formula_impact_text(impact: FormulaImpact): string | undefined {
    const formulas = (count: number) => `${count.toLocaleString('en-US')} ${count === 1 ? 'formula' : 'formulas'}`;
    if (impact.ref > 0 && impact.moved > 0) {
        return `${formulas(impact.ref)} will show #REF! and ${impact.moved.toLocaleString('en-US')} will point at different rows or columns.`;
    }
    if (impact.ref > 0) return `${formulas(impact.ref)} will show #REF!.`;
    if (impact.moved > 0) return `${formulas(impact.moved)} will point at different rows or columns.`;
    return undefined;
}

/**
 * Review Changes' padding note for a CSV or TSV worksheet (design "CSV and
 * TSV"): a column change writes every record at the prospective width, so a
 * record shorter than it is padded. Undefined without a live column change,
 * or when no record is shorter.
 */
export function short_rows_note(
    changes: Pick<PendingStructuralChanges, 'columnLayout'>,
    shortest_row_width: number | undefined,
): string | undefined {
    const layout = changes.columnLayout;
    if (layout === undefined || shortest_row_width === undefined || !has_live_column_layout_change(layout)) {
        return undefined;
    }
    const width = index_column_layout(layout).liveCount;
    return shortest_row_width < width ? `Short rows will be padded to ${width} columns.` : undefined;
}
