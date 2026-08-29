/**
 * The webview's half of the replay wire: overlays out, prepared cells in.
 *
 * Two conversions and one reader live here.
 *
 * The conversions exist because `CellOverlayState` is a webview type and the
 * host must not import webview modules, so the protocol declares the same shape
 * arm for arm and this module holds the round trip. That round trip is the only
 * thing keeping the two declarations honest, which is why it is tested
 * exhaustively rather than by example.
 *
 * The reader is the answer to a real design problem. `plan_history_replay` needs
 * each cell's live overlay to compare-and-swap against, and the obvious source —
 * the edit-session store — is the wrong one: by the time a prepared response
 * arrives the store has had an async round trip in which to move, and planning
 * against a state the host never verified would authorize a write it never
 * checked. So the planner reads the FROZEN snapshot the lease was issued
 * against. Whether the store still agrees is a separate question, asked
 * separately by {@link prepared_overlays_match_store} before the commit is sent.
 */

import {
    type HistoryReplayCellInput,
    type HistoryReplayPrepared,
    type HistoryReplayPreparedCell,
    type WireCellOverlayState,
    type WireHistoryValue,
} from '../history-replay-protocol';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    combined_overlay,
    history_value,
    hyperlink_only_overlay,
    overlay_states_equal,
    value_only_overlay,
    type CellOverlayState,
    type HistoryValue,
} from './history-cell-state-model';
import {
    cell_address as replay_cell_address,
    type CellReplayState,
    type ReadCellState,
} from './history-replay-model';

function wire_history_value(value: HistoryValue): WireHistoryValue {
    return value.runs === undefined ? { text: value.text } : { text: value.text, runs: value.runs };
}

function history_value_from_wire(value: WireHistoryValue): HistoryValue {
    return history_value(value.text, value.runs);
}

/** `CellOverlayState` as the wire carries it. */
export function wire_overlay_from_cell_overlay_state(
    state: CellOverlayState,
): WireCellOverlayState {
    if (state.kind === 'absent') return { kind: 'absent' };
    const value = state.value.kind === 'untouched'
        ? { kind: 'untouched' as const, anchor: wire_history_value(state.value.anchor) }
        : {
            kind: 'present' as const,
            value: wire_history_value(state.value.value),
            base: wire_history_value(state.value.base),
            basePending: state.value.basePending,
            ...(state.value.writeValue === true ? { writeValue: true as const } : {}),
            ...(state.value.retainValue === true ? { retainValue: true as const } : {}),
            ...(state.value.formattingKnown === true
                ? { formattingKnown: true as const }
                : {}),
            ...(state.value.movedFrom === undefined
                ? {}
                : { movedFrom: state.value.movedFrom }),
            ...(state.value.valueEditOrder === undefined
                ? {}
                : { valueEditOrder: state.value.valueEditOrder }),
        };
    const link = state.hyperlink;
    const hyperlink = link.kind === 'untouched'
        ? { kind: 'untouched' as const }
        : { kind: 'present' as const, value: link.value, base: link.base };
    // Reassembled through the union's own arms rather than spread, so the
    // combination that has neither dimension in the overlay stays unbuildable
    // here too.
    if (value.kind === 'present' && hyperlink.kind === 'untouched') {
        return { kind: 'present', value, hyperlink };
    }
    if (value.kind === 'untouched' && hyperlink.kind === 'present') {
        return { kind: 'present', value, hyperlink };
    }
    if (value.kind === 'present' && hyperlink.kind === 'present') {
        return { kind: 'present', value, hyperlink };
    }
    // Unreachable: `PresentCellOverlayState` has no fourth arm. Kept as a
    // refusal rather than a cast so a future arm cannot silently pass through.
    return { kind: 'absent' };
}

/** The inverse, rebuilt through the constructors so the shapes stay canonical. */
export function cell_overlay_state_from_wire(
    value: WireCellOverlayState,
): CellOverlayState {
    if (value.kind === 'absent') return absent_overlay();
    // Destructured before switching: narrowing the outer union on a NESTED
    // discriminant does not narrow its sibling, so `value.hyperlink` would stay
    // the full dimension union inside a `value.value.kind` branch.
    const { value: dimension, hyperlink } = value;
    if (dimension.kind === 'untouched') {
        // The union guarantees it, but the union is not evidence about a value
        // that crossed a wire; the protocol's sanitizer is, and an overlay with
        // neither dimension present never gets past it.
        if (hyperlink.kind === 'untouched') return absent_overlay();
        return hyperlink_only_overlay(
            history_value_from_wire(dimension.anchor),
            hyperlink.value,
            hyperlink.base,
        );
    }
    const present = history_value_from_wire(dimension.value);
    const base = history_value_from_wire(dimension.base);
    if (hyperlink.kind === 'untouched') {
        return value_only_overlay(
            present,
            base,
            dimension.basePending,
            dimension.writeValue,
            dimension.retainValue,
            dimension.formattingKnown,
            dimension.movedFrom,
            dimension.valueEditOrder,
        );
    }
    return combined_overlay(
        present,
        base,
        hyperlink.value,
        hyperlink.base,
        dimension.basePending,
        dimension.writeValue,
        dimension.retainValue,
        dimension.formattingKnown,
        dimension.movedFrom,
        dimension.valueEditOrder,
    );
}


/**
 * The planner's reader, over one prepared response.
 *
 * Every cell the action addresses is in here, because preparation refused
 * outright if any of them could not be read. So a `undefined` from this reader
 * means the action addresses a cell the request never listed — a bug in
 * assembly, not a document that moved — and the planner's `unavailable` refusal
 * is the correct answer either way.
 */
export function read_state_from_prepared_replay(
    prepared: HistoryReplayPrepared,
): ReadCellState {
    const by_address = new Map<string, CellReplayState>();
    for (const cell of prepared.cells) {
        by_address.set(
            replay_cell_address(cell.worksheet, cell.sourceRow, cell.sourceColumn),
            {
                overlay: cell_overlay_state_from_wire(cell.overlay),
                persisted: history_value_from_wire(cell.persisted),
                persistedHyperlink: cell.persistedHyperlink,
            },
        );
    }
    return (worksheet, source_row, source_column) => by_address.get(
        replay_cell_address(worksheet, source_row, source_column),
    );
}

/** The prepared cell for one address, for building a commit's ordinals. */
export function prepared_cell_ordinals(
    prepared: HistoryReplayPrepared,
): ReadonlyMap<string, HistoryReplayPreparedCell> {
    const by_address = new Map<string, HistoryReplayPreparedCell>();
    for (const cell of prepared.cells) {
        by_address.set(
            replay_cell_address(cell.worksheet, cell.sourceRow, cell.sourceColumn),
            cell,
        );
    }
    return by_address;
}

/**
 * Whether the store still holds what the lease was issued against.
 *
 * A second guard, not the primary one: the staged transaction is what finally
 * decides, and the host's own compare-and-swap is what protects the document.
 * This one exists to catch the drift EARLY — the round trip through preparation
 * is long enough for a keystroke to land, and finding out here costs a refusal
 * while finding out after the commit costs a document mutation that the local
 * history can no longer describe.
 */
export function prepared_overlays_match_store(
    prepared: HistoryReplayPrepared,
    read_overlay: (
        worksheet: WorksheetTarget,
        source_row: number,
        source_column: number,
    ) => CellOverlayState | undefined,
): boolean {
    for (const cell of prepared.cells) {
        const current = read_overlay(cell.worksheet, cell.sourceRow, cell.sourceColumn);
        if (current === undefined) return false;
        // `overlay_states_equal`, the same semantic comparison the planner and
        // the save path use, rather than a structural one: a formatting-only
        // difference must read as drift here too, and two spellings of one
        // value must not.
        if (!overlay_states_equal(current, cell_overlay_state_from_wire(cell.overlay))) {
            return false;
        }
    }
    return true;
}

/** One cell's prepare-request input, in the order the caller assigned. */
export function history_replay_cell_input(
    ordinal: number,
    worksheet: WorksheetTarget,
    source_row: number,
    source_column: number,
    overlay: CellOverlayState,
): HistoryReplayCellInput {
    return {
        ordinal,
        worksheet,
        sourceRow: source_row,
        sourceColumn: source_column,
        overlay: wire_overlay_from_cell_overlay_state(overlay),
    };
}
