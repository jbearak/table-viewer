import * as path from 'path';
import * as vscode from 'vscode';
import { CsvDataSource } from './data-source/csv-source';
import { attach_viewer, build_csv_source, type ViewerProfile } from './viewer-controller';
import { get_preview_reveal_target_line } from './preview-scroll-sync';
import type { AuthorityFileStateStore } from './state';
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
    state_store: AuthorityFileStateStore,
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
    state_store: AuthorityFileStateStore,
    reusing: boolean
): () => void {
    const disposables: vscode.Disposable[] = [];
    let torn_down = false;
    // Row -> source-line map for scroll sync, refreshed from the same
    // CsvDataSource that backs the grid (via the profile's on_source_adopted)
    // so row counts can never drift apart.
    let line_map: number[] = [];
    let last_editor_top_line = -1;

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

    // --- Scroll-sync helpers (shared by both directions) ---

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

    // Read-only preview profile: the controller owns load/adopt/reload/watcher
    // and paginated row serving; scroll-sync is layered on via the hooks below.
    const profile: ViewerProfile = {
        metadataDelivery: 'workbookSnapshot',
        editing: false,
        previewMode: true,
        build_source: build_csv_source,
        on_source_adopted(ds) {
            line_map = (ds as CsvDataSource).lineMap();
        },
        async on_message(msg: WebviewMessage): Promise<boolean> {
            if (msg.type !== 'visibleRowChanged') return false;
            if (torn_down || editor_lockout.locked) return true;
            if (msg.row < 0 || msg.row >= line_map.length) return true;
            const editor = find_matching_editor();
            if (!editor) return true;
            // Set lockout to prevent editor scroll from bouncing back
            start_lockout(preview_lockout);
            void reveal_source_line(editor, line_map[msg.row]);
            return true;
        },
    };

    // --- Scroll sync: editor → preview ---
    disposables.push(
        vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
            if (torn_down) return;
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

    // Attach the shared controller (owns the `ready` handshake, watcher, reload
    // guard, and core dispatch; forwards visibleRowChanged to profile.on_message).
    disposables.push(attach_viewer(panel, uri, state_store, profile));

    // When reusing an existing panel for a different file, rebuild the webview
    // HTML rather than messaging the live (stale) one. This clears the previous
    // file's rendered grid immediately and re-triggers the 'ready' handshake,
    // which the just-attached controller handles. Attach BEFORE this rebuild so
    // the fresh 'ready' is delivered to the new controller.
    if (reusing) {
        panel.webview.html = build_webview_html(
            panel.webview, extension_uri, generate_nonce()
        );
    }

    return () => {
        torn_down = true;
        clear_lockout(editor_lockout);
        clear_lockout(preview_lockout);
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
