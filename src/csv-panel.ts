import * as path from 'path';
import * as vscode from 'vscode';
import { CsvDataSource } from './data-source/csv-source';
import type { RenderedCell } from './data-source/interface';
import { ViewerPanelCore, adopt_source_into_core } from './panel-core';
import { get_csv_max_rows, get_default_orientation, get_delimiter, get_max_file_size_mib } from './viewer-config';
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
    let reload_seq = 0;
    let disposed = false;
    let initial_meta_sent = false;
    let ready_seen = false;
    // mtime of the file as of the last successful parse, for the save conflict check.
    let last_mtime = 0;

    async function build_source(): Promise<{ source: CsvDataSource; mtime: number }> {
        const stat = await vscode.workspace.fs.stat(uri);
        assert_safe_file_size(stat.size, get_max_file_size_mib());
        const raw = await vscode.workspace.fs.readFile(uri);
        // User config caps the row count, but MAX_CSV_ROWS is the hard ceiling.
        const max_rows = Math.min(get_csv_max_rows(), MAX_CSV_ROWS);
        const ds = await CsvDataSource.create(raw, get_delimiter(file_path), max_rows);
        return { source: ds, mtime: stat.mtime };
    }

    function adopt_source(ds: CsvDataSource, mtime: number): void {
        core = adopt_source_into_core(core, panel, source, ds);
        source = ds;
        last_mtime = mtime;
    }

    async function send_initial_data(): Promise<void> {
        const seq = ++reload_seq;
        try {
            const { source: ds, mtime } = await build_source();
            // A watcher reload that started after this initial load supersedes it.
            if (disposed || seq !== reload_seq) {
                ds.close();
                return;
            }
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
            initial_meta_sent = true;
        } catch (err) {
            if (disposed) return;
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
        if (disposed) return;
        if (Date.now() < suppress_reload_until) {
            return;
        }
        const seq = ++reload_seq;
        try {
            const { source: ds, mtime } = await build_source();
            // A newer reload superseded us while parsing: discard this result so
            // stale data cannot roll back the source or last_mtime.
            if (disposed || seq !== reload_seq) {
                ds.close();
                return;
            }
            adopt_source(ds, mtime);
            if (!initial_meta_sent) {
                const state = state_store.get(file_path);
                await core!.send_meta({
                    state,
                    defaultTabOrientation: get_default_orientation(),
                    csvEditable: !ds.truncationMessage,
                    csvEditingSupported: true,
                });
                if (ready_seen) initial_meta_sent = true;
                consecutive_reload_failures = 0;
                return;
            }
            const delivered = await post_reload(ds);
            if (!delivered) return;
            consecutive_reload_failures = 0;
        } catch (err) {
            if (disposed) return;
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
            if (disposed) return;
            switch (msg.type) {
                case 'ready':
                    ready_seen = true;
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
                        // Stream the sheet to the serializer in fixed-size row
                        // windows so the full (RenderedCell | null)[][] for the
                        // whole file never exists at once: each window's cell
                        // objects become GC-eligible after it is serialized. The
                        // generator yields rows in absolute order from row 0 to
                        // rowCount-1 exactly once (read_rows clamps the final
                        // window to rowCount), so output is byte-identical to
                        // serializing one materialized array.
                        const SAVE_WINDOW = 10_000;
                        const src = source;
                        const row_count = src.meta().sheets[0].rowCount;
                        function* row_windows(): Generator<(RenderedCell | null)[]> {
                            for (let start = 0; start < row_count; start += SAVE_WINDOW) {
                                const { rows } = src.read_rows(0, start, SAVE_WINDOW);
                                for (const row of rows) yield row;
                            }
                        }
                        const content = serialize_csv(
                            row_windows(),
                            get_delimiter(file_path),
                            msg.edits,
                            src.originalColumnCounts,
                            src.lineEnding
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
    disposables.push(watcher.onDidChange(() => {
        if (disposed) return;
        return send_reload();
    }));
    disposables.push(watcher.onDidCreate(() => {
        if (disposed) return;
        return send_reload();
    }));
    disposables.push(watcher);

    const panel_disposable: vscode.Disposable = {
        dispose() {
            disposed = true;
            reload_seq++;
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
