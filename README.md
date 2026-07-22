# Table Viewer

Fast, full-featured viewer for Excel (`.xlsx`, `.xls`) files and viewer/editor for CSV and TSV files in VS Code, with persistent layouts, sorting, filtering, and auto-refresh.

You do not need to be an existing VS Code user to use Table Viewer—VS Code can simply be the app that hosts the viewer. [Install Table Viewer from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.table-viewer), or follow the [setup and 10-minute try-out guide](docs/setup-guide.md) from installing VS Code through trying two sample workbooks and a safe revised-file exercise.

## Why

If you work with scripts that output tables — R, Stata, Python, or anything else — you've probably dealt with the friction of viewing those results. You rerun your script, but your viewer doesn't refresh. Or it does, but you lose your scroll position, your column widths, and the worksheet tab you were looking at. You resize columns again, or you go back to encoding widths in your script — tedious and imprecise.

Existing solutions were slow, didn't work the way I wanted, or both. I wanted a viewer that:

- **Auto-refreshes** when the file changes on disk, without losing my place
- **Remembers layout** — column widths, row heights, hidden columns, scroll position, and active sheet — across reloads and sessions
- **Lets me explore results** — promote headers, sort and filter rows, and hide irrelevant columns — without changing the underlying file
- **Lets me toggle formatting** so I can see raw values (`3.14159265358979`) or formatted output (`3.14`) with one click
- **Lives in VS Code** so it works the same whether I'm local or on a remote host via SSH
- **Uses VS Code's theme** so it doesn't look out of place
- **Shows CSV/TSV files two ways** — as a standalone table, or as a synced side-by-side preview alongside the source text

Table Viewer is the result.

## Features

**Viewing**
- Opens `.xlsx`, `.xls`, `.csv`, and `.tsv` files
- Multi-sheet workbooks with horizontal or vertical tab orientation
- Merged cells with correct colspan/rowspan rendering
- Bold and italic text styling from Excel formatting
- Conservatively detects Excel column-name rows, with a per-sheet **First Row as Header** override remembered for each file
- Stable, multi-column sorting with missing values kept last
- Per-column filters for text, comparisons, ranges, and empty/non-empty values

**Auto-refresh**
- Watches the file on disk and reloads automatically when it changes
- Preserves column widths, row heights, scroll position, and active sheet across reloads

**Layout**
- Drag column and row borders to resize
- Double-click a column border to auto-fit to content
- Select multiple columns and resize or auto-fit them together
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
- Right-click context menu for copy, select row, select column, select all

**Cell highlights**
- Apply a semantic highlight color to selected cells as a positional annotation, identified by worksheet, source row, and source column
- Highlights survive saves, reloads, file-content replacement, column-name changes, and first-row-header changes
- Highlights at temporarily unavailable rows, columns, or worksheets remain stored and reappear when those positions return
- Clear selection removes highlights only from the selected cells; Clear all removes every highlight for the file, including dormant highlights in unavailable rows, columns, or worksheets
- Only these explicit user clear actions remove highlights
- Unlike highlights, Sort and Filter are schema-bound view transforms and can be invalidated when their column schema is no longer meaningful

**Sorting and filtering**
- Right-click a column header to sort ascending or descending, add a secondary sort, or open that column's filter editor
- Sorted headers show direction arrows and multi-column priority badges; toolbar chips let you flip, reorder, remove, enable, disable, or edit active rules
- Keyboard shortcuts operate on the focused column: `Shift+Alt+A` / `D` sort, `Shift+Alt+F` filters, `Shift+Alt+X` clears its filter, and `Shift+Alt+0` / `9` clear all sorts or filters
- Multiple enabled filters are combined, while disabled filters remain available for later reuse
- Sorts and filters are view-only, persist per file and sheet, and are recomputed after reloads
- Sorting and filtering use raw cell values rather than formatted display text
- Empty values sort last in both directions
- When a sorted, filtered, or column-hidden sheet contains merged cells, the view temporarily shows them unmerged. Only the original top-left cell contains the merged value; covered cells remain empty. Restoring the natural rows and all columns restores the exact merge layout.
- Sorting and filtering are unavailable during CSV/TSV edit mode and in synchronized preview panes; column visibility remains available in every mode

**Editing (CSV/TSV only)**
- Click the **Edit** button in the toolbar to enter edit mode
- Double-click a cell, press **Enter**, or choose **Edit cell** from the right-click menu to edit its value
- **Enter** confirms and moves to the cell below; **Tab** moves right
- **Shift+Enter** or **Alt+Enter** inserts a line break within a cell
- **Escape** cancels the current edit
- **Ctrl+S** / **Cmd+S** saves all changes back to the file
- Edited cells are highlighted with a different background color until saved
- When exiting edit mode with unsaved changes, you're prompted to save or discard
- Unsaved changes are cached, so you won't lose your work if you close the tab, window, or app
- If the file changes on disk while you have unsaved edits, a banner appears. Conflicted edits — where the underlying cell also changed externally — are flagged with warning-colored text on top of the usual background highlight; you can keep all edits, discard only the conflicted ones, or discard all

## Usage

**Excel files** open automatically in Table Viewer when you open an `.xlsx` or `.xls` file. When the first row strongly resembles column names, it is promoted automatically. Use the per-sheet **First Row as Header** toolbar toggle to override the detected choice; the override is remembered for that file and worksheet.

**CSV/TSV files** open automatically in Table Viewer as an editable table. An **"Open in Text Editor"** button in the title bar takes you to VS Code's built-in text editor. When a CSV/TSV file is open there, two Table Viewer buttons appear in the editor title bar:

- The **preview icon** opens a read-only synced side-by-side preview (alt-click opens it in the same tab)
- The **table icon** opens the file again as an editable table view

## Default editor behavior

Table Viewer registers as the default editor for Excel (`.xlsx`, `.xls`), CSV, and TSV files. Excel workbooks are read-only; CSV and TSV tables are editable. If another viewer is registered for one of these formats, VS Code may ask which editor you'd like to use.

To open a CSV/TSV file as plain text, use **Open in Text Editor** in the table editor's title bar, or right-click its tab and choose **Reopen Editor With… → Text Editor**. To change the default for a file type, choose **Configure Default Editor** from the same editor picker.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tableViewer.tabOrientation` | `horizontal` | Default worksheet tab orientation (`horizontal` or `vertical`). Can be overridden per file. |
| `tableViewer.maxStoredFiles` | `10000` | Maximum number of files whose layout state is remembered. Least recently used entries are evicted first. |
| `tableViewer.csvMaxRows` | `1000000` | Maximum rows to display for CSV/TSV files. Excess rows are truncated with a banner. |
| `tableViewer.maxFileSizeMiB` | `256` | Maximum file size in MiB. Applies to all supported file types. |

## License

[GPL-3.0](LICENSE)
