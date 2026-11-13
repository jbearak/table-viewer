/**
 * Formula Anchor views over Worksheet Layouts: the adapter from the layout
 * index (`worksheet-layout.ts`) to the {@link AnchorAxisView} that anchoring
 * and rendering read (`formula-anchors.ts`), plus the workbook context and the
 * prospective-coordinate lookups that the editor, the cell renderer, and the
 * live calculator share (design: "Formula Anchors", "Rendering formulas", and
 * "Formula display and calculation" in the row and column structure spec).
 *
 * Coordinates follow `AnchorAxisView`: a **number** is the 1-based worksheet
 * row or column a formula writes; a **position** is 0-based in the axis's full
 * order, tombstones included, then the live append band. The calculator's
 * 0-based **prospective** rows and columns are numbers minus one.
 *
 * A pure leaf: no webview or host imports.
 */

import {
    appended_rows,
    type PendingRowId,
    type PendingStructuralChanges,
    type RowIdentity,
} from './pending-changes';
import {
    canonical_row_layout,
    has_live_column_layout_change,
    has_live_row_layout_change,
    index_column_layout,
    index_row_layout,
    source_column_layout,
    source_row_layout,
    type AxisLayoutIndex,
    type ColumnIdentity,
    type ColumnLayout,
    type RowLayout,
    type SourceInterval,
} from './worksheet-layout';
import type {
    AnchorAxisView,
    AnchorWorksheet,
    FormulaAnchorContext,
    FormulaAnchors,
} from './formula-anchors';
import type { WorksheetTarget } from './types';
import type { FormulaReferenceIssue } from './xlsx-formula';

// --- Axis views --------------------------------------------------------------

class LayoutAnchorAxis<Identity> implements AnchorAxisView<Identity> {
    readonly fullCount: number;
    readonly liveCount: number;
    readonly bandCount: number;
    readonly hasInsertOrOutOfOrderRun: boolean;

    constructor(
        private readonly index: AxisLayoutIndex<Identity>,
        readonly fixedCount: number,
        readonly sourceCount: number,
        readonly hasLiveChange: boolean,
        private readonly band: readonly Identity[],
        private readonly band_position: (identity: Identity) => number | undefined,
    ) {
        this.fullCount = index.entryCount;
        this.liveCount = index.liveCount;
        this.bandCount = band.length;
        this.hasInsertOrOutOfOrderRun = index.hasInsertOrOutOfOrderRun;
    }

    position_of(identity: Identity): number | undefined {
        const position = this.index.position_of(identity);
        if (position !== undefined) return position;
        const band = this.band_position(identity);
        return band === undefined ? undefined : this.fullCount + band;
    }

    is_live(position: number): boolean {
        if (position >= this.fullCount) return true;
        const identity = this.index.identity_at_position(position);
        return identity !== undefined && this.index.is_live(identity);
    }

    prospective_number(position: number): number {
        if (position >= this.fullCount) {
            return this.fixedCount + this.liveCount + position - this.fullCount + 1;
        }
        return this.fixedCount + this.index.live_count_before(position) + 1;
    }

    first_live(first: number, last: number): number | undefined {
        const start = Math.max(0, first);
        if (start > last) return undefined;
        if (start < this.fullCount) {
            const identity = this.index.first_live_between(start, Math.min(last, this.fullCount - 1));
            if (identity !== undefined) return this.index.position_of(identity);
        }
        // Every position past the layout is live: the band, then empty members.
        return last >= this.fullCount ? Math.max(start, this.fullCount) : undefined;
    }

    last_live(first: number, last: number): number | undefined {
        const start = Math.max(0, first);
        if (start > last) return undefined;
        if (last >= this.fullCount && last >= start) return last;
        const identity = this.index.last_live_between(start, last);
        return identity === undefined ? undefined : this.index.position_of(identity);
    }

    identity_at(number: number): Identity | undefined {
        const index = number - this.fixedCount - 1;
        if (!Number.isSafeInteger(index) || index < 0) return undefined;
        if (index < this.liveCount) return this.index.identity_at_body_index(index + 1);
        return this.band[index - this.liveCount];
    }

    in_displaced_run(identity: Identity): boolean {
        return this.index.in_displaced_source_run(identity);
    }
}

export interface RowAnchorAxisInput {
    /** H: the Header Row's 1-based number, or 0 without one. */
    readonly bodyStart: number;
    /** Source body rows: the body is `[bodyStart, bodyStart + bodyRowCount)` as source rows. */
    readonly bodyRowCount: number;
    /** Absent means the source layout. */
    readonly rowLayout?: RowLayout;
    /** Live Pending Appended Rows, in `createdOrder`. */
    readonly band?: readonly PendingRowId[];
    /**
     * Source rows of Pending Tail Removals. They are not live, so they are not
     * counted in N, but they are not a layout change either: a worksheet with
     * only tail removals renders implicitly anchored references unchanged.
     */
    readonly tailRemovedSourceRows?: readonly number[];
}

function with_tail_removals(layout: RowLayout, rows: readonly number[]): RowLayout {
    if (rows.length === 0) return layout;
    const removed: SourceInterval[] = [...layout.removedSourceRows];
    for (const row of rows) removed.push({ start: row, count: 1 });
    return canonical_row_layout({ ...layout, removedSourceRows: removed });
}

/** The row axis of one worksheet: H fixed rows, the row layout with tombstones, then the live append band. */
export function row_anchor_axis(input: RowAnchorAxisInput): AnchorAxisView<RowIdentity> {
    const layout = input.rowLayout ?? source_row_layout(input.bodyStart, input.bodyRowCount);
    const band = (input.band ?? []).map((pendingRowId): RowIdentity => ({ kind: 'pending', pendingRowId }));
    const band_index = new Map((input.band ?? []).map((id, index) => [id, index]));
    return new LayoutAnchorAxis<RowIdentity>(
        index_row_layout(with_tail_removals(layout, input.tailRemovedSourceRows ?? [])),
        input.bodyStart,
        input.bodyRowCount,
        input.rowLayout !== undefined && has_live_row_layout_change(input.rowLayout),
        band,
        (identity) => identity.kind === 'pending' ? band_index.get(identity.pendingRowId) : undefined,
    );
}

export interface ColumnAnchorAxisInput {
    readonly sourceColumnCount: number;
    /** Absent means the source layout. */
    readonly columnLayout?: ColumnLayout;
}

/** The column axis of one worksheet: the column layout with tombstones; columns have no fixed members and no band. */
export function column_anchor_axis(input: ColumnAnchorAxisInput): AnchorAxisView<ColumnIdentity> {
    const layout = input.columnLayout ?? source_column_layout(input.sourceColumnCount);
    return new LayoutAnchorAxis<ColumnIdentity>(
        index_column_layout(layout),
        0,
        input.sourceColumnCount,
        input.columnLayout !== undefined && has_live_column_layout_change(input.columnLayout),
        [],
        () => undefined,
    );
}

// --- Worksheets and the workbook context -------------------------------------

/** The structural fields anchoring reads from a worksheet's Pending Changes. */
export type AnchorStructuralChanges = Pick<
    PendingStructuralChanges,
    'appendedRows' | 'tailRemovals' | 'rowLayout' | 'columnLayout'
>;

export interface AnchorWorksheetInput {
    readonly target: WorksheetTarget;
    /** The name formulas qualify it by. */
    readonly name: string;
    /** H: the Header Row's 1-based number, or 0 without one. */
    readonly bodyStart: number;
    /** Canonical source row count; the body is `[bodyStart, sourceRowCount)`. */
    readonly sourceRowCount: number;
    readonly sourceColumnCount: number;
    /** Absent means no Pending Changes: the source layout and an empty band. */
    readonly changes?: AnchorStructuralChanges;
}

function band_of(changes: AnchorStructuralChanges | undefined): readonly PendingRowId[] {
    if (changes === undefined) return [];
    return [...appended_rows(changes)]
        .sort((left, right) => left.createdOrder - right.createdOrder)
        .map((row) => row.id);
}

/** One worksheet as anchoring and rendering see it. */
export function anchor_worksheet(input: AnchorWorksheetInput): AnchorWorksheet {
    return {
        target: input.target,
        name: input.name,
        rows: row_anchor_axis({
            bodyStart: input.bodyStart,
            bodyRowCount: Math.max(0, input.sourceRowCount - input.bodyStart),
            ...(input.changes?.rowLayout === undefined ? {} : { rowLayout: input.changes.rowLayout }),
            band: band_of(input.changes),
            tailRemovedSourceRows: (input.changes?.tailRemovals ?? []).map((removal) => removal.sourceRow),
        }),
        columns: column_anchor_axis({
            sourceColumnCount: input.sourceColumnCount,
            ...(input.changes?.columnLayout === undefined ? {} : { columnLayout: input.changes.columnLayout }),
        }),
    };
}

/** The workbook as anchoring and rendering see it, from the formula's own worksheet. */
export interface FormulaAnchorWorkbook {
    readonly format: FormulaAnchorContext['format'];
    readonly worksheets: readonly AnchorWorksheet[];
}

export function formula_anchor_workbook(
    format: FormulaAnchorContext['format'],
    worksheets: readonly AnchorWorksheetInput[],
): FormulaAnchorWorkbook {
    return { format, worksheets: worksheets.map(anchor_worksheet) };
}

export function formula_anchor_context(
    workbook: FormulaAnchorWorkbook,
    formula_worksheet: number,
): FormulaAnchorContext {
    return { format: workbook.format, worksheets: workbook.worksheets, formulaWorksheet: formula_worksheet };
}

/**
 * Whether rendering can change any formula text in this workbook: some
 * worksheet has a live layout change. Without one, only stored anchors render
 * (see {@link formula_needs_rendering}).
 */
export function workbook_has_live_layout_change(workbook: FormulaAnchorWorkbook): boolean {
    return workbook.worksheets.some((worksheet) =>
        worksheet.rows.hasLiveChange || worksheet.columns.hasLiveChange);
}

/**
 * Whether a formula's text may differ from its rendering: some worksheet has a
 * live layout change, or the formula stores anchors. When false,
 * `render_formula` returns the text unchanged, so callers can skip it.
 */
export function formula_needs_rendering(
    workbook: FormulaAnchorWorkbook,
    anchors: FormulaAnchors | undefined,
): boolean {
    return (anchors !== undefined && anchors.references.length > 0)
        || workbook_has_live_layout_change(workbook);
}

// --- Prospective coordinates -------------------------------------------------

/** What a prospective cell holds, by identity. */
export interface ProspectiveCell {
    /** `fixed` for a row at or above the Header Row, which the layout does not hold. */
    readonly row: RowIdentity | { readonly kind: 'fixed'; readonly sourceRow: number };
    readonly column: ColumnIdentity;
}

/**
 * The identities at a 0-based prospective `(row, column)`, or `undefined`
 * past every live row or column (an empty cell). Removed and discarded rows
 * and columns have no prospective coordinate, so they are never returned.
 */
export function prospective_cell_at(
    worksheet: AnchorWorksheet,
    row: number,
    column: number,
): ProspectiveCell | undefined {
    const column_identity = worksheet.columns.identity_at(column + 1);
    if (column_identity === undefined) return undefined;
    if (row < worksheet.rows.fixedCount) {
        return row < 0 ? undefined : { row: { kind: 'fixed', sourceRow: row }, column: column_identity };
    }
    const row_identity = worksheet.rows.identity_at(row + 1);
    return row_identity === undefined ? undefined : { row: row_identity, column: column_identity };
}

/** 0-based prospective row of a live row identity; `undefined` for a tombstone or an unknown identity. */
export function prospective_row_of(
    worksheet: AnchorWorksheet,
    identity: RowIdentity,
): number | undefined {
    if (identity.kind === 'source' && identity.sourceRow < worksheet.rows.fixedCount) {
        return identity.sourceRow >= 0 ? identity.sourceRow : undefined;
    }
    const position = worksheet.rows.position_of(identity);
    if (position === undefined || !worksheet.rows.is_live(position)) return undefined;
    return worksheet.rows.prospective_number(position) - 1;
}

/** 0-based prospective column of a live column identity; `undefined` for a tombstone or an unknown identity. */
export function prospective_column_of(
    worksheet: AnchorWorksheet,
    identity: ColumnIdentity,
): number | undefined {
    const position = worksheet.columns.position_of(identity);
    if (position === undefined || !worksheet.columns.is_live(position)) return undefined;
    return worksheet.columns.prospective_number(position) - 1;
}

/** Prospective row count: H + N + the live band. */
export function prospective_row_count(worksheet: AnchorWorksheet): number {
    return worksheet.rows.fixedCount + worksheet.rows.liveCount + worksheet.rows.bandCount;
}

/** Prospective column count: live columns. */
export function prospective_column_count(worksheet: AnchorWorksheet): number {
    return worksheet.columns.liveCount;
}

// --- Unrenderable formulas -----------------------------------------------------

/** Why a formula cannot be rendered for the current layouts: an Unknown formula result's reason. */
export type UnrenderableFormulaReason =
    | "can't adjust a range built from a function"
    | "can't adjust a range across worksheets"
    | "can't adjust a 3D reference"
    | "can't adjust a spill reference"
    | "can't adjust an R1C1 reference";

const UNRENDERABLE_REASONS: Readonly<Record<FormulaReferenceIssue['kind'], UnrenderableFormulaReason>> = {
    rangeOperand: "can't adjust a range built from a function",
    mixedSheets: "can't adjust a range across worksheets",
    threeDimensional: "can't adjust a 3D reference",
    spill: "can't adjust a spill reference",
    r1c1: "can't adjust an R1C1 reference",
};

/** The reason an `unrenderable` formula shows, for its `??` result and the editor refusal. */
export function unrenderable_formula_reason(issue: FormulaReferenceIssue): UnrenderableFormulaReason {
    return UNRENDERABLE_REASONS[issue.kind];
}

export const UNRENDERABLE_FORMULA_REASONS: readonly UnrenderableFormulaReason[] =
    Object.freeze(Object.values(UNRENDERABLE_REASONS));
