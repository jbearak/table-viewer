# Append rows design

## Status

Accepted design. This document is ready to plan and implement.

Table Viewer will append rows in Edit mode for `.xlsx`, CSV, and TSV. All three
formats ship together. The operation adds rows after the physical worksheet
body and never shifts an existing row.

This is still lightweight editing. Table Viewer will not insert rows between
existing rows, add columns, create sheets, or turn a Header Row worksheet into
an OOXML Excel Table.

## Language and invariants

`CONTEXT.md` defines the terms used here:

- An **Appended Row** extends the Worksheet body without shifting an existing
  row.
- A **Pending Appended Row** belongs to the edit session and is not yet on disk.
- A **Pending Change** is a cell change, Pending Appended Row, or Pending Tail
  Removal.
- A **Pending Tail Removal** is the Undo-only removal of an unchanged physical
  suffix previously created by a recorded Append Row.

The following rules are load-bearing:

1. Out-of-range cell edits remain stale edits. They never imply row creation.
2. A completely blank Pending Appended Row is real and survives Save, reload,
   and application restart.
3. Pending rows have opaque identities. A display number or future source
   coordinate is not their identity.
4. The adopted `DataSource` remains immutable and describes only the file.
   Pending rows live in a separate overlay.
5. Sorts, filters, and hidden-row transforms consume source rows only. Pending
   structural rows have their own display projection.
6. A save applies every worksheet's Pending Changes to one verified workbook
   snapshot and writes one replacement file.

ADRs 0002 and 0003 record why pending appends are structural changes and why
Undo may remove only the safe suffix created by a recorded append.

## User experience

### Entry points

Append Row is available only in Edit mode. It is unavailable in preview,
compare, `.xls`, `.dta`, truncated CSV/TSV, a zero-column worksheet, an
all-columns-hidden view, and any sheet already at the one-million-row limit.

The grid shows a sticky trailing row while Edit mode is active:

```text
+ Append row
```

Use Glide's existing `onRowAppended` and `trailingRowOptions` support. Set the
trailing row to sticky so a user does not have to scroll through a large file.
The label must say "Append", because activating it while scrolled near row 20
still adds after the physical end of the worksheet.

Clicking a trailing cell appends one row and opens that column. Clicking the
label opens the first visible column.

Keyboard navigation extends the same rule:

- Enter after committing an edit moves to the same column in the next displayed
  row. At the final row it appends one row and continues into it.
- Tab moves row-major. From the final visible column of the final row it appends
  one row and opens the first visible column.
- Shift+Tab remains bounded at the first cell. It never removes a row.
- Enter on an active grid cell still opens its editor. The append rule applies
  when a committed edit requests movement below the final row.

Pasting an `N x M` block into the trailing row appends `N` rows as one history
gesture. The entire paste fails if it would exceed the existing column count,
10,000 pending rows on that worksheet in the current edit session, or the
one-million-row worksheet limit. Never clip the block or apply only a prefix.

### Pending-row display

Source rows retain their current frozen edit-session projection. Pending
Appended Rows appear in an added-row band after them, separated by a "Pending
rows" divider. They use the existing added-row tint derived from
`diff_added_fg` and `COMPARE_BAND_ALPHA`.

Pending rows show their intended physical row numbers:

```text
sourceRowCount - pending tail-removal count + pending append index + 1
```

The number may increase after an external refresh adds source rows. The opaque
row identity does not change.

Pending Appended Rows stay visible even when they do not match an active filter.
They do not participate in sorting, filtering, or row hiding until Save reloads
the file. This matches the current rule for cell edits: the installed view stays
put for the edit session, then recomputes after Save.

A row-marker selection containing only pending rows has these actions:

- Remove pending row, or Remove N pending rows
- Hide row, visible but disabled
- Copy row, or Copy N rows

Delete and Backspace keep their cell-clearing meanings. They do not remove a
row. A mixed source-and-pending selection disables both Hide and Remove rather
than acting on a subset.

Removing several pending rows is one history gesture. Undo restores their
identities, order, cells, hyperlinks, highlights, and row heights.

### Pending tail removals and replacement projection

Undo of a saved append may create a Pending Tail Removal. Remove that source row
from the ordinary transform input and show it read-only in a deleted-row band
after the projected source rows. Use the existing deleted-row tint. Its context
menu contains:

- Cancel row removal
- Hide row, visible but disabled
- Copy row

If a Pending Tail Removal and a Pending Appended Row target the same prospective
physical row number, show one replacement row rather than two rows with the
same marker. Normal mode shows the new values with the added-row tint. Diff mode
shows the saved and prospective values. The history and save model keep the
removal and append as separate operations.

### Editing and row-owned state

Pending Appended Rows support every existing cell operation that has a safe
temporary-row representation:

- plain and rich-text cell editing
- manual XLSX formulas and live calculation
- hyperlinks
- copy, cut, and paste
- highlights
- row resizing and automatic height growth

Cell-level Discard edit restores a pending cell to its initial blank value. It
does not remove the row. Remove Pending Row removes all state owned by that row
in the same history gesture. Undo restores it.

A blank pending row counts as an unsaved change. Exiting Edit mode offers Save,
Discard, and Cancel. Discard removes never-saved rows and their attached state
but leaves state belonging to source rows alone.

Workbook-level UI says "unsaved changes" or "pending changes". Cell-specific UI
may continue to say "pending edit".

### Save and focus

After Save, transforms recompute against the new source. The successful save
receipt maps every temporary row identity to its canonical source row.

If the active saved row remains visible, selection follows it to its new sorted
position. If a filter hides it, keep focus in the grid and announce "Saved row
is hidden by the current filters." Never restore by the row's former bottom-of-
grid display index.

## XLSX behavior

### Formatting inheritance

At append admission, capture the preceding physical body row as an immutable
format template. Copy:

- each cell's OOXML style
- number format, font, fill, border, and alignment through that style
- native row height and the active Table Viewer row-height override

Do not copy:

- values or formulas
- hyperlinks, comments, or notes
- merges
- hidden, collapsed, or outline state
- data-validation ranges
- conditional-formatting ranges

A header-only worksheet has no body template. Use default cell formatting and
default row height. Do not copy header formatting.

The XLSX append template records the source style-table fingerprint, the copied
cell style indexes, the safe row attributes, and the rendered formatting needed
for the pending display. External source growth may rebase the row only while
those captured style indexes still resolve to the same style definitions. A
changed or ambiguous style table produces a structural conflict. Do not attach
an old style index to a different style definition.

Actual OOXML Table definitions stay byte-for-byte unchanged. An appended
worksheet row may therefore sit immediately below an Excel Table without
becoming part of it. The UI and README must describe this as a worksheet append.

### Formulas

Do not fill formulas from the preceding row. Excel's automatic formula fill is
an Excel Table calculated-column behavior, while Table Viewer's Header Row is a
logical table and does not create an OOXML Table region.

Pending Appended Rows participate in live formula calculation:

- fixed A1 ranges retain their written bounds
- Header Row body references include Pending Appended Rows
- Header Row body references exclude Pending Tail Removals
- fixed A1 references to a Pending Tail Removal observe blank cells in the
  prospective calculation
- when an append replaces a removed tail coordinate, fixed A1 references observe
  the appended value at that coordinate
- formulas typed in Pending Appended Rows calculate like formulas typed in
  source rows

External growth normally rebases pending rows. One case is intentionally
refused. If a pending formula contains an A1 reference to a provisional pending
row coordinate, rebasing makes that reference ambiguous. Mark the formula as a
structural conflict and refuse Save until the user edits or discards it.
Structured Row Intersection references such as `[@Revenue]` rebase safely and
do not trigger this conflict.

Do not add a second symbolic formula representation in this version. The
formula text remains the workbook value.

### Physical write

Extend the surgical XLSX writer to append `<row>` elements after the current
physical body, with cells in ascending column order. Reuse the current cell,
rich-text, hyperlink, and formula write paths for content. Apply the captured
styles and safe row attributes to the new elements.

The writer must also:

- remove a validated Pending Tail Removal suffix before appending replacements
- update the worksheet dimension when the used range changes
- invalidate or replace affected formula caches through the existing formula
  calculation path
- leave table parts, merges, drawings, validations, conditional formatting, and
  unrelated worksheet XML unchanged

A blank formatted row contains the styled cells needed to preserve appearance.
A blank default-format row may contain only its `<row r="...">` element. It is
still structural and must extend the worksheet's used row bound.

## CSV and TSV behavior

The delimited serializer continues to stream existing source windows. It writes
the prospective worksheet in this order:

1. source rows excluding a validated Pending Tail Removal suffix
2. Pending Appended Rows in their ordered overlay order

Use the adopted delimiter and newline convention. Serialize an explicitly blank
row at the full worksheet width. A three-column CSV writes `,,`; a three-column
TSV writes two tab separators. A final newline by itself is not a row.

CSV and TSV have no durable column identities. External row growth rebases
pending rows. An external width or header-order change conflicts when a pending
row contains values or hyperlinks whose column attachment cannot be proven.
Added blank columns may extend a completely blank pending row safely. Never
reattach a value by position after an ambiguous schema change.

## State model

### Row identity

Introduce one format-neutral identity union and use it wherever an editable row
may be pending:

```ts
export type RowIdentity =
    | { readonly kind: 'source'; readonly sourceRow: number }
    | { readonly kind: 'pending'; readonly pendingRowId: string };
```

`pendingRowId` is an opaque, worksheet-scoped, persisted identifier. Validate
its length and uniqueness at every durable and wire boundary. Do not use a
negative number, `sourceRowCount + n`, or a display row as a sentinel identity.

Cell editing, cut provenance, formula dependency roots, history, highlights,
row heights, conflict review, and selection restoration must accept
`RowIdentity`. The grid and format writers are the only boundaries that turn it
into a display or physical coordinate.

### Worksheet pending changes

Expand the format-neutral model in `src/pending-changes.ts`:

```ts
export interface PendingAppendedRow {
    readonly id: string;
    readonly cells: Readonly<Record<number, PendingRowCell>>;
    readonly formatTemplateId: string;
    readonly createdOrder: number;
}

export interface PendingRowFormatTemplate {
    readonly id: string;
    readonly format: PendingRowFormat;
}

export interface PendingTailRemoval {
    readonly appendHistoryId: string;
    readonly sourceRow: number;
    readonly savedFingerprint: string;
    readonly savedRow: SavedAppendedRowSnapshot;
}

export interface WorksheetPendingChanges extends WorksheetTarget {
    readonly cells: CsvDirtyMap;
    readonly formatTemplates: readonly PendingRowFormatTemplate[];
    readonly appendedRows: readonly PendingAppendedRow[];
    readonly tailRemovals: readonly PendingTailRemoval[];
}
```

`PendingRowCell` stores the prospective value, optional rich text, optional
hyperlink, and edit ordering needed by cut and history. It has no source-cell
base because the cell does not exist on disk. `PendingRowFormat` is `none` for
CSV/TSV and a validated XLSX template snapshot for XLSX. Rows refer to interned
format templates so a 10,000-row paste does not copy the same per-column style
snapshot 10,000 times. Drop a template when no pending row or history entry
references it.

The arrays are ordered values. Map iteration order does not define append or
removal order.

Keep `PerFileState.pendingEdits` as the persisted property name because released
SQLite DDL queries that JSON path. Its value becomes a versioned worksheet
Pending Changes envelope. The decoder accepts all existing cell-only shapes and
normalizes them to `cells` with empty structural arrays. New code and wire
messages use Pending Changes terminology. Add round-trip and malformed-input
tests before changing any producer.

The current full-map sequencing contract remains. A publication contains the
complete Pending Changes snapshot for one worksheet, the edit-session ID, and a
monotonic sequence. The host acknowledges only after the durable state accepts
that exact sequence. Accept the old `pendingEditsChanged` and
`requestPendingEditsFlush` messages while an older webview may still be open;
new peers use `pendingChangesChanged` and `requestPendingChangesFlush`.

### Append admission

Appending needs a host round trip because the webview cannot inspect an unloaded
XLSX tail or capture its exact styles. Add an edit-session-scoped request:

```ts
type RequestAppendRows = {
    type: 'requestAppendRows';
    requestId: string;
    editSessionId: string;
    worksheet: WorksheetTarget;
    sourceGeneration: number;
    count: number;
};
```

The host validates ownership, source generation, sheet identity, editability,
row limits, pending-row limit, visible schema, and template safety. It returns
ordered unique row IDs and one captured format template:

```ts
type AppendRowsResult = {
    type: 'appendRowsResult';
    requestId: string;
    sourceGeneration: number;
    granted: boolean;
    rowIds?: readonly string[];
    formatTemplate?: PendingRowFormatTemplate;
    reason?: string;
};
```

A refusal returns a reason suitable for the existing warning channel. Ignore a
result whose generation no longer matches the mounted source.

Glide's `onRowAppended` may await this request. Once admitted, the webview adds
the rows as one history gesture, publishes the full worksheet Pending Changes
snapshot, increases the overlay row count, and lets Glide focus the appended
cell. Do not use a timer to assume the row exists. Glide already polls its
observable `rows` prop before focusing.

Multi-row paste uses one request and one history gesture. Serialize append
requests per worksheet so completion order cannot reorder two rapid gestures.

## Projection and calculation

Add a small format-neutral pending-row projection between the transformed source
rows and `GridShell`:

```text
transformed source rows
        |
        +-- remove Pending Tail Removal rows from normal display
        |
        +-- append deleted review band
        |
        +-- append Pending Appended Row band
        |
        +-- coalesce same-coordinate removal + append for display only
```

The source `RowLoader` keeps its current generation guards and canonical
`sourceRows`. A separate pending-row store answers pending cells synchronously.
Do not place pending rows in the loader cache and do not teach `DataSource` to
read beyond `sourceRowCount`.

Formula calculation receives a prospective row accessor that composes source
rows, source cell changes, pending appends, and tail removals. Transform scans
continue to receive only the frozen source-side values. This intentional split
is why a new row can affect `SUM([Revenue])` without moving or disappearing under
the active sort and filter.

## History

Extend `HistoryChange` with structural changes and make its cell-addressed arms
use `RowIdentity` where needed:

```ts
type HistoryChange =
    | { readonly kind: 'cell'; readonly delta: CellHistoryDelta }
    | { readonly kind: 'highlight'; readonly delta: HighlightHistoryDelta }
    | { readonly kind: 'rowAppend'; readonly delta: RowAppendHistoryDelta }
    | { readonly kind: 'tailRemoval'; readonly delta: TailRemovalHistoryDelta };
```

One click append is one action. One multi-row paste is one action. Removing a
multi-row pending selection is one action. Measure retained cell content,
format snapshots, highlights, and row heights against the existing history byte
budget. An oversized gesture installs the existing action-too-large barrier.

A successful save receipt advances recorded append history from pending IDs to
saved identities. Undo may turn those identities into Pending Tail Removals only
when all rows created by the gesture remain an unchanged physical suffix in the
same order. Validate the worksheet identity, row coordinates, saved row
fingerprints, and absence of later rows. If validation fails, refuse replay with:

```text
Can't undo appended rows because the worksheet changed after they were saved.
```

Leave the history entry in place on refusal. Do not clear cells, remove external
rows, or shift coordinates.

Cancel row removal records a normal history action. Redo can reinstate the
removal. A saved tail removal drops its source-row highlights and row height in
the same durable state transition. Cross-save Undo retains their snapshots so it
can restore them.

## Save protocol and ownership

Generalize the existing CSV-named save types to workbook Pending Changes. Each
worksheet operation carries its target, source-cell changes, ordered appends,
and ordered tail removals. Keep a decoder for the current cell-only request
shape while an older webview may still be open.

The ownership split remains:

- The webview edit session owns responsive overlay state, selection, and history.
- The host owns edit-session admission, durable snapshots, conflict validation,
  format templates, file verification, and save planning.
- Each editable `ViewerProfile` turns one validated format-neutral operation
  into bytes.
- The adopted `DataSource` owns only the file snapshot.

Before planning bytes, the host validates cell bases and structural bases. A
structural rejection identifies the worksheet, pending row IDs or tail-removal
IDs, and one of these reasons:

- worksheet removed or replaced
- row limit exceeded
- pending append template changed
- ambiguous column change
- ambiguous pending formula reference after rebase
- saved append is no longer an unchanged suffix

The renderer adds a Pending rows section to Review Changes. It offers Go to
pending row, Remove affected pending rows, and Dismiss notice. Dismiss hides the
notice but does not admit Save. A later Save reopens the explanation.

After writing the file, the host produces:

```ts
interface AppendedRowAssignment extends WorksheetTarget {
    readonly pendingRowId: string;
    readonly sourceRow: number;
    readonly savedFingerprint: string;
}

interface PendingChangesSaveReceipt {
    readonly appendedRows: readonly AppendedRowAssignment[];
    readonly removedSourceRows: readonly (WorksheetTarget & {
        readonly sourceRows: readonly number[];
    })[];
}
```

Use the assignments to rekey durable highlights and row heights in the same
post-write state compare-and-set that rebases highlight digests today. Post the
successful receipt only after that state transition succeeds. The webview then
rekeys live history and selection before clearing its saved overlay. A failed
post-write rekey keeps the file-written warning and disables editing, matching
the current conservative cleanup path.

External refresh keeps pending rows when worksheet and column identities still
match. New physical rows move the pending destination numbers. Added columns get
blank pending cells. Removed columns with no pending content may drop their
captured formatting. Any value-bearing ambiguous column mapping conflicts.

## Limits and validation

Apply these bounds before allocating or persisting a row batch:

- maximum 10,000 Pending Appended Rows per worksheet per edit session
- maximum `MAX_SHEET_ROWS` prospective rows
- current maximum worksheet columns
- existing rich-text and hyperlink bounds per cell
- existing history byte and cell-count budgets per gesture
- a new aggregate encoded-byte bound for one Pending Changes worksheet envelope,
  enforced by the shared durable and wire validator

The encoded-byte bound must be derived from the state backend's tested safe
write size before implementation. It is a safety limit, not a second user-facing
row quota. A rejection is atomic and preserves the prior snapshot.

## Accessibility

The sticky trailing row is keyboard reachable and exposes an action label of
"Append row at end of worksheet." Pending and removal bands expose their state
through row accessibility labels as well as color. Disabled Hide Row items stay
in the ARIA menu with `aria-disabled="true"` and cannot receive an action.

After append, focus moves only after the grid reports the new row. After Save,
focus restoration uses the receipt identity. Conflict review returns focus to
the row or cell that opened it when that identity still exists.

Touch keeps the existing long-press row-menu behavior. A pending-row long press
must preserve the selected pending identities just as the current source-row
menu preserves selected display intervals.

## Files and module boundaries

The implementation should deepen existing modules instead of adding structural
cases throughout `App` and `GridShell`:

| Concern | Primary location |
|---|---|
| Pending Change types, validation, legacy decode | `src/pending-changes.ts`, `src/types.ts` |
| Webview worksheet pending store | new `src/webview/pending-row-store.ts` beside `edit-session-store.ts` |
| Display composition | new `src/webview/pending-row-projection.ts` |
| Grid affordance and navigation | `src/webview/grid-shell.tsx`, `grid-nav-model.ts` |
| Row context menu model | `src/webview/row-context-menu.ts` |
| History types and replay | `history-stack-model.ts`, history replay modules |
| Host admission, persistence, conflicts, receipts | `src/viewer-controller.ts` |
| CSV/TSV write | `src/serialize-csv.ts` |
| XLSX template capture and write | `src/data-source/xlsx-source.ts`, `src/xlsx-cell-write.ts`, `src/xlsx-package.ts` |
| Prospective formula access | `src/formula-calculation.ts`, `src/formula-dependencies.ts` |
| Durable row-height/highlight rekey | state persistence modules and `viewer-controller.ts` |

`GridShell` should consume one projected row interface and dispatch row-identity
actions. It should not know how XLSX styles are captured or how CSV records are
serialized.

## Delivery sequence

The formats ship together, but implementation can land in reviewable slices:

1. Add Pending Change types, strict validators, legacy decoding, and durable
   round-trip tests. Rename new protocol paths while retaining legacy decoders.
2. Add row identity, the pending-row store, projection, history arms, and pure
   unit tests. No writer path yet.
3. Add host append admission and template capture. Wire the sticky row, Enter,
   Tab, context menus, paste admission, tint, accessibility, and persistence.
4. Extend CSV/TSV validation and streaming serialization for appends and safe
   tail removal.
5. Extend XLSX template capture, surgical append/removal, formula calculation,
   hyperlinks, style validation, and package preservation tests.
6. Add save receipts, durable annotation rekey, external-refresh reconciliation,
   structural conflict review, and cross-save Undo.
7. Update README limitations and editing documentation, then run shared webview,
   VS Code integration, and desktop smoke coverage.

No release should expose Append Row for only one editable format. Until step 7
passes for all three, keep the capability flag false.

## Testing

### Pure and unit tests

- Strict Pending Changes codec, including every legacy `pendingEdits` shape,
  duplicate IDs, bad ordering, oversized batches, and malformed format tokens.
- Pending-row projection under sort, filter, hidden rows, Header Row promotion,
  all-hidden columns, replacement coalescing, and external source growth.
- Enter and Tab append boundaries, first-column targeting, hidden columns,
  merged cells, and zero-row/header-only sheets.
- One-row append, repeated Enter, multi-row paste, width overflow, the 10,000-row
  limit, total row limit, removal, mixed selection, and atomic Undo/Redo.
- Pending row persistence across remount, reload, and a new edit-session grant.
- Formula calculation with Header Row body references, fixed A1 ranges, pending
  appends, tail removals, and ambiguous provisional A1 conflicts.
- Save-receipt rekey of history, selection, highlights, and row heights.
- Safe and refused cross-save Undo, including external tail growth and changed
  saved content.

### CSV and TSV tests

- Append populated, ragged, and completely blank records with comma and tab
  delimiters and each supported newline convention.
- Preserve all existing rows byte-semantically while streaming large sources.
- Remove only a fingerprint-matched suffix.
- Apply removal then append at the same coordinate.
- Reject external width/header ambiguity without dropping pending content.

### XLSX package tests

- Append after ordinary, sparse, self-closing, and header-only `sheetData`.
- Preserve unrelated XML and ZIP parts byte-for-byte where the current surgical
  writer promises preservation.
- Copy style indexes and safe row attributes without copying formulas, values,
  links, merges, hidden state, validation, conditional formatting, or table
  ranges.
- Append rich text, formulas, and hyperlinks through existing writer paths.
- Update dimensions for blank and formatted rows.
- Remove only an unchanged suffix, then append replacements in row order.
- Reject a changed style-table dependency after external refresh.

Add conformance fixtures for the OOXML row shapes that can break insertion:
self-closing `sheetData`, self-closing rows, missing dimensions, sparse cells,
namespace-prefixed worksheet elements, and existing trailing extension content.

### Integration and desktop smoke

- `.xlsx`, CSV, and TSV advertise the capability together; `.xls`, `.dta`,
  preview, compare, and truncated sources do not.
- Save, Discard, close-with-unsaved-changes, restored drafts, and external refresh
  include blank Pending Appended Rows.
- Desktop and VS Code share behavior because both use `attach_viewer` and the
  common webview.
- Native Edit menu Undo/Redo labels cover Append Row, Remove Pending Rows, and
  Cancel Row Removal.
- Dirty-window and dirty-tab indicators include structural-only changes.

GUI tests must poll an observable result such as the accessible grid cell,
settings file, or focused window. Do not wait a fixed delay. Run desktop smoke
with the desktop left alone, and rule out window switching before treating a
failure as a product bug.

## Documentation changes at implementation time

Update README's current statement that Table Viewer cannot add cells beyond the
file's bounds. Replace it with the narrower limits:

- rows may be appended in Edit mode
- rows cannot be inserted between source rows
- columns, worksheets, and files cannot be created
- worksheet append does not extend an OOXML Excel Table

Document the sticky action, Enter/Tab behavior, transform treatment, inherited
XLSX formatting, formula non-fill, 10,000-row pending limit, and external-change
conflict behavior.

## Out of scope

- inserting rows above or below an existing row
- arbitrary row deletion
- adding or removing columns
- creating files, worksheets, or OOXML Excel Tables
- extending existing OOXML Table ranges or calculated columns
- copying formulas into appended rows
- copying merges, validation, conditional formatting, comments, or outline state
- sorting or filtering pending rows before Save
- symbolic formula references to temporary row identities
- editing `.xls`, `.dta`, preview, or compare sources
