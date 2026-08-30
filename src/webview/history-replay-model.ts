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

import { cell_key } from '../cell-key';
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
import {
    dirty_entry_with_observed_file_base,
    make_observed_file_base,
    move_provenance_equal,
    type WorksheetTarget,
} from '../types';

/** What a cell holds right now: its overlay, and the content underneath it. */
export interface CellReplayState {
    readonly overlay: CellOverlayState;
    /**
     * The cell's CURRENT persisted text — what a save would leave if the overlay
     * went away. Needed because an overlay that is absent has no unedited anchor
     * to offer, and a link restored onto such a cell has to hang on the content
     * that is there now rather than on whatever was there when the action was
     * recorded.
     */
    readonly persisted: HistoryValue;
    /** Current persisted link; prepared host reads always provide it. */
    readonly persistedHyperlink?: CellHyperlink | null;
}

/**
 * The state a cell holds right now, or `undefined` when the question cannot be
 * answered — the worksheet the action names is not open, or is not the one now
 * at that address.
 *
 * Unanswerable is not the same as absent, and the difference decides whether a
 * replay proceeds. An absent overlay is a fact about a cell the reader can see;
 * `undefined` means it cannot see the cell at all, and treating that as absence
 * would let an undo delete an entry it never actually looked at.
 */
export type ReadCellState = (
    worksheet: WorksheetTarget,
    sourceRow: number,
    sourceColumn: number,
) => CellReplayState | undefined;

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
    read_state: ReadCellState,
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
    const planned_state = new Map<string, CellReplayState>();
    const read_planned: ReadCellState = (worksheet, row, column) =>
        planned_state.get(cell_address(worksheet, row, column))
            ?? read_state(worksheet, row, column);

    const replay_changes = action_replay_changes(action, direction);
    for (const change of replay_changes) {
        // Structural-only actions are replayed synchronously against the
        // session-owned PendingRowStore. They never enter the source-cell lease.
        if (change.kind === 'rowAppend' || change.kind === 'tailRemoval'
            || change.kind === 'pendingRows') continue;
        if (change.kind === 'highlight') {
            highlights.push(change.delta);
            continue;
        }
        if (direction === 'undo') {
            const after = overlay_for_direction(change.delta, 'redo');
            const moved = after.kind === 'present' && after.value.kind === 'present'
                ? after.value.movedFrom
                : undefined;
            const { worksheet, sourceRow, sourceColumn } = change.delta;
            if (
                moved !== undefined
                && read_planned(worksheet, sourceRow, sourceColumn)?.overlay.kind === 'absent'
            ) {
                // Once saved, reversing only the address mapping would also
                // rewrite formulas that already referred to the destination.
                // Read the evolving plan so an earlier reverse step can restore
                // an overlapping destination before this check.
                return {
                    kind: 'refused',
                    reason: 'conflict',
                    worksheet,
                    sourceRow,
                    sourceColumn,
                };
            }
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
 * A cell's address, built from the whole target rather than the sheet index.
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
 *
 * Exported because the planner's own bookkeeping and the prepared-response
 * lookup it reads through must key cells IDENTICALLY: the planner asks for an
 * address and the wire reader answers from a map built under the same rule, so
 * two implementations that merely agree today would, on drifting apart, make
 * every prepared cell invisible to the delta that addresses it and turn a sound
 * replay into `unavailable`. One function makes the agreement structural.
 */
export function cell_address(worksheet: WorksheetTarget, row: number, column: number): string {
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
    /** The state the write leaves behind, for a later delta on the same cell. */
    readonly result: CellReplayState;
}

function plan_cell_replay(
    delta: CellHistoryDelta,
    direction: HistoryDirection,
    read_state: ReadCellState,
): PlannedCell | ReplayRefusal {
    const { worksheet, sourceRow, sourceColumn } = delta;
    const refuse = (reason: ReplayRefusal['reason']): ReplayRefusal =>
        ({ kind: 'refused', reason, worksheet, sourceRow, sourceColumn });

    const state = read_state(worksheet, sourceRow, sourceColumn);
    if (state === undefined) return refuse('unavailable');
    const current = state.overlay;

    // Undo restores `expected` and must find `desired` in place; redo the
    // reverse. `transition_side` answers with the destination, so the check
    // reads the other one.
    const source: HistoryDirection = direction === 'undo' ? 'redo' : 'undo';
    const recorded = overlay_for_direction(delta, source);
    if (delta.value !== undefined) {
        const side = transition_side(delta.value, source);
        if (!value_dimension_matches(
            value_dimension_of(current),
            side.overlay === 'present' ? value_dimension_of(recorded) : undefined,
        )) {
            return refuse('conflict');
        }
    }
    if (delta.hyperlink !== undefined) {
        const side = transition_side(delta.hyperlink, source);
        if (!link_dimension_matches(
            link_dimension_of(current),
            side.overlay === 'present' ? link_dimension_of(recorded) : undefined,
        )) {
            return refuse('conflict');
        }
        if (!anchor_matches(current, recorded)) return refuse('conflict');
    }

    const result = merge_replayed_dimensions(delta, state, overlay_for_direction(delta, direction));
    if (result === undefined) return refuse('base-pending');
    let entry = result.kind === 'absent' ? undefined : dirty_entry_from_overlay_state(result);
    if (entry !== undefined) entry = entry_with_persisted_side(entry, state);
    return {
        kind: 'planned',
        result: {
            overlay: result,
            persisted: state.persisted,
            ...(state.persistedHyperlink !== undefined
                ? { persistedHyperlink: state.persistedHyperlink }
                : {}),
        },
        write: {
            worksheet,
            sourceRow,
            sourceColumn,
            key: cell_key(sourceRow, sourceColumn),
            entry,
        },
    };
}

/** Preserve the latest file side independently of the historical overlay being
 * replayed. Undo changes user intent; it must not make the acknowledged file
 * value stale again. */
function entry_with_persisted_side(
    entry: HistoryDirtyEntry,
    state: CellReplayState,
): HistoryDirtyEntry {
    // A legacy bare-string entry means its original base was never observed.
    // Without that original there is no meaningful A -> C comparison to
    // preserve, and adding an observed side would also make the entry
    // impossible to encode back into its only lossless durable form.
    if (entry.base_pending === true) return entry;
    if (entry.link !== undefined && state.persistedHyperlink === undefined) return entry;
    return dirty_entry_with_observed_file_base(entry, make_observed_file_base(
        state.persisted.text,
        state.persisted.runs,
        entry.link !== undefined ? state.persistedHyperlink : undefined,
    ));
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
    current: OverlayValueDimension | undefined,
    recorded: OverlayValueDimension | undefined,
): boolean {
    if (recorded === undefined || recorded.kind !== 'present') return current?.kind !== 'present';
    if (current?.kind !== 'present') return false;
    return current.basePending === recorded.basePending
        && current.writeValue === recorded.writeValue
        && current.retainValue === recorded.retainValue
        && current.formattingKnown === recorded.formattingKnown
        && move_provenance_equal(current.movedFrom, recorded.movedFrom)
        && current.valueEditOrder === recorded.valueEditOrder
        && JSON.stringify(current.formulaReferenceBases ?? [])
            === JSON.stringify(recorded.formulaReferenceBases ?? [])
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
    state: CellReplayState,
    destination: CellOverlayState,
): CellOverlayState | undefined {
    const current = state.overlay;
    const value = delta.value !== undefined
        ? value_dimension_of(destination)
        : value_dimension_of(current);
    const link = delta.hyperlink !== undefined
        ? link_dimension_of(destination)
        : link_dimension_of(current);

    // The three-arm union enumerates the combinations a real entry can have, and
    // the cast is what lets this build one from two independently chosen
    // dimensions. Safe because a present value dimension is enough on its own:
    // every arm carrying one is valid whichever kind the link dimension has.
    if (value?.kind === 'present') {
        return { kind: 'present', value, hyperlink: link } as PresentCellOverlayState;
    }
    // No value dimension left. Without a link either, the entry is gone.
    if (link.kind !== 'present') return absent_overlay();
    const anchor = surviving_anchor(destination, state);
    if (anchor === undefined) return undefined;
    return hyperlink_only_overlay(anchor, link.value, link.base);
}

/**
 * An overlay's value dimension, or `undefined` when there is no overlay at all.
 *
 * An absent overlay has no value dimension to answer with — the shape needs an
 * anchor, and the only honest anchor is the cell's persisted text, which
 * {@link surviving_anchor} fetches when it is actually needed. `undefined` says
 * that plainly rather than fabricating an empty one.
 */
function value_dimension_of(state: CellOverlayState): OverlayValueDimension | undefined {
    return state.kind === 'absent' ? undefined : state.value;
}

/**
 * An overlay's hyperlink dimension. Unlike the value dimension this is total: an
 * absent overlay's link dimension is `untouched`, a complete answer needing no
 * content, and one a merge may carry into the entry it builds.
 */
function link_dimension_of(state: CellOverlayState): OverlayHyperlinkDimension {
    return state.kind === 'absent' ? UNTOUCHED_LINK_DIMENSION : state.hyperlink;
}

const UNTOUCHED_LINK_DIMENSION: OverlayHyperlinkDimension = Object.freeze({
    kind: 'untouched' as const,
});

/**
 * The unedited text a surviving link dimension hangs on.
 *
 * A cell with no overlay answers with what is PERSISTED there now, not with the
 * anchor the action recorded. The recorded anchor was the disk content at record
 * time, and an intervening save may have legitimately moved it — restoring it
 * would not rewrite what the user sees, but it would fabricate a conflict base
 * the cell never had, so the next save would report a conflict against content
 * nobody changed. That is the same rule `membership` mode follows for an absent
 * side, applied to the one field the merge still has to fill in.
 *
 * With an overlay in place the recorded anchor is right and is preferred: it is
 * session state the CAS has just checked, so an anchor-only undo restores the
 * anchor it recorded instead of silently keeping the one already there. Failing
 * that, a present value dimension's `base` IS the unedited content, captured
 * when the edit started; a base still pending is a placeholder rather than that
 * content, and has no answer.
 */
function surviving_anchor(
    destination: CellOverlayState,
    state: CellReplayState,
): HistoryValue | undefined {
    const current = state.overlay;
    if (current.kind === 'absent') return state.persisted;
    const recorded = untouched_anchor(destination);
    if (recorded !== undefined) return recorded;
    if (current.value.kind === 'untouched') return current.value.anchor;
    return current.value.basePending ? undefined : current.value.base;
}

/** A link-only overlay's unedited text, or `undefined` for any other state. */
function untouched_anchor(state: CellOverlayState): HistoryValue | undefined {
    if (state.kind === 'absent' || state.value.kind !== 'untouched') return undefined;
    return state.value.anchor;
}
