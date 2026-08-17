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
    type RichText,
} from '../cell-content';
import {
    editable_values_equal,
    plain_value,
    rich_value,
    type EditableCellValue,
} from '../pending-changes';
import {
    dirty_entry_value_changed,
    make_dirty_entry,
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
export type OverlayValueDimension =
    | { readonly kind: 'untouched'; readonly anchor: HistoryValue }
    | {
        readonly kind: 'present';
        readonly value: HistoryValue;
        readonly base: HistoryValue;
        readonly basePending: boolean;
    };

/** The hyperlink dimension. `untouched` = absent `link` field, i.e. "leave the
 *  cell's link alone"; a present dimension with `value: null` clears it. */
export type OverlayHyperlinkDimension =
    | { readonly kind: 'untouched' }
    | {
        readonly kind: 'present';
        readonly value: CellHyperlink | null;
        readonly base: CellHyperlink | null;
    };

/**
 * A cell's overlay membership. `absent` is not "empty content" — it is the
 * absence of a map entry.
 *
 * A present overlay always has at least one present dimension: an entry with
 * neither would be an entry the save path has nothing to do with, and
 * {@link overlay_state_from_dirty_entry} refuses to build one.
 */
export type CellOverlayState =
    | { readonly kind: 'absent' }
    | {
        readonly kind: 'present';
        readonly value: OverlayValueDimension;
        readonly hyperlink: OverlayHyperlinkDimension;
    };

const ABSENT: CellOverlayState = Object.freeze({ kind: 'absent' as const });

export function absent_overlay(): CellOverlayState {
    return ABSENT;
}

export function value_only_overlay(
    value: HistoryValue,
    base: HistoryValue,
    base_pending = false,
): CellOverlayState {
    return {
        kind: 'present',
        value: { kind: 'present', value, base, basePending: base_pending },
        hyperlink: { kind: 'untouched' },
    };
}

export function hyperlink_only_overlay(
    anchor: HistoryValue,
    value: CellHyperlink | null,
    base: CellHyperlink | null,
): CellOverlayState {
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
): CellOverlayState {
    return {
        kind: 'present',
        value: { kind: 'present', value, base, basePending: base_pending },
        hyperlink: { kind: 'present', value: hyperlink, base: base_hyperlink },
    };
}

/**
 * Read a store entry into its overlay state.
 *
 * The value dimension is `untouched` only for a link-only entry — one that
 * carries a link change AND whose value side is not part of the overlay. Every
 * other present entry keeps a present value dimension, including one whose
 * value equals its base (a resolved legacy no-op) and one still awaiting its
 * true base.
 */
export function overlay_state_from_dirty_entry(entry: HistoryDirtyEntry): CellOverlayState {
    const value = history_value(entry.value, entry.valueRuns);
    const base = history_value(entry.base, entry.baseRuns);
    const base_pending = entry.base_pending === true;
    const link_present = entry.link !== undefined;
    // A link-only entry is the ONLY case where the value fields are not a
    // value change: they are the unedited text the link was attached to.
    const value_untouched = link_present
        && !base_pending
        && !dirty_entry_value_changed(entry);

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
        );
    }
    return value_only_overlay(value, base, base_pending);
}

/** Rebuild the store entry a present overlay state describes. */
export function dirty_entry_from_overlay_state(
    state: Extract<CellOverlayState, { kind: 'present' }>,
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
    if (left.kind !== right.kind) return false;
    if (left.kind === 'untouched' || right.kind === 'untouched') {
        return history_values_equal(
            (left as Extract<OverlayValueDimension, { kind: 'untouched' }>).anchor,
            (right as Extract<OverlayValueDimension, { kind: 'untouched' }>).anchor,
        );
    }
    return left.basePending === right.basePending
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
 * At least one dimension is present; a delta touching neither is not a delta.
 */
export interface CellHistoryDelta {
    readonly worksheet: WorksheetTarget;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly beforeOverlay: CellOverlayState;
    readonly afterOverlay: CellOverlayState;
    readonly value?: ValueTransition;
    readonly hyperlink?: HyperlinkTransition;
}

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

    // Membership mode whenever the action added or removed the overlay itself:
    // the destination must be restored as absence, not as content.
    const membership = before.kind !== after.kind;
    const mode: CellHistoryTransitionMode = membership ? 'membership' : 'semantic';

    const value_moved = !history_values_equal(before_value.content, after_value.content)
        || before_value.overlay !== after_value.overlay;
    const link_moved = !hyperlinks_equal(before_link.content, after_link.content)
        || before_link.overlay !== after_link.overlay;

    if (!value_moved && !link_moved) return undefined;

    return {
        worksheet: args.worksheet,
        sourceRow: args.sourceRow,
        sourceColumn: args.sourceColumn,
        beforeOverlay: before,
        afterOverlay: after,
        ...(value_moved
            ? { value: { mode, expected: before_value, desired: after_value } }
            : {}),
        ...(link_moved
            ? { hyperlink: { mode, expected: before_link, desired: after_link } }
            : {}),
    };
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

/** Whether two deltas address the same cell of the same worksheet. */
export function delta_addresses_same_cell(
    left: CellHistoryDelta,
    right: CellHistoryDelta,
): boolean {
    return left.sourceRow === right.sourceRow
        && left.sourceColumn === right.sourceColumn
        && worksheet_target_matches(left.worksheet, right.worksheet);
}
