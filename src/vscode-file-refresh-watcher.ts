import * as path from 'path';
import * as vscode from 'vscode';
import {
    type FileRefreshWatcher,
    type FileRefreshWatcherEventKind,
    type FileRefreshWatcherFactory,
} from './file-refresh-watcher';
import { FileStampPoll } from './file-stamp-poll';
import {
    resource_identity_matches,
    type ResourceIdentity,
} from './resource-identity';

function literal_glob_segment(segment: string): string {
    return segment.replace(/[?*[\]{}]/g, (character) => {
        if (character === '[') return '[[]';
        if (character === ']') return '[]]';
        return `[${character}]`;
    });
}

export interface VscodeFileRefreshWatcherOptions {
    /** How often a local file is stat'ed to catch changes VS Code missed. */
    poll_interval_ms?: number;
}

/**
 * `createFileSystemWatcher` for one resource, plus, for a local file, the same
 * `FileStampPoll` safety net the desktop watcher keeps. VS Code's watcher for
 * a simple pattern rests on the same OS notifications as Node's `fs.watch`
 * (FSEvents on macOS), so it loses events under load the same way; in an
 * extension host on a loaded Mac it missed about as many external writes as a
 * bare `fs.watch` did. Provider resources (virtual file systems) have no local
 * path to stat and rely on their provider's events alone.
 */
class VscodeFileRefreshWatcher implements FileRefreshWatcher {
    private readonly listeners = new Set<(kind: FileRefreshWatcherEventKind) => void>();
    private readonly disposables: vscode.Disposable[] = [];
    private disposed = false;

    constructor(identity: ResourceIdentity, options: VscodeFileRefreshWatcherOptions = {}) {
        const resource = identity.uri as vscode.Uri;
        const base = resource.with({
            path: path.posix.dirname(resource.path),
            fragment: '',
        });
        const pattern = new vscode.RelativePattern(
            base,
            identity.basename.includes('\\')
                ? '*'
                : literal_glob_segment(identity.basename),
        );
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.disposables.push(watcher);
        const notify = (kind: FileRefreshWatcherEventKind) => {
            if (this.disposed) return;
            for (const listener of [...this.listeners]) listener(kind);
        };
        let poll: FileStampPoll | undefined;
        const emit = (kind: FileRefreshWatcherEventKind, uri: vscode.Uri) => {
            if (!resource_identity_matches(identity, uri)) return;
            // Tell the poll this state is reported, so it does not report it
            // again. Every native event still goes through.
            poll?.note_reported();
            notify(kind);
        };
        try {
            if (identity.kind === 'file') {
                poll = new FileStampPoll(identity.filePath, notify, options.poll_interval_ms);
                const started = poll;
                this.disposables.push({ dispose: () => started.dispose() });
            }
            this.disposables.push(watcher.onDidChange((uri) => emit('change', uri)));
            this.disposables.push(watcher.onDidCreate((uri) => emit('create', uri)));
            this.disposables.push(watcher.onDidDelete((uri) => emit('delete', uri)));
        } catch (error) {
            this.dispose();
            throw error;
        }
    }

    on_event(listener: (kind: FileRefreshWatcherEventKind) => void): vscode.Disposable {
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
        for (const disposable of this.disposables.splice(0).reverse()) {
            try {
                disposable.dispose();
            } catch {
                // Best-effort teardown must not leak the remaining registrations.
            }
        }
    }
}

export class VscodeFileRefreshWatcherFactory implements FileRefreshWatcherFactory {
    constructor(private readonly options: VscodeFileRefreshWatcherOptions = {}) {}

    create(identity: ResourceIdentity): FileRefreshWatcher {
        return new VscodeFileRefreshWatcher(identity, this.options);
    }
}

export const vscode_file_refresh_watcher_factory = new VscodeFileRefreshWatcherFactory();
