/**
 * A discard, as a history action.
 *
 * Discarding an edit session throws away every sheet's overlay at once, and that
 * is undoable by decision. What makes it capturable at all — for sheets the user
 * never even scrolled to — is the transition mode the delta builder already
 * assigns: every cell goes from a present overlay to an absent one, so both
 * dimensions are `membership` rather than `semantic`, and a membership side
 * carries no content for its destination. Redoing the discard therefore removes
 * the overlay rather than writing the historical persisted text back over
 * whatever is on disk now, and — the point here — the ABSENT side's content is
 * never compared, so it never has to be read.
 *
 * That is why this needs no page residency and no `get_cell_raw`. An ordinary
 * capture must refuse a cell whose page is not loaded, because substituting `''`
 * for unread disk content would fabricate the missing side of the transition
 * (see `PersistedCellHistoryState`). Here the missing side is the one nothing
 * will ever read: the persisted value only reaches the delta as the content of a
 * side whose membership is `absent`, and `value_dimension_matches` asserts only
 * absence for such a side, precisely because an intervening save may legitimately
 * have moved it.
 *
 * A generator, not an array. A workbook-wide discard is the gesture most likely
 * to exceed the history bounds, and the recorder walks a source with a budget
 * that stops mid-walk — so materializing every sheet's map first would allocate
 * exactly the peak the budget exists to avoid.
 */

import { parse_cell_highlight_key } from '../cell-highlights';
import type { WorksheetTarget } from '../types';
import {
    absent_overlay,
    history_value,
    overlay_state_from_dirty_entry,
    type HistoryDirtyEntry,
} from './history-cell-state-model';
import { build_cell_history_change } from './history-capture-model';
import type { HistoryChange } from './history-stack-model';

/** One worksheet's overlay map, with the target the action must record. */
export interface DiscardedWorksheet {
    readonly target: WorksheetTarget;
    readonly entries: ReadonlyMap<string, HistoryDirtyEntry>;
}

/**
 * The changes a discard of these worksheets records: every entry removed.
 *
 * A key that is not a well-formed `row:col` pair is SKIPPED rather than guessed
 * at. Such a key cannot occur — every writer builds one through the same
 * construction — but an action is the authority a later undo mutates through, and
 * a coordinate parsed from a malformed key would name some other cell. Dropping
 * the change means that one cell is not undoable; inventing a coordinate would
 * make undo write over a cell the user never edited.
 */
export function* discard_history_source(
    worksheets: Iterable<DiscardedWorksheet>,
): Generator<HistoryChange> {
    for (const { target, entries } of worksheets) {
        for (const [key, entry] of entries) {
            const coordinates = parse_cell_highlight_key(key);
            if (coordinates === undefined) continue;
            const change = build_cell_history_change({
                worksheet: target,
                sourceRow: coordinates.sourceRow,
                sourceColumn: coordinates.sourceColumn,
                before: overlay_state_from_dirty_entry(entry),
                after: absent_overlay(),
                // The store's own record of what this overlay was made against,
                // which is the closest thing to persisted state that exists
                // without page residency — and for a link-only entry it IS the
                // cell's unedited text. Never actually compared: both dimensions
                // are `membership` here, so only absence is asserted (see the
                // file's note). Passing the entry's own base rather than a
                // fabricated empty keeps that independent of the delta builder's
                // internals: were a later refactor to start consulting persisted
                // content, this would degrade to a stale base rather than to an
                // invented empty cell.
                persisted: {
                    value: history_value(entry.base, entry.baseRuns),
                    hyperlink: entry.baseLink ?? null,
                },
            });
            // A present overlay always moves when it is removed, so the builder
            // cannot answer `undefined` — but it is a total function and this
            // does not depend on that.
            if (change !== undefined) yield change;
        }
    }
}
