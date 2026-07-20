import * as vscode from 'vscode';
import {
    canonical_file_key,
    type FileRefreshWatchIdentity,
    type FileRefreshWatcher,
    type FileRefreshWatcherEventKind,
    type FileRefreshWatcherFactory,
} from './file-refresh-watcher';

function literal_glob_segment(segment: string): string {
    return segment.replace(/[?*[\]{}]/g, (character) => {
        if (character === '[') return '[[]';
        if (character === ']') return '[]]';
        return `[${character}]`;
    });
}

class VscodeFileRefreshWatcher implements FileRefreshWatcher {
    private readonly listeners = new Set<(kind: FileRefreshWatcherEventKind) => void>();
    private readonly disposables: vscode.Disposable[];
    private disposed = false;

    constructor(identity: FileRefreshWatchIdentity) {
        const pattern = new vscode.RelativePattern(
            vscode.Uri.file(identity.directory),
            identity.basename.includes('\\')
                ? '*'
                : literal_glob_segment(identity.basename),
        );
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const emit = (kind: FileRefreshWatcherEventKind, uri: vscode.Uri) => {
            if (canonical_file_key(uri.fsPath, identity.platform) !== identity.fileKey) return;
            for (const listener of [...this.listeners]) listener(kind);
        };
        this.disposables = [
            watcher.onDidChange((uri) => emit('change', uri)),
            watcher.onDidCreate((uri) => emit('create', uri)),
            watcher.onDidDelete((uri) => emit('delete', uri)),
            watcher,
        ];
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
        for (const disposable of this.disposables.splice(0)) disposable.dispose();
    }
}

export class VscodeFileRefreshWatcherFactory implements FileRefreshWatcherFactory {
    create(identity: FileRefreshWatchIdentity): FileRefreshWatcher {
        return new VscodeFileRefreshWatcher(identity);
    }
}

export const vscode_file_refresh_watcher_factory = new VscodeFileRefreshWatcherFactory();
