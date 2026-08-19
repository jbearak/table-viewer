/**
 * A mutation held back from its store's subscribers, so several stores can move
 * as one transaction.
 *
 * The shape is the contract, and the contract is subtle enough to be worth
 * having once: stage against the state you read, ask every participant whether
 * it is still valid, then commit them all, then notify them all. Checking
 * validity inside each commit instead would let the first store swap before the
 * third discovered its own state had moved — a half-applied transaction, which
 * is precisely what staging exists to prevent.
 */

export interface StagedMutation {
    /**
     * Whether this staging still describes a swap its store will accept — false
     * once that store has moved for any other reason since it was staged.
     * Changes nothing, so a caller may ask about every participant before moving
     * any of them.
     */
    valid(): boolean;
    /**
     * Swap the staged state in without notifying. Answers whether it changed.
     * Refuses — answering false — if the staging is no longer {@link valid}, but
     * a caller that validated the whole list first can never reach that.
     */
    commit(): boolean;
    /** Notify the store's subscribers, once, if the commit changed anything. */
    notify(): void;
}

/**
 * Wrap a store's own swap and publish in the staging protocol.
 *
 * `swap` performs the mutation and answers whether anything actually changed; it
 * runs at most once, and only while `valid` still holds. `notify` then runs at
 * most once, and only if the swap changed something — which is what makes a
 * no-op gesture publish nothing.
 *
 * Nothing here holds the store's listeners open: an abandoned staging is simply
 * dropped.
 */
export function stage_mutation(
    valid: () => boolean,
    swap: () => boolean,
    notify: () => void,
): StagedMutation {
    let changed = false;
    let committed = false;
    let notified = false;
    return {
        valid,
        commit: () => {
            if (committed) return changed;
            if (!valid()) return false;
            committed = true;
            changed = swap();
            return changed;
        },
        notify: () => {
            if (notified || !changed) return;
            notified = true;
            notify();
        },
    };
}

/**
 * Run several stores' stagings as one transaction.
 *
 * The three passes are the contract, and running them in this order across ALL
 * participants is what the contract is for. Nothing between pass one and pass
 * two may `await`, update React state, post a message, or run a callback that
 * could re-enter mutation code: a store that moved in that window would have
 * been validated in one state and committed in another, which is exactly the
 * split the protocol exists to prevent.
 *
 * Answers whether anything changed. `false` with nothing committed is the
 * ordinary outcome when a participant has moved on — the caller keeps its old
 * state and does not retry — so the caller must not read `false` as an error.
 */
export function commit_staged_transaction(
    mutations: readonly StagedMutation[],
): boolean {
    for (const mutation of mutations) {
        if (!mutation.valid()) return false;
    }
    let changed = false;
    for (const mutation of mutations) {
        if (mutation.commit()) changed = true;
    }
    // Notification is its own pass, after every store has swapped: a listener
    // woken by the first store would read the others still holding their old
    // state, and a subscriber that saw an edit map move before the history did
    // would render a menu that disagrees with the cells.
    for (const mutation of mutations) mutation.notify();
    return changed;
}
