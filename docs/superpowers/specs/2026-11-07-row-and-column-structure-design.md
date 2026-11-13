# Row and column structure design

## Status

Accepted design, revision 9. Reviewed to approval by Claude Sonnet and GPT
Terra over eight rounds; ready to plan and implement.

Table Viewer will let Edit mode insert, delete, and move rows and columns in
`.xlsx`, CSV, and TSV worksheets. The three formats ship together behind one
capability flag.

This design extends the append-rows design
(`2026-08-29-append-rows-design.md`) rather than replacing it. Appending,
Pending Appended Rows, Pending Tail Removals, cross-save append undo, and
external-growth rebasing keep their current behavior on worksheets that have
no other structural change. This design lifts the append design's "out of
scope" items for inserting rows, deleting rows, and adding or removing columns,
and adds moving rows and columns.

It does not create files or worksheets, convert a worksheet into an OOXML
Excel Table, or edit `.xls`, `.dta`, Parquet, preview, or compare sources.

## Summary of the approach

1. During an edit session, nothing that already exists changes its key. Source
   cells stay keyed by canonical source row and source column, exactly as cell
   edits, highlights, conflicts, and base validation key them today.
2. Each worksheet gets a **Worksheet Layout**: the prospective order of its
   body rows and its columns, by identity. Removed rows and columns stay in the
   layout as tombstones for the rest of the session, so every identity the
   session has seen keeps a position.
3. Formulas are never rewritten step by step. Every formula reference is
   anchored to row and column identities, and its text is rendered from the
   current layout. Rendering depends only on the anchors and the layout, so the
   order of operations that produced a layout cannot change any formula.
4. The grid displays the layout. Saving turns the layout into physical
   coordinates once. Before writing, the host records the row and column maps
   as a durable rekey intent; after writing, it applies them to durable view
   state and clears the intent.
5. For `.xlsx`, the writer shifts an allowlist of structures it understands. A
   worksheet that contains anything else is refused, with a named reason,
   before the user starts.

## Language

Add these terms to `CONTEXT.md`:

**Worksheet Layout**:
The prospective order of a worksheet's body rows and of its columns, recorded
by row and column identity rather than by position, including tombstones for
rows and columns removed during the session.
_Avoid_: Row order, permutation

**Pending Row**:
A row held in an editing session that is not yet part of the workbook on disk.
A Pending Appended Row is a Pending Row created by Append Row. A **Pending
Inserted Row** is a Pending Row created by Insert. A Pending Row keeps its
origin wherever it is later moved.
_Avoid_: New row, blank row

**Pending Row Removal**:
A source body row that the session will delete at save. It stays visible in
place, read-only, until save.
_Avoid_: Deleted row (it is not deleted until save)

**Moved Row** / **Moved Column**:
A source row or column outside the longest run of source rows or columns that
kept their relative order. See "Moved detection".

**Pending Column**:
A column held in an editing session that is not yet part of the workbook on
disk.

**Pending Column Removal**:
A source column that the session will delete at save.

**Formula Anchor**:
The row and column identities a formula reference names, recorded when the
formula is authored, from which its text is rendered for any layout.

**Structural Basis**:
The file content that a worksheet's layout changes were authored against.

Update **Pending Change** to: an unsaved change owned by an editing session — a
cell change, a Pending Row, a Pending Column, a Pending Row Removal, a Pending
Column Removal, a Moved Row or Column, or a Pending Tail Removal.

Update **Appended Row** to drop "without shifting any existing row" from the
term and keep it on the Append Row operation: appending still never shifts an
existing row. Inserting, deleting, and moving do.

Record ADR 0004: *Edit worksheet structure through an identity layout and shift
coordinates only at save.* It supersedes the "without introducing arbitrary row
deletion" clause of ADR 0003. ADR 0003's rule for undoing saved appends is
unchanged. It also supersedes the append design's "Do not add a second
symbolic formula representation": Formula Anchors are that representation.

## User experience

### Availability

Row and column structure editing is available only in Edit mode, for the same
sources that can append rows: editable `.xlsx`, CSV, and TSV, not truncated,
not preview, not compare.

For `.xlsx` the host also decides per worksheet and per axis whether the
writer can shift it (see "XLSX structural support"). When it cannot, the
structure items stay in their menus, disabled, with the reason as their
accessible description and tooltip, for example:

```text
Can't insert or delete rows on this sheet: it contains an Excel table.
```

Two existing features are mutually exclusive with layout changes on the same
worksheet, because each assumes source rows keep their physical place:

- **Cut and paste.** While a worksheet has a layout change, pasting a cut whose
  origin or destination is on that worksheet is refused: "Save or undo the row
  and column changes on Sales before moving cells there." While a worksheet has
  a pending cell move, structure items on it are disabled: "Save or undo the
  moved cells first."
- **Undoing a saved append.** While a worksheet has a layout change, Undo of a
  saved append on it is refused with the existing "Can't undo appended rows…"
  message. While a worksheet has a Pending Tail Removal, structure items on it
  are disabled: "Save or redo the row removal first."

### Rows

Row operations act on **body rows** only: rows after the active Header Row, or
every row when the worksheet has no Header Row. The Header Row and rows above
it cannot be deleted or moved, and nothing can be inserted above the Header
Row.

The row-gutter menu gains, in Edit mode:

| Item | Selection | Effect |
|---|---|---|
| Insert row above / Insert N rows above | contiguous body rows | N blank Pending Inserted Rows before the first selected row |
| Insert row below / Insert N rows below | contiguous body rows | N blank Pending Inserted Rows after the last selected row |
| Delete row / Delete N rows | any body rows | Source rows become Pending Row Removals; Pending Rows are discarded |
| Restore row / Restore N rows | only Pending Row Removals | Cancels those removals |
| Move rows up / Move rows down | contiguous body rows | Moves the block past one neighboring displayed row |

N is the number of selected rows. The current "Remove pending row(s)" item
becomes the Delete item, which now accepts a selection that mixes source and
pending rows. "Cancel row removal" for Pending Tail Removals keeps its name,
because it reverses an undo.

Pending Appended Rows stay where Append put them: a band after every other
row, in the order they were appended, behind the existing boundary line. They
cannot be moved, nothing can be inserted or moved into or after the band, and
"Insert row below" on the last row of the band appends instead. A drag drop
inside the band resolves to just before it. A selection that spans the body
and the band disables Insert and Move. These items are disabled for rows in
the band with "Appended rows stay at the end until you save." This keeps every
reference to the rows below the body exactly where Append already puts it (see
"Formula Anchors").

Insert and Move need a selection that is contiguous in display order. A
non-contiguous selection shows them disabled with "Select adjacent rows to
insert or move them." A selection that includes a Pending Row Removal moves it
with the block, so the removal stays where the user saw it.

Drag and drop moves rows. Pressing on a row marker that is already part of a
contiguous row selection and dragging past Glide's existing 20 px threshold
moves the whole block; pressing on an unselected marker keeps today's
drag-to-select. The drop indicator is a 2 px line between rows. The grid
auto-scrolls while the pointer is within one row height of the top or bottom
edge, using the existing selection auto-scroll. Dropping at or above the Header
Row is refused, with the not-allowed cursor.

`Alt+Shift+↑` and `Alt+Shift+↓` move the selected rows when whole rows are
selected. There are no insert or delete shortcuts in this version: Excel's
`Ctrl/Cmd+Shift+=` and `Ctrl/Cmd+-` are zoom in both VS Code and the desktop
app (`desktop/main/main.ts`, View menu).

### Columns

Column operations act on whole columns, including the Header Row cell and any
rows above it.

The column header menu and the multi-column menu gain, in Edit mode:

| Item | Selection | Effect |
|---|---|---|
| Insert column left / Insert N columns left | contiguous columns | N blank Pending Columns before the first selected column |
| Insert column right / Insert N columns right | contiguous columns | N blank Pending Columns after the last selected column |
| Delete column / Delete N columns | any columns, leaving at least one live column | Source columns become Pending Column Removals; Pending Columns are discarded |
| Restore column / Restore N columns | only Pending Column Removals | Cancels those removals |
| Move columns left / Move columns right | contiguous columns | Moves the block past one neighboring displayed column |

Drag and drop moves columns with the same rule as rows: dragging a header that
is already part of a contiguous column selection moves the block; dragging an
unselected header keeps today's drag-to-select. `Alt+Shift+←` and `Alt+Shift+→`
move selected whole columns.

When the worksheet has an active Header Row, each new column gets a unique
default name, `New column`, `New column 2`, and so on, unique among the
prospective column names. "Rename column…" is enabled for Pending Columns in
every editable format, including CSV and TSV, and uses the existing rename
dialog's validation. The dialog also refuses the name of a column removed in
this session on the same worksheet ("A deleted column on this sheet is named
Price. Restore it or choose another name."), because structured references
such as `[Price]` follow the name and would silently rebind to the new column.

Delete is disabled when it would leave no live column, with "A sheet needs at
least one column." Insert always needs a live column to anchor on, so this
keeps an insertion path open on every worksheet.

Hidden columns stay hidden. Inserting next to a visible column places the new
column immediately beside that column's identity. Moving a block past "one
neighboring displayed column" skips hidden columns, which keep their position
relative to the columns around them.

The prospective width may not exceed `MAX_SHEET_COLUMNS` (256). A CSV or TSV
source wider than that cannot use column operations; the items are disabled
with "This file has more columns than Table Viewer can restructure." `.xlsx`
sources cannot be wider, because the reader already refuses them.

### Transforms

Row insertion and row moves need the display order to equal the physical
order. They are available only while the worksheet's body view is
untransformed: no sort, no enabled filter, and no hidden body rows. Otherwise
the items are disabled with:

```text
Clear sorts, filters, and hidden rows to insert or move rows.
```

While a worksheet has a Pending Inserted Row or a Moved Row, sorting,
filtering, and hiding rows on that worksheet are disabled with:

```text
Save or discard inserted and moved rows to sort, filter, or hide rows.
```

Deleting rows works under any transform. A Pending Row Removal stays in its
current display position, tinted, until save.

Column operations work under any transform. Sort and filter items are disabled
for Pending Columns, because the host transform reads only source data. A sort
or filter on a column with a Pending Column Removal keeps the installed view
until save; after save it is dropped and the toolbar announces "Removed the sort
on Price because the column was deleted." (and the same for filters).

### Display

| State | Tint | Content | Gutter or header label |
|---|---|---|---|
| Pending Inserted Row / Pending Column | added (`diff_added_fg`) | editable | prospective row number or column letter/name |
| Pending Row Removal / Pending Column Removal | deleted (`diff_deleted_fg`) | read-only, current values | no row number; header keeps its name |
| Moved Row / Moved Column | moved (`diff_moved_fg`) | editable | prospective row number or column letter/name |

Tints use the existing `COMPARE_BAND_ALPHA`. A cell highlight still takes
precedence over the band tint. Pending Appended Rows keep their band and
boundary line at the end of the grid. Discarded Pending Rows and Pending
Columns are not displayed; their tombstones exist only for formula rendering.

Row numbers and column letters are prospective: what the file will show after
save. Pending Row Removals show no row number, so no two rows share a number.
Column headers for Pending Column Removals keep their source name or letter.

On a worksheet with any layout change, merged cells display unmerged until
save, as they already do in sorted or filtered views: only the anchor cell
shows the merged value. Save writes the merges by the rules under "Coverage".

### Moved detection

A row is a Moved Row when it is a live source row outside the longest
order-preserving subsequence of live source rows. Compute it over the row
layout's source runs, weighting each run by its live row count, with ties
broken toward the earlier run. That is `O(R log R)` for `R` runs and
deterministic from stored state, so a reload tints the same rows. Moving row 3
below row 4 therefore tints row 3, not row 4. Columns use the same rule over
the column layout.

### Accessibility

Every banded row and column exposes its state in its accessibility label:
"Row 12, inserted", "Row removed, was row 8", "Row 15, moved from row 9",
"Column C, inserted", "Column removed, was Price". Disabled menu items keep
`aria-disabled="true"` and the reason in `aria-description`.

After Insert, focus moves to the first new cell in the column or row that was
focused. After Delete, focus moves to the nearest live row or column. After
Move, focus and selection follow the moved identities. These moves poll the
grid's reported rows and columns; they never wait a fixed delay.

Moving announces the gesture, "Moved 3 rows down", through the existing live
region. Row labels follow the tint, which marks the fewest rows that explain
the new order, so they can name a row the user did not drag: moving rows 3–5
below row 6 labels the old row 6 "Row 3, moved from row 6".

### History

Each menu action, drag, or shortcut is one history action. Undo labels:

- Insert row / Insert N rows, Insert column / Insert N columns
- Delete row / Delete N rows, Delete column / Delete N columns
- Restore row / Restore N rows, Restore column / Restore N columns
- Move row / Move N rows, Move column / Move N columns
- Rename column (existing, now also for Pending Columns)

Undo and redo within the session restore the layout, including tombstones, and
the content of discarded Pending Rows, Pending Columns, and source cell edits.
No formula text needs restoring, because formulas are rendered from anchors.

A save that writes any layout change other than appends and Pending Tail
Removals installs a workbook-wide history barrier with the new reason
`structural-save`. Undo then reports:

```text
Can't undo past a save that inserted, deleted, or moved rows or columns.
```

The barrier lives in the in-memory history like `action-too-large`; history is
not persisted. Cross-save undo of structural changes is out of scope for this
version: after such a save, every recorded source coordinate in the workbook's
history may name different content, and restoring deleted XLSX rows would need
their styles, merges, and formulas.

### Saving and discarding

Save writes the prospective layout. Review Changes lists, per worksheet, the
counts of inserted, deleted, and moved rows and columns, so the user can see
what Save will remove before it becomes permanent. Exiting Edit mode with
structural changes offers Save, Discard, and Cancel, as with any Pending
Change. Discard restores the source layout.

### External changes

The first layout change on a worksheet records its Structural Basis:

- CSV and TSV: the file's byte length and SHA-256 digest.
- `.xlsx`: SHA-256 digests of the parts the planner reads to restructure the
  worksheet: the worksheet part, `sharedStrings.xml`, `styles.xml`, and
  `workbook.xml`. A tool that rewrites only another worksheet's part leaves
  this basis intact. Excel itself rewrites the shared parts on nearly every
  save, so in practice an external Excel save conflicts; the finer basis only
  helps generators that touch one sheet. The workbook-wide formula rendering at
  save reads the current file, so other worksheets are always rendered as they
  are at save time.

On refresh, a worksheet with layout changes other than appends and Pending
Tail Removals is reconciled this way:

1. If its basis still matches, nothing changes.
2. For CSV and TSV, the change counts as rows appended on disk only when all
   of these hold:
   - the new file is longer, and its first `byteLength` bytes have the
     recorded digest;
   - the old content ended with a record terminator, outside any quoted
     field, so the new bytes cannot be continuing the old last record;
   - the parser, run over the new file, yields exactly the old records first;
   - the column count and header are unchanged.

   Then the new source rows join the layout as one source run placed
   immediately after the layout position of the highest-numbered old source
   row's run, wherever a move left it, and before the Pending Appended Rows.
   The basis advances. Any other change falls through to step 3. This rebase
   never has to move a formula: CSV and TSV have no formulas (a value that
   starts with `=` is text), so no Formula Anchor, `trailing` or otherwise,
   exists on a delimited worksheet. `.xlsx` has no growth rebase; any change
   to its basis is a conflict.
3. Otherwise the worksheet gets a `structuralBasisChanged` conflict, and Save is
   refused. An external change also cannot move the Header Row out from under
   the layout: a re-detected Header Row arrives only with a changed file, which
   this step catches. The Header Row toggle is disabled in Edit mode in the
   webview today; the host's `setExcelFirstRowHeader` handler now also refuses
   while any worksheet of the file has a layout change, so a stale message
   cannot change it. Review Changes shows:

```text
Sales changed on disk after you inserted, deleted, or moved rows or columns.
Table Viewer can't tell where those changes belong in the new version.
```

It offers three actions:

- **Keep new rows at the end**: converts every live Pending Inserted Row to a
  Pending Appended Row, in layout order: it sets `origin` to `append`, assigns
  fresh `createdOrder` values after the band's highest, moves the rows to the
  end of `appendedRows`, and removes them from the layout. It drops removals,
  moves, Pending Columns, and tombstones, so the worksheet is left with the
  source layout and no Structural Basis, and its appended rows, which keep the
  worksheet's `appendBasis`, then reconcile by today's append rules. The history delta records the old origins, orders,
  and array positions, so Undo restores them.
  Typed content in inserted rows survives, except content in Pending Columns,
  which the notice counts: "Values typed in 2 new columns will be discarded."
- **Discard row and column changes on Sales**: drops Pending Inserted Rows,
  Pending Columns, removals, moves, and tombstones, leaving the source layout
  and no Structural Basis.
- **Dismiss notice**.

Both actions are one history action and keep cell edits on source cells and
Pending Appended Rows, which then reconcile by today's rules. Formulas
anchored to identities that the action discards render as `#REF!`, and
dropping inserted rows lowers *N*, so `trailing` references move up; the
notice counts both before the user chooses: "4 formulas will show #REF! and
12 will point at different rows."

Appended-only sessions keep today's behavior: external growth rebases Pending
Appended Rows.

## Model

### Row and column identities

`RowIdentity` is unchanged. Add the column twin:

```ts
export type PendingColumnId = string;

export type ColumnIdentity =
    | { readonly kind: 'source'; readonly sourceColumn: number }
    | { readonly kind: 'pending'; readonly pendingColumnId: PendingColumnId };
```

Pending column IDs follow the pending row ID rules: opaque, host-minted,
worksheet-scoped, at most `MAX_PENDING_ROW_ID_LENGTH` characters, validated for
uniqueness at every durable and wire boundary.

### Worksheet Layout

```ts
/** Body rows, live or tombstoned, in prospective order, compressed into runs. */
export type RowLayoutRun =
    | { readonly kind: 'source'; readonly start: number; readonly count: number }
    | { readonly kind: 'pending'; readonly ids: readonly PendingRowId[] };

export interface DiscardedPendingRow {
    readonly id: PendingRowId;
    readonly createdOrder: number;
}

export interface RowLayout {
    readonly runs: readonly RowLayoutRun[];
    /** Pending Row Removals: source body rows, as sorted disjoint intervals. */
    readonly removedSourceRows: readonly { readonly start: number; readonly count: number }[];
    /** Discarded Pending Inserted Rows, kept for formula rendering and never displayed. */
    readonly discardedPendingRows: readonly DiscardedPendingRow[];
}

export interface ColumnLayout {
    /** Every column, live or tombstoned, in prospective order. */
    readonly columns: readonly ColumnIdentity[];
    readonly removedSourceColumns: readonly number[];
    readonly discardedPendingColumns: readonly { readonly id: PendingColumnId; readonly createdOrder: number }[];
}
```

**The append band is not in the row layout.** The row layout orders source
body rows and Pending Inserted Rows. Pending Appended Rows stay exactly where
they are stored today: in `appendedRows`, in `createdOrder`, after every row of
the layout. So the existing Append dock, Enter and Tab past the last row,
paste past the end, Remove pending rows, the `rowAppend` and `pendingRows`
history arms, and their replay keep working without knowing a layout exists,
and nothing they do can break a layout invariant.

Order and removal are stored separately, so deleting rows never splits a run:
deleting 5,000 scattered rows of a filtered view adds removal intervals and
leaves one source run. Only inserts and moves split runs.

The row layout covers body rows only. Rows at or above the Header Row are fixed
and never appear in it. A row or column is **live** when it is neither removed
nor discarded; otherwise it is a **tombstone**. The **live layout** is the
layout without tombstones, followed by the live append band; it is what the
file will contain after save.

`PendingAppendedRow` gains `origin: 'append' | 'insert'`; absence means
`append`, so stored rows from before this change are appends. Origin is fixed
at admission, except that "Keep new rows at the end" and its Undo may switch
an inserted row between `insert` and `append`. The admission ledger records
which request kind minted each ID. Publication accepts origin `insert` only
for an ID minted by an insert, and origin `append` for any admitted ID, so
salvage and its Undo publish cleanly while an appended row can never pose as
an inserted one.

`appendedRows` now holds both origins under its old persisted name, so every
existing consumer reads it through two accessors, `appended_rows()` and
`inserted_rows()`, and a test fails if any module outside `pending-changes.ts`
reads the raw array. This matters most for `reconciled_against`'s
provisional-band loop, both save planners, the receipt, and the saved-append
authorities. The physical row of the *i*-th live appended row is
*H + N + i*, the end of the live layout, not today's
`retained_row_count + index`; the two agree on a worksheet without a layout.
Here *H* is the 1-based number of the Header Row (0 without one), *N* counts
body rows, and *i* is 1-based, so *H + N + i* is a 1-based worksheet row; the
0-based physical row the planners use is one less. Tests include a Header Row
that is not the first row.

Invariants, enforced by one validator used by the webview store, the durable
codec, the wire codec, and the save planner:

1. Every source body row appears in exactly one source run.
2. Every row of `appendedRows` with origin `insert` appears in exactly one
   pending run. No row of origin `append` appears in any run.
3. Every discarded ID appears in exactly one pending run, was minted by the
   session's admission ledger as an insert, and is not in `appendedRows`.
   `createdOrder` values are unique across live and discarded Pending Rows.
4. Runs are canonical: no empty run; no two adjacent source runs where
   `a.start + a.count === b.start`; no two adjacent pending runs.
5. `removedSourceRows` intervals are sorted, disjoint, non-adjacent, and within
   the body.
6. Every source column appears exactly once in `columns`. Every Pending Column
   and every discarded Pending Column ID appears exactly once. A discarded ID
   has no entry in `pendingColumns`.
7. `runs.length ≤ 10,000`; `removedSourceRows.length ≤ 100,000`;
   `columns.length ≤ 512`; live columns `≤ MAX_SHEET_COLUMNS` (256).
8. A worksheet with a **live layout change** (below) has no Pending Tail
   Removal and no pending cell move.

An action that would break invariant 7 is refused before it enters history,
with "Can't insert or move rows here without saving first: this sheet has too
many separate row changes." for runs, and "Can't delete this many separate
groups of rows at once. Save first, or delete fewer." for removals.

The **source layout** is one source run covering the body (none for a
header-only sheet), every source column in order, and nothing else. A layout
is stored (`rowLayout` or `columnLayout` present) whenever it differs from the
source layout. It has a **live layout change** when its live layout differs
from the source layout's: a live Pending Inserted Row or Pending Column, a
removal, or a moved run. A live layout change records the Structural Basis,
triggers the exclusivity rules, and makes references to the worksheet store
explicit anchors. Everywhere else in this document, "layout change" means a
live layout change.

A layout whose only difference is discarded tombstones exists only so that
stored anchors can render, and it is not a live layout change: it records no
basis and triggers no exclusivity. On any external change to the file, its
tombstones are dropped, and anchors that named them render `#REF!`. The refresh
notice counts them: "2 formulas now show #REF! because rows they named were
removed before the file changed."

**Appending on a worksheet with a layout.** Append admission additionally
checks the Structural Basis and the exclusivity rules, as insert admission
does. "Insert row below" or "Insert N rows below" on the last row of the
append band appends instead. A selection that spans both the body and the band
disables Insert and Move, and band rows themselves cannot be moved or have rows
inserted among them: "Appended rows stay at the end until you save."

#### Tombstones move with their live neighbor

A tombstone is glued to the nearest live row or column before it in the
layout, or to the start of the layout when none precedes it. Every operation
preserves that gluing:

- Moving a live row or block carries the tombstones glued to each moved row
  with it, in order.
- Insert and Move anchor on live rows. A selection that contains only
  tombstones disables both. Insert below a selection that ends in a tombstone
  anchors on the last live row of the selection and lands after that row's
  glued tombstones.
- One step of "Move rows up" or "Move rows down" passes one live row together
  with its glued tombstones. A drag drop that lands between a live row and its
  glued tombstones resolves to after those tombstones, the same place Insert
  would put a row.
- A tombstone cannot be moved by itself. A selection that mixes live rows and
  tombstones moves the live rows, and their glued tombstones come along.
- Inserting before a live row places the new rows after the tombstones glued
  to the row before it, so the new rows never separate a tombstone from its
  live neighbor.
- Deleting a live row turns it into a tombstone in place; its own glued
  tombstones then glue to the same live row it now glues to.
- Restoring a tombstone makes it live in place.

So a gesture changes which live rows surround a tombstone only when it changes
the live order around it. Formula rendering depends on that property. Columns
follow the same rules, with "left" for "before".

Discarded Pending Inserted Rows and Pending Columns are tombstones that are
never displayed. Their IDs count against the session's 10,000 Pending Row
admissions and 256 Pending Column admissions, which bounds them. When an action
leaves a discarded tombstone unreferenced by any stored Formula Anchor, the
store drops it in the same action. A discarded Pending Appended Row leaves no
tombstone, as today: an anchor that named it renders `#REF!`, even as a range
corner (see "Where this differs from Excel").

### Pending Columns

```ts
export interface PendingColumn {
    readonly id: PendingColumnId;
    /** Header cell value, used when the worksheet has an active Header Row. */
    readonly header: string;
    /** Cells in this column, keyed by row identity key. */
    readonly cells: Readonly<Record<string, PendingRowCell>>;
    readonly highlights?: Readonly<Record<string, CellHighlightColor>>;
    readonly viewerWidth?: number;
    readonly format: PendingColumnFormat;
    readonly createdOrder: number;
}
```

The row identity key is `s:<sourceRow>` for a source row, `p:<pendingRowId>`
for a Pending Row, and `f:<row>` for a fixed row at or above the Header Row.
Ownership rule: **a cell belongs to its Pending Column if it has one,
otherwise to its Pending Row if it has one, otherwise it is a source cell.**
Pending Row `cells` therefore remain keyed by source column only.

`PendingColumnFormat` is `{ kind: 'none' }` for CSV and TSV. For `.xlsx` it is
`{ kind: 'source', sourceColumn }`, naming the source column whose per-row cell
styles and `<col>` attributes the new column copies, or `{ kind: 'default' }`.
It is fixed when the column is inserted and never follows later layout changes
(see "Formatting inheritance").

### Formula Anchors

A formula's references are anchored to the identities they name. Source
formulas, and pending formulas committed while every worksheet they reference
had the source layout, are **implicitly anchored**: their text is in source
coordinates, which identify source rows and columns directly. A pending formula
stores explicit anchors for a reference when, at commit time, the target
worksheet has a layout change, or any corner of the reference lands on a
Pending Row or Pending Column. Only those references are stored; the rest stay
implicit.

So a plain cell edit that names only source cells never stores anchors, and a
reference to a Pending Row keeps naming that row wherever it moves and becomes
`#REF!` if it is discarded, as in Excel. A structural action on one
worksheet never has to touch any formula on another worksheet: a formula that
was implicitly anchored when it was committed stays correct, because at that
moment its targets' prospective coordinates were their source coordinates.

```ts
export type RowAnchor =
    | { readonly kind: 'identity'; readonly row: RowIdentity }
    | { readonly kind: 'fixed'; readonly row: number }        // at or above the Header Row
    | { readonly kind: 'trailing'; readonly offset: number }  // past the source body; see below
    | { readonly kind: 'edge' };                              // row 1,048,576

export type ColumnAnchor =
    | { readonly kind: 'identity'; readonly column: ColumnIdentity }
    | { readonly kind: 'trailing'; readonly offset: number }  // past the last source column
    | { readonly kind: 'edge' };                              // column XFD

export interface FormulaReferenceAnchor {
    /** UTF-16 span of the reference token in the stored formula text. */
    readonly start: number;
    readonly end: number;
    /** Target worksheet; omitted for the formula's own worksheet. */
    readonly worksheet?: WorksheetTarget;
    /** Corners in the order the author wrote them; one corner for a single cell. */
    readonly corners: readonly {
        readonly row?: RowAnchor;       // absent for whole-column references
        readonly column?: ColumnAnchor; // absent for whole-row references
    }[];
}

export interface FormulaAnchors {
    readonly references: readonly FormulaReferenceAnchor[];
}
```

`PendingRowCell`, the Pending Column cell, and `CsvDirtyEntry` gain an optional
`formulaAnchors`. The stored text keeps the author's `$` flags and spelling;
rendering replaces only the coordinate characters inside each anchored span.

Anchoring happens at commit time, and only on an `.xlsx` worksheet. The shared
edit-session registry classifies any value starting with `=` as a formula
input regardless of format (`edit-session-registry.ts`); anchoring checks the
worksheet's format first and never anchors a CSV or TSV value, and the
codecs refuse `formulaAnchors` on a delimited worksheet. The committed formula
is lexed (see
"Reference lexing"). For each reference to a worksheet with a layout change,
each corner's prospective coordinate is resolved against that worksheet's live
layout to an identity, or to `fixed`, `trailing`, or `edge` when it lies
outside the rows and columns the layout holds. If the lexer cannot anchor such
a reference, the commit is refused with the lexer's reason, for example "Table
Viewer can't adjust the reference `INDEX(A:A,1):B5` while rows on this sheet
are being moved."

An implicit anchor is derived from source text the same way, against the
source layout: a coordinate inside the source body is an `identity` anchor, a
coordinate at or above the Header Row is `fixed`, and a coordinate past the
last source body row is `trailing` with `offset = row − last source body row`.
Columns follow the same rule.

**`trailing` rows.** Let *N* be the number of live rows in the row layout:
live source rows, not counting Pending Tail Removals, plus live Pending
Inserted Rows. The append band always
follows the layout, so *N* never depends on where a row sits. A `trailing` anchor with offset *k* names prospective body row
*N + k*: the *k*-th live Pending Appended Row when there are at least *k*,
otherwise an empty row past them. That is exactly where Append puts row *k*
today, so:

- appending never shifts a reference: `=A11` over a 10-row body names the
  first appended row, and `=SUM(A2:A1000)` stays `A2:A1000`;
- discarding an appended row compacts the band and leaves `trailing` numbers
  unchanged, as today;
- inserting a row anywhere before the band adds one to *N*, and deleting a
  source row subtracts one, as Excel shifts every row below an insertion or
  deletion; moving rows within the body changes neither.

A `trailing` reference that would render past row 1,048,576 renders `#REF!`.
`trailing` columns work the same way, with *N* counting live source columns
plus live Pending Columns; there are no appended columns.

At commit time, a coordinate on a live Pending Appended Row becomes an
`identity` anchor on that row, so it follows the row and renders `#REF!` once
it is discarded. Only a coordinate below every live row, layout and band,
becomes a `trailing` anchor, with `k` equal to its body row minus *N*.

**Source-layout worksheets.** On a worksheet with the source layout,
implicitly anchored references render as their own text, so today's append and
tail-removal behavior is unchanged byte for byte. Explicitly anchored
references to a Pending Row render that row's current number, or `#REF!` once
it is discarded.

The existing `formulaReferenceBases` and the `ambiguousPendingFormula` conflict
keep working on worksheets with the source layout for formulas without stored
anchors. A formula that stores anchors drops its bases, because its anchors
already name the rows: the anchors win, and external growth needs no conflict
for it. Once a worksheet has a layout change, its Structural Basis refuses the
external growth that those bases exist to detect.

### Rendering formulas

Rendering turns stored text and anchors into text for the current layouts. It
is used by the editor, the calculator, the Review Changes list, and the save
planner, so all four always agree.

For each axis of each anchored reference, place every corner in the target
worksheet's **extended order**: `fixed` rows first, then the full layout with
its tombstones, then the live append band in `createdOrder`, then empty rows
past it, then `edge`. A `trailing` corner with offset *k* sits at the *k*-th
live Pending Appended Row when there are at least *k*, and otherwise at the
empty row numbered *H + N + k*. It is live in both cases. An identity anchor on
a Pending Appended Row sits at that row in the band.

A live member's row number is its prospective row for a layout row,
`fixed.row` for a `fixed` anchor, *H + N + k* for a `trailing` anchor, where
*H* is the Header Row's number (0 without a Header Row), and 1,048,576 for
`edge`.

- A single-cell reference renders its corner's live coordinate, or `#REF!` if
  the corner is a tombstone or an identity that no longer exists.
- A range takes the interval between its corners' positions in the extended
  order and renders the smallest and largest row numbers among the interval's
  live members. If the interval has no live member, the reference renders
  `#REF!`.
- Whole-row references (`3:5`) have no column corners; whole-column references
  (`A:C`) have no row corners.
- `$` never pins a reference against structural change, matching Excel.
- References to other workbooks (`[1]Sheet1!A1`) are not anchored and render
  unchanged.
- Structured references (`[Revenue]`, `[@Revenue]`, `Sales![Revenue]`) are not
  anchored. They name a column by header text and follow it wherever it moves.
  If the named column is removed, the reference no longer resolves and shows as
  an Unknown formula result, which is what Excel shows as `#REF!`.

These rules reproduce Excel's behavior for the common cases. An insertion
between two corners expands the range. An insertion before the first corner
shifts it. A deletion moves a removed corner inward to the nearest live row. A
move carries each corner with its row: rows moved out of the interval leave
the range, and rows moved into it join, which is Excel's cut-insert behavior
for ranges whose corners do not move.

**Where this differs from Excel.** Excel adjusts references one gesture at a
time, so its result can depend on the order of gestures. This design renders
from the final state, so it cannot follow Excel in three narrow classes:

1. **Corner-crossing moves**: a move carries one corner of a range past the
   other.
2. **Refilled corner gaps**: a range corner was deleted, and rows were then
   inserted or moved into the gap between that tombstone and its live
   neighbors. Excel shrinks a deleted start corner toward the next row and a
   deleted end corner toward the previous row at the moment of deletion, so
   whether a later insertion beside it falls inside the range depends on
   which gesture came first. Here the tombstone's glued position decides.

3. **Discarded appended corners**: a range corner named a Pending Appended Row
   that was then discarded. Discarded appends leave no tombstone, so the
   reference renders `#REF!`, where Excel would shrink the range.

The design accepts these differences rather than refusing the gestures, which
would block ordinary edits whenever a row happens to be a range corner. Review
Changes lists every formula that might be in any of these classes — "3 formulas have a
range whose first or last row was moved or deleted; check them before
saving." — with Go to cell.

The flag is a deliberate superset, decided per range reference and per axis:

- the reference's corners appear in the opposite order in the extended order
  from the order they had when the formula was anchored (the source order for
  implicit anchors, the commit-time layout for stored ones);
- a corner is a tombstone, and the axis has any Pending Inserted Row or Column
  or any run out of ascending source order;
- a range renders `#REF!` because a corner named a discarded Pending Appended
  Row;
- a corner lies in a source run that is out of ascending source order with
  the nearest source run on either side, skipping pending runs, which covers
  every row a move carried, whether or not the moved tint marks it.

Step 2 may narrow these rules only with oracle evidence that a narrowed case
matches Excel.

**Oracle criterion.** No Excel or LibreOffice is available to step 2, so its
fixtures (`src/test/formula-anchors.test.ts`, "Excel oracle fixtures") are
hand-written from Excel's documented insert and delete reference-adjustment
rules, and every insert and delete case must match those rules exactly. Move
cases and the three classes above are covered by the flagged superset. Running
Excel-generated fixtures is a follow-up that must happen before step 10 flips
the capability flag.

Because rendering is a function of the anchors and the full layouts, two
operation sequences that produce the same full layouts produce the same text.
That is the rendering module's central property test.

### Worksheet Pending Changes

Extend `PendingStructuralChanges`:

```ts
export interface PendingStructuralChanges {
    readonly formatTemplates: readonly PendingRowFormatTemplate[];
    readonly appendedRows: readonly PendingAppendedRow[]; // every live Pending Row
    readonly tailRemovals: readonly PendingTailRemoval[];
    readonly appendBasis?: PendingAppendBasis;
    readonly conflicts: readonly PendingStructuralConflict[];
    readonly rowLayout?: RowLayout;          // absent = source layout
    readonly columnLayout?: ColumnLayout;    // absent = source layout
    readonly pendingColumns?: readonly PendingColumn[];
    readonly structuralBasis?: StructuralBasis;
}

export type StructuralBasis =
    | {
        readonly kind: 'delimited';
        readonly byteLength: number;
        readonly digest: string;
        readonly sourceRowCount: number;
        readonly sourceColumnCount: number;
    }
    | {
        readonly kind: 'xlsx';
        readonly worksheetPartDigest: string;
        readonly sharedStringsDigest: string | null;
        readonly stylesDigest: string | null;
        readonly workbookDigest: string;
        readonly sourceRowCount: number;
        readonly sourceColumnCount: number;
    };
```

`appendedRows` keeps its persisted name because the decoder, the SQLite JSON
paths, and the legacy wire shape use it; it now holds every live Pending Row.
The new fields are optional, and absence means the source layout, so envelopes
written before this change decode unchanged. Writers omit the new fields while
they equal the source layout or are empty.

### Durable versioning

The durable decoder (`decode_pending_edits` in `src/types.ts`) rebuilds each
slot from the fields it knows, so an older build would silently drop
`rowLayout` and keep the rows it understands at the wrong coordinates. To
prevent that, `stringify_stored_per_file_state` writes
`{ version: 2, sheets, rekeyIntent? }` whenever any slot carries `rowLayout`,
`columnLayout`, `pendingColumns`, or `structuralBasis`, whenever any Pending
Row carries `origin: 'insert'`, whenever any cell entry, Pending Row cell, or
Pending Column cell carries `formulaAnchors`, or whenever a rekey intent is
stored; and `{ version: 1, sheets }` otherwise. The cell-entry decoder drops
unknown fields too, so `formulaAnchors` is listed as a trigger explicitly.
Anchors are stored only for references to a worksheet with a layout change or
to a Pending Row or Column, so ordinary cell editing keeps writing version 1;
an append-only session writes version 2 once a formula names an appended row.
A live Pending Row of origin `insert` is a live layout change, so `rowLayout`
is present and the envelope is version 2 whenever one exists; `origin` itself
is also listed as a trigger, so no version-1 build can read an inserted row as
an append.

An older build rejects any version other than 1, so its repository treats the
entry as malformed and leaves it alone. The new decoder accepts both versions.
The rekey intent lives in this envelope rather than as a new top-level
per-file field, so an older build cannot read the state without the intent and
silently drop it on its next write.

Step 3 adds tests that:

- decode every legacy shape with the new decoder;
- write a version-2 entry and run the version-1 decoder from the previous
  release against it, through `decode_state_json`, to prove it reports the
  entry malformed and that the repository writes nothing over it;
- run every existing decoder test against both versions.

The wire codec (`own_wire_pending_changes`) is already key-strict. It gains the
new fields, and `structuralBasisChanged` and `unsupportedStructure` join
`PendingStructuralConflictReason` in both hard-coded sets.

### Peer compatibility

The host and webview ship in one bundle, but an older webview can outlive an
update until its window reloads, and the codebase already keeps legacy
decoders for that case. Three rules keep an older peer from overwriting layout
state:

1. The webview's ready message declares `structuralLayout: 1`. The host grants
   an edit session on a file whose durable state is version 2 only to a peer
   that declares it. An older peer gets the existing refusal path with "Reload
   this window to keep editing this file."
2. A legacy-shaped publication (`pendingEditsChanged`, or `pendingChangesChanged`
   without layout fields) keeps the slot's stored layout fields, as
   `with_pending_edits_for_sheet` already keeps structural fields today.
   Appended rows it adds or removes belong to the append band, which the
   layout does not hold, so they need no placement. The host runs the layout
   validator over the complete result and refuses the publication if it fails,
   for example because it dropped a Pending Inserted Row the layout still
   names, or if any of its cell keys addresses a removed row or column.
3. While `STRUCTURAL_EDITING_ENABLED` is false, the host rejects any
   publication or save that carries layout fields, so an intermediate release
   never accepts layout data it cannot write.

Tests cover each rule, plus an upgrade with a version-1 durable entry and a
downgrade with a version-2 entry.

### Cell edits on removed rows and columns

Deleting a source row or column discards every pending cell value in it in
the same history action, so Undo restores them all:

- source cell edits in the removed row or column, as `cell` history deltas;
- Pending Row cells in a removed source column, as Pending Row snapshots;
- Pending Column cells in a removed source row, as Pending Column snapshots. Highlights on removed source cells stay stored until save, as for Pending
Tail Removals, and are dropped by the post-write rekey. The save planner
rejects any cell edit addressed to a removed row or column as an
internal-consistency error.

## Reference lexing

Add a reference tokenizer to `src/xlsx-formula.ts` that the anchoring step, the
renderer, the structural support scan, and the writer share. Unlike
`a1_formula_reference_at`, which returns normalized bounds, each token keeps:

- its UTF-16 span in the formula text;
- each corner's own text span, in authored order;
- each corner's `$` flags;
- each corner's sheet qualifier, so `Sheet1!A1:Sheet1!B2` is read correctly;
- its kind: cell, range, whole rows, whole columns.

The tokenizer reports, without guessing, any construct it cannot anchor:

- a range operator with a non-reference operand (`INDEX(A:A,1):B5`, `A1:B2:C3`
  chained through a function result);
- 3D references (`Sheet1:Sheet3!A1`);
- spill references (`A1#`);
- R1C1 text.

`INDIRECT`, `OFFSET`, and `ADDRESS` with text arguments are not references and
are not adjusted, as in Excel. The union and intersection operators need no
special handling, because each operand is its own token.

## XLSX

### Structural support

Add `src/xlsx-structural-support.ts`. At edit grant, and again whenever the
source generation changes, the host scans the verified package and returns, per
worksheet:

```ts
interface WorksheetStructuralSupport {
    readonly rows: StructuralAxisSupport;
    readonly columns: StructuralAxisSupport;
    /** Merged ranges, for action-time merge checks. */
    readonly merges: readonly string[];
    /** The worksheet AutoFilter, for the action-time filtered-column check. */
    readonly autoFilter?: { readonly ref: string; readonly filteredColumns: readonly number[] };
    /** Conditional-formatting and validation rules with relative references. */
    readonly relativeRules: readonly { readonly sqref: string; readonly formulas: readonly string[] }[];
}

type StructuralAxisSupport =
    | { readonly supported: true }
    | { readonly supported: false; readonly reason: StructuralRefusal };
```

The snapshot carries this next to `appendRowCeiling`. CSV and TSV report both
axes supported, except columns when the source is wider than 256.

The save planner runs the same scan against the bytes it is about to rewrite
and raises an `unsupportedStructure` conflict if support has changed, so the
grant-time answer is advisory and the save-time answer is authoritative.

### Allowlist

The scan is an allowlist. A worksheet is supported on an axis only when:

1. every child element of its `<worksheet>` is in the "Coverage" table or the
   coordinate-free list below;
2. it has no `extLst`, or every `<ext>` URI in it is in a reviewed
   coordinate-free list (initially empty);
3. no `mc:AlternateContent` wraps any worksheet child;
4. every part related to the workbook or the worksheet is a coordinate-free
   part, a part the coverage table rewrites, or a part that cannot reference
   the worksheet;
5. every formula in the workbook that may reference the worksheet lexes
   completely, in cells, defined names, conditional formatting, data
   validation, and internal hyperlink locations;
6. it contains no array formula (`<f t="array">`) or data table
   (`<f t="dataTable">`), and no array formula or data table on another
   worksheet references it. Relocating a group's `ref` and its anchor cell
   correctly for every move and deletion is a follow-up; until then any group
   refuses the whole worksheet rather than relying on split detection.

**Coordinate-free worksheet children**: `sheetPr`, `sheetFormatPr`,
`sheetCalcPr`, `sheetProtection`, `printOptions`, `pageMargins`, `pageSetup`,
`headerFooter`, and `phoneticPr`. (`protectedRanges` and `webPublishItems` are
separate elements and refuse.)

**Coordinate-free parts**: styles, theme, shared strings, calc chain (removed),
document properties, custom XML, and the content-types and relationship parts
the writer already maintains.

Everything else refuses with a reason naming it. The reasons users will most
often see, and the expected follow-ups, are:

| Refusal | Why |
|---|---|
| `tableParts` | table ranges, column lists, and calculated columns |
| a drawing (images, charts, shapes), `oleObjects`, `controls` | anchors and chart `c:f` formulas |
| a chart anywhere whose series reference the worksheet | chart formulas live outside worksheet XML |
| legacy comments/notes or threaded comments | comment refs and VML anchors |
| pivot tables or caches, slicers, timelines, query tables, connections | their own source ranges |
| `extLst` with x14 conditional formatting, data validation, or sparklines | `xm:sqref`/`xm:f` |
| `customSheetViews`, `protectedRanges`, `scenarios`, `dataConsolidate` | their own references |
| a data table or array formula as above, including the single-cell dynamic-array formulas Excel writes for `FILTER`, `SORT`, `UNIQUE`, and `XLOOKUP` | their `ref` and inputs are references; the reason names the cell, for example "Can't move rows on this sheet: cell D2 has an array formula." |
| a formula the lexer can't anchor | it cannot be adjusted |

Action-time checks run in the webview against the shipped `merges`: an
operation the merge rules forbid is refused before it enters history.

The inventory behind the allowlist was taken from ECMA-376 Part 1, §18.3.1
(worksheet children) and §18.2 (workbook). Step 9 commits it as a table in
`xlsx-structural-support.ts`, one row per element, naming whether each is
covered, coordinate-free, or refused, with a test that fails when the scanner
meets an element missing from the table.

### Coverage

Two reference semantics apply, chosen per structure:

- **Interval semantics** for formula references: the anchor rendering above.
- **Cell-set semantics** for structures that attach to cells: each listed cell
  follows its row and column identity, removed cells drop out, and a Pending
  Inserted Row or Pending Column joins when its live neighbors on both sides
  along the axis are both in the set. Moved cells carry the attachment with
  them. The result is re-encoded as the fewest rectangles, in row-major order.

| Structure | Semantics | Rows | Columns |
|---|---|---|---|
| `<row r>` and every `<c r>` | — | renumber; reorder row elements; drop `spans` | renumber; reorder cells in each row; drop `spans` |
| `<dimension>` | — | recompute from the written cells | recompute |
| `<cols>` | cell-set on columns | n/a | split, shift, and re-merge `min`/`max` ranges; a Pending Column copies its neighbor's `<col>` |
| `<mergeCells>` | cell-set | shift; insert inside expands; delete shrinks; a merge left as one cell is removed | same |
| `<hyperlinks>` `ref` | cell-set | shift; removed cells drop their link and its relationship | same |
| `<hyperlinks>` `location` (internal targets, every worksheet) | interval | remap | remap |
| `<conditionalFormatting>` `sqref` | cell-set | shift | same |
| `<conditionalFormatting>` `<formula>` (every worksheet) | interval, anchor-relative | see below | same |
| `<dataValidations>` `sqref` | cell-set | shift | same |
| `<dataValidations>` `<formula1>`/`<formula2>` (every worksheet) | interval, anchor-relative | see below | same |
| `<autoFilter ref>` | interval | shift | shift; renumber every `<filterColumn colId>` relative to the new start; drop one for a removed column; a move that would carry a filtered column outside the rendered range is refused at action time (below) |
| `<sortState ref>`, inside `<autoFilter>` or on the worksheet | interval | shift; drop the `sortState` if its `ref` renders `#REF!` | shift; same |
| `<sortCondition ref>` | interval | shift | shift; drop a condition on a removed column |
| `<sheetView topLeftCell>`, `pane topLeftCell`, `selection activeCell`/`sqref` | interval | shift; a removed target resets to the first live body cell | same |
| `<sheetView>` `pane xSplit`/`ySplit` | — | unchanged: frozen row count stays; `pane topLeftCell` is then clamped to at least row `ySplit + 1` | unchanged; clamped to at least column `xSplit + 1` |
| `<rowBreaks>` / `<colBreaks>` | cell-set | shift; breaks on removed rows dropped | same |
| `<ignoredErrors>` `sqref` | cell-set | shift; empty entries dropped | same |
| Cell formulas, every worksheet | interval | render | render |
| Shared formula groups | — | a group whose cells all shift together, keeping their relative positions, and whose rendered master text is unchanged gets its master's `ref` re-rendered by cell-set semantics; unshare any other affected group, writing each follower's formula explicitly | same |
| `<definedNames>`, including `_xlnm.Print_Area`, `_xlnm.Print_Titles`, `_xlnm._FilterDatabase` | interval | render | render |
| `calcChain.xml` | — | remove (existing path) | same |
| Formula caches | — | invalidate (existing path) | same |

**Anchor-relative formulas.** Conditional-formatting and data-validation
formulas are relative to the top-left cell of their `sqref`: each covered cell
evaluates the formula shifted by its offset from that cell. One rewritten rule
cannot always preserve that for every cell after a move. For `sqref="A1:A2"`
with formula `B1`, moving row 1 below row 2 makes the old A1 cell refer to the
old B1 from row 2 and the old A2 cell refer to the old B2 from row 1, so no
single relative formula covers both.

The writer therefore splits rules by meaning:

1. For each covered cell after the layout, take the formula as that cell
   evaluated it in the source (absolute, at the cell's old offset), render it
   through the layout, and re-express it relative to the cell's new position.
   A Pending Inserted Row or Pending Column cell that joins the `sqref` by the
   cell-set rule takes the relative formula of the live covered cell before it
   on that axis, as if the rule were filled into it.
2. Group cells whose relative formulas are textually identical. Each group
   becomes one rule, with the original rule's attributes and priority, over
   the group's cells re-encoded as rectangles. The first group keeps the
   original element; extra groups follow it in document order with the next
   priorities, and later rules' priorities shift to stay unique.
3. The relative formula is piecewise constant, so the work runs per piece, not
   per cell. Cut each axis of the full layout into **live segments**: maximal
   stretches of one source run with the same removal status, each Pending Row
   (including each row of the append band) or Pending Column, and each
   discarded tombstone. Along each axis, a piece
   boundary falls at every live-segment boundary of the covered cells and, for
   each relative reference with offset *d*, at every live-segment boundary of
   the referenced worksheet's layout shifted back by *d*. A rule over a whole
   column of unchanged rows is one piece. The writer and the webview's split
   count use the same partition function.

Any operation can split a rule, including an insertion or deletion between a
covered cell and the cell its relative reference names. For `sqref="A1:A5"`
with formula `B5`, inserting a row above row 6 leaves A1 naming B5 and makes
A2:A5 name rows one further down; deleting row 6 instead makes A2's reference
`#REF!` and moves A3:A5's up by one. This preserves what every cell evaluated
before. It differs from Excel, which keeps one rule and lets some cells change
meaning; the design prefers the extra rules to silently changed formatting and
validation.

If one rule would split into more than 64 rules, Save is refused with an
`unsupportedStructure` conflict naming the worksheet and the rule's range. The
structural support ships each rule's `sqref` and formulas with relative
references, so the webview computes the split count as layout changes happen
and Review Changes warns before Save: "Moving these rows would split the
conditional formatting on B2:B500 into 70 rules. Save will refuse it."

**Merges** keep these additional rules, all checked at action time:

- Deleting the anchor (top-left) row or column of a merge that would survive is
  refused: "Can't delete part of a merged cell's first row." Excel moves the
  value; this version does not.
- Moving a block that contains part of a merge is refused: "Can't move part of
  a merged cell."
- Moving a block to a destination strictly inside a merge's span on the move
  axis, between two of its rows or columns, is refused: "Can't move rows into a
  merged cell." Insertion inside a merge still expands it.

**AutoFilter** columns follow the same pattern. A column move whose result
would leave a column that has a `<filterColumn>` outside the rendered
`autoFilter` range is refused at action time: "Can't move a filtered column
outside the sheet's filter range." The structural support ships each
worksheet's `autoFilter` range and its filtered column indexes for that
check.

**Unsharing** is capped. If unsharing would write more than 1,000,000 follower
formulas or more than 64 MiB of formula text in one save, the save is refused
with an `unsupportedStructure` conflict naming the worksheet.

### Physical write

`write_xlsx_workbook_cell_edits` gains a structural stage that runs before cell
edits. For each worksheet with a layout change:

1. Scan rows with `scan_rows` and cut `sheetData` into row-element byte slices
   and, per row, cell-element slices. A row element that owns cells naming
   other rows is split by cell `r` first.
2. Reassemble `sheetData` in prospective order: fixed rows, the live row
   layout, then the live append band in `createdOrder`. Rewrite the `r`
   attribute on every `<row>` and `<c>`. Drop `spans`. Drop removed rows and
   cells. Copy every other byte of each slice unchanged. Write Pending Inserted
   Rows, Pending Appended Rows, and Pending Column cells using the existing
   cell and row builders.
3. Apply the coverage table's rewrites to the rest of the worksheet part.
4. Return a coordinate map that later stages use. Cell edits, hyperlink edits,
   and formula-cache invalidations are addressed in prospective coordinates
   after this stage. This replaces today's implicit "rows never move" ordering,
   and every later stage takes the map explicitly so no stage can use a source
   coordinate by accident.

Then, across the workbook, render every cell formula, defined name,
conditional-formatting and data-validation formula, and internal hyperlink
location that references a changed worksheet. Unshare shared groups whose text
changes.

Every formula is rendered exactly once, from one coordinate basis: a pending
formula from its stored anchors, a source formula from the implicit anchors of
its source text. The save operation carries the anchors on the wire, so the
writer never has to guess whether a formula's text is already in prospective
coordinates.

Byte preservation stays the rule for unchanged parts. A changed worksheet is
rewritten from its own byte slices, so attributes, namespaces, and extension
content inside rows and cells survive.

### Formatting inheritance

This matches Excel's defaults, using the append template capture:

- A Pending Inserted Row copies the format of the live source row above it. A
  row inserted directly below the Header Row copies the row below it, because
  the append design forbids copying header formatting into body rows. A
  header-only worksheet uses default formatting.
- A Pending Column's format is resolved once, at insertion, from the live
  column beside it: the column to its left in the prospective layout, or to
  its right when it is first. If that neighbor is a source column, the format
  is `{ kind: 'source', sourceColumn }`. If it is a Pending Column, the new
  column takes that column's format, so inheritance always ends at a source
  column or the default. If no live column exists, the format is
  `{ kind: 'default' }`. Later moves, removals, or restores of the neighbor do
  not change it; removing the inherited source column still lets the writer
  read that column's styles, because the write reads the Structural Basis
  bytes, where the column still exists.
- At save, a `source` Pending Column cell copies, per row, the `s` of the
  inherited source column's cell in the same row, and the new column copies
  that column's `<col>` width and style. In a Pending Row, the cell copies the
  row template's captured style for the inherited source column instead. A
  `default` column writes no `s` and no `<col>`. Pending Columns copy no
  values, formulas, links, or validation.
- Moved rows and columns carry all their own attributes and cells.

Insertion admission captures the row template through the existing
`capture_xlsx_append_row_format`, generalized to take an anchor row. Column
formatting is resolved at write time against the Structural Basis, which the
save planner has just verified, so it needs no capture. The display reads the
neighbor's rendered formatting from the row loader.

## CSV and TSV

The serializer takes the layout:

1. Rows above the body are written first, with the column layout applied.
2. Live body rows are written in layout order. A source run streams its source
   window in `SAVE_WINDOW`-row reads; a pending run writes Pending Inserted
   Rows.
3. The live append band is written next, in `createdOrder`, as today.
4. Each record is written in live column-layout order: removed columns
   dropped, Pending Column values taken from the Pending Column.

While the column layout is the source layout, the header line is copied
verbatim and ragged records keep their width, as today. Otherwise the header
line is parsed into raw fields with the CSV parser, not taken from the
normalized `columnNames`, and those raw fields are permuted, with removed
fields dropped and Pending Column headers inserted; then every record is
written at the prospective width, so ragged rows are padded. Review Changes
notes "Short rows will be padded to N columns" when a column change pads any
row.

## Webview

### Store

`PendingRowStore` grows into a worksheet structural store that owns the row
layout, the column layout, Pending Rows, and Pending Columns. It stays a
sibling of `EditSessionStore`, which keeps `row:col` source keys only. The
store exposes pure operations:

```ts
insert_rows(anchor: RowIdentity, side: 'before' | 'after', ids: readonly PendingRowId[], template)
delete_rows(identities: readonly RowIdentity[])
restore_rows(sourceRows: readonly number[])
move_rows(identities: readonly RowIdentity[], before: RowIdentity | 'end')
insert_columns(anchor: ColumnIdentity, side: 'before' | 'after', columns: readonly PendingColumn[])
delete_columns(identities: readonly ColumnIdentity[])
restore_columns(sourceColumns: readonly number[])
move_columns(identities: readonly ColumnIdentity[], before: ColumnIdentity | 'end')
```

Each returns the new snapshot, or a refusal reason, and never mutates in place.
A delete of Pending Rows or Pending Columns turns their layout entries into
tombstones and returns their content for history.

### Projection

`pending-row-projection.ts` gains a layout mode, used whenever the worksheet's
body view is untransformed. It walks the row runs with prefix sums over live
and displayed rows, so mapping a grid row to an identity, or an identity to its
grid row and prospective number, is `O(log R)`. Header and pre-header rows come
first, unchanged. Pending Row Removals stay in place. Discarded tombstones are
skipped. The existing transformed mode stays for sorted, filtered, or
row-hidden views, where the only possible layout changes are removals and
appends.

Every grid row that is a source row resolves to its **source-display row**,
the row index the host's (untransformed) view uses, exactly as the projection
already does for source rows ahead of the pending band. Everything the host
supplies by source-display row goes through that mapping:

- the row loader, which fetches the pages that cover the visible grid range's
  source-display rows; a visible range that crosses run boundaries fetches the
  union of their pages, and prefetch extends each interval in its own
  direction;
- row heights from `rowHeightProjection`;
- highlights;
- compare and conflict tints.

Merges on a worksheet with a layout change display unmerged, so the merge
projection needs no layout awareness.

`column-projection.ts` gains the column layout. Display columns are the layout
columns minus hidden source columns and discarded tombstones. The Glide column
id becomes the column identity key: `s:<n>` or `p:<id>`.

### Formula display and calculation

The editor, the cell renderer, and the calculator obtain formula text through
the renderer, for source formulas (implicit anchors) and pending formulas
(stored anchors) alike. Opening the editor on an unedited source formula shows
the rendered text. Committing creates a cell edit whose `base` is the source
text, so base validation still compares against the file, and whose anchors
come from the commit-time lex.

`formula-calculation.ts` receives a prospective cell accessor that maps a
prospective `(sheet, row, column)` to an identity and reads the source value,
cell edit, Pending Row cell, or Pending Column cell. Removed rows and columns
are not addressable. Formula results are keyed by prospective coordinate, as
pending-row results are today.

### History

The existing `rowAppend` and `pendingRows` arms keep their meaning and replay,
because the append band is outside the layout. Add two arms to `HistoryChange`:

```ts
| { readonly kind: 'rowLayout'; readonly delta: StructuralSnapshotDelta }
| { readonly kind: 'columnLayout'; readonly delta: StructuralSnapshotDelta }
```

The delta holds the worksheet's before and after `rowLayout` or
`columnLayout`, the Pending Rows or Pending Columns the action created or
discarded, and their format templates. Discarded source cell edits ride in the
same action as `cell` deltas. Replay is a compare-and-swap against the
structural store, like the existing `pendingRows` arm. Structural deltas count
against the existing history byte budget, and an oversized action installs the
existing action-too-large barrier.

### Admission and races

Inserts need a host round trip, because the host mints IDs and captures
`.xlsx` row templates. While an insert admission is outstanding on a worksheet:

- Save, Undo, Redo, and other structure items on that worksheet are disabled,
  as Save and editing are while an append is installing today;
- the reply is installed only if its anchor identity is still live in the
  layout. Otherwise the admission is released, nothing is installed, and the
  live region announces "Insert canceled because its row was removed."

Deletes, restores, and moves are local and synchronous. The host validates them
when the webview publishes the worksheet's Pending Changes.

The host enforces the same ordering, so a webview bug cannot bypass it:

1. `handle_save` refuses a save while the session's admission ledger holds an
   unsettled reservation on any worksheet in the operation, with the existing
   lifecycle rejection that tells the webview to retry after settling.
2. An admission request that arrives while a save, a discard, a history
   replay, or a cleanup holds the session's lifecycle gate is refused, as
   append admission is today.
3. A reply is installed only if its edit session, receiver epoch, and source
   generation still match the mounted worksheet. A late reply is settled as
   released.
4. The save operation carries the worksheet's complete Pending Changes,
   including the layout, and the host persists exactly that payload before it
   plans bytes, as it does today. No separate publication has to land first.

Tests cover save, discard, remount, and source refresh arriving before the
admission request, between request and reply, between reply and settle, and
after settle.

Each structural action changes exactly one worksheet's Pending Changes, and
formulas on other worksheets are rendered from anchors rather than rewritten,
so the existing per-worksheet publication and acknowledgement sequence stays
atomic for structural actions.

### Drag and drop

Wire the vendored Glide `onColumnMoved`, `onColumnProposeMove`, and
`onRowMoved`. Change the vendored data editor so a drag arms only when the
press lands on a header or row marker inside the current contiguous selection,
and so it moves the whole selected block. Keep the press-and-sweep path
unchanged otherwise. Record the vendored change in `UPSTREAM.json`'s
local-changes list.

## Host

### Admission

```ts
type RequestStructuralInsert = {
    type: 'requestStructuralInsert';
    requestId: string;
    editSessionId: string;
    worksheet: WorksheetTarget;
    sourceGeneration: number;
    axis: 'rows' | 'columns';
    anchor: { readonly row?: RowIdentity; readonly column?: ColumnIdentity };
    side: 'before' | 'after';
    count: number;
};
```

The host validates as `admit_append_rows` does, through the same
single-reservation ledger, plus axis support, the prospective size limits, the
exclusivity rules, and the Structural Basis: the first structural change on a
worksheet records it, and later changes require it to match. A row insert also
records the worksheet's `appendBasis` when it is absent and checks it when
present, exactly as append admission does, because both save planners refuse
a worksheet whose `appendedRows` is non-empty without one. `appendBasis`
describes the source column schema, so column inserts, deletes, and moves
never change it. The reply carries IDs, the row format template when inserting
rows, the Structural Basis, and the `appendBasis`. The
webview settles the admission through the existing `settleRowAdmission`
message, whether it installed the rows or released them. Pending Row IDs come
from the append ledger, so the 10,000-row limit per worksheet per session
covers appends, inserts, and discarded tombstones. Pending Column IDs come
from a parallel column ledger with the same settle and publication checks,
bounded at 256 admissions per worksheet per session. The two ledgers share one
reservation slot per worksheet: while a row admission is unsettled, a column
admission on that worksheet is refused, and the reverse, with the existing
"still being installed" message.

### Publication

`plan_pending_structural_publication` additionally checks the layout
validator, the ledger for every pending ID in the layout, the exclusivity
rules, the action-time merge and array rules, and the Structural Basis.

### Save

The worksheet save operation carries `rowLayout`, `columnLayout`,
`pendingColumns`, and `structuralBasis` alongside today's fields. Before
planning bytes, the host checks:

- the layout validator;
- the Structural Basis against the verified file;
- for `.xlsx`, structural support against the bytes it will rewrite;
- that no cell edit addresses a removed row or column.

A failure is a structural rejection naming the worksheet and reason, shown in
Review Changes.

### Receipt

Extend `PendingChangesSaveReceipt` with one entry per worksheet that had a
layout change:

```ts
interface WorksheetStructureReceipt extends WorksheetTarget {
    /**
     * Complete map of old source body rows: every live source run, in old
     * order, with its new first row. Unmoved but shifted runs are included.
     */
    readonly rowRuns: readonly { readonly from: number; readonly count: number; readonly to: number }[];
    readonly removedRows: readonly { readonly start: number; readonly count: number }[];
    /** Index = old source column; value = new column or null when removed. */
    readonly columnMap: readonly (number | null)[];
    readonly insertedRows: readonly { readonly pendingRowId: string; readonly sourceRow: number }[];
    readonly insertedColumns: readonly { readonly pendingColumnId: string; readonly column: number }[];
}
```

Rows at or above the Header Row map to themselves and are not listed.
`appendedRows` keeps carrying `AppendedRowAssignment` entries for appends.
A save that writes any layout change installs the history barrier, so neither
its inserted rows nor its appended rows feed `commit_saved_append_authorities`:
their cross-save undo is unreachable. Append-only saves keep today's path.

### Rekey intent and post-write rekey

Today the host persists the accepted save payload (`persist_accepted_save`),
plans and produces the bytes, computes their digest, takes a final stat, and
writes the file with no `await` between the final stat and the write. After
the write, a post-write compare-and-set rebases highlights and clears the saved
worksheets' Pending Changes. A structural save adds a durable **rekey intent**
around that write.

```ts
interface StructuralRekeyIntent {
    readonly saveId: string;
    /** Digest of the verified bytes the save read. */
    readonly beforeDigest: string;
    /** Digest of the bytes the save writes. */
    readonly afterDigest: string;
    /** The accepted payload this save retires, per worksheet. */
    readonly worksheets: readonly (WorksheetTarget & { readonly acceptedSequence: number })[];
    /** The complete save receipt: structure entries and appended-row assignments. */
    readonly receipt: PendingChangesSaveReceipt;
}
```

Sequence:

1. Persist the accepted payload, as today.
2. Plan and produce the bytes, as today, which yields `afterDigest`.
3. **New:** store the rekey intent in its own compare-and-set, inside the
   version-2 Pending Changes envelope. This runs before the final stat, never
   between the final stat and the write.
4. Final stat and write, as today.
5. Post-write compare-and-set: apply the intent's rekey, retire the accepted
   payload for each listed worksheet if its stored sequence still equals
   `acceptedSequence`, and clear the intent, all in one transition.

Every abort the host knows happened before the write clears the intent in the
same transition that reports the abort, and keeps the payload: a failed final
stat, a final stat that detects an external change, a refused lifecycle gate,
or a produce failure. Tests cover each of those paths.

If the write throws, the host reads the file's digest. If it equals
`beforeDigest`, nothing was written, so it clears the intent and leaves the
payload for a retry. Otherwise it keeps the intent and treats the file as
unresolved, below.

A save writes an intent whenever any worksheet in it has a layout change, and
the intent carries the whole receipt, including appended-row assignments for
every worksheet in the save, so recovery after a mixed save moves appended
rows' highlights and heights too. Append-only saves keep today's path.

Applying an intent rekeys:

- cell highlights (row and column), dropping removed cells and adding Pending
  Row and Pending Column highlights;
- row heights, dropping removed rows and adding Pending Row heights;
- `hiddenRows`;
- column widths, dropping removed columns and adding Pending Column widths;
- column visibility;
- sort keys and filters, dropping entries on removed columns;
- the transform schema fingerprint, recomputed from the new sheet so the
  rekeyed sort, filters, and visibility survive the reload instead of being
  dropped as a schema mismatch.

Header Row state needs no rekey, because rows at or above the Header Row never
move.

**Recovery.** On load, before any edit grant, the host resolves a stored
intent against the file's current digest:

- **Equals `afterDigest`**: the write finished. Apply the intent, retire the
  payload, and clear the intent, exactly as step 5 does. A later Save
  therefore never re-applies the saved layout to the restructured file.
- **Equals `beforeDigest`**: the write never happened. Clear the intent and
  keep the payload, which reopens as an unsaved session.
- **Neither**: the save may or may not have finished before something else
  changed the file, and a guess either way could attach highlights to the
  wrong rows. Keep the intent and show, in the viewer's notice bar:

```text
Table Viewer can't tell whether your last save of data.xlsx finished, because
the file has changed since.
```

with two actions: **It finished** (apply the intent and retire the payload)
and **It didn't finish** (clear the intent and keep the payload, which then
meets the Structural Basis conflict as usual). The host computes a hint by
checking whether the file's worksheet row counts, column counts, and header
names agree with the receipt, and makes the matching action the default: "The
file's shape matches the saved changes." Retiring a payload parks it, using the
existing parked-slot mechanism, until the next successful save of the file, so
a wrong "It finished" can still be recovered. Editing the file is refused, and
the structurally affected worksheets render without source-keyed highlights,
hidden rows, and widths, until the user chooses. Highlights are never dropped
silently: the README promises that only explicit user actions clear them.

The existing "file was written, but…" path now means step 5 failed with the
intent stored, so the same recovery applies on the next load.

The webview installs the history barrier, maps selection by identity, and
clears the saved structural store after the success receipt, as
`apply_save_receipt` does for appends.

Tests cover a stop after each numbered step, then a reload followed by Save,
including a save that restructures one worksheet and only appends to another;
a write failure with and without changed bytes; and both choices for an
unresolved intent.

## Limits

- 10,000 Pending Row admissions per worksheet per edit session, shared by
  appends, inserts, and discarded tombstones.
- 256 Pending Column admissions per worksheet per edit session.
- 100,000 removal intervals per worksheet.
- 10,000 row-layout runs per worksheet.
- 256 live columns per worksheet, plus at most 256 discarded Pending Column
  tombstones.
- 1,048,576 prospective rows for `.xlsx`; an insertion that would push a
  nonblank row past it is refused, as Excel refuses.
- 1,000,000 unshared follower formulas or 64 MiB of unshared formula text per
  save.
- The existing 8 MiB Pending Changes envelope bound covers the new fields,
  including Formula Anchors. An action or commit that would exceed it is
  refused atomically with the existing "too large" message and changes
  nothing.
- The existing history byte and cell budgets cover structural actions.

## Files and module boundaries

| Concern | Location |
|---|---|
| Layout types, validator, operations, maps, moved detection | new `src/worksheet-layout.ts` |
| Formula Anchors, anchoring, rendering | new `src/formula-anchors.ts` |
| Reference tokenizer | `src/xlsx-formula.ts` |
| Pending Change types and codecs, durable version 2 | `src/pending-changes.ts`, `src/types.ts` |
| Webview structural store | `src/webview/pending-row-store.ts` |
| Row and column projection | `src/webview/pending-row-projection.ts`, `src/webview/column-projection.ts` |
| Menus | `row-context-menu.ts`, `column-context-menu.tsx` |
| Drag and drop | vendored `data-grid-dnd.tsx`, `data-editor.tsx`, wired in `grid-shell.tsx` |
| History arms and replay | `history-stack-model.ts`, `pending-row-history.ts` |
| Admission, publication, conflicts, receipts, rekey intent | `src/viewer-controller.ts` |
| XLSX support scan | new `src/xlsx-structural-support.ts` |
| XLSX structural write | new `src/ooxml-surgery/worksheet-structure.ts`, `xlsx-package.ts` |
| CSV/TSV write | `plan_csv_save`, `src/serialize-csv.ts` |

`worksheet-layout.ts` and `formula-anchors.ts` are pure leaves with no imports
from the webview or the host, so the webview, the host, the calculator, and the
writer share one definition of where an identity lands.

## Delivery

Each step is one pull request and leaves `main` releasable. One flag,
`STRUCTURAL_EDITING_ENABLED`, stays false until the last step; tests turn it on
through the existing test-only settings path. Until step 9, `.xlsx` worksheets
report both axes unsupported with "Not available yet", so no intermediate
release can restructure a workbook even with the flag on.

1. **Design**: this document, ADR 0004, and `CONTEXT.md` terms.
2. **Pure core**: `worksheet-layout.ts`, the reference tokenizer, and
   `formula-anchors.ts`, with generated-layout tests for the validator,
   operations, maps, moved detection, and rendering's path independence, plus
   Excel oracle fixtures.
3. **Pending Changes**: envelope fields, durable version 2, strict wire codec,
   legacy decoding, conflict reasons, publication validation, and round-trip
   and older-decoder tests.
4. **Webview model**: structural store, row and column projection, history
   arms, formula rendering in the editor and calculator, with unit tests and no
   UI.
5. **Row delete and restore, end to end, CSV/TSV**: menus, tints,
   accessibility, the CSV/TSV writer for removals, receipt, rekey intent,
   post-write rekey, history barrier, Structural Basis conflicts, and Review
   Changes. This is the smallest path through save.
6. **Row insert, CSV/TSV**: admission, menus, races, writer.
7. **Row move, CSV/TSV**: menu items, shortcuts, vendored drag and drop,
   moved detection display, writer.
8. **Columns, CSV/TSV**: insert, delete, restore, move, Pending Column rename,
   column projection, header re-serialization, column rekey.
9. **XLSX**: structural support scan, the structural write stage, workbook-wide
   rendering, formatting inheritance, unsharing, and package tests. Removes the
   "Not available yet" refusal.
10. **Ship**: README and editing docs, VS Code integration tests, desktop smoke
    tests, and flipping the flag.

## Testing

### Pure

- Layout validator: every invariant, malformed runs, duplicate identities,
  non-canonical runs, oversized layouts, tombstone rules.
- Operations: insert, delete, restore, move for rows and columns, including
  moves across tombstones and pending rows, and boundary positions.
- Maps: grid row ↔ identity ↔ prospective coordinate round trips.
- Moved detection: determinism and minimality on generated layouts.
- Tokenizer: every construct it anchors and every one it reports.
- Rendering: equal text for operation sequences that reach the same full
  layout; the reviewed sequences, such as rows `[1,2,3,4]` with `A1:A3`, move
  row 1 after row 4 (`A2:A4`), then delete row 1 (`A2:A3`), and `SUM(A2:A5)`
  over six rows with row 5 moved to the top (`A1:A3`) and then deleted
  (`A1:A2`); Excel oracle fixtures for insert at, inside, and after a range;
  delete of corners, middles, and whole ranges; moves into and out of ranges
  and of a corner; whole-row and whole-column references; sheet-qualified and
  per-corner-qualified references; external and structured references
  unchanged; `$` references; `trailing` and `edge` anchors, including that
  moving or discarding an appended row leaves `trailing` references unchanged;
  references to Pending Rows following moves and becoming `#REF!` on discard;
  `SUM(A2:A11)` over a 10-row body before and after appending two rows;
  inserting at the end of the body; insertions and deletions on both sides of
  a `trailing` coordinate; the appended band refusing moves and inserts;
  appends and append undo interleaved with inserts, moves, and deletes;
  "Keep new rows at the end" renumbering and its undo, published both ways
  through the origin check; an insert-only session's first Save (appendBasis);
  mixed structural edits and appends through both writers; a CSV/TSV value
  starting with `=` committed before a prefix-growth rebase stays text with no
  anchors, and the durable and wire codecs refuse `formulaAnchors` on a
  delimited worksheet; a tombstone-only
  layout
  dropped on external change; origin checked against the ledger;
  multi-tombstone corner gaps refilled by inserts and moves; every flag rule
  in "Where this differs from Excel".
- Tombstone gluing under every operation, including insert at the start of
  the layout, delete then restore, one-step moves past glued tombstones, and
  drops between a live row and its glued tombstones.
- CF/DV split pieces: the insertion example above, moves through a rule, and
  the piece-count bound.

### Model

- Codec round trips, legacy envelopes, durable version 2, older-decoder
  rejection without overwrite, and legacy `formulaReferenceBases` conversion.
- Store operations and refusals, including the exclusivity rules; history undo
  and redo restore layout and content atomically.
- Projection in layout and transformed modes, including run-crossing page
  fetches.
- Rekey intent: applied after a normal save; applied on the next load after a
  simulated stop between write and post-write; cleared without applying on a
  digest mismatch.
- Receipt rekey of highlights, heights, hidden rows, widths, visibility, sorts,
  filters, and the schema fingerprint.

### CSV and TSV

- Insert, delete, move, and combinations, for rows and columns, with comma and
  tab delimiters and each newline convention; raw header permutation and
  quoting; ragged rows; header-only files; 1M-row streaming with a few runs;
  prefix-growth rebase.

### XLSX

- Every coverage-table structure, for both axes, against hand-built fixtures
  and a round trip through the existing parser.
- Anchor-relative conditional-formatting and data-validation formulas, cell-set
  semantics for moves through `sqref` ranges, `filterColumn` renumbering.
- Cross-sheet formulas, defined names, internal hyperlink locations, shared
  group unsharing and its cap, array and data-table refusal, merge rules.
- Every allowlist refusal, including an unknown worksheet child and an unknown
  `extLst` URI.
- Conformance fixtures for sparse rows, rows owning cells of other rows,
  self-closing rows, and namespace-prefixed elements.
- A representative fixture opened in Excel or LibreOffice after a save that
  inserts, deletes, and moves rows and columns, recorded in the step 9 PR as
  proof, since CI has no Excel.

### Integration and desktop smoke

- Insert, delete, move, and save for each format, through the shared webview.
- Close with unsaved structural changes; restored drafts after relaunch;
  external change conflict and both salvage actions.
- Edit menu labels for each new action.

GUI tests poll an observable result, such as the accessible grid cell, the
settings file, or the focused window, and never wait a fixed delay.

## Out of scope

- Cross-save undo of structural changes.
- Inserting or moving rows in a sorted, filtered, or row-hidden view.
- Inserting above the Header Row; deleting or moving the Header Row.
- Tables, pivots, drawings, charts, notes, threaded comments, sparklines,
  x14 extensions, array formulas, and data tables on a worksheet that is
  restructured.
- Moving a merge anchor's value on delete.
- Copying formulas into inserted rows or columns.
- Rebasing structural changes onto an externally changed file, beyond CSV/TSV
  rows appended on disk.
- Combining layout changes with cut-and-paste cell moves or saved-append undo on
  the same worksheet.
- Insert and delete keyboard shortcuts.
