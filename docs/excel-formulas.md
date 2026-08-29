# Excel formula support

Table Viewer reads and edits formulas in modern Excel (`.xlsx`) workbooks. Legacy `.xls` workbooks are read-only, and CSV/TSV cells are plain text even when their contents begin with `=`.

## Viewing and editing formulas

Formula cells display their cached result from the workbook. In edit mode, opening a formula cell shows its formula text, including the leading `=`. Saving text that begins with `=` writes an Excel formula unless the cell contains styled text runs, in which case it is saved as text.

After an edit, Table Viewer recalculates affected formulas when it can. Its built-in calculator supports:

- arithmetic with `+`, `-`, `*`, and `/`, including parentheses and unary signs
- A1 cell and range references, including references to another worksheet
- `SUM` and `AVERAGE`

If a formula uses another function, has a cycle, cannot be parsed safely, or exceeds the calculation limits, Table Viewer removes its stale cached result instead of displaying a result it cannot trust. The cell displays `??` until Excel or another spreadsheet engine recalculates the workbook.

Editing a cell that belongs to an array formula, shared formula, or what-if data table may be refused when changing that cell alone could damage the formula group. Replace the grouped formula in Excel first, or edit its input cells instead.

## Copy, cut, and paste

Within Table Viewer:

- Copying a formula adjusts relative A1 references for the destination, while `$`-absolute rows and columns stay fixed. For example, copying `=A1+$B$1` one row down produces `=A2+$B$1`.
- Cutting and pasting keeps the moved cells' formula text unchanged.
- A same-worksheet move clears the source and writes the destination as one undoable paste.
- Formulas elsewhere in the workbook that refer to moved cells follow those cells to their new addresses. `$` markers are preserved but do not prevent a reference from following a move.

Cutting cells and then switching worksheets is not supported. Table Viewer refuses the paste before changing either worksheet. Cross-worksheet moves are tracked in [issue #289](https://github.com/jbearak/table-viewer/issues/289).

Formula-aware copying is also limited to the worksheet and table layout where the copy began. Pasting after switching worksheets or changing that layout uses the copied displayed values, not formula source.

Changing a sort, filter, hidden-column layout, or promoted header after cutting also invalidates the cut location. Cut the cells again in the current view before pasting.

Undo a move before saving if you need to reverse it. After the workbook is saved, Table Viewer refuses that undo because a reverse address rewrite could also change formulas that already referred to the destination.

## Clipboard interoperability

For cells read from the workbook, Table Viewer puts the displayed values on the standard plain-text and HTML clipboard formats. A newly entered or unsaved formula may instead appear there as its `=` formula text because it has no trustworthy calculated value yet.

Formula-aware copy and move semantics use Table Viewer-specific attributes in the HTML clipboard payload. Other applications ignore those attributes. Excel's standard HTML clipboard data exposes cached values rather than formula source, so formulas copied from Excel into Table Viewer paste as values. Another application receives the public value or unsaved formula text described above.
