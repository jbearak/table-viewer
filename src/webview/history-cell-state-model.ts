/**
 * The historical state of one cell's pending-edit overlay, and the sparse
 * transitions undo/redo replays against it.
 *
 * A worksheet's unsaved work has two INDEPENDENT dimensions (see
 * pending-changes.ts): the cell VALUE and the whole-cell HYPERLINK. In
 * `CsvDirtyEntry` an absent `link` field means "no link change — leave the
 * cell's hyperlink untouched", which is a different fact from a present `null`
 * ("clear the link"). History must preserve that distinction: an undo of a
 * link-only edit may not rewrite the value dimension, and an undo of a
 * value-only edit may not touch the link. Collapsing the two into one
 * "effective content" per side would make every undo a whole-cell replacement,
 * so an unrelated external change to the untouched dimension would be
 * destroyed on the next save.
 *
 * Two further facts are load-bearing and are therefore represented explicitly
 * rather than inferred from content:
 *
 *   - Overlay MEMBERSHIP. "No overlay for this cell" and "an overlay whose
 *     value happens to equal the cell's persisted content" are observably
 *     different: membership drives the dirty tint, rides in the durable
 *     `pendingEdits` payload, and participates in `collect_save_payload`.
 *     Redo of a discard must restore *absence*, not re-derive content — see
 *     {@link CellHistoryTransitionMode}.
 *   - `base_pending`. A legacy durable entry arrives with a placeholder base
 *     of `''` (edit-session-store.ts `normalize`) and blocks saving until
 *     `resolve_pending_bases` captures the true base. History that dropped the
 *     flag would promote the placeholder to a real base.
 *
 * This module is pure: no React, no Glide, no host protocol. Comparison is
 * delegated to the existing semantic helpers (`editable_values_equal`,
 * `hyperlinks_equal`) rather than reimplemented, so history agrees with the
 * save path about what "changed" means.
 */

import {
    hyperlinks_equal,
    type CellHyperlink,
    type CellTextStyle,
    type RichText,
    type RichTextRun,
} from '../cell-content';
import {
    editable_values_equal,
    plain_value,
    rich_value,
    type EditableCellValue,
    type PendingFormulaReferenceBasis,
    type RowIdentity,
} from '../pending-changes';
import {
    dirty_entry_value_dimension_present,
    make_dirty_entry,
    move_provenance_equal,
    worksheet_target_matches,
    type CsvDirtyEntry,
    type WorksheetTarget,
} from '../types';

/** A dirty entry as the store holds it: the wire shape plus the unresolved-base flag. */
export type HistoryDirtyEntry = CsvDirtyEntry & { readonly base_pending?: boolean };

// --- Values ---

/**
 * One side of the value dimension. `runs` is present only when that side
 * carries styles, mirroring `CsvDirtyEntry`'s optional run fields so a plain
 * edit round-trips through history in its exact legacy shape.
 */
export interface HistoryValue {
    readonly text: string;
    readonly runs?: RichText;
}

export function history_value(text: string, runs?: RichText): HistoryValue {
    return runs === undefined ? { text } : { text, runs };
}

function as_editable(value: HistoryValue): EditableCellValue {
    return value.runs === undefined ? plain_value(value.text) : rich_value(value.runs);
}

/**
 * Semantic value equality, delegated to the save path's comparison so a
 * formatting-only difference (same text, different runs) reads as a real
 * change here too.
 */
export function history_values_equal(left: HistoryValue, right: HistoryValue): boolean {
    return editable_values_equal(as_editable(left), as_editable(right));
}

// --- Overlay state ---

/**
 * The value dimension of a present overlay.
 *
 * `untouched` is a link-only entry: the entry's `value`/`base` fields hold the
 * cell's *unedited* text, which must be preserved so the entry can be
 * reconstructed, but which does not represent a value change. The field is
 * named `anchor` rather than `value` so no caller mistakes it for one.
 *
 * `present` means the value dimension is part of the overlay. It deliberately
 * does NOT assert that value differs from base: `resolve_pending_bases`
 * (edit-session-store.ts) captures a true base for a legacy entry and can
 * produce `{value: A, base: A}`, an entry that is genuinely in the map — and
 * therefore tinted, persisted, and saved — while comparing equal. Membership
 * and semantic inequality are different facts.
 */
export interface UntouchedValueDimension {
    readonly kind: 'untouched';
    readonly anchor: HistoryValue;
}

export interface PresentValueDimension {
    readonly kind: 'present';
    readonly value: HistoryValue;
    readonly base: HistoryValue;
    readonly basePending: boolean;
    /** Present only for the A -> C on disk, pending A write case. */
    readonly writeValue?: true;
    /** Preserve otherwise ambiguous equal-value membership without writing text. */
    readonly retainValue?: true;
    /** Absent run sides were observed and therefore mean plain formatting. */
    readonly formattingKnown?: true;
    readonly movedFrom?: CsvDirtyEntry['movedFrom'];
    readonly valueEditOrder?: number;
    readonly formulaReferenceBases?: readonly PendingFormulaReferenceBasis[];
}

export type OverlayValueDimension = UntouchedValueDimension | PresentValueDimension;

/** The hyperlink dimension. `untouched` = absent `link` field, i.e. "leave the
 *  cell's link alone"; a present dimension with `value: null` clears it. */
export interface UntouchedHyperlinkDimension {
    readonly kind: 'untouched';
}

export interface PresentHyperlinkDimension {
    readonly kind: 'present';
    readonly value: CellHyperlink | null;
    readonly base: CellHyperlink | null;
}

export type OverlayHyperlinkDimension =
    | UntouchedHyperlinkDimension
    | PresentHyperlinkDimension;

export interface AbsentCellOverlayState {
    readonly kind: 'absent';
}

/**
 * A present overlay: an entry in the dirty map, with at least one dimension in
 * it. The three arms enumerate the combinations a real entry can have, so an
 * entry with neither dimension — which the save path would have nothing to do
 * with — is unrepresentable rather than merely undocumented.
 */
export type PresentCellOverlayState =
    | {
        readonly kind: 'present';
        readonly value: PresentValueDimension;
        readonly hyperlink: UntouchedHyperlinkDimension;
    }
    | {
        readonly kind: 'present';
        readonly value: UntouchedValueDimension;
        readonly hyperlink: PresentHyperlinkDimension;
    }
    | {
        readonly kind: 'present';
        readonly value: PresentValueDimension;
        readonly hyperlink: PresentHyperlinkDimension;
    };

/**
 * A cell's overlay membership. `absent` is not "empty content" — it is the
 * absence of a map entry.
 */
export type CellOverlayState = AbsentCellOverlayState | PresentCellOverlayState;

const ABSENT: AbsentCellOverlayState = Object.freeze({ kind: 'absent' as const });

export function absent_overlay(): AbsentCellOverlayState {
    return ABSENT;
}

export function value_only_overlay(
    value: HistoryValue,
    base: HistoryValue,
    base_pending = false,
    write_value?: true,
    retain_value?: true,
    formatting_known?: true,
    moved_from?: CsvDirtyEntry['movedFrom'],
    value_edit_order?: number,
    formula_reference_bases?: readonly PendingFormulaReferenceBasis[],
): PresentCellOverlayState {
    return {
        kind: 'present',
        value: {
            kind: 'present',
            value,
            base,
            basePending: base_pending,
            ...(write_value === true ? { writeValue: true as const } : {}),
            ...(retain_value === true ? { retainValue: true as const } : {}),
            ...(formatting_known === true ? { formattingKnown: true as const } : {}),
            ...(moved_from === undefined ? {} : { movedFrom: moved_from }),
            ...(value_edit_order === undefined ? {} : { valueEditOrder: value_edit_order }),
            ...(formula_reference_bases === undefined
                ? {}
                : { formulaReferenceBases: formula_reference_bases }),
        },
        hyperlink: { kind: 'untouched' },
    };
}

export function hyperlink_only_overlay(
    anchor: HistoryValue,
    value: CellHyperlink | null,
    base: CellHyperlink | null,
): PresentCellOverlayState {
    return {
        kind: 'present',
        value: { kind: 'untouched', anchor },
        hyperlink: { kind: 'present', value, base },
    };
}

export function combined_overlay(
    value: HistoryValue,
    base: HistoryValue,
    hyperlink: CellHyperlink | null,
    base_hyperlink: CellHyperlink | null,
    base_pending = false,
    write_value?: true,
    retain_value?: true,
    formatting_known?: true,
    moved_from?: CsvDirtyEntry['movedFrom'],
    value_edit_order?: number,
    formula_reference_bases?: readonly PendingFormulaReferenceBasis[],
): PresentCellOverlayState {
    return {
        kind: 'present',
        value: {
            kind: 'present',
            value,
            base,
            basePending: base_pending,
            ...(write_value === true ? { writeValue: true as const } : {}),
            ...(retain_value === true ? { retainValue: true as const } : {}),
            ...(formatting_known === true ? { formattingKnown: true as const } : {}),
            ...(moved_from === undefined ? {} : { movedFrom: moved_from }),
            ...(value_edit_order === undefined ? {} : { valueEditOrder: value_edit_order }),
            ...(formula_reference_bases === undefined
                ? {}
                : { formulaReferenceBases: formula_reference_bases }),
        },
        hyperlink: { kind: 'present', value: hyperlink, base: base_hyperlink },
    };
}

/**
 * What the value dimension of a link-carrying entry MEANS — a fact the entry's
 * fields cannot express.
 *
 * `{value: 'A', base: 'A', link, baseLink}` is produced by three different
 * intents, all in `use-editing.ts`:
 *   - attaching a link to an unedited cell (`commit_hyperlink`'s link-only
 *     branch): the value fields are just the unedited text — `'link-only'`;
 *   - reverting the text of a cell that has a pending link (`settle_edit`,
 *     "the entry survives as link-only, its value dimension back at the base"):
 *     the value dimension was deliberately REMOVED — `'link-only'`;
 *   - attaching a link to an existing resolved legacy no-op entry, which
 *     `commit_hyperlink` builds by copying that pending entry: the value
 *     dimension is genuinely still in the overlay — `'in-overlay'`.
 *
 * Prior membership does not decide this: the second and third cases both follow
 * a state that had a value dimension. Only the writer knows its own intent, so
 * it says. `'infer'` is for readers with no intent to declare (hydration,
 * enumerating a store) and falls back to whether the value differs from base.
 */
export type ValueDimensionIntent = 'in-overlay' | 'link-only' | 'infer';

/**
 * Read a store entry into its overlay state.
 *
 * Every entry without a link keeps a present value dimension — including one
 * whose value equals its base (a resolved legacy no-op) and one awaiting its
 * true base — because such an entry is in the map, and so tinted, persisted and
 * saved, regardless of comparing equal.
 */
export function overlay_state_from_dirty_entry(
    entry: HistoryDirtyEntry,
    value_intent: ValueDimensionIntent = 'infer',
): PresentCellOverlayState {
    const value = history_value(entry.value, entry.valueRuns);
    const base = history_value(entry.base, entry.baseRuns);
    const base_pending = entry.base_pending === true;
    const link_present = entry.link !== undefined;
    // A link-only entry is the ONLY case where the value fields are not a
    // value change: they are the unedited text the link was attached to.
    const value_untouched = link_present
        && !base_pending
        && value_intent !== 'in-overlay'
        && entry.retainValue !== true
        && entry.movedFrom === undefined
        && entry.valueEditOrder === undefined
        && entry.formulaReferenceBases === undefined
        && (
            value_intent === 'link-only'
            || !dirty_entry_value_dimension_present(entry)
        );

    if (value_untouched) {
        return hyperlink_only_overlay(value, entry.link ?? null, entry.baseLink ?? null);
    }
    if (link_present) {
        return combined_overlay(
            value,
            base,
            entry.link ?? null,
            entry.baseLink ?? null,
            base_pending,
            entry.writeValue,
            entry.retainValue,
            entry.formattingKnown,
            entry.movedFrom,
            entry.valueEditOrder,
            entry.formulaReferenceBases,
        );
    }
    return value_only_overlay(
        value,
        base,
        base_pending,
        entry.writeValue,
        entry.retainValue,
        entry.formattingKnown,
        entry.movedFrom,
        entry.valueEditOrder,
        entry.formulaReferenceBases,
    );
}

/** Rebuild the store entry a present overlay state describes. */
export function dirty_entry_from_overlay_state(
    state: PresentCellOverlayState,
): HistoryDirtyEntry {
    const value = state.value.kind === 'untouched' ? state.value.anchor : state.value.value;
    const base = state.value.kind === 'untouched' ? state.value.anchor : state.value.base;
    const entry = make_dirty_entry(
        value.text,
        base.text,
        value.runs,
        base.runs,
        state.hyperlink.kind === 'present' ? state.hyperlink.value : undefined,
        state.hyperlink.kind === 'present' ? state.hyperlink.base : undefined,
        state.value.kind === 'present' ? {
            writeValue: state.value.writeValue,
            retainValue: state.value.retainValue,
            formattingKnown: state.value.formattingKnown,
            movedFrom: state.value.movedFrom,
            valueEditOrder: state.value.valueEditOrder,
            formulaReferenceBases: state.value.formulaReferenceBases,
        } : {},
    );
    const base_pending = state.value.kind === 'present' && state.value.basePending;
    return base_pending ? { ...entry, base_pending: true } : entry;
}

export function overlay_states_equal(left: CellOverlayState, right: CellOverlayState): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === 'absent' || right.kind === 'absent') return true;
    return value_dimensions_equal(left.value, right.value)
        && hyperlink_dimensions_equal(left.hyperlink, right.hyperlink);
}

function value_dimensions_equal(
    left: OverlayValueDimension,
    right: OverlayValueDimension,
): boolean {
    if (left.kind === 'untouched') {
        return right.kind === 'untouched'
            && history_values_equal(left.anchor, right.anchor);
    }
    if (right.kind === 'untouched') return false;
    return left.basePending === right.basePending
        && left.writeValue === right.writeValue
        && left.retainValue === right.retainValue
        && left.formattingKnown === right.formattingKnown
        && move_provenance_equal(left.movedFrom, right.movedFrom)
        && left.valueEditOrder === right.valueEditOrder
        && JSON.stringify(left.formulaReferenceBases ?? [])
            === JSON.stringify(right.formulaReferenceBases ?? [])
        && history_values_equal(left.value, right.value)
        && history_values_equal(left.base, right.base);
}

function hyperlink_dimensions_equal(
    left: OverlayHyperlinkDimension,
    right: OverlayHyperlinkDimension,
): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === 'untouched' || right.kind === 'untouched') return true;
    return hyperlinks_equal(left.value, right.value)
        && hyperlinks_equal(left.base, right.base);
}

// --- Transitions ---

/**
 * How a replayed dimension is applied.
 *
 * `semantic` carries content: "the value here was X, make it Y". The host
 * compares X against the cell's current persisted content and refuses when it
 * disagrees (a compare-and-swap, not a rebase), so an undo cannot bless an
 * unrelated external change as its new conflict base.
 *
 * `membership` carries no content for its destination: "there was an overlay
 * here, and after this action there was none". This is what makes redo of a
 * discard a genuine no-op on cell content. Replaying a discard by sending its
 * historical persisted content would instead manufacture a fresh dirty edit
 * against whatever is on disk now — after an intervening save that content is
 * stale, and the redo would write it back over the saved value.
 */
export type CellHistoryTransitionMode = 'semantic' | 'membership';

/** One side of a transition: the content, and whether it was in the overlay. */
export interface HistoryDimensionSide<T> {
    readonly content: T;
    readonly overlay: 'absent' | 'present';
}

export interface ValueTransition {
    readonly mode: CellHistoryTransitionMode;
    readonly expected: HistoryDimensionSide<HistoryValue>;
    readonly desired: HistoryDimensionSide<HistoryValue>;
}

export interface HyperlinkTransition {
    readonly mode: CellHistoryTransitionMode;
    readonly expected: HistoryDimensionSide<CellHyperlink | null>;
    readonly desired: HistoryDimensionSide<CellHyperlink | null>;
}

/**
 * One cell's participation in a history action.
 *
 * `worksheet` is the FULL {@link WorksheetTarget} captured when the action was
 * recorded, never a bare index. A workbook reordered externally would
 * otherwise reattach the action to whatever sheet now occupies that slot, and
 * because the replay compare-and-swap only checks cell *content*, an undo
 * whose expected value happened to match would be authorized against the wrong
 * worksheet. `types.ts` makes the same point about durable `pendingEdits`
 * ("the name is load-bearing") and resolves through `worksheet_target_lookup`,
 * which prefers `worksheetId`, then `sheetName`, and falls back to the index
 * only when neither is known.
 *
 * At least one dimension is touched, enforced by {@link TouchedDimensions}: a
 * delta touching neither is not a delta.
 */
export interface CellHistoryDeltaBase {
    readonly worksheet: WorksheetTarget;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly beforeOverlay: CellOverlayState;
    readonly afterOverlay: CellOverlayState;
}

export type TouchedDimensions =
    | { readonly value: ValueTransition; readonly hyperlink?: never }
    | { readonly value?: never; readonly hyperlink: HyperlinkTransition }
    | { readonly value: ValueTransition; readonly hyperlink: HyperlinkTransition };

export type CellHistoryDelta = CellHistoryDeltaBase & TouchedDimensions;

export type HistoryDirection = 'undo' | 'redo';

/** The side of a transition a direction restores: undo goes to `expected`. */
export function transition_side<T>(
    transition: { readonly expected: HistoryDimensionSide<T>; readonly desired: HistoryDimensionSide<T> },
    direction: HistoryDirection,
): HistoryDimensionSide<T> {
    return direction === 'undo' ? transition.expected : transition.desired;
}

/** The overlay state a direction restores. */
export function overlay_for_direction(
    delta: CellHistoryDelta,
    direction: HistoryDirection,
): CellOverlayState {
    return direction === 'undo' ? delta.beforeOverlay : delta.afterOverlay;
}

export function delta_touches_value(delta: CellHistoryDelta): boolean {
    return delta.value !== undefined;
}

export function delta_touches_hyperlink(delta: CellHistoryDelta): boolean {
    return delta.hyperlink !== undefined;
}

/**
 * Build the delta for one cell from the overlay states either side of a user
 * action, plus the cell's persisted content (needed as the content side of a
 * dimension that was not in the overlay).
 *
 * Returns `undefined` when nothing semantically changed, so a no-op gesture
 * records no action. A dimension is included only when it actually moved: a
 * value-only edit yields no hyperlink transition, so replay leaves the link
 * alone.
 */
export function build_cell_history_delta(args: {
    readonly worksheet: WorksheetTarget;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly before: CellOverlayState;
    readonly after: CellOverlayState;
    readonly persistedValue: HistoryValue;
    readonly persistedHyperlink: CellHyperlink | null;
}): CellHistoryDelta | undefined {
    const { before, after, persistedValue, persistedHyperlink } = args;

    const before_value = effective_value_side(before, persistedValue);
    const after_value = effective_value_side(after, persistedValue);
    const before_link = effective_hyperlink_side(before, persistedHyperlink);
    const after_link = effective_hyperlink_side(after, persistedHyperlink);

    const value_moved = !history_values_equal(before_value.content, after_value.content)
        || before_value.overlay !== after_value.overlay
        || value_metadata_moved(before, after);
    const link_moved = !hyperlinks_equal(before_link.content, after_link.content)
        || before_link.overlay !== after_link.overlay
        || hyperlink_metadata_moved(before, after);

    if (!value_moved && !link_moved) return undefined;

    const base: CellHistoryDeltaBase = {
        worksheet: args.worksheet,
        sourceRow: args.sourceRow,
        sourceColumn: args.sourceColumn,
        beforeOverlay: before,
        afterOverlay: after,
    };
    const value_transition: ValueTransition = {
        mode: dimension_mode(before_value.overlay, after_value.overlay),
        expected: before_value,
        desired: after_value,
    };
    const link_transition: HyperlinkTransition = {
        mode: dimension_mode(before_link.overlay, after_link.overlay),
        expected: before_link,
        desired: after_link,
    };
    const delta: CellHistoryDelta = value_moved && link_moved
        ? { ...base, value: value_transition, hyperlink: link_transition }
        : value_moved
            ? { ...base, value: value_transition }
            : { ...base, hyperlink: link_transition };
    // The caller's RichText, CellHyperlink and WorksheetTarget stay reachable and
    // mutable while the gesture is assembled, and a later mutation would silently
    // rewrite what undo replays — `readonly` is a compile-time claim only. So the
    // result is an isolated frozen SNAPSHOT.
    //
    // Not history's ownership, which belongs to recording the action: this shares
    // the caller's strings by value rather than materializing them, because
    // materializing here would copy every string a second time. See
    // `snapshot_owner`.
    return snapshot_cell_history_delta(delta);
}

/**
 * A dimension's replay mode, decided per DIMENSION rather than per cell.
 *
 * `membership` whenever this dimension entered or left the overlay, even if the
 * cell kept an entry throughout: reverting a pending hyperlink while a value
 * edit remains leaves the cell present but takes the link dimension out, and
 * its destination must be restored as absence. Deciding from the cell's
 * membership instead would mark that transition `semantic`, and a redo after an
 * intervening save would replay the historical link as a fresh edit over the
 * saved one — exactly the stale write membership mode exists to prevent.
 */
function dimension_mode(
    before: 'absent' | 'present',
    after: 'absent' | 'present',
): CellHistoryTransitionMode {
    return before === after ? 'semantic' : 'membership';
}

/**
 * Whether the value dimension's conflict metadata moved while its effective
 * content stayed put.
 *
 * Recommitting the same text against a base that changed underneath (disk moved
 * from A to C, so `{value: B, base: A}` becomes `{value: B, base: C}`) leaves
 * the effective value at B and its membership `present`, yet it is observable:
 * the base decides whether the cell reads as conflicted and whether
 * `validate_dirty_bases` will admit the save. The same goes for `basePending`,
 * which blocks saving outright. Neither may be dropped from history, or undo
 * could not restore the prior conflict state.
 *
 * Only a `present` value dimension carries this metadata. When membership
 * itself differs the dimension has already been reported as moved, so a
 * one-sided comparison would be redundant, and reading a link-only entry's
 * anchor here would make attaching a link read as a value change.
 */
function value_metadata_moved(before: CellOverlayState, after: CellOverlayState): boolean {
    const left = present_value_dimension(before);
    const right = present_value_dimension(after);
    if (left === undefined || right === undefined) return false;
    return left.basePending !== right.basePending
        || left.writeValue !== right.writeValue
        || left.retainValue !== right.retainValue
        || left.formattingKnown !== right.formattingKnown
        || !move_provenance_equal(left.movedFrom, right.movedFrom)
        || left.valueEditOrder !== right.valueEditOrder
        || JSON.stringify(left.formulaReferenceBases ?? [])
            !== JSON.stringify(right.formulaReferenceBases ?? [])
        || !history_values_equal(left.base, right.base);
}

function present_value_dimension(state: CellOverlayState): PresentValueDimension | undefined {
    return state.kind === 'present' && state.value.kind === 'present' ? state.value : undefined;
}

function present_hyperlink_dimension(
    state: CellOverlayState,
): PresentHyperlinkDimension | undefined {
    return state.kind === 'present' && state.hyperlink.kind === 'present'
        ? state.hyperlink
        : undefined;
}

/**
 * Whether the hyperlink dimension's own metadata moved while its link did not.
 *
 * Two things count. `baseLink` decides whether the link change reads as
 * conflicted, so a base-only move is a real change. And a link-only entry's
 * `anchor` is reconstructed into the entry's `value`/`base` pair, so an
 * external change that moves the anchor (disk A -> C, then recommitting C)
 * changes the base the save is validated against even though nothing about the
 * link moved. The anchor belongs to the hyperlink dimension's own bookkeeping
 * here: the value dimension is untouched on both sides, and attributing it
 * there would emit a value transition that undo would use to rewrite text.
 */
function hyperlink_metadata_moved(before: CellOverlayState, after: CellOverlayState): boolean {
    const left = present_hyperlink_dimension(before);
    const right = present_hyperlink_dimension(after);
    if (left === undefined || right === undefined) return false;
    if (!hyperlinks_equal(left.base, right.base)) return true;
    const left_anchor = untouched_value_anchor(before);
    const right_anchor = untouched_value_anchor(after);
    if (left_anchor === undefined || right_anchor === undefined) return false;
    return !history_values_equal(left_anchor, right_anchor);
}

function untouched_value_anchor(state: CellOverlayState): HistoryValue | undefined {
    return state.kind === 'present' && state.value.kind === 'untouched'
        ? state.value.anchor
        : undefined;
}

/**
 * The value a cell effectively shows in a given overlay state.
 *
 * `overlay` describes THIS DIMENSION's membership, not the cell's: a link-only
 * entry leaves the value dimension out of the overlay just as surely as having
 * no entry at all does, and the cell shows its persisted content either way.
 * Reporting `present` here because *some* dimension was in the overlay would
 * make attaching a link read as a value change, and undo of a link-only edit
 * would then rewrite the cell's text.
 */
function effective_value_side(
    state: CellOverlayState,
    persisted: HistoryValue,
): HistoryDimensionSide<HistoryValue> {
    if (state.kind === 'absent' || state.value.kind === 'untouched') {
        return { content: persisted, overlay: 'absent' };
    }
    return { content: state.value.value, overlay: 'present' };
}

function effective_hyperlink_side(
    state: CellOverlayState,
    persisted: CellHyperlink | null,
): HistoryDimensionSide<CellHyperlink | null> {
    if (state.kind === 'absent' || state.hyperlink.kind === 'untouched') {
        return { content: persisted, overlay: 'absent' };
    }
    return { content: state.hyperlink.value, overlay: 'present' };
}

/**
 * A delta rebuilt to its declared shape, field by field, through an owner.
 *
 * `CellHistoryDelta` is a structural type, so a value that satisfies it can also
 * carry a getter where a data property was expected, inherit a field from a
 * prototype, or hold extra properties nobody declared. Any of those makes the
 * graph a holder measured and the graph it retained two different things — an
 * unmeasured 300MiB string riding along on a delta, or a `worksheet` that answers
 * differently after the bounds were computed.
 *
 * So it is rebuilt rather than inspected. Each field is read exactly once and
 * copied into a frozen object of the declared shape; nothing undeclared survives.
 * What the copy does with the CONTENT is the owner's business — a snapshot shares
 * the caller's strings, an action materializes and charges them — which is why
 * this is one function and not two that could drift apart.
 */
function copy_cell_history_delta(
    delta: CellHistoryDelta,
    owner: HistoryActionOwner,
): CellHistoryDelta {
    // A memo per delta, so an object the input SHARED between a transition and an
    // overlay is shared by the output too. That aliasing is load-bearing: it is
    // how one string exists once in memory, and how the byte estimate charges it
    // once instead of refusing gestures that fit the bounds.
    const values = new Map<HistoryValue, HistoryValue>();
    const value_of = (value: HistoryValue): HistoryValue => {
        const seen = values.get(value);
        if (seen !== undefined) return seen;
        const copied = copy_value(value, owner);
        values.set(value, copied);
        return copied;
    };
    const links = new Map<CellHyperlink, CellHyperlink>();
    const link_of = (link: CellHyperlink | null): CellHyperlink | null => {
        if (link === null) return null;
        const seen = links.get(link);
        if (seen !== undefined) return seen;
        const copied = copy_hyperlink(link, owner);
        links.set(link, copied);
        return copied;
    };

    const base: CellHistoryDeltaBase = {
        worksheet: owner.own_worksheet_target(delta.worksheet),
        sourceRow: delta.sourceRow,
        sourceColumn: delta.sourceColumn,
        beforeOverlay: copy_overlay(delta.beforeOverlay, value_of, link_of),
        afterOverlay: copy_overlay(delta.afterOverlay, value_of, link_of),
    };
    const value = delta.value;
    const hyperlink = delta.hyperlink;
    const out: CellHistoryDelta = value !== undefined && hyperlink !== undefined
        ? {
            ...base,
            value: copy_transition(value, value_of),
            hyperlink: copy_transition(hyperlink, link_of),
        }
        : value !== undefined
            ? { ...base, value: copy_transition(value, value_of) }
            : { ...base, hyperlink: copy_transition(hyperlink!, link_of) };
    return freeze_deep_declared(out);
}

/**
 * A freshly built delta, isolated from later mutation of what built it.
 *
 * Not history's ownership: the strings are the caller's, shared by value. See
 * `snapshot_owner`.
 */
function snapshot_cell_history_delta(delta: CellHistoryDelta): CellHistoryDelta {
    return copy_cell_history_delta(delta, snapshot_owner());
}

/**
 * The delta history will retain, rebuilt through the owner of the action holding
 * it.
 *
 * Always rebuilt, even from a builder's snapshot: a snapshot's strings are the
 * caller's, so retaining one would retain whatever those strings hold alive,
 * uncharged. This is the only way a cell delta enters history.
 */
export function own_cell_history_delta(
    delta: CellHistoryDelta,
    owner: HistoryActionOwner,
): CellHistoryDelta {
    return copy_cell_history_delta(delta, owner);
}

/**
 * Who owns what one ACTION retains.
 *
 * History has exactly one ownership boundary — recording an action — and this is
 * the interface across it. Three jobs no single delta can do for itself, because
 * all three are properties of the gesture rather than of one cell:
 *
 *   - `own_string` returns the string to retain, materialized and SHARED across
 *     every delta of the action asking for an equal one. Materialized because V8
 *     answers `slice` with a view retaining its whole parent, so an unmaterialized
 *     string costs its parent's allocation while being charged its own length.
 *     Shared because a million-cell paste names one worksheet, and materializing
 *     that name per delta would allocate a million copies of it.
 *   - `own_worksheet_target` returns one frozen target per exact target tuple in
 *     the action, so the estimator — which charges the retained target object —
 *     charges a gesture's worksheet identity once.
 *   - `charge_run` accounts for a run's shape as it is built. A cell carrying
 *     millions of one-character runs is mostly shape, so metering only their text
 *     let the whole run graph be allocated before anything checked.
 *
 * Any of them may throw to abandon the walk. The estimator still has the last word
 * on what an action costs; this is a tripwire.
 */
export interface HistoryActionOwner {
    own_string(text: string): string;
    own_worksheet_target(target: WorksheetTarget): WorksheetTarget;
    charge_run(): void;
}

/**
 * The owner a delta gets while a gesture is still being assembled.
 *
 * A delta is built one cell at a time, long before there is an action to own it,
 * and it must still be isolated from later mutation of the caller's overlays,
 * hyperlinks and targets — `readonly` is a compile-time claim only. So the builder
 * SNAPSHOTS: it rebuilds the declared shape and freezes it, sharing the caller's
 * string VALUES rather than materializing them.
 *
 * Sharing a value is safe because strings are immutable; what it does not do is
 * materialize, so a snapshot may still hold a parent string alive. That retention ends
 * with the caller's gesture-building graph, because history never retains a
 * snapshot: recording rebuilds every delta through the action's owner, where the
 * strings are materialized and charged. Materializing here as well would copy every
 * string twice.
 */
function snapshot_owner(): HistoryActionOwner {
    return {
        own_string: (text) => text,
        own_worksheet_target: (target) => {
            const { sheetIndex, sheetName, worksheetId } = target;
            return Object.freeze({
                sheetIndex,
                ...(sheetName === undefined ? {} : { sheetName }),
                ...(worksheetId === undefined ? {} : { worksheetId }),
            });
        },
        charge_run: () => {},
    };
}



function copy_value(value: HistoryValue, owner: HistoryActionOwner): HistoryValue {
    const runs = value.runs;
    return {
        text: owner.own_string(value.text),
        ...(runs === undefined
            ? {}
            : { runs: { runs: copy_runs(runs.runs, owner) } }),
    };
}

/**
 * Copies runs into a plain array.
 *
 * A `readonly RichTextRun[]` can be an Array subclass, and `map` honours its
 * `Symbol.species` — so mapping would hand back another subclass, carrying
 * whatever undeclared state it holds into what history retains and the estimator
 * never charges. A `for` loop into a literal cannot be redirected that way.
 */
function copy_runs(
    runs: readonly RichTextRun[],
    owner: HistoryActionOwner,
): readonly RichTextRun[] {
    const out: RichTextRun[] = [];
    for (const run of runs) {
        // Charged before it is built: a cell of one-character runs is mostly shape,
        // so a budget told only about text would allocate the whole run graph.
        owner.charge_run();
        out.push(copy_run(run, owner));
    }
    return out;
}

function copy_run(run: RichTextRun, owner: HistoryActionOwner): RichTextRun {
    const style = run.style;
    return {
        text: owner.own_string(run.text),
        ...(style === undefined ? {} : { style: copy_style(style) }),
    };
}

function copy_style(style: CellTextStyle): CellTextStyle {
    const { bold, italic, underline, strikethrough } = style;
    return {
        ...(bold === undefined ? {} : { bold }),
        ...(italic === undefined ? {} : { italic }),
        ...(underline === undefined ? {} : { underline }),
        ...(strikethrough === undefined ? {} : { strikethrough }),
    };
}

function copy_hyperlink(link: CellHyperlink, owner: HistoryActionOwner): CellHyperlink {
    const tooltip = link.tooltip;
    const rest = tooltip === undefined ? {} : { tooltip: owner.own_string(tooltip) };
    return link.kind === 'external'
        ? { kind: 'external', target: owner.own_string(link.target), ...rest }
        : { kind: 'internal', location: owner.own_string(link.location), ...rest };
}

interface CopiedTransition<T> {
    readonly mode: CellHistoryTransitionMode;
    readonly expected: HistoryDimensionSide<T>;
    readonly desired: HistoryDimensionSide<T>;
}

function copy_transition<T>(
    transition: CopiedTransition<T>,
    content: (value: T) => T,
): CopiedTransition<T> {
    // Each side is read once. An accessor read twice could answer with two
    // different objects, and the copy would then pair one side's
    // content with the other's overlay membership — a state the caller never
    // supplied, which replay would go on to compare against or restore.
    const expected = transition.expected;
    const desired = transition.desired;
    return {
        mode: transition.mode,
        expected: { content: content(expected.content), overlay: expected.overlay },
        desired: { content: content(desired.content), overlay: desired.overlay },
    };
}

const copy_row_identity = (identity: RowIdentity | undefined): RowIdentity | undefined =>
    identity === undefined
        ? undefined
        : identity.kind === 'source'
            ? { kind: 'source', sourceRow: identity.sourceRow }
            : { kind: 'pending', pendingRowId: identity.pendingRowId };

function copy_overlay(
    overlay: CellOverlayState,
    value_of: (value: HistoryValue) => HistoryValue,
    link_of: (link: CellHyperlink | null) => CellHyperlink | null,
): CellOverlayState {
    if (overlay.kind === 'absent') return ABSENT;
    const value = overlay.value;
    const hyperlink = overlay.hyperlink;
    const copied_value_dimension: OverlayValueDimension = value.kind === 'present'
        ? {
            kind: 'present',
            value: value_of(value.value),
            base: value_of(value.base),
            basePending: value.basePending,
            ...(value.writeValue === true ? { writeValue: true as const } : {}),
            ...(value.retainValue === true ? { retainValue: true as const } : {}),
            ...(value.formattingKnown === true ? { formattingKnown: true as const } : {}),
            ...(value.movedFrom === undefined ? {} : {
                movedFrom: {
                    row: value.movedFrom.row,
                    col: value.movedFrom.col,
                    order: value.movedFrom.order,
                    ...(value.movedFrom.rowIdentity === undefined ? {} : {
                        rowIdentity: copy_row_identity(value.movedFrom.rowIdentity),
                    }),
                    ...(value.movedFrom.previous === undefined ? {} : {
                        previous: value.movedFrom.previous.map((move) => ({
                            ...move,
                            ...(move.sourceRowIdentity === undefined ? {} : {
                                sourceRowIdentity: copy_row_identity(move.sourceRowIdentity),
                            }),
                            ...(move.destinationRowIdentity === undefined ? {} : {
                                destinationRowIdentity: copy_row_identity(
                                    move.destinationRowIdentity,
                                ),
                            }),
                        })),
                    }),
                },
            }),
            ...(value.valueEditOrder === undefined ? {} : { valueEditOrder: value.valueEditOrder }),
            ...(value.formulaReferenceBases === undefined ? {} : {
                formulaReferenceBases: value.formulaReferenceBases.map((basis) => ({ ...basis })),
            }),
        }
        : { kind: 'untouched', anchor: value_of(value.anchor) };
    const copied_link_dimension: OverlayHyperlinkDimension = hyperlink.kind === 'present'
        ? {
            kind: 'present',
            value: link_of(hyperlink.value),
            base: link_of(hyperlink.base),
        }
        : { kind: 'untouched' };
    // The three-arm union enumerates the combinations a real entry can have, and
    // the cast is what lets this build one generically. It is safe because a
    // dimension's kind is carried over unchanged: a present/untouched pair here
    // was a present/untouched pair there.
    return {
        kind: 'present',
        value: copied_value_dimension,
        hyperlink: copied_link_dimension,
    } as PresentCellOverlayState;
}

/** Freezes a graph this module built, so no foreign accessor can be reached. */
function freeze_deep_declared<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    for (const key of Object.keys(value)) {
        freeze_deep_declared((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value);
}

/** Whether two deltas address the same cell of the same worksheet. */
export function delta_addresses_same_cell(
    left: CellHistoryDelta,
    right: CellHistoryDelta,
): boolean {
    return left.sourceRow === right.sourceRow
        && left.sourceColumn === right.sourceColumn
        && worksheet_target_matches(left.worksheet, right.worksheet);
}
