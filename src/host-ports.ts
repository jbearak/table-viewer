// Host-agnostic ports injected into the shared viewer controller. The VS Code
// extension provides vscode-backed implementations (vscode-host-ports.ts);
// other shells (e.g. a future desktop app) can provide their own without the
// shared code importing `vscode`.
import type { FileRefreshWatcherFactory } from './file-refresh-watcher';
import type { ResourceUriLike } from './resource-identity';

/** Minimal disposable, structurally compatible with vscode.Disposable. */
export interface Disposable {
    dispose(): void;
}

/** The two stat fields the controller compares (mtime in ms since epoch). */
export interface FileStat {
    readonly size: number;
    readonly mtime: number;
}

/** File I/O the controller needs (replaces direct `vscode.workspace.fs`). */
export interface FileSystemPort {
    stat(resource: ResourceUriLike): Promise<FileStat>;
    read_file(resource: ResourceUriLike): Promise<Uint8Array>;
    write_file(resource: ResourceUriLike, content: Uint8Array): Promise<void>;
}

export type SaveDialogChoice = 'save' | 'discard' | 'cancel';

/** User-facing notifications and the modal unsaved-changes dialog. */
export interface HostUiPort {
    show_warning(message: string): void;
    show_error(message: string): void;
    /** Modal "You have unsaved changes." dialog with Save / Discard / cancel. */
    show_save_discard_dialog(): Promise<SaveDialogChoice>;
}

/** Viewer configuration reads (replaces direct viewer-config/vscode reads). */
export interface ConfigPort {
    font_family(): string | null;
    max_file_size_mib(): number;
    csv_max_rows(): number;
    default_tab_orientation(): 'horizontal' | 'vertical';
    /** Fires whenever the configured font family may have changed. */
    on_font_family_change(listener: () => void): Disposable;
}

/** Everything host-specific the shared controller needs, injected at attach. */
export interface ViewerHost {
    readonly fs: FileSystemPort;
    readonly ui: HostUiPort;
    readonly config: ConfigPort;
    readonly refreshWatcherFactory: FileRefreshWatcherFactory;
}

/** ',' for .csv (and anything else), '\t' for .tsv — chosen by extension. */
export function get_delimiter(file_path: string): ',' | '\t' {
    return file_path.toLowerCase().endsWith('.tsv') ? '\t' : ',';
}
