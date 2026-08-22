/**
 * Fake host ports for unit tests (see src/host-ports.ts).
 *
 * The fakes delegate to the state kept by the `vscode` mock module so existing
 * test knobs keep working unchanged: `__setStatImplementation` /
 * `__setReadFileImplementation` / `__setWriteFileImplementation` drive the
 * FileSystemPort, `__setConfigurationValue` + `__fireConfigurationChange`
 * drive the ConfigPort, and spies on `vscode_mock.window.show*Message`
 * observe the HostUiPort (including the modal save/discard dialog, which
 * mirrors the real showWarningMessage('Leave edit mode?',
 * { modal: true }, 'Save Edits', 'Discard Edits') call shape for assertions).
 */
import {
    file_size_limit_dialog_detail,
    type ConfigPort,
    type FileSizeLimitDialogChoice,
    type FileSystemPort,
    type GitLfsPort,
    type GitLfsResolveOutcome,
    type GitLfsSmudgeOutcome,
    type HostUiPort,
    type SaveDialogChoice,
    type ViewerHost,
} from '../../host-ports';
import type { ResourceUriLike } from '../../resource-identity';
import { vscode_file_refresh_watcher_factory } from '../../vscode-file-refresh-watcher';
import * as vscode_mock from './vscode';

type MockUri = Parameters<typeof vscode_mock.workspace.fs.stat>[0];

function as_mock_uri(resource: ResourceUriLike): MockUri {
    return resource as unknown as MockUri;
}

export const fake_file_system_port: FileSystemPort = {
    stat: (resource) => vscode_mock.workspace.fs.stat(as_mock_uri(resource)),
    read_file: (resource) => vscode_mock.workspace.fs.readFile(as_mock_uri(resource)),
    write_file: (resource, content) =>
        vscode_mock.workspace.fs.writeFile(as_mock_uri(resource), content),
};

export const fake_host_ui_port: HostUiPort = {
    show_warning(message) {
        void vscode_mock.window.showWarningMessage(message);
    },
    show_error(message) {
        void vscode_mock.window.showErrorMessage(message);
    },
    async show_save_discard_dialog(): Promise<SaveDialogChoice> {
        const choice = await vscode_mock.window.showWarningMessage(
            'Leave edit mode?',
            { modal: true },
            'Save Edits',
            'Discard Edits',
        );
        return choice === 'Save Edits'
            ? 'save'
            : choice === 'Discard Edits' ? 'discard' : 'cancel';
    },
    async show_file_size_limit_dialog(details): Promise<FileSizeLimitDialogChoice> {
        const choice = await vscode_mock.window.showWarningMessage(
            'This file exceeds the configured file-size threshold.',
            { modal: true, detail: file_size_limit_dialog_detail(details) },
            'Open Anyway',
            'Change Limit',
        );
        return choice === 'Open Anyway'
            ? 'openAnyway'
            : choice === 'Change Limit'
                ? 'configure'
                : 'cancel';
    },
    async open_setting(): Promise<void> {},
    open_external(url) {
        opened_external_urls.push(url);
    },
};

/** URLs handed to the fake `open_external`; tests read and reset this. */
export const opened_external_urls: string[] = [];

function config_value<T>(key: string, fallback: T): T {
    return vscode_mock.workspace.getConfiguration('tableViewer')
        .get(key, fallback) as T;
}

export const fake_config_port: ConfigPort = {
    font_family() {
        return config_value('fontFamily', '')?.trim() || null;
    },
    font_size() {
        const configured = config_value('fontSize', 0);
        return typeof configured === 'number' && configured > 0 ? configured : null;
    },
    max_file_size_mib: () => config_value('maxFileSizeMiB', 256),
    csv_max_rows: () => config_value('csvMaxRows', 1_000_000),
    default_tab_orientation: () =>
        config_value<'horizontal' | 'vertical'>('tabOrientation', 'horizontal'),
    diff_on_by_default: () => config_value('diffOnByDefault', false),
    on_font_change(listener: () => void) {
        return vscode_mock.workspace.onDidChangeConfiguration((event) => {
            if (
                !event.affectsConfiguration('tableViewer.fontFamily')
                && !event.affectsConfiguration('tableViewer.fontSize')
            ) return;
            listener();
        });
    },
};

/** One recorded call to the fake LFS port. */
export interface FakeGitLfsCall {
    readonly operation: 'pull' | 'smudge';
    readonly path: string;
    readonly oid?: string;
}

/**
 * A scriptable `GitLfsPort`. Tests push outcomes onto `pull_outcomes` /
 * `smudge_outcomes` (consumed in order, with the last one repeating) and read
 * `calls` to assert which operation the controller chose for which side — the
 * distinction that matters most, since `pull` and `smudge` are not
 * interchangeable.
 */
export const fake_git_lfs = {
    calls: [] as FakeGitLfsCall[],
    pull_outcomes: [] as GitLfsResolveOutcome[],
    smudge_outcomes: [] as GitLfsSmudgeOutcome[],
    /** Make the next call reject rather than resolve, so the controller's
     *  handling of a port that throws can be exercised. A real port is not
     *  supposed to, which is exactly why it is worth a test. */
    throw_on_next: undefined as Error | undefined,
    /** Resolve nothing until released, so a second click can be sent while the
     *  first is genuinely still in flight. */
    gate: undefined as { release: () => void; entered: Promise<void> } | undefined,
    open_gate(): void {
        let release = () => {};
        let mark_entered = () => {};
        const entered = new Promise<void>((r) => { mark_entered = () => r(); });
        const held = new Promise<void>((r) => { release = () => r(); });
        fake_git_lfs.gate = { release, entered };
        fake_git_lfs.held = held;
        fake_git_lfs.mark_entered = mark_entered;
    },
    held: undefined as Promise<void> | undefined,
    mark_entered: (() => {}) as () => void,
    reset(): void {
        fake_git_lfs.calls.length = 0;
        fake_git_lfs.pull_outcomes.length = 0;
        fake_git_lfs.smudge_outcomes.length = 0;
        fake_git_lfs.throw_on_next = undefined;
        fake_git_lfs.gate = undefined;
        fake_git_lfs.held = undefined;
        fake_git_lfs.mark_entered = () => {};
    },
    port: {
        async pull(resource): Promise<GitLfsResolveOutcome> {
            fake_git_lfs.calls.push({ operation: 'pull', path: resource.fsPath });
            const thrown = fake_git_lfs.throw_on_next;
            if (thrown) {
                fake_git_lfs.throw_on_next = undefined;
                throw thrown;
            }
            if (fake_git_lfs.held) {
                fake_git_lfs.mark_entered();
                await fake_git_lfs.held;
                fake_git_lfs.held = undefined;
            }
            return (
                fake_git_lfs.pull_outcomes.length > 1
                    ? fake_git_lfs.pull_outcomes.shift()!
                    : fake_git_lfs.pull_outcomes[0] ?? { type: 'resolved' }
            );
        },
        smudge(resource, pointer): Promise<GitLfsSmudgeOutcome> {
            fake_git_lfs.calls.push({
                operation: 'smudge',
                path: resource.fsPath,
                oid: pointer.oid,
            });
            return Promise.resolve(
                fake_git_lfs.smudge_outcomes.length > 1
                    ? fake_git_lfs.smudge_outcomes.shift()!
                    : fake_git_lfs.smudge_outcomes[0]
                        ?? { type: 'failed', reason: 'failed' },
            );
        },
    } satisfies GitLfsPort,
};

export const fake_viewer_host: ViewerHost = {
    fs: fake_file_system_port,
    ui: fake_host_ui_port,
    config: fake_config_port,
    // Resolves to the mock watcher via the vitest `vscode` alias, so
    // `__getWatchers()` / `__fireChange()` keep driving refreshes.
    refreshWatcherFactory: vscode_file_refresh_watcher_factory,
    gitLfs: fake_git_lfs.port,
};

/** A host that cannot resolve LFS objects, for the `resolvable: false` path. */
export const fake_viewer_host_without_lfs: ViewerHost = {
    fs: fake_file_system_port,
    ui: fake_host_ui_port,
    config: fake_config_port,
    refreshWatcherFactory: vscode_file_refresh_watcher_factory,
};
