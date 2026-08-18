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
 * typed commit — and it accumulates in the caller's own loop rather than in a
 * long-lived ref. Glide delivers each operation as a complete array, so the
 * accumulation can be born and die inside a single synchronous call; a ref
 * spanning the asynchronous clipboard and cell-loading work in paste and fill
 * could be overwritten by a second operation before the first one's batch
 * arrived.
 */

import type { CellHyperlink } from '../cell-content';
import type { WorksheetTarget } from '../types';
import {
    build_cell_history_delta,
    type CellOverlayState,
    type HistoryValue,
} from './history-cell-state-model';
import type { HistoryChange } from './history-stack-model';

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
 * One cell's transition, as the change history will record.
 *
 * `undefined` when nothing semantically moved — retyping a cell's current text,
 * say. Undo of a keypress that changed nothing would look to the user like a
 * dropped keypress, so it is not recorded at all.
 */
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
