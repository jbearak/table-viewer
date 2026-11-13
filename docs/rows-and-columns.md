# Inserting, deleting, and moving rows and columns

In Edit mode you can insert, delete, restore, and move rows and columns in `.xlsx`, CSV, and TSV files. Nothing changes on disk until you save. Until then the grid shows the file as it will look after the save: new rows and columns are tinted green, deleted ones red, and moved ones purple.

These actions are not available for `.xls`, `.dta`, or Parquet files, in a comparison, in a synchronized preview, or in a CSV or TSV file that opened with only its first rows loaded.

## Rows

Right-click a row number to open the row menu. In Edit mode it has these items:

| Item | What it does |
|---|---|
| **Insert row above** / **Insert N rows above** | Adds blank rows before the first selected row |
| **Insert row below** / **Insert N rows below** | Adds blank rows after the last selected row |
| **Delete row** / **Delete N rows** | Marks the selected rows for deletion at save |
| **Restore row** / **Restore N rows** | Brings back rows you deleted in this session |
| **Move rows up** / **Move rows down** | Moves the selected block past the next row |

N is the number of rows you selected. Insert and Move need adjacent rows. Delete accepts any selection. Restore appears when the selection includes a deleted row, and works only when every selected row is one.

To move rows with the keyboard, select whole rows and press `Alt+Shift+↑` or `Alt+Shift+↓`. To drag them, select the rows first, then press on one of their row numbers and drag. A line between rows shows where they will land, and the grid scrolls when you drag near its top or bottom edge. Pressing on a row number that isn't selected still selects rows by dragging, as before.

Inserting and deleting have no keyboard shortcuts. `Ctrl/Cmd+Shift+=` and `Ctrl/Cmd+-`, which Excel uses for them, zoom the view in VS Code and in the desktop app.

Row actions apply to body rows only. The header row and any rows above it can't be deleted or moved, and you can't insert above the header row.

A deleted row stays where it was, tinted and read-only, with no row number, until you save. The other row numbers show what the file will have after the save, so no two rows share a number.

Rows you add with **Append row** stay at the end, after every other row, until you save. You can't move them, or insert or move rows into or after them. **Insert row below** on the last appended row appends another. If you drop a dragged block among appended rows, it lands just before them.

## Columns

Right-click a column header to open the column menu, or select several columns and right-click one of them. In Edit mode it has these items:

| Item | What it does |
|---|---|
| **Insert column left** / **Insert N columns left** | Adds blank columns before the first selected column |
| **Insert column right** / **Insert N columns right** | Adds blank columns after the last selected column |
| **Delete column** / **Delete N columns** | Marks the selected columns for deletion at save |
| **Restore column** / **Restore N columns** | Brings back columns you deleted in this session |
| **Move columns left** / **Move columns right** | Moves the selected block past the next visible column |

Column actions include the header cell and any rows above the header. `Alt+Shift+←` and `Alt+Shift+→` move selected whole columns. Dragging a selected column header moves the columns, the same way dragging selected row numbers moves rows.

Hidden columns stay hidden. A new column goes right beside the column you inserted it next to, and a move steps past hidden columns, which keep their place relative to their neighbors.

A deleted column keeps its name in the header, tinted, until you save. Every sheet keeps at least one column, so you can't delete the last one.

### Naming new columns

When the sheet has a header row, a new column is named `New column`, then `New column 2`, and so on. Choose **Rename column…** to change the name. You can rename new columns in CSV and TSV files too. Existing CSV and TSV columns can't be renamed.

The rename dialog refuses the name of a column you deleted in this session, because formulas that refer to a column by name would quietly switch to the new one:

```text
A deleted column on this sheet is named Price. Restore it or choose another name.
```

## Sorts, filters, and hidden rows

Inserting and moving rows needs the rows in file order. While a sheet has a sort, an enabled filter, or hidden rows, those items are disabled with:

```text
Clear sorts, filters, and hidden rows to insert or move rows.
```

Once a sheet has an inserted or moved row, sorting, filtering, and hiding rows on that sheet are disabled until you save or discard:

```text
Save or discard inserted and moved rows to sort, filter, or hide rows.
```

Deleting rows works under any sort or filter, and every column action does. You can't sort or filter by a new column until it is saved. If you delete a column that has a sort or filter, the view keeps it until the save, then drops it and says so: "Removed the sort on Price because the column was deleted."

## Undo

Each menu action, drag, or shortcut is one undo step. In the desktop app the **Edit** menu names it: "Undo Insert row", "Undo Delete 3 rows", "Undo Move 2 columns", "Undo Restore column", "Undo Rename column". Undo brings back what the action changed, including anything you typed into a row or column that you then deleted.

A save that inserts, deletes, or moves rows or columns is as far back as undo goes. After it, undo reports:

```text
Can't undo past a save that inserted, deleted, or moved rows or columns.
```

## Saving and discarding

Save with `Ctrl+S` or `Cmd+S`, or leave Edit mode and choose to save. Saving writes rows and columns in their new structural order: the file's order with your inserts and moves applied. A sort never changes the saved order. It only changes the view, so a sorted grid can show rows in a different order than the file will have. Deleted rows and columns are removed from the file at that point, so check the red rows before you save.

Leaving Edit mode with unsaved row or column changes asks whether to save or discard them, as it does for cell edits. Discarding puts every row and column back where the file has it.

Unsaved changes survive closing the tab, the window, or the app. When you open the file again they come back, tinted as before, ready to save or discard.

### CSV and TSV files

A saved CSV or TSV file keeps the file's delimiter and line endings. If you only inserted, deleted, or moved rows, the header line is copied as it was. Once you change the columns, Table Viewer rewrites the header from the file's own header fields, so quoting survives, and pads short rows to the new width.

## Changes to the file on disk

If another program changes the file while you have unsaved row or column changes, Table Viewer checks whether it can still place them.

- A CSV or TSV file that only gained rows at the end keeps your changes. The new rows join after the file's last row, before any rows you appended.
- Any other change to a CSV or TSV file, and any change to the parts of an `.xlsx` workbook that describe the sheet, stops the save. Excel rewrites those parts on nearly every save, so an Excel save always lands here.

Table Viewer then shows a notice, and Save is refused until you choose:

```text
Sales changed on disk after you inserted, deleted, or moved rows or columns.
Table Viewer can't tell where those changes belong in the new version.
```

The notice offers three actions.

- **Keep new rows at the end** turns your inserted rows into appended rows, in their current order, and drops the deletions, moves, and new columns. What you typed into the inserted rows stays. What you typed into new columns doesn't, and the notice says how much, for example "Values typed in 2 new columns will be discarded."
- **Discard row and column changes on Sales** drops every inserted row, new column, deletion, and move on the sheet.
- **Dismiss notice** hides the notice and changes nothing. Save stays refused.

Both actions keep your edits to existing cells and your appended rows, and both can be undone.

## `.xlsx` workbooks

Table Viewer moves the parts of a worksheet it understands along with the rows and columns: cell formulas on every sheet, defined names, merged cells, conditional formatting, data validation, hyperlinks, the AutoFilter range, column widths, page breaks, and the frozen-pane position. A new row copies the formatting of the row above it, or of the row below it when it is first under the header. A new column copies the formatting of the column to its left, or to its right when it is first. New rows and columns don't copy values, formulas, links, or validation.

### Sheets Table Viewer can't restructure

A sheet that contains something Table Viewer can't shift keeps its row or column items in the menus, disabled, with the reason as the tooltip. Insert, Delete, and Restore say:

```text
Can't insert or delete rows on this sheet: it contains an Excel table.
```

Move says:

```text
Can't move rows on this sheet: it contains an Excel table.
```

These are the reasons you are most likely to see:

- an Excel table
- pictures, charts, or shapes, or a chart elsewhere in the workbook that uses data from the sheet
- notes or threaded comments
- PivotTables, slicers, timelines, query tables, or data connections
- conditional formatting, data validation, or sparklines stored as Excel extensions
- custom views, protected ranges, scenarios, or a data consolidation
- an array formula or a data table, including the single-cell dynamic-array formulas Excel writes for `FILTER`, `SORT`, `UNIQUE`, and `XLOOKUP`, for example "Can't move rows on this sheet: cell D2 has an array formula."
- a formula Table Viewer can't read well enough to adjust

### Merged cells

While a sheet has row or column changes, merged cells show unmerged, with the value in the top-left cell, as they do in a sorted view. Saving writes them merged again. Inserting inside a merge makes it bigger, and deleting part of one makes it smaller. Three actions are refused:

- deleting the first row or column of a merge that would remain: "Can't delete part of a merged cell's first row."
- moving a block that contains part of a merge: "Can't move part of a merged cell."
- moving a block into the middle of a merge: "Can't move rows into a merged cell."

### Filtered columns

A column move that would carry a filtered column outside the sheet's AutoFilter range is refused: "Can't move a filtered column outside the sheet's filter range."

### Conditional formatting and data validation

A rule whose formula points at other cells applies to each cell relative to its own position. After a move, a single rule sometimes can't keep every cell's meaning, so Table Viewer splits it into as many rules as it needs. It does this rather than let some cells silently change their formatting or validation. Excel keeps one rule instead.

One rule may split into at most 64 rules. Past that, a warning appears above the grid before you save, and Save refuses the change:

```text
Moving these rows would split the conditional formatting on B2:B500 into more than 64 rules. Save will refuse it.
```

Undo or change the move to clear it.
