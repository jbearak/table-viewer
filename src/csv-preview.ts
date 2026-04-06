import * as path from 'path';
import * as vscode from 'vscode';
import { parse_csv, type CsvParseResult } from './parse-csv';
import { get_preview_reveal_target_line } from './preview-scroll-sync';
import { assert_safe_file_size } from './spreadsheet-safety';
import type { FileStateStore } from './state';
import type { WebviewMessage } from './types';
import { build_webview_html, generate_nonce } from './webview-html';

const SCROLL_LOCKOUT_MS = 150;

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
            active_preview.panel, uri, state_store, true
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

    const cleanup = setup_preview(panel, uri, state_store, false);

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
    state_store: FileStateStore,
    reusing: boolean
): () => void {
    const disposables: vscode.Disposable[] = [];
    const file_path = uri.fsPath;
    let line_map: number[] = [];
    let consecutive_reload_failures = 0;

    // Scroll sync lockout state
    let editor_lockout = false;
    let preview_lockout = false;
    let editor_lockout_timer: ReturnType<typeof setTimeout> | undefined;
    let preview_lockout_timer: ReturnType<typeof setTimeout> | undefined;

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
            line_map = result.line_map;
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
                previewMode: true,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }

    async function send_reload(): Promise<void> {
        try {
            const result = await parse_file();
            line_map = result.line_map;
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
            editor.document.lineCount
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
            if (preview_lockout) return;
            if (e.textEditor.document.uri.toString() !== uri.toString()) return;
            if (e.visibleRanges.length === 0) return;

            const top_line = e.visibleRanges[0].start.line;
            if (top_line === last_editor_top_line) return;
            last_editor_top_line = top_line;

            const row = find_row_for_line(top_line);

            // Set lockout to prevent the webview's scroll response from bouncing back
            editor_lockout = true;
            if (editor_lockout_timer !== undefined) clearTimeout(editor_lockout_timer);
            editor_lockout_timer = setTimeout(() => { editor_lockout = false; }, SCROLL_LOCKOUT_MS);

            panel.webview.postMessage({ type: 'scrollToRow', row });
        })
    );

    // --- Scroll sync: preview → editor ---

    disposables.push(
        panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            switch (msg.type) {
                case 'ready':
                    send_initial_data();
                    break;
                case 'stateChanged':
                    state_store.set(file_path, msg.state);
                    break;
                case 'visibleRowChanged': {
                    if (editor_lockout) return;
                    if (msg.row < 0 || msg.row >= line_map.length) return;

                    const source_line = line_map[msg.row];
                    const editor = find_matching_editor();
                    if (!editor) return;

                    // Set lockout to prevent editor scroll from bouncing back
                    preview_lockout = true;
                    if (preview_lockout_timer !== undefined) clearTimeout(preview_lockout_timer);
                    preview_lockout_timer = setTimeout(() => { preview_lockout = false; }, SCROLL_LOCKOUT_MS);

                    void reveal_source_line(editor, source_line);
                    break;
                }
            }
        })
    );

    // File watcher
    const dir = path.dirname(file_path);
    const basename = path.basename(file_path);
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), basename)
    );
    disposables.push(watcher.onDidChange(() => send_reload()));
    disposables.push(watcher.onDidCreate(() => send_reload()));
    disposables.push(watcher);

    // When reusing an existing panel, the webview is already loaded and won't
    // send 'ready' again. Trigger initial data send directly.
    if (reusing) {
        send_initial_data();
    }

    return () => {
        if (editor_lockout_timer !== undefined) clearTimeout(editor_lockout_timer);
        if (preview_lockout_timer !== undefined) clearTimeout(preview_lockout_timer);
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
