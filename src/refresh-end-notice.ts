/**
 * Tells the renderer that the refresh after a Save ended without adopting a
 * file: kept (another program put the old bytes back), stopped, or failed.
 *
 * After a successful Save the renderer may keep the saved cells on screen
 * until the reloaded file arrives (webview/saved-presentation.ts). An adoption
 * ends that by itself. A refresh that ends any other way leaves the rows the
 * renderer holds in place, so it is told, and shows them as read before the
 * Save again.
 *
 * The notice names the Save by its success lifecycle revision, so a late one
 * can never end a later Save's cells. It is posted at most once per Save, and
 * retried like a snapshot delivery until the receiver takes it: a missed one
 * would leave the saved cells on screen until the next edit, sort or reload.
 */
import type { HostMessage } from './types';

export interface RefreshEndNoticeScheduler {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface RefreshEndNoticeOptions {
    /** Post to the receiver of this epoch; false when it did not take it. */
    readonly post: (message: HostMessage, receiver_epoch: number) => Promise<boolean>;
    readonly receiver_epoch: () => number;
    readonly scheduler: RefreshEndNoticeScheduler;
    /** Delays before each retry, then `dormant_retry_ms` between the rest. */
    readonly backoff_ms?: readonly number[];
    readonly dormant_retry_ms?: number;
    /** A post still unanswered after this long counts as not taken. */
    readonly attempt_timeout_ms?: number;
}

export interface RefreshEndNotice {
    /** A Save with this success revision has asked for its refresh. */
    save_requested(revision: number): void;
    /** A file was adopted: whatever the Save showed has been replaced. */
    adopted(): void;
    /** A refresh still current ended without adopting a file. */
    ended_without_adoption(): void;
    dispose(): void;
}

// The panel session's delivery policy (panel-session.ts).
const BACKOFF_MS = Object.freeze([25, 50, 100, 200]);
const DORMANT_RETRY_MS = 30_000;
const ATTEMPT_TIMEOUT_MS = 1_000;

export function create_refresh_end_notice(options: RefreshEndNoticeOptions): RefreshEndNotice {
    const backoff = options.backoff_ms ?? BACKOFF_MS;
    const dormant = options.dormant_retry_ms ?? DORMANT_RETRY_MS;
    const attempt_timeout = options.attempt_timeout_ms ?? ATTEMPT_TIMEOUT_MS;
    let awaiting: number | undefined;
    let delivery: {
        readonly revision: number;
        readonly receiver_epoch: number;
        timer: unknown;
    } | undefined;
    let disposed = false;

    const stop = () => {
        if (delivery?.timer !== undefined) options.scheduler.clearTimeout(delivery.timer);
        delivery = undefined;
    };

    const attempt = (current: NonNullable<typeof delivery>, count: number) => {
        current.timer = undefined;
        if (disposed || delivery !== current) return;
        if (current.receiver_epoch !== options.receiver_epoch()) {
            // A new receiver is a new renderer: the rows the Save was shown
            // over went with the old one.
            stop();
            return;
        }
        let answered = false;
        const retry = () => {
            if (answered) return;
            answered = true;
            if (disposed || delivery !== current) return;
            if (current.timer !== undefined) options.scheduler.clearTimeout(current.timer);
            current.timer = options.scheduler.setTimeout(
                () => attempt(current, count + 1),
                backoff[count] ?? dormant,
            );
        };
        current.timer = options.scheduler.setTimeout(retry, attempt_timeout);
        void options.post(
            { type: 'refreshEndedWithoutAdoption', revision: current.revision },
            current.receiver_epoch,
        ).then(
            (taken) => {
                if (answered || disposed || delivery !== current) return;
                if (!taken) {
                    retry();
                    return;
                }
                answered = true;
                stop();
            },
            retry,
        );
    };

    return {
        save_requested(revision) {
            if (disposed) return;
            awaiting = revision;
        },
        adopted() {
            awaiting = undefined;
        },
        ended_without_adoption() {
            if (disposed || awaiting === undefined) return;
            const revision = awaiting;
            awaiting = undefined;
            stop();
            const current = {
                revision,
                receiver_epoch: options.receiver_epoch(),
                timer: undefined as unknown,
            };
            delivery = current;
            attempt(current, 0);
        },
        dispose() {
            disposed = true;
            awaiting = undefined;
            stop();
        },
    };
}
