/**
 * Pending-change notices: what Table Viewer says before Save about Pending
 * Changes the grid cannot show (ADR 0006). The grid's tints already record
 * every inserted, deleted, and moved row and column, so a plain structural
 * change gets no notice. A notice appears, without a click, only when Save
 * will do something the person can't see in the grid or must decide on:
 *
 * - Save is refused: the file changed under a worksheet's layout, the
 *   worksheet can't be restructured, pending rows no longer fit, a rule
 *   would split past the writer's cap, or a formula can't be adjusted;
 * - formulas will show `#REF!` because a row or column they use was deleted;
 * - formulas whose range a move or delete changed in a way Excel might not.
 *
 * A pure function of its input: the workbook's pending structure as the
 * caller summarizes it, the active worksheet's conflicts, the Save-refusal
 * verdicts, the host's answers to the two formula questions, and the
 * dismissals. Each notice carries its role, severity, sentences, formula
 * list, actions as intents, and its own dismissal key; the app renders the
 * list in order and dispatches the intents.
 *
 * The Save button's description (what Save will do) lives here too, since it
 * is the other half of the same decision: the summary moved off the grid into
 * the button that acts on it.
 */
import { parse_cell_key } from '../cell-key';
import {
    appended_rows,
    inserted_rows,
    type PendingRowId,
    type PendingStructuralChanges,
    type PendingStructuralConflict,
    type RowIdentity,
} from '../pending-changes';
import {
    has_live_column_layout_change,
    index_column_layout,
    moved_source_columns,
    moved_source_rows,
    type ColumnIdentity,
    type ColumnLayout,
} from '../worksheet-layout';
import type {
    FormulaDeletedItem,
    FormulaDivergenceClass,
    FormulaDivergenceItem,
    FormulaDivergenceReview,
    FormulaImpact,
    FormulaTargetCount,
} from '../formula-divergence-review';

// --- Notices -----------------------------------------------------------------

export type PendingChangeNoticeIntent =
    /** Select a formula's 0-based prospective cell, on its own worksheet. */
    | { readonly kind: 'goToCell'; readonly sheetIndex: number; readonly row: number; readonly column: number }
    /** Hide the notice until its content changes. */
    | { readonly kind: 'dismiss'; readonly key: string }
    | { readonly kind: 'keepInsertedRowsAtEnd' }
    | { readonly kind: 'discardLayoutChanges' }
    | { readonly kind: 'retryFormulaImpact' }
    | {
        readonly kind: 'goToAffectedRow';
        readonly target:
            | { readonly kind: 'pendingRow'; readonly pendingRowId: PendingRowId }
            | { readonly kind: 'tailRemoval'; readonly tailRemovalId: string }
            | { readonly kind: 'sourceCell'; readonly sourceRow: number; readonly sourceColumn: number };
    }
    | { readonly kind: 'removePendingRows'; readonly pendingRowIds: readonly PendingRowId[] }
    | { readonly kind: 'cancelTailRemovals'; readonly tailRemovalIds: readonly string[] };

export interface PendingChangeNoticeAction {
    readonly label: string;
    readonly intent: PendingChangeNoticeIntent;
    readonly disabled?: boolean;
    readonly ariaLabel?: string;
}

export interface PendingChangeNoticeFormula {
    /** `B7`, or `Summary!B7` in a workbook with more than one worksheet. */
    readonly location: string;
    /** The formula as Save writes it. */
    readonly formula: string;
    /** The formula as written, when it differs from what Save writes. */
    readonly written?: string;
    /** Why this one is listed, when the notice's sentences don't already say. */
    readonly note?: string;
    readonly goTo: PendingChangeNoticeAction;
}

export interface PendingChangeNoticeFormulas {
    readonly items: readonly PendingChangeNoticeFormula[];
    /** Every such formula, including any past the host's listing cap. */
    readonly total: number;
    /** Long lists start collapsed behind a "Show N formulas" disclosure. */
    readonly collapsed: boolean;
    readonly disclosureLabel: string;
    /** "Showing the first 500." when the host capped the list. */
    readonly truncatedNote?: string;
}

export type PendingChangeNoticeKind =
    | 'layoutConflict'
    | 'pendingRowConflict'
    | 'saveRefusal'
    | 'deletedReferences'
    | 'changedRanges'
    | 'formulaCheckFailed';

export interface PendingChangeNotice {
    /** Stable per kind: the React key, and the disclosure's identity. */
    readonly kind: PendingChangeNoticeKind;
    /** `alert` for what blocks Save, `status` for warnings. */
    readonly role: 'alert' | 'status';
    readonly severity: 'refusal' | 'warning' | 'info';
    /** The landmark's accessible name. */
    readonly label: string;
    readonly heading?: string;
    readonly sentences: readonly string[];
    /** A transient line, such as "Checking formulas…". */
    readonly status?: string;
    readonly formulas?: PendingChangeNoticeFormulas;
    readonly actions: readonly PendingChangeNoticeAction[];
    /** The key Dismiss records; a notice whose key is dismissed is left out. */
    readonly dismissKey?: string;
}

/** The host's answer to the Save warnings' formula question. */
export interface PendingChangeFormulaReview {
    /** `null` when the host couldn't check. */
    readonly review: FormulaDivergenceReview | null;
    /**
     * Whether the answer is for the current layouts and edits. A stale answer
     * still shows while the next one is computed, so the notice doesn't
     * flicker, but its Go to cell actions wait: its cells may have moved.
     */
    readonly current: boolean;
}

export type PendingChangeFormulaImpact =
    | { readonly state: 'pending' }
    | { readonly state: 'unavailable' }
    | { readonly state: 'ready'; readonly keep?: FormulaImpact; readonly discard?: FormulaImpact };

export interface PendingChangeNoticeWorksheet {
    readonly name: string;
    /** Header Row names by source column, when the worksheet has an active Header Row. */
    readonly columnNames?: readonly (string | undefined)[];
    /** Pending Column headers by id. */
    readonly pendingColumnNames?: ReadonlyMap<string, string>;
    /**
     * The name over each column as the grid shows it, by 0-based prospective
     * column, when the worksheet has an active Header Row. The grid shows
     * these names rather than column letters, so a formula's cell is labelled
     * by them: "Total, row 2".
     */
    readonly prospectiveColumnNames?: readonly (string | undefined)[];
}

export interface PendingChangeNoticeInput {
    /** CSV and TSV: one unnamed table, so no notice names a worksheet. */
    readonly singleTable: boolean;
    readonly activeSheetIndex: number;
    readonly worksheets: readonly PendingChangeNoticeWorksheet[];
    /** The active worksheet's structural conflicts, while it can be edited. */
    readonly conflicts?: {
        /** Identifies the worksheet across tabs, for the dismissal keys. */
        readonly worksheetKey: string;
        readonly items: readonly PendingStructuralConflict[];
        /** Values typed in Pending Columns that Keep new rows at the end drops. */
        readonly columnValuesLost: number;
        /** The host's count of what each salvage action does to formulas; absent when not asked. */
        readonly impact?: PendingChangeFormulaImpact;
    };
    /** Save-refusal verdicts the webview computes as the layout changes (rule splits). */
    readonly refusals: readonly string[];
    /** Absent before the host first answers, or when there is nothing to ask. */
    readonly formulaReview?: PendingChangeFormulaReview;
    readonly dismissed: ReadonlySet<string>;
}

/** Lists this long or shorter show inline; longer ones start collapsed. */
export const INLINE_FORMULA_LIMIT = 3;

/** Dismissal keys of the notices that explain a refused Save; Save clears them. */
export function is_conflict_dismissal(key: string): boolean {
    return key.startsWith('conflict:');
}

/**
 * Every notice to show, most severe first: what blocks Save, then what Save
 * will break, then what Excel might do differently. Dismissed notices are
 * left out.
 */
export function pending_change_notices(input: PendingChangeNoticeInput): readonly PendingChangeNotice[] {
    const notices = [
        ...conflict_notices(input),
        save_refusal_notice(input),
        deleted_references_notice(input),
        changed_ranges_notice(input),
        formula_check_failed_notice(input),
    ].filter((notice): notice is PendingChangeNotice => notice !== undefined);
    return notices.filter((notice) => notice.dismissKey === undefined || !input.dismissed.has(notice.dismissKey));
}

function count(n: number, singular: string, plural: string): string {
    return `${n.toLocaleString('en-US')} ${n === 1 ? singular : plural}`;
}

function and_list(words: readonly string[]): string {
    if (words.length <= 1) return words.join('');
    if (words.length === 2) return `${words[0]} and ${words[1]}`;
    return `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`;
}

// --- Conflicts -----------------------------------------------------------------

const PENDING_ROW_CONFLICT_TEXT: Readonly<Record<string, string>> = Object.freeze({
    ambiguousColumns: 'Column identities no longer match.',
    ambiguousPendingFormula: 'A pending formula would refer to a different row after rebasing.',
    worksheetReplaced: 'The worksheet was replaced.',
    rowLimitExceeded: 'The worksheet no longer has room for every pending row.',
    templateChanged: 'The row-format template changed.',
    savedSuffixChanged: 'The saved worksheet suffix changed.',
});

function is_layout_conflict(conflict: PendingStructuralConflict): boolean {
    return conflict.reason === 'structuralBasisChanged' || conflict.reason === 'unsupportedStructure';
}

function conflict_notices(input: PendingChangeNoticeInput): PendingChangeNotice[] {
    const conflicts = input.conflicts;
    if (conflicts === undefined || conflicts.items.length === 0) return [];
    const name = input.worksheets[input.activeSheetIndex]?.name ?? '';
    const layout = conflicts.items.filter(is_layout_conflict);
    const rows = conflicts.items.filter((conflict) => !is_layout_conflict(conflict));
    const out: PendingChangeNotice[] = [];
    if (layout.length > 0) out.push(layout_conflict_notice(name, conflicts, layout));
    if (rows.length > 0) out.push(pending_row_conflict_notice(conflicts.worksheetKey, rows));
    return out;
}

/** "4 formulas will show #REF! and 12 will point at different rows or columns." */
export function formula_impact_text(impact: FormulaImpact): string | undefined {
    const formulas = (n: number) => count(n, 'formula', 'formulas');
    if (impact.ref > 0 && impact.moved > 0) {
        return `${formulas(impact.ref)} will show #REF! and ${impact.moved.toLocaleString('en-US')} will point at different rows or columns.`;
    }
    if (impact.ref > 0) return `${formulas(impact.ref)} will show #REF!.`;
    if (impact.moved > 0) return `${formulas(impact.moved)} will point at different rows or columns.`;
    return undefined;
}

function layout_conflict_notice(
    name: string,
    conflicts: NonNullable<PendingChangeNoticeInput['conflicts']>,
    layout: readonly PendingStructuralConflict[],
): PendingChangeNotice {
    const basis_changed = layout.some((conflict) => conflict.reason === 'structuralBasisChanged');
    const sentences: string[] = [];
    if (basis_changed) {
        sentences.push(
            `${name} changed on disk after you inserted, deleted, or moved rows or columns.`,
            "Table Viewer can't tell where those changes belong in the new version.",
        );
    }
    for (const conflict of layout) {
        if (conflict.reason !== 'unsupportedStructure') continue;
        sentences.push(`${name}: ${conflict.message
            ?? "Can't save these row and column changes: the worksheet has a structure Table Viewer can't shift."}`);
    }
    if (basis_changed && conflicts.columnValuesLost > 0) {
        sentences.push(`Values typed in ${count(conflicts.columnValuesLost, 'new column', 'new columns')} will be discarded.`);
    }
    const impact = conflicts.impact;
    const pending = impact?.state === 'pending';
    if (impact?.state === 'unavailable') {
        sentences.push('Formula impact unavailable. Retry, or choose an action without the count.');
    }
    if (impact?.state === 'ready') {
        const keep = basis_changed && impact.keep !== undefined ? formula_impact_text(impact.keep) : undefined;
        const discard = impact.discard === undefined ? undefined : formula_impact_text(impact.discard);
        if (keep !== undefined) sentences.push(`Keep new rows at the end: ${keep}`);
        if (discard !== undefined) sentences.push(`Discard row and column changes on ${name}: ${discard}`);
    }
    const dismissKey = `conflict:layout:${JSON.stringify([conflicts.worksheetKey, layout])}`;
    const actions: PendingChangeNoticeAction[] = [];
    if (impact?.state === 'unavailable') actions.push({ label: 'Retry', intent: { kind: 'retryFormulaImpact' } });
    if (basis_changed) {
        actions.push({ label: 'Keep new rows at the end', intent: { kind: 'keepInsertedRowsAtEnd' }, disabled: pending });
    }
    actions.push(
        { label: `Discard row and column changes on ${name}`, intent: { kind: 'discardLayoutChanges' }, disabled: pending },
        { label: 'Dismiss notice', intent: { kind: 'dismiss', key: dismissKey } },
    );
    return {
        kind: 'layoutConflict',
        role: 'alert',
        severity: 'refusal',
        label: 'Row and column changes that need review',
        sentences,
        ...(pending ? { status: 'Checking formulas…' } : {}),
        actions,
        dismissKey,
    };
}

function pending_row_conflict_notice(
    worksheet_key: string,
    conflicts: readonly PendingStructuralConflict[],
): PendingChangeNotice {
    const unique = <T>(values: readonly T[]) => [...new Set(values)];
    const pending_row_ids = unique(conflicts.flatMap((conflict) => conflict.pendingRowIds));
    const tail_removal_ids = unique(conflicts.flatMap((conflict) => conflict.tailRemovalIds));
    const formula = conflicts.flatMap((conflict) => conflict.formulaCells ?? [])[0];
    const target = pending_row_ids[0] !== undefined
        ? { kind: 'pendingRow' as const, pendingRowId: pending_row_ids[0] }
        : tail_removal_ids[0] !== undefined
            ? { kind: 'tailRemoval' as const, tailRemovalId: tail_removal_ids[0] }
            : formula?.rowIdentity.kind === 'source'
                ? { kind: 'sourceCell' as const, sourceRow: formula.rowIdentity.sourceRow, sourceColumn: formula.sourceColumn }
                : undefined;
    const dismissKey = `conflict:rows:${JSON.stringify([worksheet_key, conflicts])}`;
    const actions: PendingChangeNoticeAction[] = [{
        label: 'Go to affected row',
        // With nothing to reveal the action stays, disabled, as before.
        intent: { kind: 'goToAffectedRow', target: target ?? { kind: 'pendingRow', pendingRowId: '' } },
        disabled: target === undefined,
    }];
    if (pending_row_ids.length > 0) {
        actions.push({
            label: 'Remove affected pending rows',
            intent: { kind: 'removePendingRows', pendingRowIds: pending_row_ids },
        });
    }
    if (tail_removal_ids.length > 0) {
        actions.push({
            label: 'Cancel affected row removals',
            intent: { kind: 'cancelTailRemovals', tailRemovalIds: tail_removal_ids },
        });
    }
    actions.push({ label: 'Dismiss notice', intent: { kind: 'dismiss', key: dismissKey } });
    return {
        kind: 'pendingRowConflict',
        role: 'alert',
        severity: 'refusal',
        label: 'Pending rows that need review',
        heading: 'Pending rows need review',
        sentences: [
            'The worksheet structure changed, so these row changes cannot be saved until you edit or remove '
                + 'pending rows, or cancel affected removals.',
            ...unique(conflicts.map((conflict) => PENDING_ROW_CONFLICT_TEXT[conflict.reason]
                ?? 'The saved worksheet suffix changed.')),
        ],
        actions,
        dismissKey,
    };
}

// --- Formulas ------------------------------------------------------------------

/** A1-style address of a 0-based prospective cell, qualified by sheet when asked: `Summary!B4`. */
export function formula_cell_label(sheet_name: string | undefined, row: number, column: number): string {
    let letters = '';
    for (let rest = column + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
        letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
    }
    if (sheet_name === undefined) return `${letters}${row + 1}`;
    const quoted = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet_name)
        ? sheet_name
        : `'${sheet_name.replace(/'/g, "''")}'`;
    return `${quoted}!${letters}${row + 1}`;
}

interface FormulaCell {
    readonly sheetIndex: number;
    readonly row: number;
    readonly column: number;
    readonly formula: string;
    readonly written: string;
}

/**
 * Where a formula is, as the grid shows it: "Total, row 2" under a Header
 * Row, else "B2"; with the worksheet when the workbook has several, as
 * "Total, row 2 on Summary" or "Summary!B2".
 */
export function formula_location(
    input: Pick<PendingChangeNoticeInput, 'singleTable' | 'worksheets'>,
    sheet_index: number,
    row: number,
    column: number,
): string {
    const qualify = !input.singleTable && input.worksheets.length > 1;
    const worksheet = input.worksheets[sheet_index];
    const name = worksheet?.prospectiveColumnNames?.[column];
    if (name !== undefined && name.trim() !== '') {
        return `${name}, row ${row + 1}${qualify ? ` on ${worksheet?.name ?? ''}` : ''}`;
    }
    return formula_cell_label(qualify ? worksheet?.name ?? '' : undefined, row, column);
}

function formula_entry(
    input: PendingChangeNoticeInput,
    item: FormulaCell,
    note?: string,
): PendingChangeNoticeFormula {
    const location = formula_location(input, item.sheetIndex, item.row, item.column);
    return {
        location,
        formula: item.formula,
        ...(item.written !== item.formula ? { written: item.written } : {}),
        ...(note === undefined ? {} : { note }),
        goTo: {
            label: 'Go to cell',
            ariaLabel: `Go to ${location}`,
            intent: { kind: 'goToCell', sheetIndex: item.sheetIndex, row: item.row, column: item.column },
            disabled: input.formulaReview?.current !== true,
        },
    };
}

/** One entry per formula cell: a formula naming two worksheets is listed once. */
function unique_cells<T extends FormulaCell>(items: readonly T[]): T[][] {
    const by_cell = new Map<string, T[]>();
    for (const item of items) {
        const key = `${item.sheetIndex}:${item.row}:${item.column}`;
        const group = by_cell.get(key);
        if (group === undefined) by_cell.set(key, [item]);
        else group.push(item);
    }
    return [...by_cell.values()];
}

function formula_total(listed: number, items: number, counts: readonly FormulaTargetCount[]): number {
    const sum = counts.reduce((total, entry) => total + entry.formulas, 0);
    // Uncapped, the listed cells are exact; capped, the per-worksheet counts
    // are the best there is.
    return items >= sum ? listed : Math.max(listed, sum);
}

function formula_list(
    entries: readonly PendingChangeNoticeFormula[],
    total: number,
): PendingChangeNoticeFormulas {
    return {
        items: entries,
        total,
        collapsed: entries.length > INLINE_FORMULA_LIMIT,
        disclosureLabel: `Show ${count(total, 'formula', 'formulas')}`,
        ...(total > entries.length
            ? { truncatedNote: `Showing the first ${entries.length.toLocaleString('en-US')}.` }
            : {}),
    };
}

function signature(kind: string, total: number, entries: readonly PendingChangeNoticeFormula[]): string {
    return `${kind}:${JSON.stringify([total, entries.map((entry) => [entry.location, entry.formula])])}`;
}

/** What the person deleted that a formula uses, in words. */
function deleted_thing_words(
    input: PendingChangeNoticeInput,
    items: readonly FormulaDeletedItem[],
): string {
    const rows = new Map<string, { target: number; identity: RowIdentity }>();
    const columns = new Map<string, { target: number; identity: ColumnIdentity }>();
    for (const item of items) {
        for (const identity of item.rows) rows.set(`${item.targetSheetIndex}:${JSON.stringify(identity)}`, { target: item.targetSheetIndex, identity });
        for (const identity of item.columns) columns.set(`${item.targetSheetIndex}:${JSON.stringify(identity)}`, { target: item.targetSheetIndex, identity });
    }
    const targets = new Set([...rows.values(), ...columns.values()].map((entry) => entry.target));
    // Name the worksheet only when it helps: in a workbook, when the deleted
    // rows or columns are on another worksheet than the one showing.
    const only_target = targets.size === 1 ? [...targets][0]! : undefined;
    const where = input.singleTable || only_target === undefined || only_target === input.activeSheetIndex
        ? ''
        : ` on ${input.worksheets[only_target]?.name ?? ''}`;
    const column_name = ({ target, identity }: { target: number; identity: ColumnIdentity }): string | undefined => {
        const worksheet = input.worksheets[target];
        const name = identity.kind === 'source'
            ? worksheet?.columnNames?.[identity.sourceColumn]
            : worksheet?.pendingColumnNames?.get(identity.pendingColumnId);
        return name === undefined || name.trim() === '' ? undefined : name;
    };
    if (targets.size > 1) {
        return rows.size > 0 && columns.size > 0
            ? 'rows and columns you deleted'
            : rows.size > 0 ? 'rows you deleted' : 'columns you deleted';
    }
    if (rows.size === 0 && columns.size > 0) {
        const names = [...columns.values()].map(column_name);
        if (names.every((name) => name !== undefined) && names.length <= 3) {
            return `${names.length === 1 ? 'column' : 'columns'} ${and_list(names as string[])}${where}, which you deleted`;
        }
        return columns.size === 1 ? `a column you deleted${where}` : `columns you deleted${where}`;
    }
    if (columns.size === 0 && rows.size > 0) {
        return rows.size === 1 ? `a row you deleted${where}` : `rows you deleted${where}`;
    }
    return `rows and columns you deleted${where}`;
}

function deleted_references_notice(input: PendingChangeNoticeInput): PendingChangeNotice | undefined {
    const review = input.formulaReview?.review;
    if (review === undefined || review === null || review.deleted.length === 0) return undefined;
    const groups = unique_cells(review.deleted);
    const entries = groups.map((group) => formula_entry(input, group[0]!));
    const total = formula_total(groups.length, review.deleted.length, review.deletedCounts);
    const distinct = (pick: (item: FormulaDeletedItem) => readonly unknown[]) => new Set(review.deleted.flatMap((item) =>
        pick(item).map((identity) => `${item.targetSheetIndex}:${JSON.stringify(identity)}`))).size;
    const rows = distinct((item) => item.rows);
    const columns = distinct((item) => item.columns);
    const restore = rows > 0 && columns > 0
        ? 'rows and columns'
        : columns > 0 ? (columns === 1 ? 'column' : 'columns') : (rows === 1 ? 'row' : 'rows');
    const pronoun = total === 1 ? 'it' : 'them';
    return {
        kind: 'deletedReferences',
        role: 'status',
        severity: 'warning',
        label: 'Formulas that will show #REF!',
        sentences: [
            `${count(total, 'formula uses', 'formulas use')} ${deleted_thing_words(input, review.deleted)}. `
                + `After you save, ${total === 1 ? 'it' : 'they'} will show #REF!.`,
            `Restore the ${restore}, or undo, to keep ${pronoun} working.`,
        ],
        formulas: formula_list(entries, total),
        actions: [{ label: 'Dismiss', intent: { kind: 'dismiss', key: signature('deleted', total, entries) } }],
        dismissKey: signature('deleted', total, entries),
    };
}

type RangeClass = Exclude<FormulaDivergenceClass, 'unadjustable'>;

const RANGE_CLASSES: readonly RangeClass[] = Object.freeze(['moved', 'refilled', 'discarded']);

/** Why a range changed, in words, for one range ("its range") or several ("their ranges"). */
function range_reason(range_class: RangeClass, axis: 'row' | 'column', plural: boolean): string {
    const range = plural ? 'their ranges' : 'its range';
    switch (range_class) {
        case 'moved':
            return `A ${axis} you moved was the first or last ${axis} of ${range}.`;
        case 'refilled':
            return `${axis === 'row' ? 'Rows' : 'Columns'} went in beside a deleted first or last ${axis} of ${range}.`;
        case 'discarded':
            return `${plural ? 'Their ranges end' : 'Its range ends'} on an appended row you removed.`;
    }
}

function axis_words(axes: ReadonlySet<'row' | 'column'>, plural: boolean): string {
    const noun = (word: string) => plural ? `${word}s` : word;
    return axes.has('row') && axes.has('column')
        ? `${noun('row')} and ${noun('column')}`
        : axes.has('column') ? noun('column') : noun('row');
}

function main_axis(axes: ReadonlySet<'row' | 'column'>): 'row' | 'column' {
    return axes.has('row') ? 'row' : 'column';
}

function changed_ranges_notice(input: PendingChangeNoticeInput): PendingChangeNotice | undefined {
    const review = input.formulaReview?.review;
    if (review === undefined || review === null) return undefined;
    const ranged = review.items.filter((item) => item.classes.some((name) => name !== 'unadjustable'));
    if (ranged.length === 0) return undefined;
    const groups = unique_cells(ranged);
    const classes = RANGE_CLASSES.filter((name) => ranged.some((item) => item.classes.includes(name)));
    const axes = new Set(ranged.flatMap((item) => item.axes));
    const mixed = classes.length > 1;
    const entries = groups.map((group) => {
        const item_class = RANGE_CLASSES.find((name) => group.some((item) => item.classes.includes(name)))!;
        const note = mixed
            ? range_reason(item_class, main_axis(new Set(group.flatMap((item) => item.axes))), false)
            : undefined;
        return formula_entry(input, group[0]!, note);
    });
    // The host's per-worksheet counts include formulas it flags as
    // unadjustable, so they stand in only when it capped its list.
    const counted = review.counts.reduce((total, entry) => total + entry.formulas, 0);
    const total = review.items.length >= counted ? groups.length : Math.max(groups.length, counted);
    const cause = classes.length === 1 && classes[0] === 'moved'
        ? `Moving ${axis_words(axes, true)}`
        : classes.length === 1 && classes[0] === 'discarded'
            ? 'Removing appended rows'
            : `Your ${axis_words(axes, false)} changes`;
    const pronoun = total === 1 ? 'it' : 'them';
    return {
        kind: 'changedRanges',
        role: 'status',
        severity: 'warning',
        label: 'Formulas whose ranges changed',
        sentences: [
            `${cause} changed the range in ${count(total, 'formula', 'formulas')}.`,
            ...(mixed ? [] : [range_reason(classes[0]!, main_axis(axes), total !== 1)]),
            `Excel might adjust ${pronoun} differently, so check ${pronoun} before you save.`,
        ],
        formulas: formula_list(entries, total),
        actions: [{ label: 'Dismiss', intent: { kind: 'dismiss', key: signature('ranges', total, entries) } }],
        dismissKey: signature('ranges', total, entries),
    };
}

function save_refusal_notice(input: PendingChangeNoticeInput): PendingChangeNotice | undefined {
    const review = input.formulaReview?.review;
    const unadjustable: FormulaDivergenceItem[] = review === undefined || review === null
        ? []
        : review.items.filter((item) => item.classes.includes('unadjustable'));
    if (input.refusals.length === 0 && unadjustable.length === 0) return undefined;
    const groups = unique_cells(unadjustable);
    const entries = groups.map((group) => formula_entry(input, group[0]!));
    const sentences = [...input.refusals];
    if (groups.length > 0) {
        const pronoun = groups.length === 1 ? 'it' : 'them';
        sentences.push(
            `Table Viewer can't adjust ${count(groups.length, 'formula', 'formulas')} for these row and column changes, `
                + `so Save will refuse ${pronoun}. Undo the change, or edit ${pronoun}.`,
        );
    }
    return {
        kind: 'saveRefusal',
        role: 'alert',
        severity: 'refusal',
        label: 'Row and column changes Save will refuse',
        sentences,
        ...(entries.length > 0 ? { formulas: formula_list(entries, groups.length) } : {}),
        actions: [],
    };
}

function formula_check_failed_notice(input: PendingChangeNoticeInput): PendingChangeNotice | undefined {
    if (input.formulaReview === undefined || input.formulaReview.review !== null) return undefined;
    const dismissKey = 'formula-check-failed';
    return {
        kind: 'formulaCheckFailed',
        role: 'status',
        severity: 'info',
        label: "Formulas Table Viewer couldn't check",
        sentences: ["Table Viewer couldn't check what these row and column changes do to formulas."],
        actions: [{ label: 'Dismiss', intent: { kind: 'dismiss', key: dismissKey } }],
        dismissKey,
    };
}

// --- What Save will do -------------------------------------------------------------

export interface WorksheetStructureCounts {
    readonly rows: {
        readonly inserted: number;
        readonly appended: number;
        readonly deleted: number;
        readonly moved: number;
    };
    readonly columns: {
        readonly inserted: number;
        readonly deleted: number;
        readonly moved: number;
        readonly renamed: number;
    };
}

/**
 * What Save will do to one worksheet's rows and columns. Inserted counts live
 * Pending Inserted Rows and Pending Columns; appended counts Pending Appended
 * Rows; deleted counts Pending Row and Column Removals; moved counts Moved
 * Rows and Columns by the moved-detection rule, as the tint marks them;
 * renamed counts the `renamed_columns` the caller found among live source
 * columns.
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
            appended: appended_rows(changes).length,
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

/**
 * Source cells with a pending edit that Save writes: edits on rows or columns
 * a removal drops are left out, as are renamed header cells, which the counts
 * already name.
 */
export function saved_cell_edit_count(
    keys: Iterable<string>,
    changes: Pick<PendingStructuralChanges, 'rowLayout' | 'columnLayout'> | undefined,
    renamed_columns: number,
): number {
    const removed_rows = changes?.rowLayout?.removedSourceRows ?? [];
    const removed_columns = new Set(changes?.columnLayout?.removedSourceColumns ?? []);
    let edits = 0;
    for (const key of keys) {
        const cell = parse_cell_key(key);
        if (cell === undefined) continue;
        if (removed_columns.has(cell.sourceColumn)) continue;
        if (removed_rows.some((run) => cell.sourceRow >= run.start && cell.sourceRow < run.start + run.count)) continue;
        edits += 1;
    }
    return Math.max(0, edits - renamed_columns);
}

/**
 * Save's padding note for a CSV or TSV worksheet: a column change writes
 * every record at the prospective width, so a record shorter than it is
 * padded. Undefined without a live column change, or when no record is
 * shorter.
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

/** "2 rows inserted, 1 row deleted, 1 column renamed, 3 cells edited" — zero counts left out. */
export function save_counts_text(counts: WorksheetStructureCounts | undefined, cell_edits: number): string {
    const parts: string[] = [];
    const add = (n: number, singular: string, plural: string, verb: string) => {
        if (n > 0) parts.push(`${count(n, singular, plural)} ${verb}`);
    };
    if (counts !== undefined) {
        add(counts.rows.inserted, 'row', 'rows', 'inserted');
        add(counts.rows.appended, 'row', 'rows', 'added at the end');
        add(counts.rows.deleted, 'row', 'rows', 'deleted');
        add(counts.rows.moved, 'row', 'rows', 'moved');
        add(counts.columns.inserted, 'column', 'columns', 'inserted');
        add(counts.columns.deleted, 'column', 'columns', 'deleted');
        add(counts.columns.moved, 'column', 'columns', 'moved');
        add(counts.columns.renamed, 'column', 'columns', 'renamed');
    }
    add(cell_edits, 'cell', 'cells', 'edited');
    return parts.join(', ');
}

export interface SaveSummaryWorksheet {
    readonly sheetIndex: number;
    readonly name: string;
    readonly counts?: WorksheetStructureCounts;
    readonly cellEdits: number;
    /** A note Save adds for this worksheet, such as padding short rows. */
    readonly note?: string;
}

/**
 * The Save button's description: "Save: 1 row inserted, 1 column deleted."
 * A single-table format names no worksheet; a workbook names each worksheet
 * only when more than one has changes or the one that does isn't showing.
 * Undefined when nothing countable is pending.
 */
export function save_summary(input: {
    readonly singleTable: boolean;
    readonly activeSheetIndex: number;
    readonly worksheets: readonly SaveSummaryWorksheet[];
}): string | undefined {
    const changed = input.worksheets.flatMap((worksheet) => {
        const text = save_counts_text(worksheet.counts, worksheet.cellEdits);
        return text === '' ? [] : [{ ...worksheet, text }];
    });
    if (changed.length === 0) return undefined;
    const named = !input.singleTable
        && (changed.length > 1 || changed[0]!.sheetIndex !== input.activeSheetIndex);
    const body = named
        ? changed.map((worksheet) => `${worksheet.name}: ${worksheet.text}`).join('; ')
        : changed.map((worksheet) => worksheet.text).join('; ');
    const notes = changed.flatMap((worksheet) => worksheet.note === undefined ? [] : [worksheet.note]);
    return [`Save: ${body}.`, ...notes].join(' ');
}
