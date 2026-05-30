import * as vscode from 'vscode';
import { register_table_viewer, TABLE_VIEW_TYPE } from './custom-editor';
import { show_csv_preview, dispose_csv_preview } from './csv-preview';
import { create_file_state_store, DEFAULT_MAX_STORED_FILES } from './state';

function active_custom_tab_uri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
    const get_max_stored = () =>
        Math.max(1, vscode.workspace.getConfiguration('tableViewer')
            .get<number>('maxStoredFiles', DEFAULT_MAX_STORED_FILES)!);

    const state_store = create_file_state_store(context, get_max_stored);
    register_table_viewer(context, state_store);

    context.subscriptions.push(
        vscode.commands.registerCommand('tableViewer.showCsvPreviewToSide', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            show_csv_preview(target, context.extensionUri, state_store, vscode.ViewColumn.Beside);
        }),
        vscode.commands.registerCommand('tableViewer.showCsvPreview', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            show_csv_preview(target, context.extensionUri, state_store, vscode.ViewColumn.Active);
        }),
        vscode.commands.registerCommand('tableViewer.openCsvTable', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            vscode.commands.executeCommand('vscode.openWith', target, TABLE_VIEW_TYPE);
        }),
        vscode.commands.registerCommand('tableViewer.openAsText', (uri?: vscode.Uri) => {
            const target = uri ?? active_custom_tab_uri();
            if (!target) return;
            vscode.commands.executeCommand('vscode.openWith', target, 'default');
        }),
    );

    context.subscriptions.push({ dispose() { dispose_csv_preview(); } });
}

export function deactivate(): void {}
