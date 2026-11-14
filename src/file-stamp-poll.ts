import * as fs from 'fs';
import type { FileRefreshWatcherEventKind } from './file-refresh-watcher';

export const DEFAULT_FILE_STAMP_POLL_INTERVAL_MS = 1000;

/** One stat of the target, reduced to what changes when its bytes do, or
 *  `ABSENT_FILE_STAMP`. Nanosecond times so two writes in one millisecond
 *  still differ. */
export type FileStamp = string;
export const ABSENT_FILE_STAMP: FileStamp = 'absent';

function stamp_of(stat: fs.BigIntStats): FileStamp {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export function read_file_stamp(file_path: string): FileStamp {
    try {
        return stamp_of(fs.statSync(file_path, { bigint: true }));
    } catch {
        return ABSENT_FILE_STAMP;
    }
}

/**
 * The safety net under a native file watcher. Native watchers can report a
 * change late or never: on macOS both Node's `fs.watch` and VS Code's
 * `createFileSystemWatcher` ride on FSEvents, which drops events under load,
 * and neither reports what it dropped. A missed event would leave the view on
 * stale data for good, so a stat poll runs alongside.
 *
 * Both sides compare the target's stamp with the last one either of them
 * reported, and the first is the stamp taken when watching starts.
 * (`fs.watchFile` would compare against its own first sample instead, which a
 * busy thread pool can take after a change, and then that change is never
 * reported.) The native watcher calls `note_reported` for every event it passes
 * on, so the poll does not report that change a second time, and any change
 * after the last report always is, even the rest of a write the native watcher
 * reported only partway through.
 */
export class FileStampPoll {
    private last_stamp: FileStamp;
    private poll_timer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    constructor(
        private readonly file_path: string,
        private readonly emit: (kind: FileRefreshWatcherEventKind) => void,
        poll_interval_ms = DEFAULT_FILE_STAMP_POLL_INTERVAL_MS,
    ) {
        this.last_stamp = read_file_stamp(file_path);
        // Samples off the main thread, so a slow disk never blocks it; only a
        // sample that differs pays for `reconcile`'s synchronous stat.
        const poll = () => {
            fs.promises.stat(file_path, { bigint: true }).then(
                stamp_of,
                () => ABSENT_FILE_STAMP,
            ).then((sample) => {
                if (this.disposed) return;
                if (sample !== this.last_stamp) this.reconcile();
                this.poll_timer = setTimeout(poll, poll_interval_ms);
                this.poll_timer.unref?.();
            });
        };
        this.poll_timer = setTimeout(poll, poll_interval_ms);
        this.poll_timer.unref?.();
    }

    /** Record that the native watcher is reporting the file's current state,
     *  and return that state's stamp. */
    note_reported(): FileStamp {
        const stamp = read_file_stamp(this.file_path);
        this.last_stamp = stamp;
        return stamp;
    }

    /** Called when a poll's sample differs from the last reported stamp. It
     *  re-stats rather than trusting the sample, which may predate a stamp the
     *  native watcher has recorded since. */
    private reconcile(): void {
        if (this.disposed) return;
        const stamp = read_file_stamp(this.file_path);
        const previous = this.last_stamp;
        if (stamp === previous) return;
        this.last_stamp = stamp;
        if (previous === ABSENT_FILE_STAMP) this.emit('create');
        else if (stamp === ABSENT_FILE_STAMP) this.emit('delete');
        else this.emit('change');
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.poll_timer !== undefined) {
            clearTimeout(this.poll_timer);
            this.poll_timer = undefined;
        }
    }
}
