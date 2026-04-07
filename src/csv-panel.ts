import * as path from 'path';
import * as vscode from 'vscode';
import { parse_csv, type CsvParseResult } from './parse-csv';
import { assert_safe_file_size } from './spreadsheet-safety';
import type { FileStateStore } from './state';
import type { WebviewMessage } from './types';
import { build_webview_html, generate_nonce } from './webview-html';
import { serialize_csv } from './serialize-csv';

export function open_csv_table(
    uri: vscode.Uri,
    extension_uri: vscode.Uri,
    state_store: FileStateStore,
    active_panels: Set<vscode.Disposable>
): void {
    const file_path = uri.fsPath;
    const basename = path.basename(file_path);

    const panel = vscode.window.createWebviewPanel(
        'tableViewer.csvTable',
        basename,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extension_uri, 'dist', 'webview'),
            ],
        }
    );

    const nonce = generate_nonce();
    panel.webview.html = build_webview_html(panel.webview, extension_uri, nonce);

    const disposables: vscode.Disposable[] = [];
    let consecutive_reload_failures = 0;
    let suppress_reload_until = 0;

    function get_delimiter(): ',' | '\t' {
        return file_path.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    }

    function get_max_file_size_mib(): number {
        return vscode.workspace.getConfiguration('tableViewer')
            .get<number>('maxFileSizeMiB', 16)!;
    }

    function get_csv_max_rows(): number {
        return vscode.workspace.getConfiguration('tableViewer')
            .get<number>('csvMaxRows', 10_000)!;
    }

    async function parse_file(): Promise<CsvParseResult> {
        const stat = await vscode.workspace.fs.stat(uri);
        assert_safe_file_size(stat.size, get_max_file_size_mib());
        const raw = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder('utf-8').decode(raw);
        return parse_csv(text, get_delimiter(), get_csv_max_rows());
    }

    let last_parsed: CsvParseResult | null = null;

    async function send_initial_data(): Promise<void> {
        try {
            const result = await parse_file();
            last_parsed = result;
            const state = state_store.get(file_path);
            const config = vscode.workspace.getConfiguration('tableViewer');
            const default_orientation = config.get<'horizontal' | 'vertical'>(
                'tabOrientation', 'horizontal'
            );

            panel.webview.postMessage({
                type: 'workbookData',
                data: result.data,
                state,
                defaultTabOrientation: default_orientation,
                truncationMessage: result.truncationMessage,
                csvEditable: !result.truncationMessage,
                csvEditingSupported: true,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }

    async function send_reload(): Promise<void> {
        if (Date.now() < suppress_reload_until) {
            return;
        }
        try {
            const result = await parse_file();
            last_parsed = result;
            const delivered = await panel.webview.postMessage({
                type: 'reload',
                data: result.data,
                truncationMessage: result.truncationMessage,
                csvEditable: !result.truncationMessage,
                csvEditingSupported: true,
            });
            if (!delivered) return;
            consecutive_reload_failures = 0;
        } catch (err) {
            const code = typeof err === 'object' && err !== null && 'code' in err
                && typeof err.code === 'string' ? err.code : null;
            if (code === 'EBUSY' || code === 'EPERM') return;

            consecutive_reload_failures++;
            if (consecutive_reload_failures >= 3) {
                const message = err instanceof Error ? err.message : String(err);
                console.error('Failed to reload CSV viewer data', err);
                vscode.window.showErrorMessage(`Failed to reload CSV: ${message}`);
            }
        }
    }

    disposables.push(
        panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
            switch (msg.type) {
                case 'ready':
                    send_initial_data();
                    break;
                case 'stateChanged': {
                    const existing = state_store.get(file_path) as import('./types').PerFileState;
                    const new_state = { ...msg.state };
                    if (existing.pendingEdits) {
                        new_state.pendingEdits = existing.pendingEdits;
                    }
                    state_store.set(file_path, new_state);
                    break;
                }
                case 'saveCsv': {
                    if (!last_parsed) return;
                    if (last_parsed.truncationMessage) {
                        panel.webview.postMessage({ type: 'saveResult', success: false });
                        return;
                    }
                    try {
                        const content = serialize_csv(
                            last_parsed.data.sheets[0].rows,
                            get_delimiter(),
                            msg.edits,
                            last_parsed.originalColumnCounts,
                            last_parsed.lineEnding
                        );
                        suppress_reload_until = Date.now() + 2000;
                        await vscode.workspace.fs.writeFile(
                            uri,
                            new TextEncoder().encode(content)
                        );
                        last_parsed = await parse_file();
                        panel.webview.postMessage({
                            type: 'reload',
                            data: last_parsed.data,
                            truncationMessage: last_parsed.truncationMessage,
                            csvEditable: !last_parsed.truncationMessage,
                            csvEditingSupported: true,
                        });
                        // Clear cached edits on successful save
                        const current = state_store.get(file_path) as import('./types').PerFileState;
                        const { pendingEdits: _, ...rest } = current;
                        state_store.set(file_path, rest);
                        panel.webview.postMessage({ type: 'saveResult', success: true });
                    } catch (err) {
                        suppress_reload_until = 0;
                        const message = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Failed to save: ${message}`);
                        panel.webview.postMessage({ type: 'saveResult', success: false });
                    }
                    break;
                }
                case 'pendingEditsChanged': {
                const current = state_store.get(file_path) as import('./types').PerFileState;
                if (msg.edits) {
                    state_store.set(file_path, { ...current, pendingEdits: msg.edits });
                } else {
                    const { pendingEdits: _, ...rest } = current;
                    state_store.set(file_path, rest);
                }
                break;
            }
            case 'showSaveDialog': {
                    const choice = await vscode.window.showWarningMessage(
                        'You have unsaved changes.',
                        { modal: true },
                        'Save',
                        'Discard'
                    );
                    panel.webview.postMessage({
                        type: 'saveDialogResult',
                        choice: choice === 'Save' ? 'save' : choice === 'Discard' ? 'discard' : 'cancel',
                    });
                    break;
                }
            }
        })
    );

    // File watcher
    const dir = path.dirname(file_path);
    const file_basename = path.basename(file_path);
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), file_basename)
    );
    disposables.push(watcher.onDidChange(() => send_reload()));
    disposables.push(watcher.onDidCreate(() => send_reload()));
    disposables.push(watcher);

    const panel_disposable: vscode.Disposable = {
        dispose() {
            for (const d of disposables) d.dispose();
        },
    };

    active_panels.add(panel_disposable);

    panel.onDidDispose(() => {
        panel_disposable.dispose();
        active_panels.delete(panel_disposable);
    });
}
