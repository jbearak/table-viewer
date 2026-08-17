/**
 * Assembling one user gesture into one history action.
 *
 * Capture happens in the editing layer, not in the store, because only the
 * writer knows the intent behind the entry it is about to write: `{value: 'A',
 * base: 'A', link}` is produced both by attaching a link to an unedited cell and
 * by an entry that genuinely still has a value dimension, and the two undo
 * differently. See `ValueDimensionIntent`. So a caller hands capture the exact
 * overlay it means, and capture never re-derives one.
 *
 * A gesture is one invocation of a batch editing API — one paste, one fill, one
 * typed commit — and it accumulates here rather than in a long-lived ref. Glide
 * delivers each operation as a complete array, so the accumulator can be born
 * and die inside a single synchronous call; a ref spanning the asynchronous
 * clipboard and cell-loading work in paste and fill could be overwritten by a
 * second operation before the first one's batch arrived.
 */

import type { CellHyperlink } from '../cell-content';
import type { WorksheetTarget } from '../types';
import {
    build_cell_history_delta,
    type CellOverlayState,
    type HistoryValue,
} from './history-cell-state-model';
import type { HistoryAction, HistoryChange } from './history-stack-model';

/**
 * A cell's state on disk: what the overlay is an edit ON TOP OF.
 *
 * Required, never defaulted. A cell whose page is not resident has no persisted
 * state to read, and substituting `''` would fabricate the missing side of an
 * undo transition — undo would then write an empty cell over content it never
 * saw. Such a cell must be refused before it mutates, not captured with a guess.
 */
export interface PersistedCellHistoryState {
    readonly value: HistoryValue;
    readonly hyperlink: CellHyperlink | null;
}

export interface CellHistoryCapture {
    readonly worksheet: WorksheetTarget;
    readonly sourceRow: number;
    readonly sourceColumn: number;
    readonly before: CellOverlayState;
    readonly after: CellOverlayState;
    readonly persisted: PersistedCellHistoryState;
}

/**
 * One gesture under assembly.
 *
 * Also the gesture's memory of what it has already done: a paste whose target
 * overlaps a cell it wrote earlier in the same batch must transition from the
 * overlay that earlier write produced, not from the one the store held when the
 * batch began.
 */
export interface GestureCapture {
    /** The exact overlay an earlier transition in this gesture left, if any. */
    overlay_at(key: string): CellOverlayState | undefined;
    /** Records the transition and remembers `capture.after` for `key`. */
    record(key: string, capture: CellHistoryCapture): void;
    /** Changes so far, in application order. */
    readonly changes: readonly HistoryChange[];
    /** Builds the action to record. See {@link capture_history_action}. */
    action(label: string): HistoryAction;
}

export function begin_gesture_capture(): GestureCapture {
    const overlays = new Map<string, CellOverlayState>();
    const changes: HistoryChange[] = [];
    return {
        overlay_at: (key) => overlays.get(key),
        record: (key, capture) => {
            overlays.set(key, capture.after);
            const change = build_cell_history_change(capture);
            // Absent when nothing semantically moved — retyping a cell's current
            // text, say. Undo of a keypress that changed nothing would look like
            // a dropped keypress, so it is not recorded at all.
            if (change !== undefined) changes.push(change);
        },
        get changes() { return changes; },
        action: (label) => capture_history_action(label, changes),
    };
}

export function build_cell_history_change(
    capture: CellHistoryCapture,
): HistoryChange | undefined {
    const delta = build_cell_history_delta({
        worksheet: capture.worksheet,
        sourceRow: capture.sourceRow,
        sourceColumn: capture.sourceColumn,
        before: capture.before,
        after: capture.after,
        persistedValue: capture.persisted.value,
        persistedHyperlink: capture.persisted.hyperlink,
    });
    return delta === undefined ? undefined : { kind: 'cell', delta };
}

/**
 * The action to hand `record_history_action` — plain, deliberately not owned.
 *
 * `history_action` would build the whole owned graph eagerly. Recording owns as
 * it walks and abandons the walk the moment the hard bound is passed, so an
 * oversized paste that history will refuse anyway must reach it unowned; owning
 * it first would allocate the entire copy that the budget exists to avoid.
 */
export function capture_history_action(
    label: string,
    changes: readonly HistoryChange[],
): HistoryAction {
    return { label, changes };
}
