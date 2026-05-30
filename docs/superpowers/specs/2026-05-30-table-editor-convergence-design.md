# Table Editor Convergence Design

## Problem

The README tells users they can open CSV/TSV files directly in Table Viewer by setting:

```json
"workbench.editorAssociations": {
    "*.csv": "tableViewer.editor",
    "*.tsv": "tableViewer.editor"
}
```

Doing this does **not** work. VS Code honors the association and opens the custom editor, but the custom editor only knows how to parse Excel. The CSV bytes fall through to the `.xls` parser and VS Code shows **"Not a valid .xls file."**

The root cause is architectural. The extension grew three separate webview hosts that share a rendering core but diverge in capability:

| Host | File | Formats | Editing | How it opens |
|------|------|---------|---------|--------------|
| Custom editor `tableViewer.editor` | `src/custom-editor.ts` | Excel only | No (`CustomReadonlyEditorProvider`) | Auto (selector) **and** `editorAssociations` |
| CSV Table panel `tableViewer.csvTable` | `src/csv-panel.ts` | CSV/TSV | **Yes** | "Open as Table" command |
| CSV Preview `tableViewer.csvPreview` | `src/csv-preview.ts` | CSV/TSV | No (scroll-synced preview) | "Open Preview to the Side" command |

The editing machinery the README advertises lives in the *command-launched panel* (`csv-panel.ts`), not in the host that `editorAssociations` targets (`custom-editor.ts`). Editing was never wired into the custom editor. All three hosts also re-implement the same lifecycle (load, adopt-into-core, file watcher, monotonic reload guard, message dispatch).

The editing flow is **host-agnostic**: the webview captures `Ctrl/Cmd+S` itself (`src/webview/grid-shell.tsx`), posts a `saveCsv` message, and the host writes the file directly. It never uses VS Code's document/dirty model. Editing is gated purely on the `csvEditingSupported` / `csvEditable` flags the host sends in the `sheetMeta` envelope. This means a `CustomReadonlyEditorProvider` can host a fully editable table — read-only at the VS Code level, editable via the webview's own save path.

## Goal

Collapse the divergence into a single editable-table editor that hosts every format, so the README's `editorAssociations` advice works **with editing**, and the three near-duplicate hosts stop drifting apart.

## Approach

Extract one **viewer controller** that owns the shared lifecycle, and drive it with a per-format **profile**. Make the custom editor the single host for all formats; reduce the CSV table panel to a `vscode.openWith` call; refactor the preview to consume the controller too.

```
   editorAssociations ─┐
   "Reopen With…"     ─┤──►  tableViewer.excelViewer (xlsx/xls, priority "default")
   "Open as Table" cmd ┘     tableViewer.tableEditor (csv/tsv,  priority "option")
                                      │  (one provider class, two viewType registrations)
                                      ▼
                        ┌─────────────────────────────────────────┐
                        │  viewer-controller.ts  (new)             │
                        │  • load + size-check + build DataSource  │
                        │  • adopt into ViewerPanelCore            │
                        │  • file watcher + monotonic reload guard │
                        │  • message dispatch                      │
                        │  • editable profile: saveCsv /           │
                        │    pendingEditsChanged / showSaveDialog   │
                        │  • profile.onMessage fallthrough hook    │
                        └─────────────────────────────────────────┘
                             ▲                              ▲
              csv/tsv profile: CsvDataSource,    xlsx/xls profile: Xls(x)DataSource,
              editing on, mtime-tracked          read-only, no mtime tracking
                             ▲
              preview profile: CsvDataSource, read-only, previewMode,
              scroll-sync layered via profile hooks
```

## Components

### `src/viewer-controller.ts` (new)

The extracted controller. Given a webview-panel-like host, a `uri`, the `state_store`, and a `ViewerProfile`, it owns:

- **Source building** — read file, `assert_safe_file_size` (re-checked against bytes actually read), build the `DataSource` via the profile, return `{ source, mtime }`.
- **Adoption** — `adopt_source_into_core(...)` into a `ViewerPanelCore`; calls `profile.onSourceAdopted(source)` for hosts that need post-adopt work (the preview rebuilds its row→line map here).
- **Initial data** — on `ready`, build + adopt + `send_meta(...)` with the profile's envelope flags (`csvEditable`, `csvEditingSupported`, `previewMode`, `truncationMessage`).
- **Reload** — file watcher (`RelativePattern` on dir/basename, `onDidChange` + `onDidCreate`) with the monotonic `reload_seq` guard, the editable profile's `mtime`-equality dedup, `EBUSY`/`EPERM` swallow, and the 3-strikes error surface. This is the logic currently duplicated across all three hosts.
- **Message dispatch** — `ready`, `stateChanged`, `showWarning`, and `default → core.handle_message` for every profile. For the **editable** profile it also handles `saveCsv` (mtime conflict check → streamed `serialize_csv` over 10k-row windows → `writeFile` → `reparse_and_post` → clear cached edits), `pendingEditsChanged`, and `showSaveDialog`, and uses the `pendingEdits`-preserving `stateChanged` merge. Messages the controller does not recognize fall through to an optional `profile.onMessage(msg)` hook (the preview uses this for `visibleRowChanged`).
- **Dispose** — close the source, tear down disposables. Must be cleanly re-attachable so the preview can reuse one panel across files.

```ts
interface ViewerProfile {
    buildSource(raw: Uint8Array, uri, filePath): Promise<DataSource> | DataSource;
    editing: boolean;          // → csvEditingSupported
    previewMode?: boolean;
    onSourceAdopted?(source: DataSource): void;
    onMessage?(msg: WebviewMessage): boolean | Promise<boolean>;  // returns "handled"
}
```

Profile selection is by file extension: `.xlsx` → XLSX read-only, `.xls` → XLS read-only, `.csv`/`.tsv` → CSV editable (`csvEditable: !truncationMessage`). The preview supplies its own CSV read-only + `previewMode` profile with scroll-sync hooks.

### `src/custom-editor.ts`

`resolveCustomEditor` selects the profile by extension and hands off to the controller; `onDidDispose` disposes it. The Excel-only `build_source` branch and the inline `ViewerPanel` lifecycle are removed — the controller owns them. The provider stays `CustomReadonlyEditorProvider` (save is webview-driven). `register_table_viewer` registers the **same provider instance under two viewTypes**:

- `tableViewer.excelViewer` — Excel selector, `priority: "default"`. **Renamed from the old `tableViewer.editor`** (see "Renaming `tableViewer.editor`" below).
- `tableViewer.tableEditor` — new viewType (CSV/TSV selector, `priority: "option"`).

Both keep `supportsMultipleEditorsPerDocument: true`. Because the controller picks its profile by file extension, **either viewType can host any format** — e.g. a CSV routed at `tableViewer.excelViewer` still opens as an editable table, not an error.

Constants in `custom-editor.ts`: replace the single `VIEW_TYPE` with `EXCEL_VIEW_TYPE = 'tableViewer.excelViewer'` and `TABLE_VIEW_TYPE = 'tableViewer.tableEditor'`.

### `src/csv-panel.ts`

**Deleted.** Its `saveCsv` / conflict / `reparse_and_post` / pending-edit logic migrates into the controller's editable path. The `tableViewer.openCsvTable` command in `extension.ts` becomes:

```ts
vscode.commands.executeCommand('vscode.openWith', target_uri, 'tableViewer.tableEditor');
```

### `src/csv-preview.ts`

Refactored to consume the controller for the common lifecycle (load / adopt / reload / watcher / core dispatch) via a CSV read-only + `previewMode` profile. The preview-specific concerns stay in this file, layered on top:

- **Singleton reuse** — one preview panel reused across files; on reuse it rebuilds the webview HTML and re-attaches a fresh controller.
- **Scroll sync** — the `onDidChangeTextEditorVisibleRanges` listener and 150ms lockout state stay here; `visibleRowChanged` arrives via `profile.onMessage`; the row→line map is refreshed in `profile.onSourceAdopted`.

### `src/extension.ts`

- Register the provider under both viewTypes.
- `openCsvTable` command → `vscode.openWith(..., 'tableViewer.tableEditor')`.
- Remove the now-unused `active_panels` set (only `csv-panel.ts` populated it); the preview manages its own singleton disposal.

### `package.json`

- Rename the existing `customEditors` contribution's `viewType` from `tableViewer.editor` to `tableViewer.excelViewer` (selector and `priority: "default"` unchanged).
- Add a second `customEditors` contribution: `viewType: "tableViewer.tableEditor"`, selector `*.csv` / `*.tsv` (and their uppercase variants), `priority: "option"`. `"option"` never auto-opens, so the text editor stays the default for CSV/TSV — matching the README's stated intent — while the table becomes available in **"Reopen Editor With…"**.
- Refine the `editor/title` `when` for `tableViewer.openCsvTable` so it hides when the active editor is already a table editor:
  `resourceExtname =~ /\.(csv|tsv|CSV|TSV)$/ && activeCustomEditorId != tableViewer.excelViewer && activeCustomEditorId != tableViewer.tableEditor`

### `README.md`

Update the `editorAssociations` snippet to target `tableViewer.tableEditor`, note that opening this way is **editable**, and mention "Reopen Editor With… → Table Viewer" as an alternative now that CSV/TSV appear in the picker. (The old `tableViewer.editor` id no longer exists — see the renaming note below.)

## Renaming `tableViewer.editor` → `tableViewer.excelViewer`

A hard rename, no compatibility alias. Rationale and blast radius:

- The extension's own persisted layout state (`state.ts` `globalState`) is keyed by **file path, not viewType**, so the rename orphans nothing we store.
- Excel auto-associates via the `priority: "default"` selector and is the sole default-priority editor for `.xlsx`/`.xls`, so it re-associates to the new id automatically on next open.
- The only external references are (a) VS Code's internal memory of which editor last opened a file — self-healing on reopen — and (b) any manual `workbench.editorAssociations` entry a user wrote pointing at `tableViewer.editor`. The only documented such mapping was for CSV, and it **never worked** (it produced the "Not a valid .xls file" error this change fixes), so there are no working users to break.

In-repo references to update: `package.json` (viewType), `src/custom-editor.ts` (`VIEW_TYPE` → `EXCEL_VIEW_TYPE`), `README.md` (snippet), and the `tableViewer.editor` assertions in `src/test-integration/open-formats.test.ts`.

## Data flow — CSV via the custom editor

1. User opens `data.csv` (via `editorAssociations`, "Reopen With", or the "Open as Table" button → `openWith`).
2. `resolveCustomEditor` → controller with the **CSV profile**.
3. Webview sends `ready` → controller builds `CsvDataSource`, sends `sheetMeta` with `csvEditingSupported: true`, `csvEditable: !truncationMessage`.
4. User edits; `Ctrl/Cmd+S` in the webview → `saveCsv` → controller does the mtime conflict check → streamed serialize → `writeFile` → `reparse_and_post`. Byte-identical to today's path, just hosted in an editor tab.
5. External change → watcher → guarded reload → conflict banner when there were pending edits. Unchanged.

## Behavior changes (intended)

- **"Open as Table" now opens a real editor tab** instead of a free-floating webview panel, so it survives window reload and is listed under "Reopen With". VS Code dedups one editor per (file, viewType) per group; split views still work (`supportsMultipleEditorsPerDocument` stays `true`).
- The cryptic **"Not a valid .xls file"** is gone; the README's `editorAssociations` advice works, **with editing**.
- CSV/TSV appear in **"Reopen Editor With…"** without becoming the default editor.

## Edge cases to honor / verify

- **`Ctrl/Cmd+S` inside a read-only custom editor** — the webview captures and `preventDefault`s the key (`src/webview/grid-shell.tsx`); VS Code's own save is a no-op since the provider is read-only. **Must be verified in the browser-harness** that save still fires when the table is hosted as a custom editor. If VS Code swallows the key, fallback is a command bound to the custom editor's focus context that calls the webview's save.
- **Exit-with-unsaved-changes** (`showSaveDialog`) and the **pending-edit cache** (survives tab close) are `state_store`-keyed by file path — the same key whether opened by association or command — so no work is lost. Verify the modal fires from a custom-editor tab.
- **Preview scroll-sync needs a text editor open.** If a user opts the table in as the default for CSV/TSV, the side preview has nothing to sync to. This is inherent to *their* opt-in — document it, do not engineer around it.
- **Excel stays read-only.** The profile enables `csvEditingSupported` only for CSV/TSV. "Editing (CSV/TSV only)" remains accurate.
- **Multiple editors of one document** editing concurrently can race on `state_store.pendingEdits`. This is **pre-existing** (the old panel already allowed multiple instances) and is out of scope for this change.

## Testing

- **Unit** — exercise the controller with a fake panel (as `panel-core` tests already do) for each profile: the reload monotonic guard, the `mtime` dedup, the `saveCsv` conflict path, and the `pendingEdits`-preserving `stateChanged` merge.
- **Integration** (`src/test-integration/open-formats.test.ts`) — update the existing `has_custom_tab('tableViewer.editor')` assertions to `tableViewer.excelViewer`; the custom editor opens CSV/TSV **editable** (rows render, `csvEditingSupported` true) and XLSX/XLS **read-only**; the `openWith` path from the command; a regression test that forcing the `editorAssociations` (both viewTypes) no longer errors.
- **Preview** (`src/test-integration/preview.test.ts`) — must stay green after the refactor; scroll-sync and singleton reuse behave as before.

## Out of scope

- Making Excel files editable.
- Switching to a writable `CustomEditorProvider` / VS Code dirty-and-save model (the existing self-owned save flow — conflict banner, keep/discard conflicted edits, cached pending edits — is deliberate and stays).
- The concurrent-multi-editor pending-edits race noted above.
