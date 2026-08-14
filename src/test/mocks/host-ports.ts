/**
 * Fake host ports for unit tests (see src/host-ports.ts).
 *
 * The fakes delegate to the state kept by the `vscode` mock module so existing
 * test knobs keep working unchanged: `__setStatImplementation` /
 * `__setReadFileImplementation` / `__setWriteFileImplementation` drive the
 * FileSystemPort, `__setConfigurationValue` + `__fireConfigurationChange`
 * drive the ConfigPort, and spies on `vscode_mock.window.show*Message`
 * observe the HostUiPort (including the modal save/discard dialog, which
 * preserves the historical showWarningMessage('You have unsaved changes.',
 * { modal: true }, 'Save', 'Discard') call shape for assertions).
 */
import {
    file_size_limit_dialog_detail,
    type ConfigPort,
    type FileSizeLimitDialogChoice,
    type FileSystemPort,
    type HostUiPort,
    type SaveDialogChoice,
    type ViewerHost,
} from '../../host-ports';
import type { ResourceUriLike } from '../../resource-identity';
import { vscode_file_refresh_watcher_factory } from '../../vscode-file-refresh-watcher';
import { vscode_host_ui_port } from '../../vscode-host-ports';
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
            'You have unsaved changes.', { modal: true }, 'Save', 'Discard');
        return choice === 'Save' ? 'save' : choice === 'Discard' ? 'discard' : 'cancel';
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
    open_setting: (target) => vscode_host_ui_port.open_setting(target),
};

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

export const fake_viewer_host: ViewerHost = {
    fs: fake_file_system_port,
    ui: fake_host_ui_port,
    config: fake_config_port,
    // Resolves to the mock watcher via the vitest `vscode` alias, so
    // `__getWatchers()` / `__fireChange()` keep driving refreshes.
    refreshWatcherFactory: vscode_file_refresh_watcher_factory,
};
