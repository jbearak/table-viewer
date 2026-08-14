// VS Code–backed implementations of the host ports (host-ports.ts). This is
// the only module that bridges the shared viewer controller to the `vscode`
// API surface it used to call directly.
import * as vscode from 'vscode';
import {
    file_size_limit_dialog_detail,
    type ConfigPort,
    type FileSizeLimitDialogChoice,
    type FileSystemPort,
    type HostUiPort,
    type SaveDialogChoice,
    type ViewerHost,
} from './host-ports';
import type { ResourceUriLike } from './resource-identity';
import {
    get_csv_max_rows,
    get_default_orientation,
    get_font_family,
    get_font_size,
    get_max_file_size_mib,
} from './viewer-config';
import { vscode_file_refresh_watcher_factory } from './vscode-file-refresh-watcher';
import { build_webview_html } from './webview-html';

function to_vscode_uri(resource: ResourceUriLike): vscode.Uri {
    // attach_viewer passes through the exact uri object it was given, so in the
    // extension this is always already a vscode.Uri; the rebuild below only
    // runs for synthetic identities (string paths).
    if (typeof vscode.Uri === 'function' && resource instanceof vscode.Uri) {
        return resource;
    }
    return vscode.Uri.from({
        scheme: resource.scheme,
        authority: resource.authority,
        path: resource.path,
        query: resource.query,
        fragment: resource.fragment,
    });
}

export const vscode_file_system_port: FileSystemPort = {
    async stat(resource) {
        const stat = await vscode.workspace.fs.stat(to_vscode_uri(resource));
        return { size: stat.size, mtime: stat.mtime };
    },
    read_file(resource) {
        return Promise.resolve(vscode.workspace.fs.readFile(to_vscode_uri(resource)));
    },
    write_file(resource, content) {
        return Promise.resolve(vscode.workspace.fs.writeFile(
            to_vscode_uri(resource),
            content,
        ));
    },
};

export const vscode_host_ui_port: HostUiPort = {
    show_warning(message) {
        void vscode.window.showWarningMessage(message);
    },
    show_error(message) {
        void vscode.window.showErrorMessage(message);
    },
    async show_save_discard_dialog(): Promise<SaveDialogChoice> {
        const choice = await vscode.window.showWarningMessage(
            'You have unsaved changes.', { modal: true }, 'Save', 'Discard');
        return choice === 'Save' ? 'save' : choice === 'Discard' ? 'discard' : 'cancel';
    },
    async show_file_size_limit_dialog(details): Promise<FileSizeLimitDialogChoice> {
        const choice = await vscode.window.showWarningMessage(
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
    async open_setting(target): Promise<void> {
        await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            `@id:tableViewer.${target}`,
        );
    },
};

export const vscode_config_port: ConfigPort = {
    font_family: get_font_family,
    font_size: get_font_size,
    max_file_size_mib: get_max_file_size_mib,
    csv_max_rows: get_csv_max_rows,
    default_tab_orientation: get_default_orientation,
    on_font_change(listener) {
        return vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                !event.affectsConfiguration('tableViewer.fontFamily')
                && !event.affectsConfiguration('tableViewer.fontSize')
            ) return;
            listener();
        });
    },
};

export const vscode_viewer_host: ViewerHost = {
    fs: vscode_file_system_port,
    ui: vscode_host_ui_port,
    config: vscode_config_port,
    refreshWatcherFactory: vscode_file_refresh_watcher_factory,
};

/** Build the viewer HTML from a vscode webview + extension uri (asWebviewUri
 *  and cspSource are vscode-specific; the shared builder takes plain URLs). */
export function build_vscode_webview_html(
    webview: vscode.Webview,
    extension_uri: vscode.Uri,
    nonce: string,
    font_family: string | null = get_font_family(),
    font_size: number | null = get_font_size(),
): string {
    const asset_url = (file: string) => webview.asWebviewUri(
        vscode.Uri.joinPath(extension_uri, 'dist', 'webview', file),
    ).toString();
    return build_webview_html(
        {
            scriptUrl: asset_url('index.js'),
            styleUrl: asset_url('index.css'),
            cspSource: webview.cspSource,
        },
        nonce,
        font_family,
        font_size,
    );
}
