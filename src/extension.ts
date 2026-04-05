import * as vscode from 'vscode';
import { register_table_viewer } from './custom-editor';
import { create_file_state_store, DEFAULT_MAX_STORED_FILES } from './state';

export function activate(context: vscode.ExtensionContext): void {
    const get_max_stored = () =>
        Math.max(1, vscode.workspace.getConfiguration('tableViewer')
            .get<number>('maxStoredFiles', DEFAULT_MAX_STORED_FILES)!);

    const state_store = create_file_state_store(context, get_max_stored);
    register_table_viewer(context, state_store);
}

export function deactivate(): void {}
