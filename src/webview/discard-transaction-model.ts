/**
 * Discarding an edit session, as one transaction.
 *
 * A discard empties every sheet's overlay AND records what it emptied, and the
 * two are one all-or-nothing step: publishing the emptying first would leave the
 * edits gone with no way back if the recording were then refused for exceeding
 * the history bounds. That invariant is the whole of this module, kept out of the
 * React callback that used to hold it so it can be exercised directly and so a
 * second discard entry point cannot diverge from it.
 *
 * What stays in the caller: the edit-mode transition, the barrier, and the
 * terminal message to the host. Those are session lifecycle, not this gesture.
 */

import type { WorksheetIdentityInput } from '../types';
import { discard_history_source } from './history-discard-model';
import type { EditSessionRegistry } from './edit-session-registry';
import type { HistoryStore } from './history-store';
import type { HistoryBounds } from './history-stack-model';
import { commit_staged_transaction, type StagedMutation } from './staged-mutation';


export type DiscardTransactionOutcome =
    /** Emptied, and recorded as undoable. */
    | { readonly kind: 'recorded' }
    /**
     * Emptied, but too large to keep in the history, so it cannot be undone. The
     * discard still happens — refusing a user's discard to protect a history
     * buffer would be the wrong trade — and the recording installs the barrier
     * that makes a later undo explain itself. The caller says so.
     */
    | { readonly kind: 'unrecordable' }
    /**
     * A store moved between staging and committing — a keystroke, a save landing.
     * Nothing was emptied and nothing recorded, so the gesture is abandoned
     * rather than half-applied; the user presses it again.
     */
    | { readonly kind: 'abandoned' }
    /**
     * No store would stage, which is a session that has already moved on. The
     * fallback clear is attempted and a store the session does not own refuses it
     * too — correctly, since those edits are another session's. The caller still
     * sends its terminal message, because the host's durable slots are the host's
     * own to clear.
     */
    | { readonly kind: 'stale' };

export function run_discard_transaction(args: {
    readonly registry: EditSessionRegistry;
    readonly history: HistoryStore;
    readonly sessionId: string;
    readonly sheets: readonly WorksheetIdentityInput[];
    /** Injected so a test can drive the too-large path without a real 128MiB. */
    readonly bounds?: HistoryBounds;
}): DiscardTransactionOutcome {
    const { registry, history, sessionId, sheets } = args;
    // Every sheet's, not just the mounted grid's: the session covers the whole
    // workbook and the host clears every live durable slot, so a store left full
    // here would repaint edits the user just discarded the next time its sheet is
    // opened.
    const discarded = registry.stage_discard(sessionId, sheets);
    if (discarded === undefined) {
        registry.clear_all(sessionId);
        return { kind: 'stale' };
    }
    const recorded = history.stage_record({
        label: 'Discard edits',
        // Streamed, not built: a workbook-wide discard is the gesture most likely
        // to exceed the bounds, and the recorder stops mid-walk.
        changes: discard_history_source(discarded.worksheets),
    }, args.bounds);
    const staged: readonly StagedMutation[] = [...discarded.mutations, recorded];
    // Validity, not the commit's answer. `commit_staged_transaction` reports
    // whether anything CHANGED, and a discard of an already-empty session changes
    // nothing while being perfectly valid — abandoning on that would swallow the
    // terminal message the host needs to clear its own durable slots.
    if (!staged.every((mutation) => mutation.valid())) return { kind: 'abandoned' };
    commit_staged_transaction(staged);
    return recorded.outcome.kind === 'refused' ? { kind: 'unrecordable' } : { kind: 'recorded' };
}
