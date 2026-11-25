# Table Viewer

Review and compare spreadsheets, tables, and datasets, with editing for common formats.

![Table Viewer comparing two recipe tables, with added, deleted, moved, and changed rows](docs/images/app-recipe-diff.png)

Table Viewer supports editing modern Excel (`.xlsx`), `.csv`, and `.tsv` files, plus read-only viewing and diffing of legacy Excel (`.xls`) workbooks, Stata (`.dta`) datasets, and Parquet (`.parquet`) files. It is built for reviewing, exploring, comparing, and annotating tables. Available as a standalone desktop app and a VS Code extension.

What you do while reviewing a table — sorting, filtering, hiding columns, resizing, highlighting cells — is stored alongside the file rather than inside it, so the file on disk is untouched and your sorts, filters, and highlights are still there the next time you open it, even if the file was regenerated in the meantime. Table Viewer also reloads on its own when the file changes on disk.

Follow the [setup and 10-minute try-out guide](docs/setup-guide.md) to choose the standalone app or VS Code extension, install it, try two sample workbooks, and see Table Viewer preserve a saved view when a file is replaced.

## Installation

### Visual Studio Code extension

Install Table Viewer from the extension registry used by your editor:

- **Visual Studio Code:** open [Table Viewer in the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.table-viewer) and click **Install**.
- **Editors that use Open VSX:** open [Table Viewer on Open VSX](https://open-vsx.org/extension/jbearak/table-viewer) and click **Install**.

You can also open your editor's **Extensions** view and search for the exact extension ID `jbearak.table-viewer`. After installation, open an `.xlsx`, `.xls`, `.csv`, `.tsv`, `.dta`, or `.parquet` file; Table Viewer registers itself as an editor for those file types.

### macOS desktop app

The desktop app requires an Apple Silicon Mac (M1 or newer) running macOS 12 or later. Install it with Homebrew:

```sh
brew install --cask jbearak/table-viewer/table-viewer
```

Or download `table-viewer-<version>-arm64.dmg` from the [latest release](https://github.com/jbearak/table-viewer/releases/latest), open it, and drag **Table Viewer** into **Applications**.

### Windows desktop app

The desktop app requires Windows 10 or 11. From the [latest release](https://github.com/jbearak/table-viewer/releases/latest), download `table-viewer-<version>-x64-setup.exe` for most PCs, or `table-viewer-<version>-arm64-setup.exe` for an Arm-based PC such as a Snapdragon laptop. Each also comes as a no-install `-portable.exe`. Windows builds are unsigned, so SmartScreen may show **Windows protected your PC** the first time; click **More info**, confirm that the app is Table Viewer, then click **Run anyway**.

The [desktop setup guide](docs/setup-guide-desktop-app.md) explains which file to pick, how updates work, how to verify a download, and what to do when something goes wrong.

## Features

The [feature reference](docs/features.md) describes everything Table Viewer does, in both the desktop app and the VS Code extension. Some topics have a page of their own:

- [Undo and redo](docs/undo-and-redo.md)
- [Filtering](docs/filtering.md), with each filter condition and how to use it
- [Inserting, deleting, and moving rows and columns](docs/rows-and-columns.md)
- [Excel formula support](docs/excel-formulas.md)
- [Parquet files](docs/parquet-files.md)
- [VS Code extension settings](README.vscode.md#settings)

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
- **Diffing a spreadsheet in Git shows you a wall of text.** Click a changed `.xlsx`, `.xls`, `.csv`, `.tsv`, `.dta`, or `.parquet` file in VS Code's Source Control or Timeline view and Table Viewer opens the comparison as a table: added and deleted rows banded, changed cells showing before and after in place. The desktop app also compares any two files.
- **Comparing a Git LFS file shows you the pointer, not the table.** An LFS-tracked file is stored in Git as a small pointer naming the real object, so the version you want to compare against is often not on your machine at all. Table Viewer recognizes the pointer on either side of a comparison and offers to download the object.

**Limitations:** Table Viewer is *not* a full spreadsheet editor. You can't create files or sheets. You can insert, delete, and move rows and columns in `.xlsx`, CSV, and TSV worksheets, but an `.xlsx` sheet with an Excel table, a chart, notes, a PivotTable, or an array formula can't be restructured; see [Inserting, deleting, and moving rows and columns](docs/rows-and-columns.md). Formula editing and recalculation intentionally support a documented subset of Excel; see [Excel formula support](docs/excel-formulas.md).

## Development

Clone the repo and run `npm install`, then `npm test` for the unit tests. The [development guide](docs/development.md) lists the build, test, and packaging scripts for both front ends, and explains `./scripts/setup.sh`, which builds and installs both locally. [desktop/README.md](desktop/README.md) covers the desktop shell, and the [Homebrew tap guide](docs/homebrew-tap.md) covers the release plumbing.

## License

[GPL-3.0](LICENSE)

Third-party attributions (the bundled color themes, and where to find the
generated npm package notices): [NOTICE.md](NOTICE.md).
