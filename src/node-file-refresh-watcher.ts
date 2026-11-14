import * as fs from 'fs';
import * as path from 'path';
import {
    type FileRefreshWatcher,
    type FileRefreshWatcherEventKind,
    type FileRefreshWatcherFactory,
} from './file-refresh-watcher';
import { canonical_file_key, type ResourceIdentity } from './resource-identity';

const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface NodeFileRefreshWatcherOptions {
    /** How often the target is stat'ed to catch changes `fs.watch` missed. */
    poll_interval_ms?: number;
    /** Watch by polling alone, without `fs.watch` (mainly for tests). */
    force_polling?: boolean;
}

/** One stat of the target, reduced to what changes when its bytes do, or
 *  `ABSENT`. Nanosecond times so two writes in one millisecond still differ. */
type FileStamp = string;
const ABSENT: FileStamp = 'absent';

/**
 * Node `fs.watch`-based implementation of `FileRefreshWatcher`, mirroring
 * `vscode-file-refresh-watcher.ts`: it watches the containing directory and
 * filters events to the exact target file via `canonical_file_key`, so case
 * differences reported by case-insensitive file systems still match.
 *
 * `fs.watch` alone is not enough. On macOS it rides on FSEvents, which can
 * report a change seconds late or never. Under load the kernel drops events,
 * and libuv skips the notice that it did. A missed event would leave the view
 * on stale data for good, so an `fs.watchFile` stat poll runs alongside it.
 * Both sides compare the target's stamp with the last one either of them
 * reported. A change the native watcher caught is not reported a second time,
 * and any change after the last report always is, even the rest of a write the
 * native watcher reported only partway through.
 *
 * When directory watching is unavailable (missing directory, platform limits),
 * the poll is the only signal.
 */
class NodeFileRefreshWatcher implements FileRefreshWatcher {
    private readonly listeners = new Set<(kind: FileRefreshWatcherEventKind) => void>();
    private readonly identity: ResourceIdentity;
    private readonly target_key: string;
    private readonly poll_interval_ms: number;
    private fs_watcher: fs.FSWatcher | undefined;
    private poll_listener: (() => void) | undefined;
    private last_stamp: FileStamp;
    private disposed = false;

    constructor(identity: ResourceIdentity, options: NodeFileRefreshWatcherOptions = {}) {
        if (identity.kind !== 'file') {
            throw new Error('Node file refresh watcher only supports file resources.');
        }
        this.identity = identity;
        this.target_key = canonical_file_key(identity.filePath, identity.platform);
        this.poll_interval_ms = options.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
        this.last_stamp = this.stamp();
        this.start_polling();
        if (options.force_polling) return;
        try {
            this.fs_watcher = fs.watch(identity.directory, (event_type, filename) => {
                this.handle_directory_event(event_type, filename);
            });
            this.fs_watcher.on('error', () => this.close_native_watcher());
        } catch {
            // The poll already running is the fallback.
        }
    }

    private stamp(): FileStamp {
        try {
            const stat = fs.statSync(this.identity.filePath, { bigint: true });
            return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch {
            return ABSENT;
        }
    }

    private matches(filename: string | Buffer | null): boolean {
        if (filename === null || filename === undefined) return true;
        const name = typeof filename === 'string' ? filename : filename.toString();
        return canonical_file_key(
            path.join(this.identity.directory, name),
            this.identity.platform,
        ) === this.target_key;
    }

    private handle_directory_event(
        event_type: string,
        filename: string | Buffer | null,
    ): void {
        if (this.disposed || !this.matches(filename)) return;
        // Every native event is reported, even one whose stamp matches: the
        // stamp only tells the poll what has already been reported.
        const stamp = this.stamp();
        this.last_stamp = stamp;
        if (event_type === 'change') {
            this.emit('change');
            return;
        }
        // 'rename' covers creation, deletion, and replacement; disambiguate
        // by current existence like the poll does.
        this.emit(stamp === ABSENT ? 'delete' : 'create');
    }

    private close_native_watcher(): void {
        if (this.disposed) return;
        try {
            this.fs_watcher?.close();
        } catch {
            // Best-effort: the poll keeps watching either way.
        }
        this.fs_watcher = undefined;
    }

    /** Called by `fs.watchFile` whenever two of its samples differ. It
     *  re-stats rather than trusting the sample, which may predate a stamp the
     *  native watcher has recorded since. */
    private reconcile(): void {
        if (this.disposed) return;
        const stamp = this.stamp();
        const previous = this.last_stamp;
        if (stamp === previous) return;
        this.last_stamp = stamp;
        if (previous === ABSENT) this.emit('create');
        else if (stamp === ABSENT) this.emit('delete');
        else this.emit('change');
    }

    private start_polling(): void {
        if (this.disposed || this.poll_listener) return;
        this.poll_listener = () => this.reconcile();
        fs.watchFile(
            this.identity.filePath,
            { interval: this.poll_interval_ms },
            this.poll_listener,
        );
    }

    private emit(kind: FileRefreshWatcherEventKind): void {
        for (const listener of [...this.listeners]) listener(kind);
    }

    on_event(listener: (kind: FileRefreshWatcherEventKind) => void): { dispose(): void } {
        if (this.disposed) return { dispose() {} };
        this.listeners.add(listener);
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                this.listeners.delete(listener);
            },
        };
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.listeners.clear();
        if (this.fs_watcher) {
            try {
                this.fs_watcher.close();
            } catch {
                // Best-effort teardown.
            }
            this.fs_watcher = undefined;
        }
        if (this.poll_listener) {
            fs.unwatchFile(this.identity.filePath, this.poll_listener);
            this.poll_listener = undefined;
        }
    }
}

export class NodeFileRefreshWatcherFactory implements FileRefreshWatcherFactory {
    constructor(private readonly options: NodeFileRefreshWatcherOptions = {}) {}

    create(identity: ResourceIdentity): FileRefreshWatcher {
        return new NodeFileRefreshWatcher(identity, this.options);
    }
}

export const node_file_refresh_watcher_factory = new NodeFileRefreshWatcherFactory();
