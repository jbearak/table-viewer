/**
 * What to tell the user about an undo or redo that did not happen.
 *
 * Pure and separate from App because the policy is the interesting part: most
 * refusals are ordinary and must stay silent, and a warning for one of those
 * would fire on every key repeat.
 */

import type { HistoryDirection } from './history-cell-state-model';
import type { ReplayRefusalReason } from './history-replay-request-model';

function verb(direction: HistoryDirection): string {
    return direction === 'undo' ? 'Undo' : 'Redo';
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
 *  - `document-changed` — the document was replaced underneath. That replacement
 *    is itself the visible event, and history is cleared with it.
 *  - `malformed` — a protocol fault, not a user-actionable condition. Reporting
 *    it would ask the user to act on something only a bug report can fix.
 *
 * The protocol's own vocabulary — leases, proposals, overlays — never reaches
 * these strings. They describe what happened to the document.
 */
export function history_refusal_warning(
    reason: ReplayRefusalReason,
    direction: HistoryDirection,
    barrier_label: string | undefined,
): string | null {
    switch (reason) {
        case 'busy':
        case 'nothing-to-replay':
        case 'document-changed':
        case 'malformed':
            return null;
        case 'blocked':
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
