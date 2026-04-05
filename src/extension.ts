import * as vscode from 'vscode';
import { register_table_viewer } from './custom-editor';
import { create_file_state_store } from './state';

export function activate(context: vscode.ExtensionContext): void {
    const state_store = create_file_state_store(context);
    register_table_viewer(context, state_store);
}

export function deactivate(): void {}
