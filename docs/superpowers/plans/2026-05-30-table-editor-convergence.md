# Table Editor Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CSV/TSV files open as an editable table in the custom-editor host (so `workbench.editorAssociations` works), by collapsing three near-duplicate webview hosts onto one shared controller.

**Architecture:** Extract a `viewer-controller.ts` that owns the lifecycle every host shares (load → adopt into `ViewerPanelCore` → file watcher with monotonic reload guard → message dispatch → editable save flow). Drive it with a per-format **profile**. The custom editor becomes the host for all formats under two viewTypes (`tableViewer.excelViewer` for xlsx/xls at `default` priority; the repurposed `tableViewer.editor` for csv/tsv at `option` priority). The "Open as Table" command becomes `vscode.openWith(..., 'tableViewer.editor')`; the CSV panel is deleted; the preview consumes the controller with scroll-sync layered via profile hooks. A new "Open in Text Editor" button is the inverse navigation.

**Tech Stack:** TypeScript, VS Code extension API, esbuild, vitest (unit), @vscode/test-electron (integration). Spec: `docs/superpowers/specs/2026-05-30-table-editor-convergence-design.md`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/viewer-controller.ts` | Shared host lifecycle + profiles + save flow | **Create** |
| `src/custom-editor.ts` | Custom-editor provider; picks profile by extension; registers two viewTypes | Rewrite body |
| `src/csv-panel.ts` | (CSV table webview panel) | **Delete** |
| `src/csv-preview.ts` | Preview singleton + scroll-sync, atop the controller | Rewrite to use controller |
| `src/extension.ts` | Command wiring | Modify |
| `package.json` | viewTypes, commands, menus | Modify |
| `README.md` | Docs | Modify |
| `src/test/csv-reload-race.test.ts` | Unit lifecycle/race/save tests | Re-target to `attach_viewer` |
| `src/test-integration/open-formats.test.ts` | Format-open integration tests | Update viewTypes |
| `src/test-integration/perf.test.ts` | Perf integration test | Update viewType |

`ViewerPanelCore`/`adopt_source_into_core` (`panel-core.ts`), `serialize_csv`, `viewer-config.ts`, `spreadsheet-safety.ts`, the `DataSource` implementations, and the webview are unchanged.

---

### Task 1: package.json — viewTypes, command, menus

**Files:**
- Modify: `package.json` (`contributes.commands`, `contributes.menus`, `contributes.customEditors`)

- [ ] **Step 1: Add the `openAsText` command**

In `contributes.commands`, after the `tableViewer.openCsvTable` entry, add:

```json
{
    "command": "tableViewer.openAsText",
    "title": "Table Viewer: Open in Text Editor",
    "icon": "$(go-to-file)"
}
```

- [ ] **Step 2: Refine the `openCsvTable` menu `when` and add the `openAsText` menu entry**

Replace the `contributes.menus` block with:

```json
"menus": {
    "editor/title": [
        {
            "command": "tableViewer.showCsvPreviewToSide",
            "when": "resourceExtname =~ /\\.(csv|tsv|CSV|TSV)$/",
            "group": "navigation",
            "alt": "tableViewer.showCsvPreview"
        },
        {
            "command": "tableViewer.openCsvTable",
            "when": "resourceExtname =~ /\\.(csv|tsv|CSV|TSV)$/ && activeCustomEditorId != tableViewer.editor && activeCustomEditorId != tableViewer.excelViewer",
            "group": "navigation"
        },
        {
            "command": "tableViewer.openAsText",
            "when": "resourceExtname =~ /\\.(csv|tsv|CSV|TSV)$/ && activeCustomEditorId == tableViewer.editor",
            "group": "navigation",
            "icon": "$(go-to-file)"
        }
    ]
}
```

- [ ] **Step 3: Rewrite the `customEditors` contributions**

Replace the single `customEditors` array with two entries (Excel default + CSV/TSV option):

```json
"customEditors": [
    {
        "viewType": "tableViewer.excelViewer",
        "displayName": "Table Viewer",
        "selector": [
            { "filenamePattern": "*.xlsx" },
            { "filenamePattern": "*.XLSX" },
            { "filenamePattern": "*.xls" },
            { "filenamePattern": "*.XLS" }
        ],
        "priority": "default"
    },
    {
        "viewType": "tableViewer.editor",
        "displayName": "Table Viewer",
        "selector": [
            { "filenamePattern": "*.csv" },
            { "filenamePattern": "*.CSV" },
            { "filenamePattern": "*.tsv" },
            { "filenamePattern": "*.TSV" }
        ],
        "priority": "option"
    }
]
```

- [ ] **Step 4: Validate JSON**

Run: `node -e "require('./package.json'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat: add excelViewer viewType, repurpose tableViewer.editor for csv/tsv, add openAsText"
```

---

### Task 2: viewer-controller.ts — shared lifecycle, profiles, save flow

This is the heart of the change. It merges the lifecycle currently duplicated in `csv-panel.ts`, `csv-preview.ts`, and `custom-editor.ts`, plus the CSV save/conflict/pending-edit flow from `csv-panel.ts`.

**Files:**
- Create: `src/viewer-controller.ts`

- [ ] **Step 1: Write the module**

```ts
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
    /** Enables the csvEditingSupported flag + saveCsv/pendingEdits/showSaveDialog handling. */
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

    function surface_warnings(ds: DataSource): void {
        const warnings = ds.warnings ?? [];
        if (warnings.length > 0) vscode.window.showWarningMessage(warnings[0]);
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
            await reparse_and_post();
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
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors referencing `viewer-controller.ts`. (Other files still reference the old modules; those are fixed in later tasks. If pre-existing errors appear only in `csv-panel.ts`/`custom-editor.ts`, that is expected until Tasks 3–6.)

- [ ] **Step 3: Commit**

```bash
git add src/viewer-controller.ts
git commit -m "feat: add viewer-controller with shared lifecycle, profiles, and save flow"
```

---

### Task 3: custom-editor.ts — host all formats via the controller, two viewTypes

**Files:**
- Modify: `src/custom-editor.ts` (replace the `ViewerPanel` class and `build_source`; keep the provider + registration shape)

- [ ] **Step 1: Replace the file body**

```ts
import * as vscode from 'vscode';
import { attach_viewer, profile_for } from './viewer-controller';
import { get_default_orientation } from './viewer-config'; // (remove if unused after edits)
import type { FileStateStore } from './state';
import { build_webview_html, generate_nonce } from './webview-html';

export const EXCEL_VIEW_TYPE = 'tableViewer.excelViewer';
export const TABLE_VIEW_TYPE = 'tableViewer.editor';

class TableViewerDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}
    dispose(): void {}
}

export class TableViewerEditorProvider
    implements vscode.CustomReadonlyEditorProvider<TableViewerDocument> {

    constructor(
        private readonly extension_uri: vscode.Uri,
        private readonly state_store: FileStateStore,
    ) {}

    async openCustomDocument(uri: vscode.Uri): Promise<TableViewerDocument> {
        return new TableViewerDocument(uri);
    }

    async resolveCustomEditor(
        document: TableViewerDocument,
        webview_panel: vscode.WebviewPanel,
    ): Promise<void> {
        webview_panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extension_uri, 'dist', 'webview'),
            ],
        };
        webview_panel.webview.html = build_webview_html(
            webview_panel.webview, this.extension_uri, generate_nonce());

        const controller = attach_viewer(
            webview_panel, document.uri, this.state_store, profile_for(document.uri));
        webview_panel.onDidDispose(() => controller.dispose());
    }
}

export function register_table_viewer(
    context: vscode.ExtensionContext,
    state_store: FileStateStore,
): void {
    const provider = new TableViewerEditorProvider(context.extensionUri, state_store);
    const options = { supportsMultipleEditorsPerDocument: true };
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(EXCEL_VIEW_TYPE, provider, options),
        vscode.window.registerCustomEditorProvider(TABLE_VIEW_TYPE, provider, options),
    );
}
```

Remove the `get_default_orientation` import if it is unused after this edit (it is — delete that import line).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no new errors in `custom-editor.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/custom-editor.ts
git commit -m "refactor: custom editor hosts all formats via controller under two viewTypes"
```

---

### Task 4: extension.ts — openWith for table, add openAsText, drop active_panels

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Replace the file body**

```ts
import * as vscode from 'vscode';
import { register_table_viewer, TABLE_VIEW_TYPE } from './custom-editor';
import { show_csv_preview, dispose_csv_preview } from './csv-preview';
import { create_file_state_store, DEFAULT_MAX_STORED_FILES } from './state';

function active_custom_tab_uri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
    const get_max_stored = () =>
        Math.max(1, vscode.workspace.getConfiguration('tableViewer')
            .get<number>('maxStoredFiles', DEFAULT_MAX_STORED_FILES)!);

    const state_store = create_file_state_store(context, get_max_stored);
    register_table_viewer(context, state_store);

    context.subscriptions.push(
        vscode.commands.registerCommand('tableViewer.showCsvPreviewToSide', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            show_csv_preview(target, context.extensionUri, state_store, vscode.ViewColumn.Beside);
        }),
        vscode.commands.registerCommand('tableViewer.showCsvPreview', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            show_csv_preview(target, context.extensionUri, state_store, vscode.ViewColumn.Active);
        }),
        vscode.commands.registerCommand('tableViewer.openCsvTable', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            vscode.commands.executeCommand('vscode.openWith', target, TABLE_VIEW_TYPE);
        }),
        vscode.commands.registerCommand('tableViewer.openAsText', (uri?: vscode.Uri) => {
            const target = uri ?? active_custom_tab_uri();
            if (!target) return;
            vscode.commands.executeCommand('vscode.openWith', target, 'default');
        }),
    );

    context.subscriptions.push({ dispose() { dispose_csv_preview(); } });
}

export function deactivate(): void {}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no new errors in `extension.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: openCsvTable uses openWith; add openAsText; drop active_panels"
```

---

### Task 5: csv-preview.ts — consume the controller, layer scroll-sync via hooks

**Files:**
- Modify: `src/csv-preview.ts`

The preview keeps its singleton-reuse and scroll-sync; it delegates load/adopt/reload/watcher/core dispatch to `attach_viewer` through a preview profile.

- [ ] **Step 1: Replace `setup_preview` to use `attach_viewer`**

Keep `show_csv_preview`, `dispose_csv_preview`, the `ScrollLockout` helpers, `find_row_for_line`, `find_matching_editor`, `get_sticky_header_lines`, `reveal_source_line`, and the `active_preview` singleton exactly as they are. Replace the body of `setup_preview` so it:

1. Builds a preview profile:

```ts
import { attach_viewer, type ViewerProfile } from './viewer-controller';
import { CsvDataSource } from './data-source/csv-source';
import { get_csv_max_rows, get_delimiter } from './viewer-config';
import { MAX_CSV_ROWS } from './spreadsheet-safety';

// inside setup_preview, after declaring line_map / lockouts:
let line_map: number[] = [];

const profile: ViewerProfile = {
    editing: false,
    previewMode: true,
    async build_source(raw, fp) {
        const max_rows = Math.min(get_csv_max_rows(), MAX_CSV_ROWS);
        return CsvDataSource.create(raw, get_delimiter(fp), max_rows);
    },
    on_source_adopted(ds) {
        line_map = (ds as CsvDataSource).lineMap();
    },
    async on_message(msg) {
        if (msg.type !== 'visibleRowChanged') return false;
        if (editor_lockout.locked) return true;
        if (msg.row < 0 || msg.row >= line_map.length) return true;
        const editor = find_matching_editor();
        if (!editor) return true;
        start_lockout(preview_lockout);
        void reveal_source_line(editor, line_map[msg.row]);
        return true;
    },
};
```

2. Registers the editor→preview scroll listener (unchanged logic) and attaches the controller, collecting both for disposal:

```ts
const disposables: vscode.Disposable[] = [];

disposables.push(vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
    if (preview_lockout.locked) return;
    if (e.textEditor.document.uri.toString() !== uri.toString()) return;
    if (e.visibleRanges.length === 0) return;
    const top_line = e.visibleRanges[0].start.line;
    if (top_line === last_editor_top_line) return;
    last_editor_top_line = top_line;
    const row = find_row_for_line(top_line);
    start_lockout(editor_lockout);
    panel.webview.postMessage({ type: 'scrollToRow', row });
}));

const controller = attach_viewer(panel, uri, state_store, profile);
disposables.push(controller);

if (reusing) {
    panel.webview.html = build_webview_html(panel.webview, extension_uri, generate_nonce());
}

return () => {
    clear_lockout(editor_lockout);
    clear_lockout(preview_lockout);
    for (const d of disposables) d.dispose();
};
```

Move the `let last_editor_top_line = -1;` declaration to the top of `setup_preview`. Delete the preview's old inline `load`/`adopt_source`/`send_first_meta`/`send_initial_data`/`send_reload`/`core`/`source`/`reload_seq`/`disposed`/watcher/`onDidReceiveMessage` block — `attach_viewer` now owns all of it.

> Note: the controller calls `build_webview_html` is NOT its job — the host (preview) still builds html. On first open, `show_csv_preview` sets `panel.webview.html` before calling `setup_preview` (unchanged). On reuse, the `if (reusing)` branch above rebuilds it; because `attach_viewer` is created *before* that rebuild, the fresh html re-fires `ready`, which the just-attached controller handles. Keep the attach-before-rebuild order.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no new errors in `csv-preview.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/csv-preview.ts
git commit -m "refactor: csv preview consumes viewer-controller with scroll-sync hooks"
```

---

### Task 6: Delete csv-panel.ts; re-target the unit tests to attach_viewer

**Files:**
- Delete: `src/csv-panel.ts`
- Modify: `src/test/csv-reload-race.test.ts`

- [ ] **Step 1: Delete the panel module**

```bash
git rm src/csv-panel.ts
```

- [ ] **Step 2: Replace the CSV-table driver in the test with a controller helper**

At the top of `src/test/csv-reload-race.test.ts`, replace the `open_csv_table` import with:

```ts
import { attach_viewer, csv_table_profile } from '../viewer-controller';
import { dispose_csv_preview, show_csv_preview } from '../csv-preview';
```

Add a helper that mirrors `open_csv_table`'s old role (create a mock panel + attach the CSV profile):

```ts
function open_csv_table(file_uri: vscode.Uri): void {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    attach_viewer(panel as unknown as Parameters<typeof attach_viewer>[0],
        file_uri, state_store(), csv_table_profile());
}
```

Then update each call site (lines that read `open_csv_table(uri('/tmp/...'), uri('/ext'), state_store(), new Set());`) to `open_csv_table(uri('/tmp/...'));`. The five call sites: race, pre-ready, post-ready, dispose, and the two save tests.

> The preview tests (`show_csv_preview(...)`) are unchanged — `show_csv_preview` still exists and now routes through the controller, so these tests continue to exercise the real preview path including `previewMode`.

- [ ] **Step 3: Run the unit suite**

Run: `npm test`
Expected: PASS. The race/dispose/save assertions hold because the controller preserves the same `reload_seq` guard, mtime dedup, and save→reparse flow. If the `dispose` test fails, confirm the helper's mock panel `dispose()` reaches `controller.dispose()` — the test calls `panel.dispose()`, and `attach_viewer` does not itself subscribe to `onDidDispose` (the host does). Fix: in the test's `open_csv_table` helper, wire disposal — `panel.onDidDispose(() => controller.dispose())` — capturing `controller` from `attach_viewer`.

```ts
function open_csv_table(file_uri: vscode.Uri): void {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        file_uri, state_store(), csv_table_profile());
    panel.onDidDispose(() => controller.dispose());
}
```

- [ ] **Step 4: Commit**

```bash
git add -A src/csv-panel.ts src/test/csv-reload-race.test.ts
git commit -m "refactor: delete csv-panel; drive csv lifecycle tests through attach_viewer"
```

---

### Task 7: Integration tests — viewType updates + openAsText

**Files:**
- Modify: `src/test-integration/open-formats.test.ts`
- Modify: `src/test-integration/perf.test.ts`

- [ ] **Step 1: Update `open-formats.test.ts`**

In `afterEach`, replace the two settle waits with:

```ts
await wait_for(() => has_custom_tab('tableViewer.editor') === false, 5000);
await wait_for(() => has_custom_tab('tableViewer.excelViewer') === false, 5000);
```

Replace the CSV and TSV cases (which asserted a `tableViewer.csvTable` webview tab) with custom-tab assertions, and route through the command:

```ts
it('CSV opens in the table editor', async () => {
    await vscode.commands.executeCommand('tableViewer.openCsvTable', fixture_uri('basic.csv'));
    const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
    assert.ok(opened, 'expected a tableViewer.editor custom tab for basic.csv');
});

it('TSV opens in the table editor', async () => {
    await vscode.commands.executeCommand('tableViewer.openCsvTable', fixture_uri('basic.tsv'));
    const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
    assert.ok(opened, 'expected a tableViewer.editor custom tab for basic.tsv');
});
```

In the three Excel cases, change the `vscode.openWith` viewType argument and the `has_custom_tab(...)`/assertion strings from `'tableViewer.editor'` to `'tableViewer.excelViewer'`.

Add a regression case (forcing the association no longer errors) and an openAsText case:

```ts
it('CSV opened via the editor association renders (no xls error)', async () => {
    await vscode.commands.executeCommand('vscode.openWith', fixture_uri('basic.csv'), 'tableViewer.editor');
    const opened = await wait_for(() => has_custom_tab('tableViewer.editor'));
    assert.ok(opened, 'expected basic.csv to open in tableViewer.editor without error');
});

it('Open in Text Editor reopens a CSV as text', async () => {
    await vscode.commands.executeCommand('vscode.openWith', fixture_uri('basic.csv'), 'tableViewer.editor');
    await wait_for(() => has_custom_tab('tableViewer.editor'));
    await vscode.commands.executeCommand('tableViewer.openAsText', fixture_uri('basic.csv'));
    const as_text = await wait_for(() => all_tabs().some(
        (t) => t.input instanceof vscode.TabInputText &&
               t.input.uri.fsPath.endsWith('basic.csv')));
    assert.ok(as_text, 'expected basic.csv to open in a text editor tab');
});
```

Add `all_tabs` to the import from `./helpers`.

- [ ] **Step 2: Update `perf.test.ts`**

Change the `has_webview_tab('tableViewer.csvTable')` settle/await checks to `has_custom_tab('tableViewer.editor')`, and ensure the relevant import includes `has_custom_tab`. (Inspect the file; it opens a large CSV via `tableViewer.openCsvTable` and waits for the tab — the tab kind is now a custom tab.)

- [ ] **Step 3: Run the integration suite**

Run: `npm run test:integration`
Expected: PASS (all format cases, the regression case, and the openAsText case).

- [ ] **Step 4: Commit**

```bash
git add src/test-integration/open-formats.test.ts src/test-integration/perf.test.ts
git commit -m "test: integration tests for converged table editor + openAsText"
```

---

### Task 8: README — document the working association, editable CSV, and the new button

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the "Default editor behavior" section**

The `editorAssociations` snippet keeps `tableViewer.editor` (now the CSV/TSV editor), so the code block is unchanged. Add a sentence that opening CSV/TSV this way is now **editable**, and that the table also appears under "Reopen Editor With… → Table Viewer".

- [ ] **Step 2: Update the "Usage" / buttons section**

Document that when a CSV/TSV is open in the table view, an **"Open in Text Editor"** button (`$(go-to-file)`) in the title bar returns to the text editor.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: editable CSV via editor association + Open in Text Editor button"
```

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check the whole project**

Run: `npx tsc --noEmit -p .` then `npx tsc --noEmit -p tsconfig.integration.json`
Expected: no errors. Confirm no dangling references to `csv-panel`, `open_csv_table`, `VIEW_TYPE`, or `tableViewer.csvTable` remain:
Run: `rg -n "csv-panel|open_csv_table|VIEW_TYPE\b|tableViewer\.csvTable" src` → only comments in `viewer-config.ts`/`serialize-csv.test.ts`/`csv-source.test.ts` (historical mentions) may remain; no live code references.

- [ ] **Step 2: Run unit tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Run integration tests**

Run: `npm run test:integration`
Expected: PASS.

- [ ] **Step 4: Build the bundles**

Run: `npm run bundle && npm run bundle:webview`
Expected: both succeed.

- [ ] **Step 5: Commit any final fixes, then proceed to adversarial review + PR.**

---

## Verification notes (manual / browser-harness)

These need the running webview and are not covered by headless tests (see memory: Glide canvas editing is not drivable headlessly). Flag for human/browser-harness verification:

- **Ctrl/Cmd+S inside the table custom editor actually saves.** The webview captures the key and `preventDefault`s it; the custom editor is read-only at the VS Code level, so VS Code's own save is a no-op. Confirm a CSV edited in the table-as-custom-editor saves to disk. If VS Code swallows the key, add a command bound to `webviewId`/custom-editor focus that calls the webview's save.
- **Exit-with-unsaved-changes modal** (`showSaveDialog`) fires from a custom-editor tab, and pending edits survive closing/reopening the tab (cached in `state_store` by file path).
