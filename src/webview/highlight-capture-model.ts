/**
 * A highlight gesture, as history changes.
 *
 * The gesture's cells come from the HOST, not from a local comparison: the host
 * holds both sides at its compare-and-set, so its delta names exactly the cells
 * this gesture moved. A renderer-side diff of the state that comes back would
 * attribute another window's concurrent change to this gesture and let undo
 * revert it. See `highlight_state_deltas`.
 *
 * What is left for the renderer is the part only it can do: resolving each
 * delta's sheet INDEX to the worksheet target a history change records. A
 * workbook-wide undo has to find its way back to the sheet a gesture was made on,
 * and a bare index cannot survive a sheet reorder between the gesture and the
 * undo.
 *
 * A generator, on the same reasoning as the discard's source: clearing every
 * highlight in a file can reach the 100_000-cell ceiling, and the recorder's
 * budget stops mid-walk rather than after a full materialization.
 */

import type { HighlightCellDelta, WorksheetIdentityInput } from '../types';
import { target_for_sheet } from './edit-session-registry';
import type { HistoryChange } from './history-stack-model';

export function* highlight_history_source(
    deltas: Iterable<HighlightCellDelta>,
    sheets: readonly WorksheetIdentityInput[],
): Generator<HistoryChange> {
    for (const delta of deltas) {
        const sheet = sheets[delta.sheetIndex];
        // No identity to record the change against. A target resolving by index
        // alone would name a different worksheet after a sheet move, so the cell
        // is left uncapturable rather than recorded against one that could drift.
        if (sheet === undefined) continue;
        yield Object.freeze({
            kind: 'highlight' as const,
            delta: Object.freeze({
                worksheet: target_for_sheet(delta.sheetIndex, sheet),
                sourceRow: delta.sourceRow,
                sourceColumn: delta.sourceColumn,
                before: delta.before,
                after: delta.after,
            }),
        });
    }
}
