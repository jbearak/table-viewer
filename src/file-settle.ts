/**
 * Whether a failed refresh read a file that is still being written.
 *
 * Another program writing a file in place (a sync client, a copy to a slow
 * disk, a large export) leaves it unreadable until the last byte lands, and
 * the writer can pause between chunks. A refresh that reads it partway
 * through should wait for the file to go quiet rather than report it
 * unreadable; only a failure on a file that has stopped changing is the
 * file's own fault.
 *
 * The file counts as quiet once nothing has changed it for `quiet_ms`. Its
 * mtime says when it last changed. Each sample also counts as a change when
 * its stat differs from the previous sample's, which covers a writer that
 * sets an old mtime and a clock that disagrees with the file system's. A file
 * that never goes quiet is waited on for `limit_ms` at most, then treated as
 * settled so its error is still reported.
 */

/** How long a file must go unchanged before a failed read of it counts. */
export const FILE_SETTLE_QUIET_MS = 1_000;
/** How long one refresh waits, in all, for a file that keeps changing. */
export const FILE_SETTLE_LIMIT_MS = 30_000;

/** One stat of the file, or `absent` when it does not exist. */
export type FileSettleSample =
    | { readonly size: number; readonly mtime: number }
    | 'absent';

export type FileSettleVerdict =
    | { readonly type: 'settled' }
    | { readonly type: 'unsettled'; readonly retry_in_ms: number };

export interface FileSettleOptions {
    readonly quiet_ms?: number;
    readonly limit_ms?: number;
    /** The shortest wait before a retry. */
    readonly min_retry_ms?: number;
    readonly now?: () => number;
}

export class FileSettleTracker {
    private readonly quiet_ms: number;
    private readonly limit_ms: number;
    private readonly min_retry_ms: number;
    private readonly now: () => number;
    private started_at: number | undefined;
    private last_fingerprint: string | undefined;
    private observed_change_at: number | undefined;

    constructor(options: FileSettleOptions = {}) {
        this.quiet_ms = options.quiet_ms ?? FILE_SETTLE_QUIET_MS;
        this.limit_ms = options.limit_ms ?? FILE_SETTLE_LIMIT_MS;
        this.min_retry_ms = options.min_retry_ms ?? 0;
        this.now = options.now ?? Date.now;
    }

    /**
     * Judge a failed attempt from a stat taken after it. `undefined` means the
     * stat itself failed for a reason other than absence; with nothing to
     * judge by, the failure counts as it always did.
     */
    after_failure(sample: FileSettleSample | undefined): FileSettleVerdict {
        if (sample === undefined) return { type: 'settled' };
        const now = this.now();
        this.started_at ??= now;
        const fingerprint = sample === 'absent' ? 'absent' : `${sample.mtime}:${sample.size}`;
        if (this.last_fingerprint !== undefined && fingerprint !== this.last_fingerprint) {
            this.observed_change_at = now;
        }
        this.last_fingerprint = fingerprint;
        let last_change_at = this.observed_change_at ?? -Infinity;
        if (sample !== 'absent') {
            // An mtime ahead of this clock cannot be measured against it, so
            // the file counts as changed when this stat was first seen.
            last_change_at = Math.max(
                last_change_at,
                sample.mtime <= now ? sample.mtime : this.observed_change_at ?? this.started_at,
            );
        }
        const quiet_for = now - last_change_at;
        if (quiet_for >= this.quiet_ms || now - this.started_at >= this.limit_ms) {
            return { type: 'settled' };
        }
        return {
            type: 'unsettled',
            retry_in_ms: Math.max(this.min_retry_ms, this.quiet_ms - quiet_for),
        };
    }
}
