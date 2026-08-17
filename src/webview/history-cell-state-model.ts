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
export interface UntouchedValueDimension {
    readonly kind: 'untouched';
    readonly anchor: HistoryValue;
}

export interface PresentValueDimension {
    readonly kind: 'present';
    readonly value: HistoryValue;
    readonly base: HistoryValue;
    readonly basePending: boolean;
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
): PresentCellOverlayState {
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
): PresentCellOverlayState {
    return {
        kind: 'present',
        value: { kind: 'present', value, base, basePending: base_pending },
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
        && (value_intent === 'link-only' || !dirty_entry_value_changed(entry));

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
    // History outlives the objects it was built from: the caller's RichText,
    // CellHyperlink and WorksheetTarget stay reachable and mutable, and a later
    // mutation would silently rewrite what undo replays. `readonly` is a
    // compile-time claim only, so take an isolated frozen copy here — this
    // function is history's ownership boundary.
    return canonical_cell_history_delta(delta);
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
 * A delta rebuilt to its declared shape, field by field.
 *
 * `CellHistoryDelta` is a structural type, so a value that satisfies it can also
 * carry a getter where a data property was expected, inherit a field from a
 * prototype, or hold extra properties nobody declared. Any of those makes the
 * graph a holder measured and the graph it retained two different things — an
 * unmeasured 300MiB string riding along on a highlight delta, or a `worksheet`
 * that answers differently after the bounds were computed.
 *
 * So it is rebuilt rather than inspected. Each field is read exactly once and
 * copied into a frozen object of the declared shape; nothing undeclared survives.
 * The copy is cheap because the content is primitives — the strings themselves
 * are shared, not duplicated, which is what makes this affordable on the
 * million-cell gestures history has to bound rather than refuse.
 */
export function canonical_cell_history_delta(
    delta: CellHistoryDelta,
    owner: RetainedStringOwner = detaching_owner(),
): CellHistoryDelta {
    if (CANONICAL_DELTAS.has(delta)) return delta;
    // A memo per delta, so an object the input SHARED between a transition and an
    // overlay is shared by the output too. That aliasing is load-bearing: it is
    // how one string exists once in memory, and how the byte estimate charges it
    // once instead of refusing gestures that fit the bounds.
    const values = new Map<HistoryValue, HistoryValue>();
    const value_of = (value: HistoryValue): HistoryValue => {
        const seen = values.get(value);
        if (seen !== undefined) return seen;
        const canonical = canonical_value(value, owner);
        values.set(value, canonical);
        return canonical;
    };
    const links = new Map<CellHyperlink, CellHyperlink | null>();
    const link_of = (link: CellHyperlink | null): CellHyperlink | null => {
        if (link === null) return null;
        const seen = links.get(link);
        if (seen !== undefined) return seen;
        const canonical = canonical_hyperlink(link, owner);
        links.set(link, canonical);
        return canonical;
    };

    const base: CellHistoryDeltaBase = {
        worksheet: canonical_worksheet_target(delta.worksheet, owner),
        sourceRow: delta.sourceRow,
        sourceColumn: delta.sourceColumn,
        beforeOverlay: canonical_overlay(delta.beforeOverlay, value_of, link_of),
        afterOverlay: canonical_overlay(delta.afterOverlay, value_of, link_of),
    };
    const value = delta.value;
    const hyperlink = delta.hyperlink;
    const out: CellHistoryDelta = value !== undefined && hyperlink !== undefined
        ? {
            ...base,
            value: canonical_transition(value, value_of),
            hyperlink: canonical_transition(hyperlink, link_of),
        }
        : value !== undefined
            ? { ...base, value: canonical_transition(value, value_of) }
            : { ...base, hyperlink: canonical_transition(hyperlink!, link_of) };
    const frozen = freeze_deep_declared(out);
    CANONICAL_DELTAS.add(frozen);
    return frozen;
}

/**
 * An owner for a lone delta: detaches, shares within the delta, charges nothing.
 *
 * The default for a caller building one delta at a time, where there is no action
 * to bound and no sibling delta to share with.
 */
export function detaching_owner(): RetainedStringOwner {
    const owned = new Map<string, string>();
    return {
        own: (text) => {
            const seen = owned.get(text);
            if (seen !== undefined) return seen;
            const detached = detached_string(text);
            owned.set(text, detached);
            return detached;
        },
        charge_run: () => {},
    };
}

/**
 * Who owns the strings and the shape a canonical delta retains.
 *
 * Two jobs a delta cannot do for itself, because both are properties of the whole
 * ACTION rather than of one cell:
 *
 *   - `own` returns the string to retain, SHARED across every delta that asks for
 *     an equal one. A million-cell paste names one worksheet; detaching that name
 *     per delta would allocate a million copies of it, each of them charged once by
 *     an estimator that deduplicates by value — a bound defeated by the very
 *     copying that was meant to make the bound honest.
 *   - `charge_run` accounts for a run's shape as it is built. The bounds are
 *     otherwise enforced by a separate estimating walk, which cannot stop a rebuild
 *     already under way: a cell carrying millions of one-character runs is mostly
 *     shape, so metering only their text let the whole run graph be allocated
 *     before anything checked.
 *
 * Either may throw to abandon the walk. The estimator still has the last word on
 * what an action costs; this is a tripwire.
 */
export interface RetainedStringOwner {
    own(text: string): string;
    charge_run(): void;
}

/** Registers what this module built, so a second rebuild can be skipped. */
const CANONICAL_DELTAS = new WeakSet<CellHistoryDelta>();

/**
 * Whether this delta is already the canonical, frozen, detached form.
 *
 * True only of a graph this module built. Re-canonicalizing one would allocate a
 * second full copy of every string it holds, so a gesture near the hard bound
 * would hold both copies at once — exhausting memory below the bound meant to
 * prevent exactly that.
 */
export function is_canonical_cell_delta(delta: CellHistoryDelta): boolean {
    return CANONICAL_DELTAS.has(delta);
}

/**
 * How much of a string is copied at a time when detaching it.
 *
 * Large enough that a cell's text is one pass, small enough that the argument
 * list never approaches the engine's limit on a spread call.
 */
const DETACH_CHUNK = 4_096;

/**
 * A string that stands on its own, holding no other string alive.
 *
 * V8 answers `slice` with a view retaining the WHOLE of its parent, and `a + b`
 * with a rope retaining both halves, so a twenty-character cell sliced out of a
 * 300MiB document keeps all 300MiB reachable while the estimator charges it forty
 * bytes — the hard bound defeated by content it did measure, honestly, at the
 * wrong size. Every string history retains is therefore copied out unit by unit;
 * `String.fromCharCode` is one of the few constructions that actually allocates a
 * fresh flat string rather than a view of an existing one.
 *
 * Copying costs a pass over the text once per retained string, which is cheap
 * against what it prevents: cell text is short, and a long value is one that
 * would otherwise be retained unmeasured.
 */
export function detached_string(text: string): string {
    if (text.length <= DETACH_CHUNK) return detached_chunk(text, 0, text.length);
    const chunks: string[] = [];
    for (let start = 0; start < text.length; start += DETACH_CHUNK) {
        chunks.push(detached_chunk(text, start, Math.min(start + DETACH_CHUNK, text.length)));
    }
    // Joined rather than accumulated with `+=`: the result is one flat string,
    // where a chain of concatenations would be a rope thousands of nodes deep. Its
    // pieces are all ours either way, so nothing foreign is retained.
    return chunks.join('');
}

function detached_chunk(text: string, start: number, end: number): string {
    const units: number[] = [];
    for (let index = start; index < end; index += 1) units.push(text.charCodeAt(index));
    return String.fromCharCode(...units);
}

/**
 * Canonical worksheet targets, interned for the life of the session.
 *
 * Interned GLOBALLY rather than per action, because a delta is built one cell at a
 * time — long before there is an action to scope an owner to. A million-cell paste
 * names one worksheet, and without a shared target every delta would detach its own
 * copy of that name while the estimator charged one.
 *
 * The estimator keys its charge on the target OBJECT, so this is an optimization
 * and never a correctness requirement: a target that misses every cache is freshly
 * built and honestly charged. That is what lets both caches be bounded.
 *
 * Two of them, because they answer different questions:
 *
 *   - `BY_SOURCE` maps a caller's target object to its canonical form. A wide
 *     gesture names one worksheet with one object, so this answers in O(1) without
 *     touching the identity strings at all. Weak, so it costs nothing to keep.
 *   - `BY_IDENTITY` catches equal targets that arrive as different objects, keyed
 *     on a composite of the identity. Building that key is O(identity length), so
 *     it is only consulted for identities short enough for that to be free — a
 *     real sheet name is a few dozen characters, and a caller handing us a
 *     megabyte-long one gets correctly-charged copies rather than a hang.
 */
const MAX_INTERNED_TARGETS = 4_096;
/** Longest identity worth building a composite key for. Real names are tiny. */
const MAX_INTERNED_IDENTITY_LENGTH = 512;
/**
 * A canonical target remembered against the source object it came from, WITH the
 * field values it was built from.
 *
 * A caller's target is a mutable object — `readonly` is a compile-time claim — and
 * one that gets renamed or reordered between two cells of a gesture would otherwise
 * keep answering with the first snapshot, so later deltas would replay against the
 * sheet it used to be.
 */
interface SourceMemo {
    readonly sheetIndex: number;
    readonly sheetName: string | undefined;
    readonly worksheetId: string | undefined;
    readonly canonical: WorksheetTarget;
}
let BY_SOURCE = new WeakMap<WorksheetTarget, SourceMemo>();
const BY_IDENTITY = new Map<string, WorksheetTarget>();

export function canonical_worksheet_target(
    target: WorksheetTarget,
    owner: RetainedStringOwner,
): WorksheetTarget {
    // Each field is read exactly once, here, and everything below uses the locals:
    // an accessor that answers differently on a second read must not be able to
    // pair one field's value with another's.
    const { sheetIndex, sheetName, worksheetId } = target;

    // The common case: every delta of a gesture was handed the same target object.
    // Verified against the values it was built from, since the caller's object can
    // be mutated between two cells of one gesture.
    const memo = BY_SOURCE.get(target);
    if (
        memo !== undefined
        && memo.sheetIndex === sheetIndex
        && memo.sheetName === sheetName
        && memo.worksheetId === worksheetId
    ) {
        return memo.canonical;
    }

    const identity_length = (sheetName?.length ?? 0) + (worksheetId?.length ?? 0);
    const key = identity_length <= MAX_INTERNED_IDENTITY_LENGTH
        ? `${sheetIndex}\u0000${sheetName === undefined ? 0 : 1}${worksheetId === undefined ? 0 : 1}\u0000${sheetName ?? ''}\u0000${worksheetId ?? ''}`
        : undefined;
    const seen = key === undefined ? undefined : BY_IDENTITY.get(key);
    if (seen !== undefined) {
        BY_SOURCE.set(target, { sheetIndex, sheetName, worksheetId, canonical: seen });
        return seen;
    }

    // Charged only when it is really allocated: a delta pointing at an
    // already-interned sheet retains no new string, and the estimator agrees
    // because it charges per retained target object.
    const canonical = Object.freeze({
        sheetIndex,
        ...(sheetName === undefined ? {} : { sheetName: owner.own(sheetName) }),
        ...(worksheetId === undefined ? {} : { worksheetId: owner.own(worksheetId) }),
    });
    // Always remembered against the source object, which retains nothing the source
    // was not already keeping alive.
    BY_SOURCE.set(target, { sheetIndex, sheetName, worksheetId, canonical });
    if (key !== undefined && BY_IDENTITY.size < MAX_INTERNED_TARGETS) {
        // The key repeats the identity, so it is only ever a bounded few hundred
        // characters — which is what MAX_INTERNED_IDENTITY_LENGTH is for.
        BY_IDENTITY.set(detached_string(key), canonical);
    }
    return canonical;
}

/**
 * A short stand-in for a canonical target's SEMANTIC identity.
 *
 * Anything that needs to tell two worksheets apart — deduplicating a gesture's
 * cells, say — would otherwise build a key holding the whole identity, once per
 * cell, on fields nothing bounds. A token is a handful of characters, computed once
 * per canonical target and remembered against it.
 *
 * Equal identities get equal tokens even when they are two objects. They can be:
 * interning is bounded, so a very long identity or a full table leaves two targets
 * unshared on purpose, and a token that followed object identity would then count
 * one cell twice and evict history the user could still undo. Sharing an object is
 * an optimization; naming the same sheet is a fact.
 */
export function worksheet_token(target: WorksheetTarget): string {
    const seen = TOKENS.get(target);
    if (seen !== undefined) return seen;
    const { sheetIndex, sheetName, worksheetId } = target;
    // Prefers identity over index for the same reason replay does: an external
    // reorder reassigns indices while the identity carried alongside stays true.
    const identity = worksheetId !== undefined
        ? `id:${worksheetId}`
        : sheetName !== undefined
            ? `name:${sheetName}`
            : `index:${sheetIndex}`;
    const existing = TOKENS_BY_IDENTITY.get(identity);
    const token = existing ?? `w${NEXT_TOKEN++}`;
    if (existing === undefined) TOKENS_BY_IDENTITY.set(detached_string(identity), token);
    TOKENS.set(target, token);
    return token;
}

let TOKENS = new WeakMap<WorksheetTarget, string>();
/**
 * Identity to token, so two unshared targets naming one sheet agree.
 *
 * Held for the session and unbounded, which a canonical target's identity can
 * afford to be: it is only ever reached once per canonical target — the WeakMap
 * above answers every later ask — and a workbook has tens of sheets. The strings
 * are detached, so nothing larger is kept alive behind them.
 */
const TOKENS_BY_IDENTITY = new Map<string, string>();
let NEXT_TOKEN = 0;

/**
 * Test seam: forgets every interned worksheet target.
 *
 * Both caches, or the reset would leave tests order-dependent: a target object
 * memoized before the reset would keep answering with its old canonical form
 * without repopulating the identity map, so an equal target arriving afterwards
 * would get a different object and be charged separately.
 */
export function reset_interned_worksheet_targets(): void {
    BY_IDENTITY.clear();
    BY_SOURCE = new WeakMap<WorksheetTarget, SourceMemo>();
    TOKENS_BY_IDENTITY.clear();
    // Both halves, for the same reason: a target still memoized against a token no
    // identity maps to any more would leave an equal target with a different one.
    TOKENS = new WeakMap<WorksheetTarget, string>();
}

function canonical_value(value: HistoryValue, owner: RetainedStringOwner): HistoryValue {
    const runs = value.runs;
    return {
        text: owner.own(value.text),
        ...(runs === undefined
            ? {}
            : { runs: { runs: canonical_runs(runs.runs, owner) } }),
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
function canonical_runs(
    runs: readonly RichTextRun[],
    owner: RetainedStringOwner,
): readonly RichTextRun[] {
    const out: RichTextRun[] = [];
    for (const run of runs) {
        // Charged before it is built: a cell of one-character runs is mostly shape,
        // so a budget told only about text would allocate the whole run graph.
        owner.charge_run();
        out.push(canonical_run(run, owner));
    }
    return out;
}

function canonical_run(run: RichTextRun, owner: RetainedStringOwner): RichTextRun {
    const style = run.style;
    return {
        text: owner.own(run.text),
        ...(style === undefined ? {} : { style: canonical_style(style) }),
    };
}

function canonical_style(style: CellTextStyle): CellTextStyle {
    const { bold, italic, underline, strikethrough } = style;
    return {
        ...(bold === undefined ? {} : { bold }),
        ...(italic === undefined ? {} : { italic }),
        ...(underline === undefined ? {} : { underline }),
        ...(strikethrough === undefined ? {} : { strikethrough }),
    };
}

function canonical_hyperlink(
    link: CellHyperlink | null,
    owner: RetainedStringOwner,
): CellHyperlink | null {
    if (link === null) return null;
    const tooltip = link.tooltip;
    const rest = tooltip === undefined ? {} : { tooltip: owner.own(tooltip) };
    return link.kind === 'external'
        ? { kind: 'external', target: owner.own(link.target), ...rest }
        : { kind: 'internal', location: owner.own(link.location), ...rest };
}

interface CanonicalTransition<T> {
    readonly mode: CellHistoryTransitionMode;
    readonly expected: HistoryDimensionSide<T>;
    readonly desired: HistoryDimensionSide<T>;
}

function canonical_transition<T>(
    transition: CanonicalTransition<T>,
    content: (value: T) => T,
): CanonicalTransition<T> {
    // Each side is read once. An accessor read twice could answer with two
    // different objects, and the canonical delta would then pair one side's
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

function canonical_overlay(
    overlay: CellOverlayState,
    value_of: (value: HistoryValue) => HistoryValue,
    link_of: (link: CellHyperlink | null) => CellHyperlink | null,
): CellOverlayState {
    if (overlay.kind === 'absent') return ABSENT;
    const value = overlay.value;
    const hyperlink = overlay.hyperlink;
    const canonical_value_dimension: OverlayValueDimension = value.kind === 'present'
        ? {
            kind: 'present',
            value: value_of(value.value),
            base: value_of(value.base),
            basePending: value.basePending,
        }
        : { kind: 'untouched', anchor: value_of(value.anchor) };
    const canonical_link_dimension: OverlayHyperlinkDimension = hyperlink.kind === 'present'
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
        value: canonical_value_dimension,
        hyperlink: canonical_link_dimension,
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
