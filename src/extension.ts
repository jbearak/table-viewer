import * as vscode from 'vscode';
import { register_table_viewer } from './custom-editor';
import { open_csv_table } from './csv-panel';
import { show_csv_preview, dispose_csv_preview } from './csv-preview';
import { create_file_state_store, DEFAULT_MAX_STORED_FILES } from './state';

export function activate(context: vscode.ExtensionContext): void {
    const get_max_stored = () =>
        Math.max(1, vscode.workspace.getConfiguration('tableViewer')
            .get<number>('maxStoredFiles', DEFAULT_MAX_STORED_FILES)!);

    const state_store = create_file_state_store(context, get_max_stored);
    register_table_viewer(context, state_store);

    const active_panels = new Set<vscode.Disposable>();

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'tableViewer.showCsvPreviewToSide',
            (uri?: vscode.Uri) => {
                const target_uri = uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target_uri) return;
                show_csv_preview(
                    target_uri,
                    context.extensionUri,
                    state_store,
                    vscode.ViewColumn.Beside
                );
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'tableViewer.showCsvPreview',
            (uri?: vscode.Uri) => {
                const target_uri = uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target_uri) return;
                show_csv_preview(
                    target_uri,
                    context.extensionUri,
                    state_store,
                    vscode.ViewColumn.Active
                );
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'tableViewer.openCsvTable',
            (uri?: vscode.Uri) => {
                const target_uri = uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target_uri) return;
                open_csv_table(
                    target_uri,
                    context.extensionUri,
                    state_store,
                    active_panels
                );
            }
        )
    );

    context.subscriptions.push({
        dispose() {
            dispose_csv_preview();
            for (const p of active_panels) p.dispose();
            active_panels.clear();
        },
    });
}

export function deactivate(): void {}
