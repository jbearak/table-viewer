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
    /** Viewer saves use the host's ordinary filesystem write after conflict checks. */
    write_file(resource: ResourceUriLike, content: Uint8Array): Promise<void>;
}

export type SaveDialogChoice = 'save' | 'discard' | 'cancel';
export type FileSizeLimitDialogChoice = 'openAnyway' | 'configure' | 'cancel';
export type ViewerSettingTarget = 'maxFileSizeMiB' | 'csvMaxRows';

export interface FileSizeLimitDialogDetails {
    readonly actualBytes: number;
    readonly limitBytes: number;
}

export function file_size_limit_dialog_detail(
    { actualBytes, limitBytes }: FileSizeLimitDialogDetails,
): string {
    const mib = (bytes: number) => String(Math.round(bytes / 1024 / 1024 * 10) / 10);
    return `The file is ${mib(actualBytes)} MiB. Table Viewer is configured to ask before opening files larger than ${mib(limitBytes)} MiB. Opening it may use significant memory or take some time, depending on your computer and the file.`;
}

/** User-facing notifications and modal decision dialogs. */
export interface HostUiPort {
    show_warning(message: string): void;
    show_error(message: string): void;
    /** Modal "You have unsaved changes." dialog with Save / Discard / cancel. */
    show_save_discard_dialog(): Promise<SaveDialogChoice>;
    show_file_size_limit_dialog(
        details: FileSizeLimitDialogDetails,
    ): Promise<FileSizeLimitDialogChoice>;
    /** Open the requested viewer preference, focused on that field. */
    open_setting(target: ViewerSettingTarget): Promise<void>;
    /**
     * Hand an already-validated http(s) URL to the OS opener. Callers must
     * validate with parse_http_external_url first — this port only launches.
     */
    open_external(url: string): void;
}

/** Viewer configuration reads (replaces direct viewer-config/vscode reads). */
export interface ConfigPort {
    font_family(): string | null;
    /** Font size in px, or null to inherit the host's editor font size. */
    font_size(): number | null;
    max_file_size_mib(): number;
    csv_max_rows(): number;
    default_tab_orientation(): 'horizontal' | 'vertical';
    /** Fires whenever the configured font (family or size) may have changed. */
    on_font_change(listener: () => void): Disposable;
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
