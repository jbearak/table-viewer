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
export function canonical_cell_history_delta(delta: CellHistoryDelta): CellHistoryDelta {
    // A memo per delta, so an object the input SHARED between a transition and an
    // overlay is shared by the output too. That aliasing is load-bearing: it is
    // how one string exists once in memory, and how the byte estimate charges it
    // once instead of refusing gestures that fit the bounds.
    const values = new Map<HistoryValue, HistoryValue>();
    const value_of = (value: HistoryValue): HistoryValue => {
        const seen = values.get(value);
        if (seen !== undefined) return seen;
        const canonical = canonical_value(value);
        values.set(value, canonical);
        return canonical;
    };
    const links = new Map<CellHyperlink, CellHyperlink | null>();
    const link_of = (link: CellHyperlink | null): CellHyperlink | null => {
        if (link === null) return null;
        const seen = links.get(link);
        if (seen !== undefined) return seen;
        const canonical = canonical_hyperlink(link);
        links.set(link, canonical);
        return canonical;
    };

    const base: CellHistoryDeltaBase = {
        worksheet: canonical_worksheet_target(delta.worksheet),
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
    return freeze_deep_declared(out);
}

function canonical_worksheet_target(target: WorksheetTarget): WorksheetTarget {
    const { sheetIndex, sheetName, worksheetId } = target;
    return {
        sheetIndex,
        ...(sheetName === undefined ? {} : { sheetName }),
        ...(worksheetId === undefined ? {} : { worksheetId }),
    };
}

function canonical_value(value: HistoryValue): HistoryValue {
    const runs = value.runs;
    return {
        text: value.text,
        ...(runs === undefined
            ? {}
            : { runs: { runs: runs.runs.map(canonical_run) } }),
    };
}

function canonical_run(run: RichTextRun): RichTextRun {
    const style = run.style;
    return {
        text: run.text,
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

function canonical_hyperlink(link: CellHyperlink | null): CellHyperlink | null {
    if (link === null) return null;
    const tooltip = link.tooltip;
    const rest = tooltip === undefined ? {} : { tooltip };
    return link.kind === 'external'
        ? { kind: 'external', target: link.target, ...rest }
        : { kind: 'internal', location: link.location, ...rest };
}

function canonical_transition<T>(
    transition: { readonly mode: CellHistoryTransitionMode; readonly expected: HistoryDimensionSide<T>; readonly desired: HistoryDimensionSide<T> },
    content: (value: T) => T,
): { readonly mode: CellHistoryTransitionMode; readonly expected: HistoryDimensionSide<T>; readonly desired: HistoryDimensionSide<T> } {
    return {
        mode: transition.mode,
        expected: { content: content(transition.expected.content), overlay: transition.expected.overlay },
        desired: { content: content(transition.desired.content), overlay: transition.desired.overlay },
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
