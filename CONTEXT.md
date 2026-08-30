# Table Viewer

Table Viewer presents workbook data as reviewable tables while preserving the workbook's own worksheet structure.

## Language

**Workbook**:
A spreadsheet file containing one or more worksheets.

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
A new Worksheet body row placed after every existing body row without shifting any existing row.
_Avoid_: Added row, inserted row

**Pending Appended Row**:
An Appended Row held in an editing session that is not yet part of the workbook on disk.
_Avoid_: Unsaved physical row, temporary row

**Pending Change**:
An unsaved change owned by an editing session: a cell change, a Pending Appended Row, or a Pending Tail Removal.
_Avoid_: Pending edit, dirty edit

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
