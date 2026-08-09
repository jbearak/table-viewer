# Table Viewer

A fast viewer for Excel (`.xlsx`, `.xls`) files and viewer/editor for CSV and TSV files, built for *reading* tables — reviewing, exploring, and annotating them — rather than authoring spreadsheets. Available as a standalone desktop app and a VS Code extension, with persistent layouts, view-only sorting and filtering, and auto-refresh.

Follow the [setup and 10-minute try-out guide](docs/setup-guide.md) to choose the standalone app or VS Code extension, install it, try two sample workbooks, and see Table Viewer preserve a saved view when a file is replaced.

## Why

When I make tables, I make them in code — R, Stata, Python — and refine them by rerunning the script. The rest of my time with tables is spent reading them: reviewing output that I or colleagues generate programmatically, or sheets someone sent me. Excel and Numbers are built for authoring spreadsheets by hand, and for both of these workflows they add friction at every step. Iterating on a generated workbook means closing the file, reopening it, and finding your place again on every rerun — redoing highlights, column widths, and the rest each time:

- **They're slow to open**, and every time a script re-outputs a file there are extra steps to get back to what you were looking at. Table Viewer opens fast, auto-refreshes when the file changes on disk, and keeps your scroll position, column widths, hidden columns, sorts, filters, and active sheet — across reloads and across sessions.
- **Sorting, filtering, and hiding modify the worksheet.** When you're reviewing output, the last thing you want is to change it. In Table Viewer these are view-only transforms: the file on disk is never touched, and there's no extra step to turn a range into a sortable/filterable list — every column already is one.
- **You can't easily control how files open.** Typeface, font size, colors — Table Viewer lets you set all of these in Preferences once, and every sheet you ever open respects them, so files are legible the moment they open.
- **Overflowing cells mean resizing rows and columns**, often in ways that make the table awkward. Table Viewer shows the full contents in a tooltip on hover.
- **Highlighting a cell takes a trip through formatting menus.** Here you right-click a cell and pick a color. Highlights are annotations, not formatting: they survive saves, reloads, and file replacement without modifying the file.
- **Many-sheet workbooks are painful**: when tabs overflow Excel's bottom bar you can't even scroll — you click left/right buttons to expose tabs. Table Viewer's sheet tabs scroll, and can be laid out vertically.
- **Remote files must be downloaded first.** As a VS Code extension, Table Viewer works the same over SSH as locally, and uses your editor's theme and font.

The flip side is that Table Viewer is deliberately *not* a spreadsheet editor. You can't create files or sheets, add cells beyond the file's existing bounds, or change formatting — Excel workbooks are strictly read-only, and CSV/TSV editing is limited to the cells the file already has. That constraint is the point: you can hand it any output file and explore it freely, knowing the file will only change if you explicitly edit and save it.

## Features

**Viewing**
- Opens `.xlsx`, `.xls`, `.csv`, and `.tsv` files
- Multi-sheet workbooks with horizontal or vertical tab orientation
- Merged cells with correct colspan/rowspan rendering
- Bold and italic text styling from Excel formatting
- Conservatively detects Excel column-name rows, with remembered per-sheet controls for promoting the first non-hidden row or a chosen row
- Hover briefly over horizontally truncated or vertically clipped cell content to see the displayed value in a tooltip
- Stable, multi-column sorting with missing values kept last
- Per-column filters for text, comparisons, ranges, distinct-value checklists, and empty/non-empty values

**Auto-refresh**
- Watches the file on disk and reloads automatically when it changes
- Preserves column widths, row heights, scroll position, and active sheet across reloads

**Layout**
- Drag column and row borders to resize
- Double-click a column border to auto-fit to content
- Select contiguous or discontiguous rows by their row numbers, then drag a selected row boundary to resize them together
- Select multiple columns to resize them together or auto-fit the selection
- Use the searchable **Columns** menu to show, hide, restore, or hide all columns
- Column visibility and sizing are persisted per file and sheet across VS Code sessions

**Formatting toggle**
- Switch between formatted and raw cell values with one click
- Useful for inspecting the exact number behind a formatted display

**CSV/TSV modes**
- **Open as Table**: opens the file in its own viewer tab
- **Open Preview to the Side**: split view with the source editor on the left and the table on the right, with synchronized scrolling between them

**Selection and copy**
- Click, drag, or shift-click to select cells
- Arrow keys and `h`/`j`/`k`/`l` to navigate
- `Ctrl+C` / `Cmd+C` to copy selected cells as tab-separated text
- Right-click context menus for copying, selecting or hiding rows and columns, and choosing an Excel row as the header

**Cell highlights**
- Apply a semantic highlight color to selected cells as a positional annotation, identified by worksheet, source row, and source column
- Highlights survive saves, reloads, file-content replacement, column-name changes, and first-row-header changes
- Highlights at temporarily unavailable rows, columns, or worksheets remain stored and reappear when those positions return
- Clear selection removes highlights only from the selected cells; Clear all removes every highlight for the file, including dormant highlights in unavailable rows, columns, or worksheets
- Only these explicit user clear actions remove highlights
- Unlike highlights, Sort and Filter are schema-bound view transforms and can be invalidated when their column schema is no longer meaningful

**Sorting and filtering** — the [filtering guide](docs/filtering.md) explains each filter condition and how to use them
- Right-click a column header to sort ascending or descending, add a secondary sort, or open that column's filter editor
- Sorted headers show direction arrows and multi-column priority badges; toolbar chips let you flip, reorder, remove, enable, disable, or edit active rules
- Keyboard shortcuts operate on the focused column: `Shift+Alt+A` / `D` sort, `Shift+Alt+F` filters, `Shift+Alt+X` clears its filter, and `Shift+Alt+0` / `9` clear all sorts or filters
- Multiple enabled filters are combined, while disabled filters remain available for later reuse
- Sorts and filters are view-only, persist per file and sheet, and are recomputed after reloads
- Sorting and filtering use raw cell values rather than formatted display text
- Empty values sort last in both directions
- When a sorted, filtered, or column-hidden sheet contains merged cells, the view temporarily shows them unmerged. Only the original top-left cell contains the merged value; covered cells remain empty. Restoring the natural rows and all columns restores the exact merge layout.
- Sorting, filtering, and row-hiding work alongside CSV/TSV edit mode in both directions: you can sort or filter while editing, and you can start editing a sheet that is already sorted or filtered. Either way the displayed order stays put while you edit, so rows stay where you left them, and the view reflects your new values once you save and the file reloads. While one tab is editing a file, it is the tab that can change that file's view; another tab showing the same file can change it again once the edit session ends. They are unavailable in synchronized preview panes, which always show rows in source order. Column visibility remains available in every mode

**Editing (CSV/TSV only)**
- Click the **Edit** button in the toolbar to enter edit mode
- Double-click a cell, press **Enter**, or choose **Edit cell** from the right-click menu to edit its value
- **Enter** confirms and moves to the cell below; **Tab** moves right
- **Shift+Enter** or **Alt+Enter** inserts a line break within a cell
- **Escape** cancels the current edit
- **Ctrl+S** / **Cmd+S** saves all changes back to the file
- Edited cells are highlighted with a different background color until saved
- Rows keep their position for the whole edit session, so a cell stays under your cursor while you work on it. You can enter edit mode with a sort or filter already applied, and add or change one while editing; neither moves the rows you are working on. A row you edit so that it no longer matches an active filter stays visible until you save; the view reflects your new values once the file is saved and reloaded
- When exiting edit mode with unsaved changes, you're prompted to save or discard
- Unsaved changes are cached, so you won't lose your work if you close the tab, window, or app
- If the file changes on disk while you have unsaved edits, a banner appears. Conflicted edits — where the underlying cell also changed externally — are flagged with warning-colored text on top of the usual background highlight; you can keep all edits, discard only the conflicted ones, or discard all

## Usage

**Excel files** open automatically in Table Viewer when you open an `.xlsx` or `.xls` file. When the first row strongly resembles column names, it is promoted automatically. Use the per-sheet **First Row as Header** toolbar toggle to override the detected choice; enabling it promotes the first non-hidden row.

To choose a different header row, right-click its row number and select **Use row as header**. Table Viewer hides the rows above it, preserves any hidden rows below it, and promotes the chosen row to column names in one step. The action is available only when no sort or enabled filter is changing the displayed row order. Header choices and hidden rows are remembered for that file and worksheet.

**CSV/TSV files** open automatically in Table Viewer as an editable table. An **"Open in Text Editor"** button in the title bar takes you to VS Code's built-in text editor. When a CSV/TSV file is open there, two Table Viewer buttons appear in the editor title bar:

- The **preview icon** opens a read-only synced side-by-side preview (alt-click opens it in the same tab)
- The **table icon** opens the file again as an editable table view

## Default editor behavior

Table Viewer registers as the default editor for Excel (`.xlsx`, `.xls`), CSV, and TSV files. Excel workbooks are read-only; CSV and TSV tables are editable. If another viewer is registered for one of these formats, VS Code may ask which editor you'd like to use.

To open a CSV/TSV file as plain text, use **Open in Text Editor** in the table editor's title bar, or right-click its tab and choose **Reopen Editor With… → Text Editor**. To change the default for a file type, choose **Configure Default Editor** from the same editor picker.

## Settings

Table Viewer uses VS Code's editor font (`editor.fontFamily` and `editor.fontSize`) by default. Set `tableViewer.fontFamily` to a CSS font-family value such as `Hack, monospace`, or `tableViewer.fontSize` to a pixel size, if you want tables to differ from the editor.

| Setting | Default | Description |
|---------|---------|-------------|
| `tableViewer.fontFamily` | empty (editor font) | Font family used in table views. Leave empty to follow `editor.fontFamily`. |
| `tableViewer.fontSize` | `0` (editor size) | Font size in pixels used in table views. Set to `0` to follow `editor.fontSize`. |
| `tableViewer.tabOrientation` | `horizontal` | Default worksheet tab orientation (`horizontal` or `vertical`). Can be overridden per file. |
| `tableViewer.maxStoredFiles` | `10000` | Maximum number of files whose layout state is remembered. Least recently used entries are evicted first. |
| `tableViewer.csvMaxRows` | `1000000` | Maximum rows to display for CSV/TSV files. Excess rows are truncated with a banner. |
| `tableViewer.maxFileSizeMiB` | `256` | Maximum file size in MiB. Applies to all supported file types. |

## Standalone desktop app (experimental)

Table Viewer also runs as a standalone Electron desktop app that reuses the same viewer, grid, and persistence code — no VS Code required. See [desktop/README.md](desktop/README.md) for build, run, packaging, and testing instructions.

On macOS (Apple Silicon, macOS 12+) download `table-viewer-<version>-arm64.dmg` from the [latest release](https://github.com/jbearak/table-viewer/releases/latest), or install it with Homebrew:

```sh
brew install --cask jbearak/table-viewer/table-viewer
```

Builds are not yet signed or notarized, so macOS blocks the first launch; the cask prints how to approve it. See [docs/homebrew-tap.md](docs/homebrew-tap.md) for the tap and release plumbing.

**Windows desktop builds are paused.** The desktop app keeps its per-file view
state in a SQLite database, and storing it safely requires durably flushing a
directory entry — an operation Node exposes no proven primitive for on Windows,
and which cannot be added without a native addon the packaging deliberately
excludes. Rather than ship a build whose sorts, filters, and layouts might not
survive a restart, the app declines the platform up front and no Windows artifact
is published. The VS Code extension is unaffected and works normally on Windows.

**In scope for v1:** opening `.xlsx`/`.xls`/`.csv`/`.tsv` files (dialog, command line, Finder "Open with…"), one window per open file, auto-refresh, layout persistence, sort/filter/hide, Excel header controls, CSV edit/save with conflict handling, cell highlights, the formatting toggle, per-window zoom, appearance and color-theme selection, and font/tab-orientation preferences.

**Deferred:** auto-update, and shared view state between VS Code and the desktop app (each keeps its own state store for now; the on-disk schema is shared so this can land later).

## Development

Clone the repo and run `npm install`.

**VS Code extension** (unchanged flow):

- `npm run bundle && npm run bundle:webview` — build the extension and webview bundles
- `npm test` — vitest unit tests
- `npm run test:integration` — VS Code Extension Host integration tests
- `npm run package` — build the `.vsix` with vsce

**Desktop app:**

- `npm run desktop:dev` — build the bundles and launch the app with Electron
- `npm run desktop:package` — unsigned local macOS build (dmg + zip, under `dist/desktop-packages/`)
- `npm run desktop:package:win` — Windows build (setup + portable exe, x64 + arm64); must be run on Windows. Developer-only: the resulting app declines to open its state database (see the Windows note above), and the release workflow does not publish Windows artifacts.
- `npm run test:desktop-smoke` — Playwright Electron smoke tests (separate from the vitest suite)

`./scripts/setup.sh` builds and installs both front ends locally in one go — the `.vsix` into every supported editor on `PATH`, and (on macOS) the desktop app into `/Applications`. See the [development guide](docs/development.md) for its flags and exact behavior.

## License

[GPL-3.0](LICENSE)

Third-party attributions (the bundled color themes, and where to find the
generated npm package notices): [NOTICE.md](NOTICE.md).
