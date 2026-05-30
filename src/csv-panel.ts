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

    // The first structural send (paginated protocol). Shared by the initial
    // `ready` load and the first watcher reload that wins before `ready`.
    function send_first_meta(ds: CsvDataSource): Promise<void> {
        return core!.send_meta({
            state: state_store.get(file_path),
            defaultTabOrientation: get_default_orientation(),
            csvEditable: !ds.truncationMessage,
            csvEditingSupported: true,
        });
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
            await send_first_meta(ds);
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

    // Re-parse the on-disk file and adopt it through the same monotonic guard
    // send_reload uses: bumping reload_seq invalidates any watcher reload already
    // in flight (its older parse can't roll back this result) and lets a newer
    // reload supersede us. Used by both saveCsv branches after they write or
    // detect an external change; adopting here (last_mtime = the new mtime) makes
    // send_reload's mtime dedup skip the watcher event the write itself fires.
    async function reparse_and_post(): Promise<void> {
        const seq = ++reload_seq;
        const { source: ds, mtime } = await build_source();
        if (!disposed && seq === reload_seq) {
            adopt_source(ds, mtime);
            await post_reload(ds);
        } else {
            ds.close();
        }
    }

    async function send_reload(): Promise<void> {
        if (disposed) return;
        const seq = ++reload_seq;
        try {
            const { source: ds, mtime } = await build_source();
            // A newer reload superseded us while parsing: discard this result so
            // stale data cannot roll back the source or last_mtime.
            if (disposed || seq !== reload_seq) {
                ds.close();
                return;
            }
            // Nothing changed since our last parse (our own save's write fires
            // the watcher, or a spurious event): skip the redundant re-parse +
            // metaReload. mtime-based, so a genuine external edit — which always
            // bumps the mtime — still goes through. This replaces the old wall-
            // clock suppress window, which dropped real edits landing within 2s
            // of a save. Only applies once we're showing data (initial_meta_sent);
            // before then every delivery may be the first real one.
            if (initial_meta_sent && mtime === last_mtime) {
                ds.close();
                consecutive_reload_failures = 0;
                return;
            }
            adopt_source(ds, mtime);
            if (!initial_meta_sent) {
                await send_first_meta(ds);
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
                            // also fires the watcher's onDidChange; reparse_and_post
                            // adopts the new content here so that watcher reload is
                            // deduped, guarded against in-flight reloads.
                            await reparse_and_post();
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
                        await vscode.workspace.fs.writeFile(
                            uri,
                            new TextEncoder().encode(content)
                        );
                        await reparse_and_post();
                        // Clear cached edits on successful save
                        const current = state_store.get(file_path) as PerFileState;
                        const { pendingEdits: _, ...rest } = current;
                        state_store.set(file_path, rest);
                        panel.webview.postMessage({ type: 'saveResult', success: true });
                    } catch (err) {
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
    // send_reload() already short-circuits when disposed.
    disposables.push(watcher.onDidChange(() => send_reload()));
    disposables.push(watcher.onDidCreate(() => send_reload()));
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
