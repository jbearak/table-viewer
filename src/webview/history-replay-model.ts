/**
 * Turning a recorded action back into overlay edits, in two separate steps.
 *
 * PLANNING is pure and total: it reads the overlay states the cells hold now,
 * checks each against what the action says was there, and either produces the
 * complete list of writes or refuses with a reason. It changes nothing.
 * APPLYING takes a plan that already exists and cannot fail.
 *
 * The split is what makes a replay atomic. A gesture spans many cells across
 * many worksheets, and a replay that wrote as it went would leave half an undo
 * applied when the tenth cell turned out to have moved underneath — a state no
 * further undo or redo could describe, because history records whole gestures.
 * Nothing is written until every cell has been checked.
 *
 * Deliberately free of React, the store, and the row-space question: the caller
 * supplies a reader over overlay states and applies the plan to whatever holds
 * them. Keys are built from source rows because that is the space history
 * records in and the space durable edits live in.
 */

import {
    absent_overlay,
    dirty_entry_from_overlay_state,
    history_values_equal,
    hyperlink_only_overlay,
    overlay_for_direction,
    transition_side,
    type CellHistoryDelta,
    type CellOverlayState,
    type HistoryDirection,
    type HistoryDirtyEntry,
    type HistoryValue,
    type OverlayHyperlinkDimension,
    type OverlayValueDimension,
    type PresentCellOverlayState,
} from './history-cell-state-model';
import {
    action_replay_changes,
    type HighlightHistoryDelta,
    type HistoryAction,
} from './history-stack-model';
import { hyperlinks_equal, type CellHyperlink } from '../cell-content';
import type { WorksheetTarget } from '../types';

/**
 * The overlay state a cell holds right now, or `undefined` when the question
 * cannot be answered — the worksheet the action names is not open, or is not the
 * one now at that address.
 *
 * Unanswerable is not the same as absent, and the difference decides whether a
 * replay proceeds. An absent overlay is a fact about a cell the reader can see;
 * `undefined` means it cannot see the cell at all, and treating that as absence
 * would let an undo delete an entry it never actually looked at.
 */
export type ReadCellOverlay = (
    worksheet: WorksheetTarget,
    sourceRow: number,
    sourceColumn: number,
) => CellOverlayState | undefined;

/** One cell's write: the entry to store, or `undefined` to remove it. */
export interface PlannedCellWrite {
    readonly worksheet: WorksheetTarget;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly key: string;
    readonly entry: HistoryDirtyEntry | undefined;
}

export interface ReplayPlan {
    readonly kind: 'plan';
    readonly direction: HistoryDirection;
    /**
     * In replay order, which for undo is the gesture reversed: a cell a paste
     * touched twice has to be walked back through the same states it came
     * forward through.
     */
    readonly writes: readonly PlannedCellWrite[];
    /**
     * The action's highlight changes, carried through untouched. Highlights live
     * in their own store with their own reservations, so they are planned here
     * only in the sense of being handed to the caller in replay order.
     */
    readonly highlights: readonly HighlightHistoryDelta[];
}

/**
 * Why no plan exists. The gesture is left entirely unapplied.
 *
 *   - `conflict`: a cell no longer holds what the action recorded, so replaying
 *     over it would silently discard whatever put it in its current state.
 *   - `unavailable`: the reader could not see a cell — its worksheet is not
 *     open, or the target no longer resolves to one.
 *   - `base-pending`: the cell's entry is awaiting its true conflict base, and
 *     the replay would have to reconstruct an unedited anchor from a base that
 *     is a placeholder rather than the cell's real content.
 */
export interface ReplayRefusal {
    readonly kind: 'refused';
    readonly reason: 'conflict' | 'unavailable' | 'base-pending';
    readonly worksheet: WorksheetTarget;
    readonly sourceRow: number;
    readonly sourceColumn: number;
}

export type ReplayPlanResult = ReplayPlan | ReplayRefusal;

/**
 * Plan a whole action's replay, or refuse at the first cell that has moved.
 *
 * Refusing on the first mismatch rather than collecting every one is deliberate:
 * the outcome is the same — nothing is applied — and a wide gesture over a
 * workbook that has moved underneath would otherwise walk a million cells to
 * report a fact the first one already established.
 */
export function plan_history_replay(
    action: HistoryAction,
    direction: HistoryDirection,
    read_overlay: ReadCellOverlay,
): ReplayPlanResult {
    const writes: PlannedCellWrite[] = [];
    const highlights: HighlightHistoryDelta[] = [];
    // What the plan has already decided to leave in each cell it visited.
    //
    // A gesture may touch one cell twice — a paste overlapping its own source
    // gives A->B then B->C — and the second delta's compare-and-swap has to run
    // against the state the FIRST write will produce, not against the store,
    // which will not have moved until the whole plan is applied. Reading the
    // store for both would look for B, find C, and refuse a replay that is
    // perfectly consistent with itself.
    const planned_state = new Map<string, CellOverlayState>();
    const read_planned: ReadCellOverlay = (worksheet, row, column) =>
        planned_state.get(cell_address(worksheet, row, column))
            ?? read_overlay(worksheet, row, column);

    for (const change of action_replay_changes(action, direction)) {
        if (change.kind === 'highlight') {
            highlights.push(change.delta);
            continue;
        }
        const planned = plan_cell_replay(change.delta, direction, read_planned);
        if (planned.kind === 'refused') return planned;
        const { worksheet, sourceRow, sourceColumn } = change.delta;
        planned_state.set(cell_address(worksheet, sourceRow, sourceColumn), planned.result);
        writes.push(planned.write);
    }
    return { kind: 'plan', direction, writes, highlights };
}

/**
 * A cell's address for the plan's own bookkeeping, built from the whole target
 * rather than the sheet index.
 *
 * Object identity would be tempting — an owned action shares one target per
 * tuple — but a plan must not depend on how its action was built, and two
 * gestures merged into one action can legitimately carry equal targets that are
 * not the same object.
 *
 * Keyed by the STRONGEST identity the target carries, which is the hierarchy
 * `worksheet_target_lookup` resolves by: id, then name, then index. Two targets
 * naming one worksheet may disagree on the weaker fields — a sheet renamed or
 * moved between the two gestures an action merged — and keying on the whole
 * tuple would file them as two cells, so the second delta would miss the first's
 * planned state, read a store that has not moved, and refuse a replay that is
 * consistent with itself.
 */
function cell_address(worksheet: WorksheetTarget, row: number, column: number): string {
    const { sheetIndex, sheetName, worksheetId } = worksheet;
    const identity: readonly [string, string | number] = worksheetId !== undefined
        ? ['id', worksheetId]
        : sheetName !== undefined
            ? ['name', sheetName]
            : ['index', sheetIndex];
    return JSON.stringify([...identity, row, column]);
}

interface PlannedCell {
    readonly kind: 'planned';
    readonly write: PlannedCellWrite;
    /** The overlay the write leaves behind, for a later delta on the same cell. */
    readonly result: CellOverlayState;
}

function plan_cell_replay(
    delta: CellHistoryDelta,
    direction: HistoryDirection,
    read_overlay: ReadCellOverlay,
): PlannedCell | ReplayRefusal {
    const { worksheet, sourceRow, sourceColumn } = delta;
    const refuse = (reason: ReplayRefusal['reason']): ReplayRefusal =>
        ({ kind: 'refused', reason, worksheet, sourceRow, sourceColumn });

    const current = read_overlay(worksheet, sourceRow, sourceColumn);
    if (current === undefined) return refuse('unavailable');

    // Undo restores `expected` and must find `desired` in place; redo the
    // reverse. `transition_side` answers with the destination, so the check
    // reads the other one.
    const source: HistoryDirection = direction === 'undo' ? 'redo' : 'undo';
    const recorded = overlay_for_direction(delta, source);
    if (delta.value !== undefined) {
        const side = transition_side(delta.value, source);
        if (!value_dimension_matches(
            dimension_of(current, 'value'),
            side.overlay === 'present' ? dimension_of(recorded, 'value') : undefined,
        )) {
            return refuse('conflict');
        }
    }
    if (delta.hyperlink !== undefined) {
        const side = transition_side(delta.hyperlink, source);
        if (!link_dimension_matches(
            dimension_of(current, 'hyperlink'),
            side.overlay === 'present' ? dimension_of(recorded, 'hyperlink') : undefined,
        )) {
            return refuse('conflict');
        }
        if (!anchor_matches(current, recorded)) return refuse('conflict');
    }

    const merged = merge_replayed_dimensions(delta, current, overlay_for_direction(delta, direction));
    if (merged === undefined) return refuse('base-pending');
    const result = merged === ABSENT_RESULT ? absent_overlay() : merged;
    return {
        kind: 'planned',
        result,
        write: {
            worksheet,
            sourceRow,
            sourceColumn,
            key: `${sourceRow}:${sourceColumn}`,
            entry: result.kind === 'absent' ? undefined : dirty_entry_from_overlay_state(result),
        },
    };
}

/**
 * Whether the cell's value dimension is where the action left it.
 *
 * Membership is always checked. When the recorded side was IN the overlay, the
 * WHOLE dimension is checked — value, base and `basePending` — because all three
 * are session state the replay itself put there, and `build_cell_history_delta`
 * records a move of any of them as a real change. Checking only the displayed
 * value would let a later recommit against a base that moved underneath
 * (`{value: B, base: C}` becoming `{value: B, base: D}`) pass the swap and be
 * silently overwritten, taking with it whether the cell reads as conflicted and
 * whether a save may be admitted at all.
 *
 * `undefined` for `recorded` means the dimension was NOT in the overlay, and
 * then only its absence is asserted: the content of an absent side is the cell's
 * persisted text at record time, which an intervening save may have legitimately
 * moved. Comparing that would refuse an undo for the very reason `membership`
 * mode exists to tolerate.
 */
function value_dimension_matches(
    current: OverlayValueDimension,
    recorded: OverlayValueDimension | undefined,
): boolean {
    if (recorded === undefined || recorded.kind !== 'present') return current.kind !== 'present';
    if (current.kind !== 'present') return false;
    return current.basePending === recorded.basePending
        && history_values_equal(current.value, recorded.value)
        && history_values_equal(current.base, recorded.base);
}

function link_dimension_matches(
    current: OverlayHyperlinkDimension,
    recorded: OverlayHyperlinkDimension | undefined,
): boolean {
    if (recorded === undefined || recorded.kind !== 'present') return current.kind !== 'present';
    if (current.kind !== 'present') return false;
    return hyperlinks_equal(current.value, recorded.value)
        && hyperlinks_equal(current.base, recorded.base);
}

/**
 * Whether a link-only entry's unedited anchor is where the action left it.
 *
 * Checked only for a replayed hyperlink dimension, and only between two entries
 * that are both link-only, because that is exactly the case
 * `hyperlink_metadata_moved` attributes to this dimension: the anchor is
 * reconstructed into the entry's `value`/`base` pair, so a move of it changes
 * the base a save is validated against even though nothing about the link moved.
 * A dimension whose membership differs has already been reported as moved, and
 * an absent overlay has no anchor to compare.
 */
function anchor_matches(current: CellOverlayState, recorded: CellOverlayState): boolean {
    const left = untouched_anchor(current);
    const right = untouched_anchor(recorded);
    if (left === undefined || right === undefined) return true;
    return history_values_equal(left, right);
}

/** The merge produced no entry at all, as distinct from the merge failing. */
const ABSENT_RESULT = Symbol('absent overlay');

/**
 * Rebuild the cell's entry with only the replayed dimensions replaced.
 *
 * The delta's destination overlay describes both dimensions, but only the ones
 * the delta TOUCHED may be taken from it. A cell whose text was edited and then,
 * in a later gesture, given a hyperlink has both in its entry; undoing the text
 * edit must leave the link exactly where the later gesture put it. Writing the
 * whole recorded overlay would delete a change the action never made, and — worse
 * — one the compare-and-swap deliberately did not object to, because the value
 * dimension it checked really was untouched.
 *
 * Returns `undefined` when the surviving link dimension would need an anchor the
 * cell cannot supply: a base-pending entry's `base` is a placeholder, and
 * promoting it to a link-only entry's unedited text would fabricate content the
 * user never saw and admit a save against it.
 */
function merge_replayed_dimensions(
    delta: CellHistoryDelta,
    current: CellOverlayState,
    destination: CellOverlayState,
): PresentCellOverlayState | typeof ABSENT_RESULT | undefined {
    const value = delta.value !== undefined
        ? dimension_of(destination, 'value')
        : dimension_of(current, 'value');
    const link = delta.hyperlink !== undefined
        ? dimension_of(destination, 'hyperlink')
        : dimension_of(current, 'hyperlink');

    // The three-arm union enumerates the combinations a real entry can have, and
    // the cast is what lets this build one from two independently chosen
    // dimensions. Safe because a present value dimension is enough on its own:
    // every arm carrying one is valid whichever kind the link dimension has.
    if (value.kind === 'present') {
        return { kind: 'present', value, hyperlink: link } as PresentCellOverlayState;
    }
    // No value dimension left. Without a link either, the entry is gone.
    if (link.kind !== 'present') return ABSENT_RESULT;
    const anchor = surviving_anchor(destination, current);
    if (anchor === undefined) return undefined;
    return hyperlink_only_overlay(anchor, link.value, link.base);
}

function dimension_of(state: CellOverlayState, dimension: 'value'): OverlayValueDimension;
function dimension_of(state: CellOverlayState, dimension: 'hyperlink'): OverlayHyperlinkDimension;
function dimension_of(
    state: CellOverlayState,
    dimension: 'value' | 'hyperlink',
): OverlayValueDimension | OverlayHyperlinkDimension {
    if (state.kind === 'absent') {
        return dimension === 'value' ? ABSENT_VALUE_DIMENSION : UNTOUCHED_LINK_DIMENSION;
    }
    return dimension === 'value' ? state.value : state.hyperlink;
}

/**
 * An absent overlay's value dimension, which needs an anchor no absent overlay
 * carries. The placeholder is never read for content: a merge that keeps it
 * either drops the entry entirely, or asks {@link surviving_anchor} for the real
 * unedited text.
 */
const ABSENT_VALUE_DIMENSION: OverlayValueDimension = Object.freeze({
    kind: 'untouched' as const,
    anchor: Object.freeze({ text: '' }),
});

const UNTOUCHED_LINK_DIMENSION: OverlayHyperlinkDimension = Object.freeze({
    kind: 'untouched' as const,
});

/**
 * The unedited text a surviving link dimension hangs on.
 *
 * The DESTINATION's own anchor first: that is the text the action recorded for
 * this cell, and it is the only source that survives the cell having no entry at
 * all. Redoing a hyperlink attached to an unedited cell starts from an absent
 * overlay, so asking the current state would refuse a replay whose answer the
 * action was carrying all along — and where two link-only states differ only in
 * their anchor, taking the current one would make the undo a silent no-op while
 * history advanced past it.
 *
 * Otherwise the cell's current entry knows it: a present value dimension's
 * `base` IS the unedited content, captured when the edit started. A base still
 * pending is a placeholder rather than that content, and has no answer.
 */
function surviving_anchor(
    destination: CellOverlayState,
    current: CellOverlayState,
): HistoryValue | undefined {
    const recorded = untouched_anchor(destination);
    if (recorded !== undefined) return recorded;
    if (current.kind === 'absent') return undefined;
    if (current.value.kind === 'untouched') return current.value.anchor;
    return current.value.basePending ? undefined : current.value.base;
}

/** A link-only overlay's unedited text, or `undefined` for any other state. */
function untouched_anchor(state: CellOverlayState): HistoryValue | undefined {
    if (state.kind === 'absent' || state.value.kind !== 'untouched') return undefined;
    return state.value.anchor;
}
