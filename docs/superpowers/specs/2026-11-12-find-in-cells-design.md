# Find text in cells

Status: design, 2026-11-12.

## Goal

Press `Cmd+F` (macOS) or `Ctrl+F` (Linux, Windows) in a table, type text, and
jump to the cells that contain it. Works the same in the VS Code extension
(custom editor and CSV preview) and the desktop app.

## Non-goals (follow-ups)

- Replace.
- Searching every worksheet at once. Find covers the active worksheet; switching
  tabs keeps the query and the next search runs on the new tab.
- A total match count ("3 of 120") and highlighting every match. Both need a
  full pass over the sheet before showing anything; see "Why no count".
- Regular expressions, whole-word matching, a Match Case toggle.
- Searching column names (the header row) or hidden rows and columns.
- `F3` / `Cmd+G` for next match, and prefilling the query from the selection.

## What the user sees

A find bar floats over the grid's top-right corner, like the VS Code find
widget:

```
[ Find…            ]  No matches   [↑] [↓] [×]
```

- `Cmd/Ctrl+F` opens the bar and focuses its input. If the bar is already open,
  it focuses the input and selects its text, so typing replaces the query (the
  browser and VS Code convention).
- Typing searches as you type: the first match at or after the active cell
  becomes the selected cell and scrolls into view. The selection outline is the
  match marker; no extra tint.
- `Enter` / `↓` moves to the next match; `Shift+Enter` / `↑` to the previous.
  Both wrap around the end of the sheet. The buttons are for mouse users.
- `Escape` or `×` closes the bar and returns focus to the grid, leaving the last
  match selected so the user can act on it (copy, edit, highlight).
- The status text is empty while matches are found, `Searching…` while a scan
  is running, and `No matches` after a full lap finds nothing. A scan that is
  stopped (see "Invalidation") clears the status rather than leaving a stale
  `Searching…` or `No matches`.

## What counts as a match

Find answers "where does this text appear in what I am looking at?". So it
searches the view, not the file:

- **Cells**: the active worksheet's displayed rows (after filters, in the
  current sort order, including Pending Rows and rows pending removal, which
  stay visible) crossed with its visible columns. Hidden columns and rows that
  filters or **Hide rows** remove are skipped.
- **Text**: the text the cell paints, as `displayed_text` in `cell-renderer.ts`
  computes it: the formatted value when Formatting is on and the raw value when
  it is off, a pending edit's text in place of the stored value, and a
  recalculated formula result (which `displayed_text` renders as
  `base → result` when the workbook cached a different base; both sides then
  match). The Diff toggle's and git compare's `before` text is not part of
  `displayed_text`, so it does not match.
- **Comparison**: case-insensitive substring, folding both sides with
  `toLocaleLowerCase()`, the fold the **Contains** filter uses
  (`table-transform.ts`). No other normalization. An empty query matches nothing and clears the status.
- **Merged cells**: only the anchor cell carries text; selecting it selects the
  whole merged block (`select_active_display_cell` already snaps).

This differs from **Contains** deliberately: filters test stored values; Find
tests shown text, because the user is looking for what they can see.

## Order and starting point

Row-major in display order: left to right across visible columns, then the next
display row. `Enter` starts one cell after the active cell; typing starts *at*
the active cell, so extending the query keeps the current match when it still
matches. With no active cell, or one no longer in the view, search starts at the
top-left. Reaching the end wraps to the start; a full lap with no match reports
`No matches`.

## How it works

### Why scan in the webview

The host holds the data, but not what the user sees: pending edits, Pending
Rows, recalculated formula results, and Formatting state live in the webview,
and `displayed_text` is webview code. A host-side search would need a second
copy of that overlay logic and a merge step for every class of pending change.
Scanning in the webview reuses the paint path's inputs, so Find and the grid
cannot disagree about what a cell says.

### Display rows vs loader rows

The grid's display rows interleave Pending Rows and rows pending removal with
source-backed rows. The `RowLoader` is indexed by *source display row* (the
host's transformed order), not by grid row. `get_cell_content` resolves this
through `pending_projection.row_at(row)` and `sourceDisplayRow`, and the
viewport path loads `pending_projection.source_display_intervals(...)`. The scan
does the same: it walks grid display rows, maps each source-backed row through
`row_at(row).sourceDisplayRow`, and loads the loader pages those rows sit on. Rows
that are not source-backed come from `pending_projection` and are already in
memory.

### The scan

`GridShell` owns one scan at a time. For each chunk:

1. A chunk is the longest run of grid rows whose mapped source display
   intervals touch at most 8 distinct loader pages (at least one grid row).
   Grid rows alone are not a bound: after row moves or removal gaps, a few
   grid rows can map to many pages. The loader already shrinks its page so one
   page holds at most 64 Ki cells and 8 MiB (`RowLoader.configure`); eight
   pages therefore stay within the cache's 1 M-cell and 64 MiB caps even on a
   wide sheet, and within `MAX_PENDING_PAGE_REQUESTS`. `RowLoader` exposes its
   effective `page_size` for this.
2. Pin the chunk's source display intervals, `await ensure_rows_loaded` for
   each (resident pages are not re-requested).
3. Test cells through `find_text_at(display_column, display_row)`, yielding to
   the event loop every 20,000 cells so a wide chunk does not freeze the UI.
   Stop at the first match.
4. Unpin and `trim_rows()` in `finally`, the same pin / load / trim discipline
   `copy_sheet` uses.

`ensure_rows_loaded` returning `false` (cache cleared, loader disabled) ends the
scan with the status cleared; it never reports `No matches` for rows it did not
read.

### Reading a cell's text

`find_text_at` is a text-only helper, not a call into `get_cell_content`, which
builds a Glide cell, styles, edit values, and formula retargeting for every
call. The helper shares the pieces that decide text with `get_cell_content`:

- Source-backed row with no dirty entry and no formula overlay (the common
  case): `displayed_text(loaded_cell, show_formatting, undefined)`.
- Otherwise it builds only the text-bearing overlay fields (`dirty_value`,
  `dirty_display`, `formula_result`, `formula_result_pending`) through the same
  `value_overlay_for_cell` and `calculated_formula_display` calls
  `get_cell_content` makes, then calls `displayed_text`.
- Pending and removal rows read `pending_rendered_rows` /
  `removal_rendered_rows` as `get_cell_content` does.

The overlay pieces move into a small shared function that both callers use, so
the two cannot drift; the rest of `get_cell_content` is unchanged.

### Invalidation and concurrency

A scan records a *find epoch* when it starts. The epoch changes whenever
anything that decides text or coordinates changes: the query, Formatting, the
column projection, `pending_projection`, the dirty store's version, the
formula result maps (`formula_results`, `source_formula_results`) and
`pending_formula_impact`, which land asynchronously, the loader generation, or the grid remounting (reload, transform install, sheet switch).
The scan checks the epoch after every await and every yield; a stale scan stops
without moving the selection, and the status clears. Nothing restarts
automatically except the query itself: a new keystroke starts a new incremental
search, and otherwise the user presses `Enter`.

Only one chunk load is in flight per grid. A new search waits for the previous
scan's in-flight `ensure_rows_loaded` to settle (it cannot be cancelled, and its
pin is released in `finally`) before loading anything, so fast typing cannot
pile up obsolete loads and pins. Only the latest requested search runs once the
previous one settles; intermediate queries are dropped.

### Open cell editor

Opening Find (by chord or menu) first calls the grid's existing
`commit_live_edit()`, which folds the open editor's text into the dirty map and
dismisses Glide's overlay, the same lifecycle App already uses before a
transform or column-visibility change. The just-typed text is therefore
searchable, and moving the selection never leaves a stale overlay. If
`commit_live_edit()` returns `false` (the edit was refused), the bar does not
open and the editor stays open with its text.

### State across remounts

App owns find state (open, query, status) because transforms and sheet switches
remount `GridShell`. The scan itself lives in `GridShell` behind a
`find(query, direction, inclusive)` action on `GridActionsHandle`. App calls it
only through the current handle and only when the handle's `sheet_index`
matches `active_sheet_index`, the check `pending_sheet_action_to_run` already
makes. A remount ends any running scan (the old instance unmounts, its loader
clears, its epoch is stale) and clears the status; the query stays in the bar.

### Why no count

A count or an all-matches tint requires reading every row before showing the
first answer. For a million-row Parquet file that is thousands of page
round-trips. Find Next stops at the first hit, which is usually near. A count
can be added later, computed in the background after the first match lands,
without changing this design.

### Modules

- `src/webview/find-model.ts` (new, pure): `find_query_matches(text, query)`,
  the cell-order walk (next and previous position with wrap, inclusive or
  exclusive start), and `scan_for_match({ start, direction, inclusive,
  row_count, column_count, load_chunk, text_at, is_stale })`, an async loop
  over chunks. Unit-tested without React or a grid.
- `src/webview/row-loader.ts`: expose `page_size`.
- `src/webview/grid-shell.tsx`: `find_text_at` and the shared overlay helper;
  the `find` action (epoch, single in-flight load, pin / load / trim) and
  `select_find_match`. Not `select_active_display_cell`, which writes the
  selection *and* scrolls: Glide already scrolls a controlled selection change
  into view, and the second, imperative scroll in the same tick measures against
  a visible region Glide has not updated yet, so a far match landed at twice its
  offset (the bottom of the sheet). `select_find_match` scrolls only when the
  selection does not change.
- `src/webview/find-bar.tsx` (new): the bar.
- `src/webview/app.tsx`: find state; a capture-phase `keydown` listener for
  `Cmd/Ctrl+F` beside the undo/redo listener, for the same reason (Glide eats
  key events on the way up); `run_edit_command` handles `'find'` *before* its
  text-field branch, so the menu path opens Find even from a cell editor
  instead of copying the field.
- `src/webview/edit-command.ts`: `EditCommand` gains `'find'`.
  `is_find_hotkey` (exactly one of Meta/Ctrl, no Alt, no Shift, key `f`) lives
  in `find-model.ts`.

### Keyboard routing per host

- **VS Code**: the webview's capture listener handles the chord and calls
  `preventDefault` + `stopPropagation`, as the undo listener does, so the chord
  is not forwarded to the workbench. `enableFindWidget` stays off: VS Code's
  widget searches DOM text and the grid is a canvas. This must be checked by
  hand in a real VS Code window, because no automated suite drives a VS Code
  webview's keyboard.
- **Desktop**: add **Edit → Find…** with accelerator `CmdOrCtrl+F`. The menu
  item makes the feature discoverable, and the accelerator owns the chord
  before the page. The command union `'copy' | 'selectAll' | 'undo' | 'redo'`
  gains `'find'` at its three sites: `src/types.ts` (`editCommand`),
  `desktop/main/viewer-windows.ts` (`send_edit_command`), and
  `desktop/main/main.ts` (`route_edit_command`). `route_edit_command`'s native
  fallback returns early for `'find'`, so the chord does nothing in welcome,
  preferences, or the state inspector instead of falling through to
  `contents.redo()`.

### Edge cases

- **CSV edit mode**: filters pause in edit mode, so display order is source
  order plus Pending Rows. Find works unchanged.
- **No rows or no visible columns**: the bar opens; any query reports
  `No matches`.
- **Truncated CSV** (`csvMaxRows`): searches the rows that were loaded, which is
  what the grid shows.

## Testing

- `find-model.test.ts`: matching and case folding; row-major order with wrap in
  both directions; inclusive vs exclusive start; a stale scan returns
  `undefined` and loads no further chunk; `load_chunk` returning `false` ends
  the scan without a "no match" result.
- `find-model.test.ts`: `is_find_hotkey` accepts `Cmd+F` / `Ctrl+F`, rejects
  `Cmd+Ctrl+F`, `Alt`, `Shift`.
- Grid-level tests (existing GridShell harness): a pending edit's text is found
  and its stored value is not; a match in a row after a Pending Row is found
  (display vs loader rows); a hidden column is skipped; Formatting off matches
  the raw value; opening Find with an open editor commits its text, and a
  refused commit leaves the editor open and the bar closed.
- Desktop smoke: open a fixture, press `Cmd/Ctrl+F`, type a value from a row far
  below the fold, poll the grid's accessibility cell until it reports the match
  selected; `Escape` returns focus to the grid.
- Manual: the chord in a VS Code custom editor opens the bar and not VS Code's
  find.

## Docs

A **Find text** section in the user docs beside filtering.
