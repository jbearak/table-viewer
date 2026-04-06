# Table Viewer

Read-only viewer for Excel (`.xlsx`, `.xls`), CSV, and TSV files in VS Code.

## Why

If you work with scripts that output tables — R, Stata, Python, or anything else — you've probably dealt with the friction of viewing those results. You rerun your script, but your viewer doesn't refresh. Or it does, but you lose your scroll position, your column widths, and the worksheet tab you were looking at. You resize columns again, or you go back to encoding widths in your script — tedious and imprecise.

Existing solutions were slow, didn't work the way I wanted, or both. I wanted a viewer that:

- **Auto-refreshes** when the file changes on disk, without losing my place
- **Remembers layout** — column widths, row heights, scroll position, and active sheet — across reloads and sessions
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

**Auto-refresh**
- Watches the file on disk and reloads automatically when it changes
- Preserves column widths, row heights, scroll position, and active sheet across reloads

**Layout**
- Drag column and row borders to resize
- Double-click a column border to auto-fit to content
- Select multiple columns and resize or auto-fit them together
- All layout state is persisted per file across VS Code sessions

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

**Editing (CSV/TSV only)**
- Click the **Edit** button in the toolbar to enter edit mode
- Double-click a cell to edit its value
- **Enter** confirms and moves to the cell below; **Tab** moves right
- **Escape** cancels the current edit
- **Ctrl+S** / **Cmd+S** saves all changes back to the file
- Edited cells show a dot indicator until saved
- When exiting edit mode with unsaved changes, you're prompted to save or discard

## Usage

**Excel files** open automatically in Table Viewer when you open an `.xlsx` or `.xls` file.

**CSV/TSV files** open in VS Code's built-in text editor. Two buttons appear in the editor title bar:

- The **preview icon** opens a synced side-by-side preview (alt-click opens it in the same tab)
- The **table icon** opens the file as a standalone table view

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tableViewer.tabOrientation` | `horizontal` | Default worksheet tab orientation (`horizontal` or `vertical`). Can be overridden per file. |
| `tableViewer.maxStoredFiles` | `10000` | Maximum number of files whose layout state is remembered. Least recently used entries are evicted first. |
| `tableViewer.csvMaxRows` | `10000` | Maximum rows to display for CSV/TSV files. Excess rows are truncated with a banner. |
| `tableViewer.maxFileSizeMiB` | `16` | Maximum file size in MiB. Applies to all supported file types. |

## License

[GPL-3.0](LICENSE)
