import * as path from 'path';
import * as vscode from 'vscode';
import { CsvDataSource } from './data-source/csv-source';
import { ViewerPanelCore, adopt_source_into_core } from './panel-core';
import { get_csv_max_rows, get_default_orientation, get_delimiter, get_max_file_size_mib } from './viewer-config';
import { get_preview_reveal_target_line } from './preview-scroll-sync';
import { assert_safe_file_size, MAX_CSV_ROWS } from './spreadsheet-safety';
import type { FileStateStore } from './state';
import type { WebviewMessage } from './types';
import { build_webview_html, generate_nonce } from './webview-html';

const SCROLL_LOCKOUT_MS = 150;

interface ScrollLockout {
    locked: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
}

interface ActivePreview {
    panel: vscode.WebviewPanel;
    uri: vscode.Uri;
    dispose: () => void;
}

let active_preview: ActivePreview | null = null;

export function show_csv_preview(
    uri: vscode.Uri,
    extension_uri: vscode.Uri,
    state_store: FileStateStore,
    view_column: vscode.ViewColumn
): void {
    if (active_preview) {
        if (active_preview.uri.toString() === uri.toString()) {
            active_preview.panel.reveal(view_column);
            return;
        }
        // Reuse panel for different file: clean up old listeners, set up new ones
        active_preview.dispose();
        const new_cleanup = setup_preview(
            active_preview.panel, uri, extension_uri, state_store, true
        );
        active_preview.uri = uri;
        active_preview.dispose = new_cleanup;
        active_preview.panel.reveal(view_column);
        active_preview.panel.title = `Preview: ${path.basename(uri.fsPath)}`;
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'tableViewer.csvPreview',
        `Preview: ${path.basename(uri.fsPath)}`,
        view_column,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extension_uri, 'dist', 'webview'),
            ],
        }
    );

    const nonce = generate_nonce();
    panel.webview.html = build_webview_html(panel.webview, extension_uri, nonce);

    const cleanup = setup_preview(panel, uri, extension_uri, state_store, false);

    active_preview = { panel, uri, dispose: cleanup };

    panel.onDidDispose(() => {
        if (active_preview) {
            active_preview.dispose();
            active_preview = null;
        }
    });
}

function setup_preview(
    panel: vscode.WebviewPanel,
    uri: vscode.Uri,
    extension_uri: vscode.Uri,
    state_store: FileStateStore,
    reusing: boolean
): () => void {
    const disposables: vscode.Disposable[] = [];
    const file_path = uri.fsPath;
    let line_map: number[] = [];
    let consecutive_reload_failures = 0;

    // Paginated protocol engine. `line_map` (row -> source line) for scroll sync
    // comes from the same CsvDataSource that streams the grid rows, so the two
    // always agree on row count and boundaries.
    let core: ViewerPanelCore | undefined;
    let source: CsvDataSource | undefined;
    let reload_seq = 0;
    let disposed = false;
    let initial_meta_sent = false;
    let ready_seen = false;

    // Scroll sync lockout state
    const editor_lockout: ScrollLockout = { locked: false, timer: undefined };
    const preview_lockout: ScrollLockout = { locked: false, timer: undefined };

    function clear_lockout(lockout: ScrollLockout): void {
        if (lockout.timer === undefined) return;
        clearTimeout(lockout.timer);
        lockout.timer = undefined;
    }

    function start_lockout(lockout: ScrollLockout): void {
        lockout.locked = true;
        clear_lockout(lockout);
        lockout.timer = setTimeout(() => {
            lockout.locked = false;
            lockout.timer = undefined;
        }, SCROLL_LOCKOUT_MS);
    }

    async function load(): Promise<CsvDataSource> {
        const max_file_size_mib = get_max_file_size_mib();
        const stat = await vscode.workspace.fs.stat(uri);
        assert_safe_file_size(stat.size, max_file_size_mib);
        const raw = await vscode.workspace.fs.readFile(uri);
        // Re-check after read: the file can grow between stat() and readFile()
        // (this is a live-reload viewer, so concurrent writes are expected), and
        // raw.byteLength is the buffer we actually allocated.
        assert_safe_file_size(raw.byteLength, max_file_size_mib);
        const delimiter = get_delimiter(file_path);
        const max_rows = Math.min(get_csv_max_rows(), MAX_CSV_ROWS);
        return CsvDataSource.create(raw, delimiter, max_rows);
    }

    function adopt_source(ds: CsvDataSource): void {
        core = adopt_source_into_core(core, panel, source, ds);
        source = ds;
        // Scroll sync needs row -> source-line; derive it from the same source
        // that backs the grid so row counts can never drift apart.
        line_map = ds.lineMap();
    }

    async function send_initial_data(): Promise<void> {
        const seq = ++reload_seq;
        try {
            const ds = await load();
            if (disposed || seq !== reload_seq) {
                ds.close();
                return;
            }
            adopt_source(ds);
            const state = state_store.get(file_path);

            await core!.send_meta({
                state,
                defaultTabOrientation: get_default_orientation(),
                previewMode: true,
                truncationMessage: ds.truncationMessage,
            });
            initial_meta_sent = true;
        } catch (err) {
            if (disposed) return;
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }

    async function send_reload(): Promise<void> {
        const seq = ++reload_seq;
        try {
            const ds = await load();
            // A newer reload superseded us while parsing: discard this result so
            // stale data cannot roll back the source or scroll-sync line map.
            if (disposed || seq !== reload_seq) {
                ds.close();
                return;
            }
            adopt_source(ds);
            if (!initial_meta_sent) {
                const state = state_store.get(file_path);
                await core!.send_meta({
                    state,
                    defaultTabOrientation: get_default_orientation(),
                    previewMode: true,
                    truncationMessage: ds.truncationMessage,
                });
                if (ready_seen) initial_meta_sent = true;
                consecutive_reload_failures = 0;
                return;
            }
            const delivered = await core!.send_meta_reload({
                truncationMessage: ds.truncationMessage,
            });
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
                console.error('Failed to reload CSV preview', err);
                vscode.window.showErrorMessage(`Failed to reload CSV preview: ${message}`);
            }
        }
    }

    // --- Scroll sync: editor → preview ---

    function find_row_for_line(source_line: number): number {
        // Binary search for the last row whose source line ≤ source_line
        let lo = 0;
        let hi = line_map.length - 1;
        let result = 0;

        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (line_map[mid] <= source_line) {
                result = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        return result;
    }

    function find_matching_editor(): vscode.TextEditor | undefined {
        return vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === uri.toString()
        );
    }

    function get_sticky_header_lines(): number {
        const rainbow_csv = vscode.extensions.getExtension('mechatroner.rainbow-csv');
        if (!rainbow_csv) return 0;
        const enabled = vscode.workspace.getConfiguration('rainbow_csv')
            .get<boolean>('enable_sticky_header', false);
        return enabled ? 1 : 0;
    }

    async function reveal_source_line(
        editor: vscode.TextEditor,
        source_line: number
    ): Promise<void> {
        const visible_range = editor.visibleRanges[0];
        const reveal_target_line = get_preview_reveal_target_line(
            source_line,
            visible_range
                ? {
                    top_line: visible_range.start.line,
                }
                : null,
            editor.document.lineCount,
            get_sticky_header_lines()
        );
        if (reveal_target_line === null) return;
        const show_options: vscode.TextDocumentShowOptions = {
            preserveFocus: true,
        };
        if (editor.viewColumn !== undefined) {
            show_options.viewColumn = editor.viewColumn;
        }

        const shown_editor = await vscode.window.showTextDocument(
            editor.document,
            show_options
        );
        const range = new vscode.Range(
            reveal_target_line,
            0,
            reveal_target_line,
            0
        );
        shown_editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
    }

    let last_editor_top_line = -1;

    disposables.push(
        vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
            if (disposed) return;
            if (preview_lockout.locked) return;
            if (e.textEditor.document.uri.toString() !== uri.toString()) return;
            if (e.visibleRanges.length === 0) return;

            const top_line = e.visibleRanges[0].start.line;
            if (top_line === last_editor_top_line) return;
            last_editor_top_line = top_line;

            const row = find_row_for_line(top_line);

            // Set lockout to prevent the webview's scroll response from bouncing back
            start_lockout(editor_lockout);

            panel.webview.postMessage({ type: 'scrollToRow', row });
        })
    );

    // --- Scroll sync: preview → editor ---

    disposables.push(
        panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            if (disposed) return;
            switch (msg.type) {
                case 'ready':
                    ready_seen = true;
                    send_initial_data();
                    break;
                case 'stateChanged':
                    state_store.set(file_path, msg.state);
                    break;
                case 'visibleRowChanged': {
                    if (editor_lockout.locked) return;
                    if (msg.row < 0 || msg.row >= line_map.length) return;

                    const source_line = line_map[msg.row];
                    const editor = find_matching_editor();
                    if (!editor) return;

                    // Set lockout to prevent editor scroll from bouncing back
                    start_lockout(preview_lockout);

                    void reveal_source_line(editor, source_line);
                    break;
                }
                case 'showWarning':
                    vscode.window.showWarningMessage(msg.message);
                    break;
                default:
                    // requestRows (paginated protocol) -> core answers with rowData.
                    void core?.handle_message(msg);
                    break;
            }
        })
    );

    // File watcher
    const dir = path.dirname(file_path);
    const basename = path.basename(file_path);
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), basename)
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

    // When reusing an existing panel for a different file, rebuild the webview
    // HTML rather than messaging the live (stale) one. This clears the previous
    // file's rendered grid immediately — so a slow or failing load can't leave
    // it on screen under the new title — and re-triggers the 'ready' handshake,
    // which calls send_initial_data() exactly once for the new file.
    if (reusing) {
        panel.webview.html = build_webview_html(
            panel.webview, extension_uri, generate_nonce()
        );
    }

    return () => {
        disposed = true;
        reload_seq++;
        clear_lockout(editor_lockout);
        clear_lockout(preview_lockout);
        source?.close();
        for (const d of disposables) d.dispose();
    };
}

/** Dispose the active preview (for extension deactivation). */
export function dispose_csv_preview(): void {
    if (active_preview) {
        active_preview.panel.dispose();
        // onDidDispose handler will clean up
    }
}
