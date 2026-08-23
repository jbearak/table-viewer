# Table Viewer

Read, edit, and diff Excel, CSV, and TSV tables.

Table Viewer supports editing modern Excel (`.xlsx`), `.csv`, and `.tsv` files, plus read-only viewing and diffing of legacy Excel (`.xls`) workbooks. It is built for reviewing, exploring, comparing, and annotating tables. Available as a standalone desktop app and a VS Code extension.

What you do while reviewing a table — sorting, filtering, hiding columns, resizing, highlighting cells — is stored alongside the file rather than inside it, so the file on disk is untouched and your sorts, filters, and highlights are still there the next time you open it, even if the file was regenerated in the meantime. Table Viewer also reloads on its own when the file changes on disk. Cell contents change only when you enter edit mode and save.

Follow the [setup and 10-minute try-out guide](docs/setup-guide.md) to choose the standalone app or VS Code extension, install it, try two sample workbooks, and see Table Viewer preserve a saved view when a file is replaced.

## Why

When I make tables, I make them in code — R, Stata, Python — and refine them by rerunning the script. The rest of my time with tables is spent reading them: reviewing output that I or colleagues generate programmatically, or sheets someone sent me. Excel and Numbers are built for authoring spreadsheets by hand, and for both of these workflows they add friction at every step.

The original reason I created Table Viewer was to make iteration on a generated workbook less painful. In Excel or Numbers, every rerun means closing the file, reopening it, finding your place again, and redoing highlights, column widths, and the rest. Table Viewer opens fast, reloads the file automatically when it changes, and keeps your scroll position, column widths, hidden columns, sorts, filters, and active sheet across reloads and sessions.

It also removes other friction from reading tables:

- **CSV and TSV files can exceed Excel's 1,048,576-row worksheet limit.** Table Viewer shows up to one million rows by default; when a file has more, you can raise the limit or choose **Load all rows** for that file. It indexes the file once and parses rows for the grid on demand.
- **Sorting, filtering, and hiding modify the worksheet.** When you're reviewing output, the last thing you want is to change it. In Table Viewer these are view-only transforms: the file on disk is never touched, and there's no extra step to turn a range into a sortable/filterable list — every column already is one.
- **Exported reports often put titles and notes above the real table.** Right-click the actual header row — even several rows down — and choose **Use row as header**. Table Viewer hides the preamble, promotes that row, remembers the choice, and handles common two-row vertically merged header labels.
- **You can't easily control how files open.** Typeface, font size, colors — Table Viewer lets you set all of these in Preferences once, and every sheet you ever open respects them, so files are legible the moment they open.
- **Formatting can obscure the value you're auditing.** Switch between the workbook's formatted display and the underlying raw cell values without changing the workbook.
- **Overflowing cells mean resizing rows and columns**, often in ways that make the table awkward. Table Viewer shows the full displayed value in a tooltip on hover.
- **Highlighting a cell takes a trip through formatting menus.** Here you right-click a cell and pick a color. Highlights are annotations, not formatting: they survive saves, reloads, and file replacement.
- **Many-sheet workbooks are painful**: when tabs overflow Excel's bottom bar you can't even scroll — you click left/right buttons to expose tabs. Table Viewer's sheet tabs scroll, and can be laid out vertically.
- **Remote files must be downloaded first.** As a VS Code extension, Table Viewer works the same over SSH as locally, and uses your editor's theme and font.
- **Diffing a spreadsheet in Git shows you a wall of text.** Click a changed `.xlsx`, `.csv`, or `.tsv` file in VS Code's Source Control or Timeline view and Table Viewer opens the comparison as a table: added and deleted rows banded, changed cells showing before and after in place. The desktop app also compares any two files.
- **Comparing a Git LFS file shows you the pointer, not the table.** An LFS-tracked file is stored in Git as a small pointer naming the real object, so the version you want to compare against is often not on your machine at all. Table Viewer recognizes the pointer on either side of a comparison and offers to download the object.

The flip side is that Table Viewer is deliberately *not* a full spreadsheet editor. You can't create files or sheets, add cells beyond the file's existing bounds, or change formatting. Editing `.xlsx`, CSV, and TSV files is limited to the cells the file already has; legacy `.xls` workbooks are read-only. That constraint is intentional: you can hand it any output file and explore it freely, knowing the file will only change if you explicitly edit and save it.

## Features

**Viewing**
- Opens `.xlsx`, `.xls`, `.csv`, and `.tsv` files
- Multi-sheet workbooks with horizontal or vertical tab orientation
- Merged cells with colspan/rowspan rendering
- `.xlsx` rich-text runs and whole-cell bold, italic, underline, and strikethrough styling
- `.xlsx` hyperlinks, with destination information on hover and open/copy actions for external links
- Conservatively detects Excel column-name rows, with remembered per-sheet controls for promoting the first non-hidden row or a chosen row, including column names inherited from simple two-row vertical merges
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
- Column visibility and sizing are persisted per file and sheet

**Formatting toggle**
- Switch between formatted and raw cell values with one click
- Useful for inspecting the exact number behind a formatted display

**Table diffs**
- Compare two Excel, CSV, or TSV files in a read-only table view — neither file is modified
- See added, deleted, moved, and changed rows, with before-and-after values highlighted within changed cells
- Aligns inserted, deleted, and moved rows so one structural change does not make every later row look modified
- An optional **Only changed rows** toggle hides rows that are the same in both files
- In VS Code, click a changed table file in the Source Control or Timeline view to open the diff — unstaged, staged, and committed changes alike
- In the desktop app, choose **File → Compare Files…** or reopen a comparison from the Recent list
- Files stored in Git LFS but not yet downloaded are detected on either side of a comparison, with a banner naming the object's real size and a button to fetch it

**CSV/TSV modes**
- **Open as Table**: opens the file in its own viewer tab
- **Open Preview to the Side**: split view with the source editor on the left and the table on the right, with synchronized scrolling between them
- Large files are indexed once and parsed in windows as the grid requests them
- Files beyond the configured row limit show a banner for changing the limit or loading every row for that view

**Selection and copy**
- Click, drag, or shift-click to select cells
- Arrow keys, and, outside Edit mode, `h`/`j`/`k`/`l` to navigate
- `Ctrl+C` / `Cmd+C` to copy selected cells as tab-separated text
- Right-click context menus for copying, selecting or hiding rows and columns, and choosing an Excel row as the header

**Cell highlights**
- Apply a semantic highlight color to selected cells as a positional annotation, identified by worksheet, source row, and source column
- Highlights survive saves, reloads, file-content replacement, column-name changes, and first-row-header changes
- Highlights at temporarily unavailable rows, columns, or worksheets remain stored and reappear when those positions return
- Clear selection removes highlights only from the selected cells; Clear all removes every highlight for the file, including dormant highlights in unavailable rows, columns, or worksheets
- Only these explicit user clear actions remove highlights
- Unlike highlights, Sort and Filter are schema-bound view transforms and can be invalidated when their column schema is no longer meaningful

**Undo and redo**
- `Ctrl+Z` / `Cmd+Z` undoes your last change; `Ctrl+Y` or `Cmd+Shift+Z` redoes it. In the desktop app the **Edit** menu carries both, named after what they would apply — "Undo Paste", "Redo Clear all highlights" — and greyed out when there is nothing left
- Covers cell edits (values, line breaks, styling, hyperlinks), cell highlights, and discards. A discarded edit session can be undone in full
- One history per workbook, in the order you worked: undoing a change on another worksheet switches to it. The cursor moves to what changed and the region flashes briefly, so an undo you cannot see is still findable
- Undo reaches back past a save. Doing so re-enters edit mode if you had left it, and re-saves are yours to make; undo never exits edit mode or discards an open session
- If a change is hidden by an active filter or a hidden column, it is still applied and you are told where it went rather than left watching a still cursor
- Sorts, filters, and column visibility are not part of history — they are view state, with their own toolbar chips and **Columns** menu for undoing them
- `Ctrl+Z` / `Cmd+Z` **inside** an open cell editor is ordinary text undo for what you are typing, and does not touch the workbook's history
- History lives with the window: closing the tab, window, or app clears it. Unsaved edits are cached and survive that, so a reopened file can show edits that can no longer be undone

**Sorting and filtering** — the [filtering guide](docs/filtering.md) explains each filter condition and how to use them
- Right-click a column header to sort ascending or descending, add a secondary sort, or open that column's filter editor
- Sorted headers show direction arrows and multi-column priority badges; toolbar chips let you flip, reorder, remove, enable, disable, or edit active rules
- Keyboard shortcuts operate on the focused column: `Shift+Alt+A` / `D` sort, `Shift+Alt+F` filters, `Shift+Alt+X` clears its filter, and `Shift+Alt+0` / `9` clear all sorts or filters
- Multiple enabled filters are combined, while disabled filters remain available for later reuse
- Sorts and filters are view-only, persist per file and sheet, and are recomputed after reloads
- Sorting and filtering use raw cell values rather than formatted display text
- Empty values sort last in both directions
- When a sorted, filtered, or column-hidden sheet contains merged cells, the view temporarily shows them unmerged. Only the original top-left cell contains the merged value; covered cells remain empty. Restoring the natural rows and all columns restores the exact merge layout.
- Sorting, filtering, and row-hiding work alongside edit mode in both directions: you can sort or filter while editing, and you can start editing a sheet that is already sorted or filtered. Either way the displayed order stays put while you edit, so rows stay where you left them, and the view reflects your new values once you save and the file reloads. While one tab is editing a file, it is the tab that can change that file's view; another tab showing the same file can change it again once the edit session ends. They are unavailable in synchronized preview panes, which always show rows in source order. Column visibility remains available in every mode

**Editing (`.xlsx`, CSV, and TSV)**
- Click the **Edit** button in the toolbar to enter edit mode
- Double-click a cell, press **Enter**, or choose **Edit cell** from the right-click menu to edit its value
- **Enter** confirms and moves to the cell below; **Tab** moves right
- **Shift+Enter** or **Alt+Enter** inserts a line break within a cell
- **Escape** cancels the current edit
- **Ctrl+S** / **Cmd+S** saves all changes back to the file
- Edit `.xlsx` cell styling with Markdown syntax: `**bold**`, `*italic*`, `<u>underline</u>`, and `~~strikethrough~~`
- Add, edit, or remove `.xlsx` hyperlinks to a web address or a place in the workbook from the cell context menu
- Edited cells are highlighted with a different background color until saved
- Rows keep their position for the whole edit session, so a cell stays under your cursor while you work on it. You can enter edit mode with a sort or filter already applied, and add or change one while editing; neither moves the rows you are working on. A row you edit so that it no longer matches an active filter stays visible until you save; the view reflects your new values once the file is saved and reloaded
- When exiting edit mode with unsaved changes, you're prompted to save or discard
- Unsaved changes are cached, so you won't lose your work if you close the tab, window, or app
- If the file changes on disk while you have unsaved edits, a banner appears. Conflicted edits — where the underlying cell also changed externally — are flagged with warning-colored text on top of the usual background highlight; you can keep all edits, discard only the conflicted ones, or discard all

**Diffing**

In the desktop app, choose **File → Compare Files…** and select an original (before) file and a modified (after) file. The comparison is read-only and neither file is changed.

In VS Code, click a changed Excel, CSV, or TSV file in the Source Control or Timeline view and Table Viewer opens the comparison as a table.

## Usage

**Excel files** open automatically in Table Viewer when you open an `.xlsx` or `.xls` file. Modern `.xlsx` workbooks are editable; legacy `.xls` workbooks are read-only. When the first row strongly resembles column names, it is promoted automatically. Use the per-sheet **Header Row** toolbar toggle to override the detected choice; enabling it promotes the first non-hidden row.

To choose a different header row, right-click its row number and select **Use row as header**. Table Viewer hides the rows above it, preserves any hidden rows below it, and promotes the chosen row to column names in one step. The action is available only when no sort or enabled filter is changing the displayed row order. Header choices and hidden rows are remembered for that file and worksheet.

**CSV/TSV files** open automatically in Table Viewer as an editable table. An **"Open in Text Editor"** button in the title bar takes you to VS Code's built-in text editor. When a CSV/TSV file is open there, two Table Viewer buttons appear in the editor title bar:

- The **preview icon** opens a read-only synced side-by-side preview (alt-click opens it in the same tab)
- The **table icon** opens the file again as an editable table view

## Default editor behavior

Table Viewer registers as the default editor for Excel (`.xlsx`, `.xls`), CSV, and TSV files. `.xlsx`, CSV, and TSV files are editable; legacy `.xls` workbooks are read-only. If another viewer is registered for one of these formats, VS Code may ask which editor you'd like to use.

To open a CSV/TSV file as plain text, use **Open in Text Editor** in the table editor's title bar, or right-click its tab and choose **Reopen Editor With… → Text Editor**. To change the default for a file type, choose **Configure Default Editor** from the same editor picker.

## Settings

Table Viewer uses VS Code's editor font (`editor.fontFamily` and `editor.fontSize`) by default. Set `tableViewer.fontFamily` to a CSS font-family value such as `Hack, monospace`, or `tableViewer.fontSize` to a pixel size, if you want tables to differ from the editor.

| Setting | Default | Description |
|---------|---------|-------------|
| `tableViewer.fontFamily` | empty (editor font) | Font family used in table views. Leave empty to follow `editor.fontFamily`. |
| `tableViewer.fontSize` | `0` (editor size) | Font size in pixels used in table views. Set to `0` to follow `editor.fontSize`. |
| `tableViewer.tabOrientation` | `horizontal` | Default worksheet tab orientation (`horizontal` or `vertical`). Can be overridden per file. |
| `tableViewer.diffOnByDefault` | `false` | Turn the **Diff** toggle on when edit mode is entered, so each edited cell keeps showing its original value beside the new one. Can be overridden per viewer from the toolbar. |
| `tableViewer.maxStoredFiles` | `10000` | Maximum number of files whose layout state is remembered. Least recently used entries are evicted first. |
| `tableViewer.csvMaxRows` | `1000000` | Rows to display by default for CSV/TSV files. A banner on larger files lets you change the limit or load all rows for that view. |
| `tableViewer.maxFileSizeMiB` | `256` | File-size threshold in MiB. Above it, Table Viewer asks before opening the file and offers **Open Anyway**. |

## Standalone desktop app

Table Viewer also runs as a standalone Electron desktop app that reuses the same viewer, grid, and persistence code — no VS Code required. See [desktop/README.md](desktop/README.md) for build, run, packaging, and testing instructions.

On macOS (Apple Silicon, macOS 12+) download `table-viewer-<version>-arm64.dmg` from the [latest release](https://github.com/jbearak/table-viewer/releases/latest), or install it with Homebrew:

```sh
brew install --cask jbearak/table-viewer/table-viewer
```

Official macOS releases are Developer ID signed. They are also notarized when the release credentials are complete; otherwise Gatekeeper may warn on first launch and the cask prints how to approve it. See [docs/homebrew-tap.md](docs/homebrew-tap.md) for the tap and release plumbing.

On Windows, download the setup or portable executable for your architecture from
the [latest release](https://github.com/jbearak/table-viewer/releases/latest).
Windows builds are unsigned, so SmartScreen displays its first-run warning; see
the [desktop setup guide](docs/setup-guide-desktop-app.md) for installation and
checksum-verification instructions.

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
- `npm run desktop:package:win` — Windows build (setup + portable exe, x64 + arm64); must be run on Windows
- `npm run test:desktop-smoke` — Playwright Electron smoke tests (separate from the vitest suite)

`./scripts/setup.sh` builds and installs both front ends locally in one go — the `.vsix` into every supported editor on `PATH`, and (on macOS) the desktop app into `/Applications`. See the [development guide](docs/development.md) for its flags and exact behavior.

## License

[GPL-3.0](LICENSE)

Third-party attributions (the bundled color themes, and where to find the
generated npm package notices): [NOTICE.md](NOTICE.md).
