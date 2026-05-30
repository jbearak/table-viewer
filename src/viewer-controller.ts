import * as path from 'path';
import * as vscode from 'vscode';
import { XlsxDataSource } from './data-source/xlsx-source';
import { XlsDataSource } from './data-source/xls-source';
import { CsvDataSource } from './data-source/csv-source';
import type { DataSource, RenderedCell } from './data-source/interface';
import { ViewerPanelCore, adopt_source_into_core } from './panel-core';
import {
    get_csv_max_rows, get_default_orientation, get_delimiter, get_max_file_size_mib,
} from './viewer-config';
import { assert_safe_file_size, MAX_CSV_ROWS } from './spreadsheet-safety';
import { serialize_csv } from './serialize-csv';
import type { FileStateStore } from './state';
import type { PerFileState, WebviewMessage } from './types';

/** The host surface the controller needs. Both vscode.WebviewPanel and the
 *  unit-test mock panel satisfy it; html is set by the host before attaching. */
export interface ViewerHostPanel {
    webview: {
        postMessage(message: unknown): Thenable<boolean> | Promise<boolean> | boolean;
        onDidReceiveMessage(handler: (msg: WebviewMessage) => unknown): vscode.Disposable;
    };
}

export interface ViewerProfile {
    /** Build a DataSource from freshly-read bytes. Throws are surfaced as errors. */
    build_source(raw: Uint8Array, file_path: string): Promise<DataSource>;
    /** Enables csvEditingSupported + saveCsv/pendingEdits/showSaveDialog handling. */
    editing: boolean;
    /** Sets previewMode on the meta envelope (read-only synced preview). */
    previewMode?: boolean;
    /** Called after each (re)load adopts a source — preview refreshes its line map. */
    on_source_adopted?(source: DataSource): void;
    /** Handle a message the controller does not own (preview: visibleRowChanged).
     *  Return true if handled. */
    on_message?(msg: WebviewMessage): boolean | Promise<boolean>;
}

export function excel_profile(): ViewerProfile {
    return {
        editing: false,
        async build_source(raw, file_path) {
            return file_path.toLowerCase().endsWith('.xlsx')
                ? XlsxDataSource.create(raw)
                : XlsDataSource.create(Buffer.from(raw));
        },
    };
}

export function csv_table_profile(): ViewerProfile {
    return {
        editing: true,
        async build_source(raw, file_path) {
            const max_rows = Math.min(get_csv_max_rows(), MAX_CSV_ROWS);
            return CsvDataSource.create(raw, get_delimiter(file_path), max_rows);
        },
    };
}

/** Profile for a uri, by extension: csv/tsv → editable table; else Excel viewer. */
export function profile_for(uri: vscode.Uri): ViewerProfile {
    const ext = uri.fsPath.toLowerCase();
    return ext.endsWith('.csv') || ext.endsWith('.tsv')
        ? csv_table_profile()
        : excel_profile();
}

/**
 * Wire a webview panel to a file: initial load on `ready`, live reload via a
 * directory watcher with a monotonic guard, paginated row serving (via the
 * core), and — for editing profiles — save/conflict/pending-edit handling.
 * Returns a Disposable that tears everything down. The host sets webview html
 * and options before calling this.
 */
export function attach_viewer(
    panel: ViewerHostPanel,
    uri: vscode.Uri,
    state_store: FileStateStore,
    profile: ViewerProfile,
): vscode.Disposable {
    const file_path = uri.fsPath;
    const disposables: vscode.Disposable[] = [];

    let core: ViewerPanelCore | undefined;
    let source: DataSource | undefined;
    let reload_seq = 0;
    let disposed = false;
    let initial_meta_sent = false;
    let ready_seen = false;
    let last_mtime = 0;
    let consecutive_reload_failures = 0;

    function csv_editable(ds: DataSource): boolean {
        return profile.editing && !ds.truncationMessage;
    }

    async function build_source(): Promise<{ source: DataSource; mtime: number }> {
        const stat = await vscode.workspace.fs.stat(uri);
        const max_mib = get_max_file_size_mib();
        assert_safe_file_size(stat.size, max_mib);
        const raw = await vscode.workspace.fs.readFile(uri);
        assert_safe_file_size(raw.byteLength, max_mib);
        const ds = await profile.build_source(raw, file_path);
        return { source: ds, mtime: stat.mtime };
    }

    function adopt(ds: DataSource, mtime: number): void {
        core = adopt_source_into_core(core, panel, source, ds);
        source = ds;
        last_mtime = mtime;
        profile.on_source_adopted?.(ds);
    }

    function send_first_meta(ds: DataSource): Promise<void> {
        return core!.send_meta({
            state: state_store.get(file_path),
            defaultTabOrientation: get_default_orientation(),
            previewMode: profile.previewMode,
            csvEditingSupported: profile.editing || undefined,
            csvEditable: profile.editing ? csv_editable(ds) : undefined,
        });
    }

    function post_reload(ds: DataSource): Promise<boolean> {
        return core!.send_meta_reload({
            csvEditingSupported: profile.editing || undefined,
            csvEditable: profile.editing ? csv_editable(ds) : undefined,
        });
    }

    function surface_warnings(ds: DataSource): void {
        const warnings = ds.warnings ?? [];
        if (warnings.length > 0) vscode.window.showWarningMessage(warnings[0]);
    }

    async function send_initial_data(): Promise<void> {
        const seq = ++reload_seq;
        try {
            const { source: ds, mtime } = await build_source();
            if (disposed || seq !== reload_seq) { ds.close(); return; }
            adopt(ds, mtime);
            await send_first_meta(ds);
            initial_meta_sent = true;
            surface_warnings(ds);
        } catch (err) {
            if (disposed) return;
            vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
    }

    // Re-parse on disk and adopt through the same monotonic guard send_reload
    // uses; bumping reload_seq invalidates any in-flight watcher reload.
    async function reparse_and_post(): Promise<void> {
        const seq = ++reload_seq;
        const { source: ds, mtime } = await build_source();
        if (!disposed && seq === reload_seq) {
            adopt(ds, mtime);
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
            if (disposed || seq !== reload_seq) { ds.close(); return; }
            // Our own save's write fires the watcher; skip the redundant re-parse
            // when nothing changed. mtime-based so a genuine external edit (which
            // bumps mtime) still reloads. Only once we are showing data.
            if (initial_meta_sent && mtime === last_mtime) {
                ds.close();
                consecutive_reload_failures = 0;
                return;
            }
            adopt(ds, mtime);
            if (!initial_meta_sent) {
                await send_first_meta(ds);
                if (ready_seen) initial_meta_sent = true;
                consecutive_reload_failures = 0;
                return;
            }
            const delivered = await post_reload(ds);
            if (!delivered) return;
            consecutive_reload_failures = 0;
            surface_warnings(ds);
        } catch (err) {
            if (disposed) return;
            const code = typeof err === 'object' && err !== null && 'code' in err
                && typeof err.code === 'string' ? err.code : null;
            if (code === 'EBUSY' || code === 'EPERM') return;
            consecutive_reload_failures++;
            if (consecutive_reload_failures >= 3) {
                console.error('Failed to reload table viewer data', err);
                vscode.window.showErrorMessage(
                    `Failed to reload: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    async function handle_save(edits: Record<string, string>): Promise<void> {
        if (!source) return;
        if (source.truncationMessage) {
            panel.webview.postMessage({ type: 'saveResult', success: false });
            return;
        }
        try {
            const current_stat = await vscode.workspace.fs.stat(uri);
            if (current_stat.mtime !== last_mtime) {
                vscode.window.showWarningMessage(
                    'File was modified externally. Please review the changes and try again.');
                await reparse_and_post();
                panel.webview.postMessage({ type: 'saveResult', success: false });
                return;
            }
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
                row_windows(), get_delimiter(file_path), edits,
                src.originalColumnCounts, src.lineEnding);
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
            // The write succeeded — the save is done. A failure to re-parse the
            // just-written file (a transient read error, or an external delete in
            // the TOCTOU window) must not be reported as a failed save: the bytes
            // are on disk. last_mtime is only advanced by a successful reparse, so
            // the watcher event from our own write still refreshes the grid here.
            try {
                await reparse_and_post();
            } catch (reload_err) {
                console.error('Post-save reload failed (file was written)', reload_err);
            }
            const current = state_store.get(file_path) as PerFileState;
            const { pendingEdits: _drop, ...rest } = current;
            await state_store.set(file_path, rest);
            panel.webview.postMessage({ type: 'saveResult', success: true });
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to save: ${err instanceof Error ? err.message : String(err)}`);
            panel.webview.postMessage({ type: 'saveResult', success: false });
        }
    }

    disposables.push(panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
        if (disposed) return;
        switch (msg.type) {
            case 'ready':
                ready_seen = true;
                await send_initial_data();
                return;
            case 'stateChanged': {
                // Preserve pendingEdits the webview did not include in this snapshot.
                const existing = state_store.get(file_path) as PerFileState;
                const next = { ...msg.state };
                if (existing.pendingEdits) next.pendingEdits = existing.pendingEdits;
                await state_store.set(file_path, next);
                return;
            }
            case 'showWarning':
                vscode.window.showWarningMessage(msg.message);
                return;
            case 'saveCsv':
                if (profile.editing) await handle_save(msg.edits);
                return;
            case 'pendingEditsChanged': {
                if (!profile.editing) return;
                const current = state_store.get(file_path) as PerFileState;
                if (msg.edits) {
                    await state_store.set(file_path, { ...current, pendingEdits: msg.edits });
                } else {
                    const { pendingEdits: _drop, ...rest } = current;
                    await state_store.set(file_path, rest);
                }
                return;
            }
            case 'showSaveDialog': {
                if (!profile.editing) return;
                const choice = await vscode.window.showWarningMessage(
                    'You have unsaved changes.', { modal: true }, 'Save', 'Discard');
                panel.webview.postMessage({
                    type: 'saveDialogResult',
                    choice: choice === 'Save' ? 'save' : choice === 'Discard' ? 'discard' : 'cancel',
                });
                return;
            }
            default:
                if (profile.on_message && await profile.on_message(msg)) return;
                await core?.handle_message(msg);
        }
    }));

    const dir = path.dirname(file_path);
    const basename = path.basename(file_path);
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), basename));
    disposables.push(watcher.onDidChange(() => send_reload()));
    disposables.push(watcher.onDidCreate(() => send_reload()));
    disposables.push(watcher);

    return {
        dispose() {
            disposed = true;
            reload_seq++;
            source?.close();
            for (const d of disposables) d.dispose();
        },
    };
}
