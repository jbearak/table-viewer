import * as path from 'path';
import * as vscode from 'vscode';
import { parse_csv, type CsvParseResult } from './parse-csv';
import { assert_safe_file_size } from './spreadsheet-safety';
import type { FileStateStore } from './state';
import type { WebviewMessage } from './types';
import { build_webview_html, generate_nonce } from './webview-html';

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

    async function send_initial_data(): Promise<void> {
        try {
            const result = await parse_file();
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
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }

    async function send_reload(): Promise<void> {
        try {
            const result = await parse_file();
            const delivered = await panel.webview.postMessage({
                type: 'reload',
                data: result.data,
                truncationMessage: result.truncationMessage,
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
        panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            switch (msg.type) {
                case 'ready':
                    send_initial_data();
                    break;
                case 'stateChanged':
                    state_store.set(file_path, msg.state);
                    break;
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
