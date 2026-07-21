import * as path from 'path';
import * as vscode from 'vscode';
import {
    type FileRefreshWatcher,
    type FileRefreshWatcherEventKind,
    type FileRefreshWatcherFactory,
} from './file-refresh-watcher';
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

class VscodeFileRefreshWatcher implements FileRefreshWatcher {
    private readonly listeners = new Set<(kind: FileRefreshWatcherEventKind) => void>();
    private readonly disposables: vscode.Disposable[] = [];
    private disposed = false;

    constructor(identity: ResourceIdentity) {
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
        const emit = (kind: FileRefreshWatcherEventKind, uri: vscode.Uri) => {
            if (!resource_identity_matches(identity, uri)) return;
            for (const listener of [...this.listeners]) listener(kind);
        };
        try {
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
    create(identity: ResourceIdentity): FileRefreshWatcher {
        return new VscodeFileRefreshWatcher(identity);
    }
}

export const vscode_file_refresh_watcher_factory = new VscodeFileRefreshWatcherFactory();
