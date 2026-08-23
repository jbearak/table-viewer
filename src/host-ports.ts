// Host-agnostic ports injected into the shared viewer controller. The VS Code
// extension provides vscode-backed implementations (vscode-host-ports.ts);
// other shells (e.g. a future desktop app) can provide their own without the
// shared code importing `vscode`.
import type { FileRefreshWatcherFactory } from './file-refresh-watcher';
import type { GitLfsPointer } from './git-lfs-pointer';
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

/**
 * Why a Git LFS resolve did not produce the object. Distinguished rather than
 * collapsed into one failure because the remedies differ completely: a missing
 * `git-lfs` is fixed by installing it and a retry will never help, while a
 * network or authentication failure is worth pressing the button again.
 */
export type GitLfsFailureReason =
    /** No `git-lfs` on PATH, or it is too old to have the subcommand. */
    | 'lfsNotInstalled'
    /** The file is not inside a Git repository (so nothing can be fetched). */
    | 'notARepository'
    /**
     * git-lfs ran, reported success, and left the pointer in place. Real and
     * not rare: in a repository where `git lfs install` was never run,
     * `git lfs pull` prints "Skipping object checkout" and exits 0. Its own
     * reason because the remedy is specific and local — run `git lfs install`
     * in that repository — and retrying without it changes nothing.
     */
    | 'filtersNotConfigured'
    /**
     * git-lfs reached its remote and the object is not there. Verified against
     * git-lfs 3.7.1: `pull` exits 2 with `remote missing object <oid>`.
     *
     * Its own reason because it is the one failure that is neither the user's
     * setup nor transient — the bytes do not exist to be fetched, so clicking
     * again cannot ever work, and offering a retry is precisely the confusing
     * "button that does nothing" this feature exists to avoid.
     */
    | 'objectMissing'
    /**
     * The file's own name defeats `--include`. git-lfs splits that value on
     * commas before matching and no escape restores the literal, so a single
     * file whose name contains one cannot be named at all.
     *
     * Non-retryable for the same reason as `objectMissing`, arrived at from the
     * opposite direction: the object is presumably fine, but nothing about
     * clicking again changes the filename, so a retry is a button that cannot
     * work.
     */
    | 'pathNotExpressible'
    /** git-lfs ran and failed: no network, no credentials, object missing. */
    | 'failed';

/** A resolve attempt's result. `detail` is git-lfs's own message, already
 *  truncated and stripped of anything path-like by the port, for the banner. */
export type GitLfsResolveOutcome =
    | { readonly type: 'resolved' }
    | {
        readonly type: 'failed';
        readonly reason: GitLfsFailureReason;
        readonly detail?: string;
    };

/** A smudge additionally yields the object's bytes, since the side that needs
 *  smudging has no working-tree file to re-read them from. */
export type GitLfsSmudgeOutcome =
    | { readonly type: 'resolved'; readonly content: Uint8Array }
    | {
        readonly type: 'failed';
        readonly reason: GitLfsFailureReason;
        readonly detail?: string;
    };

/**
 * Fetching Git LFS objects the working tree does not have. Optional on
 * `ViewerHost`: a host without it still *detects* pointers and says so, it
 * just cannot offer the button.
 *
 * Two operations rather than one, because the two sides of a compare are
 * unresolved in different ways.
 *
 * `pull` is for a working-tree file that *is* a pointer. The fix is to
 * materialize the real bytes on disk, permanently, and let the viewer's
 * ordinary reload path pick them up — which is also why it returns no content.
 *
 * `smudge` is for a pointer with no working-tree file behind it: a `git:`
 * revision read returns the committed blob, and for an LFS-tracked file that
 * blob is the pointer no matter how many times it is re-read. Nothing on disk
 * is wrong and nothing on disk can be fixed, so the object is fetched into
 * memory for this comparison alone.
 */
export interface GitLfsPort {
    /** Materialize `resource`'s real bytes in the working tree. */
    pull(resource: ResourceUriLike): Promise<GitLfsResolveOutcome>;
    /**
     * The bytes `pointer` names, fetched without touching the working tree.
     * `resource` locates the repository (and supplies the path git-lfs needs
     * to pick the right filter configuration); it need not exist on disk.
     */
    smudge(
        resource: ResourceUriLike,
        pointer: GitLfsPointer,
    ): Promise<GitLfsSmudgeOutcome>;
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
    /** Modal "Leave edit mode?" dialog with Save Edits / Discard Edits / cancel. */
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
    diff_on_by_default(): boolean;
    /** Fires whenever the configured font (family or size) may have changed. */
    on_font_change(listener: () => void): Disposable;
}

/** Everything host-specific the shared controller needs, injected at attach. */
export interface ViewerHost {
    readonly fs: FileSystemPort;
    readonly ui: HostUiPort;
    readonly config: ConfigPort;
    readonly refreshWatcherFactory: FileRefreshWatcherFactory;
    /** Absent on hosts that cannot run git-lfs; pointers are then reported
     *  without a resolve action rather than not reported at all. */
    readonly gitLfs?: GitLfsPort;
}

/** ',' for .csv (and anything else), '\t' for .tsv — chosen by extension. */
export function get_delimiter(file_path: string): ',' | '\t' {
    return file_path.toLowerCase().endsWith('.tsv') ? '\t' : ',';
}
