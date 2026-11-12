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
- `F3` / `Cmd+G` for next match.

## What the user sees

A find bar floats over the grid's top-right corner, like the VS Code find
widget:

```
[ Find…            ]  No matches   [↑] [↓] [×]
```

- `Cmd/Ctrl+F` opens the bar and focuses its input. If the bar is already open,
  it re-focuses the input and selects its text. If a single cell is selected
  when the bar opens fresh and the input is empty, nothing is prefilled (cell
  values are often long; prefill is a follow-up).
- Typing searches as you type: the first match at or after the active cell
  becomes the selected cell and scrolls into view. The selection outline is the
  match marker; no extra tint.
- `Enter` / `↓` moves to the next match; `Shift+Enter` / `↑` to the previous.
  Both wrap around the end of the sheet.
- `Escape` or `×` closes the bar and returns focus to the grid, leaving the last
  match selected so the user can act on it (copy, edit, highlight).
- The status text is empty while matches are found, `Searching…` while a scan
  has run longer than a moment (the bar shows rows scanned so far, e.g.
  `Searching… 120,000 of 1,000,000 rows`), and `No matches` after a full pass
  finds nothing.

## What counts as a match

Find answers "where does this text appear in what I am looking at?". So it
searches the view, not the file:

- **Cells**: the active worksheet's displayed rows (after filters, in the
  current sort order, including Pending Rows and rows pending removal, which
  stay visible) crossed with its visible columns. Hidden columns and rows that
  filters or **Hide rows** remove are skipped.
- **Text**: the text the cell paints, from the same function the grid paints
  with (`displayed_text` in `cell-renderer.ts`): the formatted value when
  Formatting is on and the raw value when it is off, a pending edit's text in
  place of the stored value, and a recalculated formula result. A cell the Diff
  toggle or git compare paints as `before → after` matches on its current
  (after) text only, which is what `displayed_text` returns for it.
- **Comparison**: case-insensitive substring, folding both sides with
  `toLocaleLowerCase()`, the same fold the **Contains** filter uses. An empty
  query matches nothing and clears the status.
- **Merged cells**: only the anchor cell carries text; selecting it selects the
  whole merged block (`select_active_display_cell` already snaps).

This differs from **Contains** deliberately: filters test stored values; Find
tests shown text, because the user is looking for what they can see.

## Order and starting point

Row-major in display order: left to right across visible columns, then the next
display row. Forward search starts one cell after the active cell; typing
(incremental search) starts *at* the active cell, so extending the query keeps
the current match when it still matches. With no active cell, search starts at
the top-left. Reaching the end wraps to the start; a full lap with no match
reports `No matches`.

## How it works

### Why scan in the webview

The host holds the data, but not what the user sees: pending edits, Pending
Rows, recalculated formula results, and the Diff/compare text live only in the
webview, and `displayed_text` is webview code. A host-side search would need a
second copy of that overlay logic and a merge step for every class of pending
change. Scanning in the webview reuses the paint path, so Find and the grid
cannot disagree about what a cell says.

The webview does not hold the whole sheet — `RowLoader` pages rows on demand —
so the scan walks display rows in chunks:

1. For chunk `[start, end]` (1,600 rows, 16 pages, which is
   `MAX_PENDING_PAGE_REQUESTS` × `PAGE_SIZE`): pin the range, `await
   ensure_rows_loaded(start, end)`, which requests only pages not resident.
2. Test each row × visible column through `find_text_at(display_column,
   display_row)`. Stop at the first match.
3. Unpin and `trim_rows()`, so a long scan never grows the cache past its cap.
   This is the same pin / load / trim sequence `copy_sheet` uses.
4. Yield to the event loop between chunks so the UI stays responsive.

Pending Rows and rows pending removal come from `pending_projection` and are
already in memory; `ensure_rows_loaded` covers source rows only.

### Cancellation

Each scan carries a token. A new query, `Enter`, close, sheet switch, or a
generation change (reload, transform install, which remount the grid) cancels
the running scan; a cancelled scan never moves the selection. `ensure_rows_loaded`
returning `false` (cache cleared mid-load) also ends the scan silently.

### Why no count

A count or an all-matches tint requires reading every row before showing the
first answer. For a million-row Parquet file that is thousands of page
round-trips. Find Next stops at the first hit, which is usually near. The
desktop and VS Code find widgets show counts because their documents are in
memory; ours is not. A count can be added later, computed in the background
after the first match lands, without changing this design.

### Modules

- `src/webview/find-model.ts` (new, pure): `find_query_matches(text, query)`,
  the cell-order walk (`next_position`, wrap, direction), and
  `run_find_scan({ start, direction, inclusive, row_count, column_count,
  load_chunk, text_at, is_cancelled, on_progress })` returning the match
  position or `undefined`. All I/O injected, so it is unit-tested without React
  or a grid.
- `src/webview/grid-shell.tsx`: `find_text_at`, factored out of
  `get_cell_content` so both build the same overlay and call `displayed_text`;
  a `find(query, direction, inclusive)` action on `GridActionsHandle` that runs
  the scan with `ensure_rows_loaded` / `pin_rows` / `trim_rows` and selects the
  match with `select_active_display_cell`.
- `src/webview/find-bar.tsx` (new): the bar. Owns its input; calls back into
  App.
- `src/webview/app.tsx`: owns find state (open, query, status) so it survives
  the grid remounts that transforms cause. A capture-phase `keydown` listener
  for `Cmd/Ctrl+F`, beside the undo/redo listener and for the same reason
  (Glide eats key events on the way up). `run_edit_command` gains `'find'`.
- `src/webview/edit-command.ts`: `EditCommand` gains `'find'`;
  `find_hotkey(event)` classifies the chord (exactly one of Meta/Ctrl, no Alt,
  no Shift, key `f`).

### Keyboard routing per host

- **VS Code**: the webview's capture listener handles the chord and calls
  `preventDefault` + `stopPropagation`, exactly as undo does today, so VS Code
  never sees it. `enableFindWidget` stays off: VS Code's widget searches DOM
  text and the grid is a canvas.
- **Desktop**: add **Edit → Find…** with accelerator `CmdOrCtrl+F`, routed
  through `route_edit_command('find')` like Copy and Select All. The menu item
  makes the feature discoverable, and the accelerator owns the chord before the
  page, so the webview listener is a no-op there.
- Inside a text field (cell editor, filter input), `Cmd/Ctrl+F` still opens the
  bar. No text field in the app uses the chord for anything.

### Edge cases

- **Edit mode for CSV**: filters pause in edit mode, so display order is source
  order plus Pending Rows. Find works unchanged.
- **Grid with no rows or no visible columns**: the bar opens; any query reports
  `No matches`.
- **Active cell leaves the view** (filtered away): search starts at the top.
- **A cell editor is open** when Find moves the selection: same behavior as
  clicking another cell.
- **Truncated CSV** (`csvMaxRows`): searches the rows that were loaded, which is
  what the grid shows.

## Testing

- `find-model.test.ts`: matching and case folding; row-major order with wrap in
  both directions; inclusive vs exclusive start; chunk loading calls; a
  cancelled scan returns `undefined`; `load_chunk` returning `false` ends the
  scan.
- `edit-command.test.ts`: `find_hotkey` accepts `Cmd+F` / `Ctrl+F`, rejects
  `Cmd+Ctrl+F`, `Alt`, `Shift`.
- Grid-level test (existing GridShell test harness): a pending edit's text is
  found and its stored value is not; a hidden column is skipped; Formatting
  off matches the raw value.
- Desktop smoke: open a fixture, press `Cmd/Ctrl+F`, type a value from a row
  far below the fold, poll the grid's accessibility cell until it reports the
  match selected; Escape returns focus to the grid.

## Docs

A short user page, `docs/find.md`, linked from the README beside filtering.
