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
