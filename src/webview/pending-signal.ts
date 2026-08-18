/**
 * A promise several callers may await, settled once from the outside.
 *
 * The shape an acknowledgement takes when the thing being acknowledged arrives
 * as a message rather than as a return value: the sender keeps the signal, every
 * awaiter reads the same `settled`, and the message handler settles it.
 *
 * One promise rather than a list of resolvers. A list would model a concurrency
 * that has to be reasoned about — which waiter is stale, when the collection is
 * emptied, whether a late arrival joins the old set or a new one — where awaiting
 * the same promise needs none of it. Settling more than once is ignored, so a
 * duplicate host message cannot hand two different answers to the same await.
 */
export interface PendingSignal<T> {
    /** Resolves with the settled value. Safe to await any number of times. */
    readonly settled: Promise<T>;
    /** Settle it. The first call wins; later ones do nothing. */
    settle(value: T): void;
}

export function pending_signal<T>(): PendingSignal<T> {
    let resolve!: (value: T) => void;
    const settled = new Promise<T>((resolver) => { resolve = resolver; });
    let done = false;
    return {
        settled,
        settle: (value) => {
            if (done) return;
            done = true;
            resolve(value);
        },
    };
}
