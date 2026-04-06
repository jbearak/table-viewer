# CSV/TSV Viewer Design

Add CSV and TSV file support to the Table Viewer VS Code extension, with two viewing modes: a Preview with scroll sync, and a standalone table viewer tab.

## Viewing Modes

### Preview Mode

Opens via the `$(open-preview)` icon in the editor toolbar when a `.csv` or `.tsv` file is open in the text editor. Click opens a side-by-side Preview panel; option/alt-click opens a full-editor-width tab.

- **Singleton:** Only one CSV/TSV Preview can be open at a time (matching VS Code's markdown preview pattern). If a Preview already exists for the same file, it is revealed. If it exists for a different file, the panel is reused with new content.
- **Scroll sync:** Bidirectional with a 150ms lockout to prevent feedback loops. Syncs individual rows between the text editor and the table view using a line-to-row mapping computed during parsing.
- **Live reload:** File watcher updates the table when the file changes on disk.

### Toolbar-Button Mode

Opens via a `$(table)` icon in the editor toolbar (same `when` clause as Preview). Opens as a regular editor tab in the active editor group.

- **Not singleton:** Multiple tabs can be open for different (or the same) CSV/TSV files.
- **No scroll sync.**
- **Live reload:** File watcher updates the table when the file changes on disk.

## Extension Registration

### Commands

| Command | Description |
|---|---|
| `tableViewer.showCsvPreviewToSide` | Open CSV/TSV Preview beside the text editor |
| `tableViewer.showCsvPreview` | Open CSV/TSV Preview in the active editor group (full-width) |
| `tableViewer.openCsvTable` | Open CSV/TSV in standalone table viewer tab |

### Menu Contributions (`editor/title`)

- **Preview icon:** `$(open-preview)`, `when` = `resourceExtname =~ /\.(csv|tsv|CSV|TSV)$/`, `group` = `navigation`. Default click runs `showCsvPreviewToSide`; `alt` runs `showCsvPreview`.
- **Table icon:** `$(table)`, same `when` clause, `group` = `navigation`. Runs `openCsvTable`.

### Language Contributions

Register `csv` and `tsv` language IDs with their file extensions so VS Code recognizes the file types:
- `csv`: `.csv`, `.CSV`
- `tsv`: `.tsv`, `.TSV`

## CSV/TSV Parsing

### Module: `src/parse-csv.ts`

Uses **papaparse** (new dependency) for RFC 4180-compliant parsing. Handles quoted fields, embedded commas/newlines, escaped quotes, and BOM markers.

**Input:** File contents as string, plus a delimiter parameter (`','` for CSV, `'\t'` for TSV — detected from file extension).

**Output:** Same `WorkbookData` shape used by the xlsx viewer:
- Single `SheetData` with `name: "Sheet1"`, empty `merges` array, and `hasFormatting: false`
- All cell values stored as `CellData` with `raw` = the string value, `formatted` = same string, `bold: false`, `italic: false`

**Line-to-row mapping:** After parsing, walk the original source tracking newlines, matching each parsed row to its starting line in the source. Produces a `number[]` where `line_map[rowIndex] = sourceLineNumber`. Multi-line quoted fields span multiple source lines; the map points to the first line of each row.

**Row truncation:** Controlled by the `tableViewer.csvMaxRows` setting (default: 10,000). If parsed data exceeds this limit, truncate and produce a `truncationMessage` string (e.g., "Showing 10,000 of 150,000 rows") passed alongside the `WorkbookData`. The webview displays this as a banner above the table.

**File size safety:** Uses the `tableViewer.maxFileSizeMiB` setting (default: 16), replacing the existing hardcoded 16 MiB constant. Applies to all file types.

## Scroll Sync (Preview Mode Only)

The extension host acts as intermediary between the text editor and the webview, maintaining the `line_map` from parsing.

### Editor → Preview

1. Listen to `vscode.window.onDidChangeTextEditorVisibleRanges` for the synced text editor.
2. Get the top visible line from `visibleRanges[0].start.line`.
3. Binary-search the `line_map` to find the corresponding row index (last row whose source line ≤ visible line).
4. Post `{ type: 'scrollToRow', row }` to the webview.

### Preview → Editor

1. Webview detects scroll, determines top visible row index from `<tr>` element positions.
2. Posts `{ type: 'visibleRowChanged', row }` to the extension host.
3. Extension host looks up `line_map[row]` to get the source line number.
4. Calls `editor.revealRange(new Range(line, 0, line, 0), TextEditorRevealType.AtTop)`.

### Lockout Mechanism

A flag + timer (150ms) on the extension host. When a scroll originates from side A, suppress handling events from side B for 150ms. Prevents feedback loops.

### Editor Tracking

The Preview stores a reference to the source `TextEditor` and its `Uri`. Scroll sync pauses if the user focuses a different editor and resumes when they refocus the matching editor. Tracked via `vscode.window.onDidChangeActiveTextEditor`.

## Preview Singleton & Lifecycle

The extension maintains `active_preview: { panel: WebviewPanel, uri: Uri } | null`.

- **No preview exists** → create one.
- **Preview exists for same file** → reveal it.
- **Preview exists for different file** → reuse the panel: re-parse, update webview, re-bind scroll sync.
- **Panel closed** → set `active_preview = null`, clean up listeners.

### Panel Titles

- Preview: `"Preview: filename.csv"`
- Toolbar button: `"filename.csv"`

### State Persistence

Both viewer types persist UI state (column widths, row heights, scroll position) through the same `FileStateStore` used by the xlsx viewer, keyed by file path. State set in Preview carries over to toolbar-button viewer for the same file.

## Webview Reuse & Adaptation

The existing React webview renders all contexts. Differences are handled by data:

**Already handled by existing logic:**
- Sheet tabs hidden (single sheet → `has_multiple_sheets` is false)
- Formatting toggle hidden (`hasFormatting: false`)
- Tab orientation toggle hidden (single sheet)

**New webview behavior:**
- **Truncation banner:** Rendered below the toolbar when `truncationMessage` is present.
- **Scroll sync messages:** Webview listens for `scrollToRow` and posts `visibleRowChanged`. Only active when a `previewMode` flag is set in the initial data message.

### Message Type Changes

The existing `workbookData` host message gains two optional fields:
- `truncationMessage?: string` — e.g., "Showing 10,000 of 150,000 rows". Webview renders a banner when present.
- `previewMode?: boolean` — when true, the webview enables scroll sync messaging.

New message types:
```typescript
// Host → Webview (additions)
| { type: 'scrollToRow'; row: number }

// Webview → Host (additions)
| { type: 'visibleRowChanged'; row: number }
```

## Configuration

### New Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `tableViewer.csvMaxRows` | integer | 10000 | Maximum rows to display for CSV/TSV files. Excess rows are truncated with a banner. |
| `tableViewer.maxFileSizeMiB` | number | 16 | Maximum file size in MiB for all file types. Replaces the hardcoded constant. |

### Existing Settings (Unchanged)

| Setting | CSV/TSV Impact |
|---|---|
| `tableViewer.tabOrientation` | Not relevant (single sheet) |
| `tableViewer.maxStoredFiles` | Applies to CSV/TSV state persistence |

## File Structure

### New Files

| File | Purpose |
|---|---|
| `src/parse-csv.ts` | papaparse wrapper, line-to-row mapping, row truncation |
| `src/csv-preview.ts` | Preview panel: singleton management, scroll sync, file watcher |
| `src/csv-panel.ts` | Toolbar-button panel: multi-instance, file watcher, no scroll sync |

### Modified Files

| File | Changes |
|---|---|
| `package.json` | papaparse dependency, language contributions, commands, menus, new settings |
| `src/extension.ts` | Register CSV commands and providers |
| `src/types.ts` | New message types, truncation message in host data, preview mode flag |
| `src/spreadsheet-safety.ts` | Read `maxFileSizeMiB` setting instead of hardcoded constant |
| `src/webview/app.tsx` | Truncation banner, scroll sync message handling |
| `src/webview-html.ts` | Reused as-is |
