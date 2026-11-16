/**
 * What to tell the user about an undo or redo that did not happen.
 *
 * Pure and separate from App because the policy is the interesting part: most
 * refusals are ordinary and must stay silent, and a warning for one of those
 * would fire on every key repeat.
 */

import type { HistoryDirection } from './history-cell-state-model';
import type { ReplayRefusalReason } from './history-replay-request-model';
import type { HeaderWait } from './history-header-rebase';
import type { ViewSkipReason } from './view-history-model';
import {
    STRUCTURAL_SAVE_BARRIER_MESSAGE,
    type HistoryBarrier,
} from './history-stack-model';

function verb(direction: HistoryDirection): string {
    return direction === 'undo' ? 'Undo' : 'Redo';
}

/**
 * How to describe a replay that already landed: "undone" or "redone".
 *
 * Direction-aware because these strings tell the user what happened to their
 * document, and a redo announced as an undo says the opposite of the truth. It
 * lives here rather than at the call sites for the same reason the refusal
 * warnings do — the wording is the policy.
 */
export function replayed_verb(direction: HistoryDirection): string {
    return direction === 'undo' ? 'undone' : 'redone';
}

/**
 * The warning a refusal deserves, or `null` for the ones that deserve silence.
 *
 * Silent, deliberately:
 *  - `busy` — a second keypress while the first replay is still out. Holding the
 *    key down is how a user walks back a dozen edits; warning about it would fire
 *    once per repeat.
 *  - `nothing-to-replay` — the stack is empty. The menu item is already disabled,
 *    and in the webview there is nothing to say beyond "no".
 *  - `malformed` — a protocol fault, not a user-actionable condition. Reporting
 *    it would ask the user to act on something only a bug report can fix.
 *  - `header-row` — worded by `header_wait_warning`, which knows which rows.
 *
 * `document-changed` speaks. The caller has already returned for a document
 * that really was replaced, so what arrives here is the same document whose
 * host-side view moved under the replay — a refresh not yet acknowledged, a
 * lease that expired — and saying nothing would leave a keypress that did
 * nothing with no account of why.
 *
 * The protocol's own vocabulary — leases, proposals, overlays — never reaches
 * these strings. They describe what happened to the document.
 */
export function history_refusal_warning(
    reason: ReplayRefusalReason,
    direction: HistoryDirection,
    barrier_label: string | undefined,
    barrier_reason?: HistoryBarrier['reason'],
): string | null {
    switch (reason) {
        case 'busy':
        case 'nothing-to-replay':
        case 'malformed':
        case 'header-row':
            return null;
        case 'document-changed':
            return `${verb(direction)} did not run because the file was refreshing. Try again.`;
        case 'blocked':
            if (barrier_reason === 'structural-save') return STRUCTURAL_SAVE_BARRIER_MESSAGE;
            // Named where it can be: the user's question is which gesture cost
            // them their history, and the barrier is the only thing that knows.
            return barrier_label === undefined
                ? `Cannot ${direction} any further: an earlier change was too large to keep in history.`
                : `Cannot ${direction} past “${barrier_label}”: it was too large to keep in history.`;
        case 'unavailable':
            return `${verb(direction)} is unavailable: the change it would apply can no longer be reached.`;
        case 'conflict':
            // "No changes were applied" is a promise the replay's atomic planning
            // actually keeps — it commits every cell or none.
            return `${verb(direction)} could not be completed because the workbook changed. No changes were applied.`;
    }
}

/**
 * What to say about a change that cannot be replayed under the current Header
 * Row. The change stays in history, so the message says which header row
 * makes it replayable: the one it was made under always does. Row numbers are
 * the sheet's, 1-based. `sheet_name` is given when the workbook has more than
 * one worksheet: the refusal comes before replay would switch to the change's
 * worksheet, so "row 3" alone could be read as the one on screen.
 */
export function header_wait_warning(
    wait: HeaderWait,
    direction: HistoryDirection,
    sheet_name?: string,
): string {
    const sheet = sheet_name === undefined ? '' : `Sheet “${sheet_name}”: `;
    const remedy = wait.from > 0
        ? `Use row ${wait.from} as the header row`
        : 'Turn the header row off';
    if (wait.reason === 'header-cell') {
        // The cell's row is the Header Row at exactly one of the two body starts.
        if (wait.row !== undefined && wait.row === wait.to - 1) {
            return `${sheet}Can't ${direction} this cell change while row ${wait.to} is the header row: `
                + `it was made when row ${wait.to} was an ordinary row. `
                + `Use another row as the header row, or turn the header row off, to ${direction} it.`;
        }
        return `${sheet}Can't ${direction} this change while row ${wait.from} is not the header row: `
            + `it changed a column name when row ${wait.from} was the header row. `
            + `${remedy} to ${direction} it.`;
    }
    if (wait.reason === 'rows' && wait.to > 0) {
        return `${sheet}Can't ${direction} this row change while row ${wait.to} is the header row: `
            + `it changes rows that are now in or above the header. ${remedy} to ${direction} it.`;
    }
    // A recorded side that cannot be carried for another reason (it holds a
    // layout conflict, or the worksheet lost rows). Under the header it was
    // made with, nothing has to be carried.
    const now = wait.to > 0 ? `row ${wait.to} is the header row` : 'the header row is off';
    const then = wait.from > 0 ? `row ${wait.from} was the header row` : 'the header row was off';
    return `${sheet}Can't ${direction} this change while ${now}: it was made when ${then}. `
        + `${remedy} to ${direction} it.`;
}

// ---- View steps (a sort, a filter, hidden rows, hidden columns, column widths, row heights) ----

/** A view gesture that cannot start while another one of this window is in flight. */
export const VIEW_GESTURE_WAIT_MESSAGE = 'Wait for the table view to finish updating.';

/** A view gesture or replay whose open cell editor would not commit. */
export const FOLD_REFUSED_MESSAGE = 'Finish or cancel the cell edit first.';

/** Redo, after committing the open cell editor cleared what there was to redo. */
export const REDO_REPLACED_BY_FOLD_MESSAGE =
    'Nothing to redo: the cell edit you just finished replaced it.';

/** A resize or Auto-fit change the host did not write. */
export const SIZE_WRITE_REFUSED_MESSAGE =
    'Could not resize because the file was refreshing. Try again.';

/**
 * What stands in the way of a size write on a worksheet restructured by a
 * save the person has not said finished or not.
 */
export const UNRESOLVED_SAVE_SIZE_REASON = 'choose whether your last save finished first.';

/** A resize the host refused for that reason. */
export const SIZE_WRITE_UNRESOLVED_MESSAGE = `Could not resize: ${UNRESOLVED_SAVE_SIZE_REASON}`;

/** A column hide or show the host did not write. */
export const COLUMN_WRITE_REFUSED_MESSAGE =
    'Could not change the columns because the file was refreshing. Try again.';

/** Why a view replay did not start, when the reason clears by itself. */
export type ViewReplayWait =
    | 'applying'
    | 'updating'
    | 'refreshing'
    | 'finishing'
    | 'preview';

/**
 * What to say about a view replay that did not run and left its entry where
 * it was. Each of these clears without the person doing anything but pressing
 * again, except `preview`, where a sort or filter cannot be installed at all.
 */
export function view_replay_wait_warning(wait: ViewReplayWait, direction: HistoryDirection): string {
    switch (wait) {
        case 'applying':
            return `${verb(direction)} did not run because another change is still being applied. Try again.`;
        case 'updating':
            return `${verb(direction)} did not run because the table view is still updating. Try again.`;
        case 'refreshing':
            return `${verb(direction)} did not run because the file was refreshing. Try again.`;
        case 'finishing':
            return `${verb(direction)} did not run because editing is still finishing. Try again.`;
        case 'preview':
            return `${verb(direction)} is unavailable in preview.`;
    }
}

/** A view replay the host, or a rule of this window, refused. The entry stays. */
export function view_replay_refusal_warning(
    direction: HistoryDirection,
    label: string,
    reason: string,
): string {
    return `Can't ${direction} “${label}”: ${reason}`;
}

const VIEW_SKIP_TEXT: Readonly<Record<ViewSkipReason, string>> = {
    'columns-changed': 'the columns of this worksheet changed since then',
    'rows-above-header': 'rows above the header row stay hidden',
    'header-row': "the header row can't be hidden",
    'rows-gone': 'rows that are no longer in the worksheet were left out',
    'too-many-hidden': 'too many rows would be hidden',
    'columns-gone': 'columns that are no longer in the worksheet were left out',
    'sheets-gone': 'worksheets that are no longer in the workbook were left out',
    'too-many-heights': 'too many rows would have a custom height',
};

/**
 * What to say when part of a view step, or all of it, could not be applied
 * and the step moved on all the same. `whole` is true when nothing of the
 * step was applied. `sheet_name` is given when the workbook has more than one
 * worksheet.
 */
export function view_skip_warning(
    direction: HistoryDirection,
    label: string,
    skipped: readonly ViewSkipReason[],
    whole: boolean,
    sheet_name?: string,
): string {
    const sheet = sheet_name === undefined ? '' : `Sheet “${sheet_name}”: `;
    const reasons = skipped.map((reason) => VIEW_SKIP_TEXT[reason]).join('; ');
    return `${sheet}${verb(direction)} skipped ${whole ? '' : 'part of '}“${label}”: ${reasons}.`;
}

/** The host installed something other than what the replay asked for. */
export function view_partly_applied_warning(direction: HistoryDirection, label: string): string {
    return `${verb(direction)} of “${label}” was only partly applied.`;
}

/** A view replay landed after history was cleared or cut off behind a barrier. */
export function view_replay_dropped_warning(direction: HistoryDirection): string {
    return `The view change was ${replayed_verb(direction)}, but it is no longer in history.`;
}
