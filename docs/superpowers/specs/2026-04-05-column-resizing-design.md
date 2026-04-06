# Column Resizing Features Design

## Overview

Three related features for column width management in the table viewer:

1. **Multi-column resize** — resizing a column while multiple columns are selected applies the width to all selected columns
2. **Double-click auto-size** — double-clicking a resize handle auto-fits the column (or all selected columns) to content
3. **Auto-fit All toggle** — toolbar button that auto-fits all columns, with revert capability

## Feature 1: Multi-Column Resize

### Behavior

When a column resize drag completes (mouseup), check whether the resized column falls within the current selection range. If the selection spans multiple columns, apply the final width to all columns in the selection's column range (`start_col` through `end_col`).

- The focal column is whichever column's resize handle was dragged
- All selected columns get the exact same absolute width as the focal column
- If the resized column is not within the selection, single-column resize as today

### Implementation

`ColumnResizeHandle` currently calls `on_resize(col, width)` on mouseup. The `on_column_resize` handler in `app.tsx` is updated to check the current selection state:

- If selection exists and `col` is within `selection.range.start_col..end_col`, apply `width` to every column in that range
- Otherwise, apply to just the single column

This requires passing selection state into the resize callback chain (or closing over it in `app.tsx` where it's already available).

## Feature 2: Double-Click Auto-Size

### Behavior

Double-clicking a column resize handle auto-fits the column to its content. If multiple columns are selected and the double-clicked column is within the selection, each selected column auto-sizes independently to its own content.

### Measurement Logic

A new utility function in `src/webview/measure-column.ts`:

```
measure_column_fit_width(table_element, col, merge_map) → number
```

1. Query all `<td>` elements in the target column from the rendered `<table>`
2. For each cell, create an off-screen measurement span with the cell's computed font styles, insert the cell's text content, read `offsetWidth`
3. Skip merge-hidden cells (they don't contribute to the column's natural width)
4. Include row 0 (header) in the measurement unless it is a merged cell that spans multiple columns (merged headers would inflate the width for a single column)
5. Return `max_width + 16px` padding (8px per side for breathing room), clamped to a minimum of 40px (matching the existing resize minimum)

### Resize Handle Changes

`ColumnResizeHandle` gets a new `on_auto_size` callback prop and an `onDoubleClick` handler on the resize handle div.

On double-click, the handler calls `on_auto_size(col)`. The parent checks if the column is within a multi-column selection — if so, auto-sizes each selected column independently; if not, auto-sizes just that column.

The first click of a double-click will briefly trigger the drag logic, but the double-click's auto-fit width overwrites it since both persist to state.

## Feature 3: Auto-Fit All Toggle Button

### Behavior

A new toolbar toggle button labeled "Auto-fit Columns":

- **Click to activate**: Snapshot the current `column_widths` for the active sheet, then measure and apply auto-fit widths for all columns. Button shows as active.
- **Click to deactivate**: Restore the snapshotted pre-auto-fit widths. Button shows as inactive.
- **Manual column resize while active**: Set toggle to inactive, keep all current widths as-is. Discard the snapshot.
- **State is per-sheet**: Auto-fitting sheet 1 doesn't affect sheet 2. Switching back to an auto-fitted sheet shows it still active with the option to revert.

Tooltip when inactive: "Auto-fit all columns to their content."
Tooltip when active: "Restore original column widths."

### State

Two new pieces of ephemeral UI state in `app.tsx` (not persisted to VS Code global state):

- `auto_fit_active: boolean[]` — per-sheet toggle state
- `auto_fit_snapshot: (Record<number, number> | undefined)[]` — per-sheet snapshot of column widths before auto-fit, for reverting

On manual column resize while auto-fit is active: set `auto_fit_active[sheet]` to false, discard `auto_fit_snapshot[sheet]`.

## Files Changed

| File | Changes |
|------|---------|
| `src/webview/measure-column.ts` | New file — `measure_column_fit_width()` utility |
| `src/webview/table.tsx` | `ColumnResizeHandle` gets `on_auto_size` callback and `onDoubleClick` handler |
| `src/webview/app.tsx` | New state (`auto_fit_active`, `auto_fit_snapshot`), updated `on_column_resize` for multi-column selection, new `on_auto_size` handler, new `on_toggle_auto_fit` handler |
| `src/webview/toolbar.tsx` | New "Auto-fit Columns" button with toggle behavior |
