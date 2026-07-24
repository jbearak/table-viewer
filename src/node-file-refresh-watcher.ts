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
    /** Polling interval used by the `fs.watchFile` fallback. */
    poll_interval_ms?: number;
    /** Force the polling fallback instead of `fs.watch` (mainly for tests). */
    force_polling?: boolean;
}

/**
 * Node `fs.watch`-based implementation of `FileRefreshWatcher`, mirroring
 * `vscode-file-refresh-watcher.ts`: it watches the containing directory and
 * filters events to the exact target file via `canonical_file_key`, so case
 * differences reported by case-insensitive file systems still match.
 *
 * When directory watching is unavailable (missing directory, platform limits),
 * it degrades to `fs.watchFile` polling on the target path.
 */
class NodeFileRefreshWatcher implements FileRefreshWatcher {
    private readonly listeners = new Set<(kind: FileRefreshWatcherEventKind) => void>();
    private readonly identity: ResourceIdentity;
    private readonly target_key: string;
    private readonly poll_interval_ms: number;
    private fs_watcher: fs.FSWatcher | undefined;
    private poll_listener: ((curr: fs.Stats, prev: fs.Stats) => void) | undefined;
    private last_exists = false;
    private disposed = false;

    constructor(identity: ResourceIdentity, options: NodeFileRefreshWatcherOptions = {}) {
        if (identity.kind !== 'file') {
            throw new Error('Node file refresh watcher only supports file resources.');
        }
        this.identity = identity;
        this.target_key = canonical_file_key(identity.filePath, identity.platform);
        this.poll_interval_ms = options.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
        if (options.force_polling) {
            this.start_polling();
            return;
        }
        try {
            this.fs_watcher = fs.watch(identity.directory, (event_type, filename) => {
                this.handle_directory_event(event_type, filename);
            });
            this.fs_watcher.on('error', () => this.fall_back_to_polling());
        } catch {
            this.start_polling();
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
        if (event_type === 'change') {
            this.emit('change');
            return;
        }
        // 'rename' covers creation, deletion, and replacement; disambiguate
        // by current existence like the polling fallback does.
        this.emit(fs.existsSync(this.identity.filePath) ? 'create' : 'delete');
    }

    private fall_back_to_polling(): void {
        if (this.disposed) return;
        try {
            this.fs_watcher?.close();
        } catch {
            // Best-effort: never let a broken native watcher block fallback.
        }
        this.fs_watcher = undefined;
        this.start_polling();
    }

    private start_polling(): void {
        if (this.disposed || this.poll_listener) return;
        this.last_exists = fs.existsSync(this.identity.filePath);
        this.poll_listener = () => {
            if (this.disposed) return;
            const exists = fs.existsSync(this.identity.filePath);
            const existed = this.last_exists;
            this.last_exists = exists;
            if (exists && !existed) this.emit('create');
            else if (!exists && existed) this.emit('delete');
            else if (exists) this.emit('change');
        };
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
