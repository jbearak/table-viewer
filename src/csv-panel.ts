import * as path from 'path';
import * as vscode from 'vscode';
import { CsvDataSource } from './data-source/csv-source';
import { ViewerPanelCore } from './panel-core';
import { assert_safe_file_size, MAX_CSV_ROWS } from './spreadsheet-safety';
import { serialize_csv } from './serialize-csv';
import type { FileStateStore } from './state';
import type { PerFileState, WebviewMessage } from './types';
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
    let suppress_reload_until = 0;

    // Protocol engine (paginated sheetMeta/rowData), created on first successful
    // parse. The Glide webview consumes the paginated protocol exclusively.
    let core: ViewerPanelCore | undefined;
    let source: CsvDataSource | undefined;
    // mtime of the file as of the last successful parse, for the save conflict check.
    let last_mtime = 0;

    function get_delimiter(): ',' | '\t' {
        return file_path.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    }

    function get_max_file_size_mib(): number {
        return vscode.workspace.getConfiguration('tableViewer')
            .get<number>('maxFileSizeMiB', 256)!;
    }

    function get_csv_max_rows(): number {
        return vscode.workspace.getConfiguration('tableViewer')
            .get<number>('csvMaxRows', 1_000_000)!;
    }

    function get_default_orientation(): 'horizontal' | 'vertical' {
        return vscode.workspace.getConfiguration('tableViewer')
            .get<'horizontal' | 'vertical'>('tabOrientation', 'horizontal');
    }

    async function build_source(): Promise<{ source: CsvDataSource; mtime: number }> {
        const stat = await vscode.workspace.fs.stat(uri);
        assert_safe_file_size(stat.size, get_max_file_size_mib());
        const raw = await vscode.workspace.fs.readFile(uri);
        // User config caps the row count, but MAX_CSV_ROWS is the hard ceiling.
        const max_rows = Math.min(get_csv_max_rows(), MAX_CSV_ROWS);
        const ds = await CsvDataSource.create(raw, get_delimiter(), max_rows);
        return { source: ds, mtime: stat.mtime };
    }

    function adopt_source(ds: CsvDataSource, mtime: number): void {
        if (source && source !== ds) {
            source.close();
        }
        source = ds;
        last_mtime = mtime;
        if (core) {
            core.set_source(ds);
        } else {
            core = new ViewerPanelCore(panel, ds);
        }
    }

    async function send_initial_data(): Promise<void> {
        try {
            const { source: ds, mtime } = await build_source();
            adopt_source(ds, mtime);
            const state = state_store.get(file_path);
            const default_orientation = get_default_orientation();

            // Paginated protocol.
            await core!.send_meta({
                state,
                defaultTabOrientation: default_orientation,
                csvEditable: !ds.truncationMessage,
                csvEditingSupported: true,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }

    async function post_reload(ds: CsvDataSource): Promise<boolean> {
        // Paginated protocol: bump generation + clear cache + post metaReload.
        // The returned flag is false when the panel is hidden/disposed.
        return core!.send_meta_reload({
            csvEditable: !ds.truncationMessage,
            csvEditingSupported: true,
        });
    }

    async function send_reload(): Promise<void> {
        if (Date.now() < suppress_reload_until) {
            return;
        }
        try {
            const { source: ds, mtime } = await build_source();
            adopt_source(ds, mtime);
            const delivered = await post_reload(ds);
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
                    await send_initial_data();
                    break;
                case 'stateChanged': {
                    const existing = state_store.get(file_path) as PerFileState;
                    const new_state = { ...msg.state };
                    if (existing.pendingEdits) {
                        new_state.pendingEdits = existing.pendingEdits;
                    }
                    state_store.set(file_path, new_state);
                    break;
                }
                case 'saveCsv': {
                    if (!source) return;
                    if (source.truncationMessage) {
                        panel.webview.postMessage({ type: 'saveResult', success: false });
                        return;
                    }
                    try {
                        // Verify file hasn't changed since we last parsed it
                        const current_stat = await vscode.workspace.fs.stat(uri);
                        if (current_stat.mtime !== last_mtime) {
                            vscode.window.showWarningMessage(
                                'File was modified externally. Please review the changes and try again.'
                            );
                            // The external modification that tripped the mtime check
                            // also fires the watcher's onDidChange. Suppress it so we
                            // don't redundantly re-parse + metaReload the same file
                            // twice (mirrors the success branch).
                            suppress_reload_until = Date.now() + 2000;
                            const { source: ds, mtime } = await build_source();
                            adopt_source(ds, mtime);
                            await post_reload(ds);
                            panel.webview.postMessage({ type: 'saveResult', success: false });
                            return;
                        }
                        const content = serialize_csv(
                            source.read_all_rows(0),
                            get_delimiter(),
                            msg.edits,
                            source.originalColumnCounts,
                            source.lineEnding
                        );
                        suppress_reload_until = Date.now() + 2000;
                        await vscode.workspace.fs.writeFile(
                            uri,
                            new TextEncoder().encode(content)
                        );
                        const { source: ds, mtime } = await build_source();
                        adopt_source(ds, mtime);
                        await post_reload(ds);
                        // Clear cached edits on successful save
                        const current = state_store.get(file_path) as PerFileState;
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
                    const current = state_store.get(file_path) as PerFileState;
                    if (msg.edits) {
                        state_store.set(file_path, { ...current, pendingEdits: msg.edits });
                    } else {
                        const { pendingEdits: _, ...rest } = current;
                        state_store.set(file_path, rest);
                    }
                    break;
                }
                case 'showWarning': {
                    vscode.window.showWarningMessage(msg.message);
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
                default:
                    // requestRows (paginated protocol) -> core answers with rowData.
                    await core?.handle_message(msg);
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
            source?.close();
            for (const d of disposables) d.dispose();
        },
    };

    active_panels.add(panel_disposable);

    panel.onDidDispose(() => {
        panel_disposable.dispose();
        active_panels.delete(panel_disposable);
    });
}
