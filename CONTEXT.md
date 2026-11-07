# Table Viewer

Table Viewer presents workbook data as reviewable tables while preserving the workbook's own worksheet structure.

## Language

**Workbook**:
A spreadsheet file containing one or more worksheets.

**Table format**:
A file type Table Viewer opens: CSV, TSV, XLSX, XLS, Parquet, or Stata. A single-table format holds one table, compared as one unnamed sheet; a workbook format holds worksheets. Only CSV, TSV, and XLSX are editable.
_Avoid_: File type, extension (an extension names a format; it is not one)

**Worksheet**:
One grid within a workbook. A worksheet whose Header Row is active forms one logical table in Table Viewer.
_Avoid_: Sheet, Excel table

**Header Row**:
The worksheet row promoted to column names. It may be detected automatically, enabled explicitly, or chosen from a later row.
_Avoid_: Table header

**Worksheet body**:
Every physical row after the active Header Row through the worksheet's last existing row. Hidden rows, filtered rows, and display sorting do not change the body.
_Avoid_: Visible rows, displayed rows

**Appended Row**:
A new Worksheet body row placed after every existing body row. Appending never shifts an existing row; inserting, deleting, and moving rows do.
_Avoid_: Added row

**Pending Appended Row**:
An Appended Row held in an editing session that is not yet part of the workbook on disk.
_Avoid_: Unsaved physical row, temporary row

**Pending Change**:
An unsaved change owned by an editing session: a cell change, a Pending Row, a Pending Column, a Pending Row Removal, a Pending Column Removal, a Moved Row or Column, or a Pending Tail Removal.
_Avoid_: Pending edit, dirty edit

**Pending Row**:
A row held in an editing session that is not yet part of the workbook on disk. A Pending Appended Row is a Pending Row created by Append Row; a **Pending Inserted Row** is one created by Insert. A Pending Row keeps its origin wherever it is later moved.
_Avoid_: New row, blank row

**Worksheet Layout**:
The prospective order of a worksheet's body rows and of its columns, recorded by row and column identity rather than by position, including tombstones for rows and columns removed during the session. Pending Appended Rows follow it, outside it.
_Avoid_: Row order, permutation

**Pending Row Removal**:
A source body row that the session will delete at save. It stays visible in place, read-only, until save.
_Avoid_: Deleted row (it is not deleted until save)

**Moved Row** / **Moved Column**:
A source row or column outside the longest run of source rows or columns that kept their relative order.

**Pending Column**:
A column held in an editing session that is not yet part of the workbook on disk.

**Pending Column Removal**:
A source column that the session will delete at save.

**Formula Anchor**:
The row and column identities a formula reference names, recorded when the formula is authored, from which its text is rendered for any Worksheet Layout.

**Structural Basis**:
The file content that a worksheet's layout changes were authored against.

**Pending Tail Removal**:
The pending removal, through Undo, of an unchanged physical worksheet suffix previously created by a recorded Append Row.
_Avoid_: Deleted row, row deletion

**Column reference**:
A case-insensitive formula reference such as `[Revenue]` that names one column of the worksheet body. Blank and duplicate column names cannot be referenced.
_Avoid_: Table reference

**Row intersection**:
A formula reference such as `[@Revenue]` that names the cell in a column on the formula cell's physical row.
_Avoid_: Current visible row

**Qualified column reference**:
A formula reference such as `Sales![Revenue]` that names a column on another worksheet. The referenced worksheet, but not necessarily the formula's worksheet, must have an active Header Row.
_Avoid_: Table-qualified reference

**Column rename**:
A change to the workbook's actual header cell that preserves the column's identity. References to that column adopt the new name throughout the workbook.
_Avoid_: Column alias, header label override

**Unknown formula result**:
A formula result Table Viewer cannot calculate safely, displayed as `??` together with the reason.
_Avoid_: Formula error
