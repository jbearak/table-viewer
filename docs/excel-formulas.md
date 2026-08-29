# Excel formula support

Table Viewer reads and edits formulas in modern Excel (`.xlsx`) workbooks. Legacy `.xls` workbooks are read-only, and CSV/TSV cells are plain text even when their contents begin with `=`.

## Viewing and editing formulas

Formula cells display their cached result from the workbook. In edit mode, opening a formula cell shows its formula text, including the leading `=`. Saving text that begins with `=` writes an Excel formula unless the cell contains styled text runs, in which case it is saved as text.

After an edit, Table Viewer recalculates affected formulas when it can. Its built-in calculator supports:

- arithmetic with `+`, `-`, `*`, and `/`, including parentheses and unary signs
- A1 cell and range references, including references to another worksheet
- Header Row column references, described below
- `SUM` and `AVERAGE`

If a formula uses another function, has a cycle, cannot be parsed safely, or exceeds the calculation limits, Table Viewer removes its stale cached result instead of displaying a result it cannot trust. The cell displays `??` until Excel or another spreadsheet engine recalculates the workbook.

Editing a cell that belongs to an array formula, shared formula, or what-if data table may be refused when changing that cell alone could damage the formula group. Replace the grouped formula in Excel first, or edit its input cells instead.

## Header Row column references

When a worksheet has **Header Row** active, Table Viewer treats every existing row below the header as one logical table. Use `[Revenue]` for the Revenue column or `[@Revenue]` for the Revenue cell on the formula's physical row. Worksheet qualifiers use the same spelling as A1 references: `Sales![Revenue]` and `'Sales Q1'![@Revenue]`.

Column names match without regard to case. Blank names and duplicate names cannot be referenced. An apostrophe escapes `[`, `]`, `#`, `'`, or `@` inside a name. For example, `[Net '@ Revenue]` refers to a column named `Net @ Revenue`.

Column references include hidden and filtered rows and do not follow display sorting. They exclude the promoted header and any rows above it. A full column is a range, so use it with a supported function such as `=SUM([Revenue])`; a cell cannot display `=[Revenue]`. If Table Viewer cannot calculate a formula, it shows the reason, such as `?? (unknown column)`, `?? (ambiguous column)`, or `?? (row outside worksheet body)`.

This is smaller than Excel's structured-reference language. Table Viewer does not support table names, `#Data`, `#Headers`, `#Totals`, column spans, or unions. The useful difference is that you do not have to format a range as an Excel table. Turning on **Header Row** is enough. Right-click a column while in Edit mode and choose **Rename column…** to change the workbook's header cell and update references to that column. Rename is disabled when the name is inherited from the anchor of a vertical merge because the promoted row has no editable header cell in that column.

Table Viewer preserves this formula syntax in the `.xlsx`. Excel may not calculate it unless the worksheet cells belong to a real Excel table; Table Viewer does not create an OOXML table region behind your back.

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
