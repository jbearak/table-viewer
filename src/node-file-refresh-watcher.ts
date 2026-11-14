import * as fs from 'fs';
import * as path from 'path';
import {
    type FileRefreshWatcher,
    type FileRefreshWatcherEventKind,
    type FileRefreshWatcherFactory,
} from './file-refresh-watcher';
import { ABSENT_FILE_STAMP, FileStampPoll } from './file-stamp-poll';
import { canonical_file_key, type ResourceIdentity } from './resource-identity';

export interface NodeFileRefreshWatcherOptions {
    /** How often the target is stat'ed to catch changes `fs.watch` missed. */
    poll_interval_ms?: number;
    /** Watch by polling alone, without `fs.watch` (mainly for tests). */
    force_polling?: boolean;
}

/**
 * Node `fs.watch`-based implementation of `FileRefreshWatcher`, mirroring
 * `vscode-file-refresh-watcher.ts`: it watches the containing directory and
 * filters events to the exact target file via `canonical_file_key`, so case
 * differences reported by case-insensitive file systems still match.
 *
 * `fs.watch` alone is not enough. On macOS it rides on FSEvents, which can
 * report a change seconds late or never; under load the kernel drops events,
 * and libuv skips the notice that it did. A `FileStampPoll` runs alongside it
 * and reports any change `fs.watch` did not. When directory watching is
 * unavailable (missing directory, platform limits), the poll is the only
 * signal.
 */
class NodeFileRefreshWatcher implements FileRefreshWatcher {
    private readonly listeners = new Set<(kind: FileRefreshWatcherEventKind) => void>();
    private readonly identity: ResourceIdentity;
    private readonly target_key: string;
    private readonly poll: FileStampPoll;
    private fs_watcher: fs.FSWatcher | undefined;
    private disposed = false;

    constructor(identity: ResourceIdentity, options: NodeFileRefreshWatcherOptions = {}) {
        if (identity.kind !== 'file') {
            throw new Error('Node file refresh watcher only supports file resources.');
        }
        this.identity = identity;
        this.target_key = canonical_file_key(identity.filePath, identity.platform);
        this.poll = new FileStampPoll(
            identity.filePath,
            (kind) => this.emit(kind),
            options.poll_interval_ms,
        );
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
        const stamp = this.poll.note_reported();
        if (event_type === 'change') {
            this.emit('change');
            return;
        }
        // 'rename' covers creation, deletion, and replacement; disambiguate
        // by current existence like the poll does.
        this.emit(stamp === ABSENT_FILE_STAMP ? 'delete' : 'create');
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

    private emit(kind: FileRefreshWatcherEventKind): void {
        if (this.disposed) return;
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
        this.poll.dispose();
    }
}

export class NodeFileRefreshWatcherFactory implements FileRefreshWatcherFactory {
    constructor(private readonly options: NodeFileRefreshWatcherOptions = {}) {}

    create(identity: ResourceIdentity): FileRefreshWatcher {
        return new NodeFileRefreshWatcher(identity, this.options);
    }
}

export const node_file_refresh_watcher_factory = new NodeFileRefreshWatcherFactory();
