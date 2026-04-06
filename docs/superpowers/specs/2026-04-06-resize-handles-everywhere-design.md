# Resize Handles on Every Cell

## Summary

Currently, column resize handles only appear on the topmost non-hidden row for each column, and row resize handles live in a trailing `<td>` per row. This makes it impossible to resize from most cells in the table — especially confusing in tables with colspans where the handle row varies per column.

This design adds resize handles to every cell's right and bottom edges, with cross-row/cross-column highlight feedback that respects colspan and rowspan boundaries.

## Requirements

1. **Resize from any cell** — every cell's right edge is a column resize handle, every cell's bottom edge is a row resize handle.
2. **Cross-cell highlight** — hovering a resize zone highlights the corresponding border on all applicable rows/columns (not just the hovered cell).
3. **Colspan/rowspan boundaries** — highlights stop at merged cell boundaries. Interior edges of a colspan are excluded from the column boundary group. Same for rowspans and row boundaries.
4. **Colspan outer edge** — hovering/dragging the right edge of a colspan cell highlights only that cell's right border (since the resize distributes across all spanned columns, no single column boundary makes sense).
5. **Equal distribution on span drag** — dragging a colspan cell's right edge distributes the width delta equally across all columns in the span. Same for rowspan cells and row heights.
6. **Full-column highlight during drag** — the highlight border remains visible on all applicable rows throughout the drag, not just on hover.
7. **Visible-row optimization** — highlight classes are only applied to cells within the scroll viewport. On scroll during drag, highlights update on animation frames.
8. **Column resize priority** — when the cursor is in a corner zone where both column and row handles overlap, column resize takes precedence.
9. **Handle hit zone: 7px** — up from 5px for better targeting.
10. **Row resize moves to per-cell handles** — the trailing `<td>` approach is removed; each cell gets a bottom-edge handle zone.
11. **Double-click auto-fit** — works from any row. On a colspan cell, auto-fits all spanned columns independently.

## Architecture

### Approach: Per-cell handles + CSS class propagation

Every `<td>` gets `position: relative` and contains resize handle `<div>` elements on its right edge (column resize) and bottom edge (row resize). On hover or drag, the component computes which other cells share that boundary and applies highlight CSS classes to visible ones.

### New Data Structures

Precomputed once per render from the merge map:

- **`col_boundary_groups: Map<number, Set<number>>`** — for each column boundary (right edge of column `c`), the set of rows where that boundary is exposed (not interior to a colspan).
- **`row_boundary_groups: Map<number, Set<number>>`** — for each row boundary (bottom edge of row `r`), the set of columns where that boundary is exposed (not interior to a rowspan).

### Boundary Group Computation

For column boundaries:
- Iterate all visible cells (non-hidden in merge map).
- A cell at column `c` with `colSpan = s` exposes the boundary at `c + s - 1` (its outer right edge).
- Interior boundaries (between `c` and `c + s - 2`) are NOT exposed on that row.
- Result: `col_boundary_groups.get(1)` → `Set {0, 2, 3}` means "the right edge of column 1 is visible on rows 0, 2, 3 but not row 1 (which has a colspan spanning across it)."

For row boundaries: same logic transposed using rowSpan.

### New State (lifted to Table component)

- `active_col_resize: { boundary_col: number, is_colspan: boolean, colspan_cols: number[] } | null` — which column boundary is hovered or being dragged.
- `active_row_resize: { boundary_row: number, is_rowspan: boolean, rowspan_rows: number[] } | null` — which row boundary is hovered or being dragged.

### Removed

- `resize_handle_row` map — no longer needed since every cell has handles.
- Trailing `<td>` for row resize handles — replaced by per-cell bottom-edge handles.

## Interaction Flow

### Column Resize

1. **Hover**: mouse enters 7px handle div on a cell's right edge. Determine the boundary column. Set `active_col_resize`. Look up `col_boundary_groups.get(boundary)`, intersect with visible rows, apply `resize-col-highlight` class to those cells' right borders.
2. **Leave**: clear state, remove highlight classes.
3. **Drag start** (mousedown): capture `startX` and starting width(s). Attach document-level `mousemove`/`mouseup`. Highlight persists.
4. **Drag move**: compute delta. Single-column: update column width inline. Colspan: divide delta equally among spanned columns, update each inline.
5. **Drag end** (mouseup): call `on_column_resize` for each affected column. Clear state and highlights.

### Row Resize

Symmetric to column resize, using bottom-edge handles and `row_boundary_groups`.

### Colspan Cell Specifics

- The handle on a colspan cell's right edge represents the outer boundary of the span.
- On hover, only that cell's right border highlights (since interior column boundaries don't exist on that row).
- On drag, the total delta is divided equally among all columns in the span.
- On double-click, all spanned columns are auto-fitted independently.

### Rowspan Cell Specifics

Same as colspan but for row heights.

## Visible-Row Optimization

To avoid touching thousands of DOM nodes in large tables:

1. On hover/drag-start, compute which `<tr>` elements are within the scroll container viewport using `scrollTop`, `clientHeight`, and row `offsetTop`/`offsetHeight`.
2. Only apply highlight classes to cells within those rows.
3. During drag, attach a `scroll` event listener on the scroll container. The scroll handler calls `requestAnimationFrame` to batch highlight updates — removing highlights from rows that scrolled out of view and adding them to newly visible rows.
4. Same approach horizontally for row resize highlights.

## Priority Rules

1. **Column resize wins over row resize.** The column handle div overlaps the row handle div in the corner zone; column handle has higher z-index.
2. **Outer edge wins.** A cell's handle always represents its own outer edge boundary.

## CSS

```css
.col-resize-handle {
    position: absolute;
    top: 0;
    right: 0;
    width: 7px;
    height: 100%;
    cursor: col-resize;
    z-index: 2;
}

.row-resize-handle {
    position: absolute;
    bottom: 0;
    left: 0;
    width: 100%;
    height: 7px;
    cursor: row-resize;
    z-index: 1;
}

.col-resize-handle:hover,
.col-resize-handle.dragging {
    background: var(--vscode-focusBorder, #007acc);
}

.row-resize-handle:hover,
.row-resize-handle.dragging {
    background: var(--vscode-focusBorder, #007acc);
}

.data-table td.resize-col-highlight {
    border-right: 2px solid var(--vscode-focusBorder, #007acc);
}

.data-table td.resize-row-highlight {
    border-bottom: 2px solid var(--vscode-focusBorder, #007acc);
}
```

Column handle gets `z-index: 2`, row handle gets `z-index: 1` — this implements the column-priority rule at corners.

## Edge Cases

- **Last column/row**: right/bottom edge is the table boundary. Handles work normally.
- **Fully merged row**: a single cell spanning all columns — only the table-edge boundary is exposed. One right-edge handle for the last column boundary.
- **Colspan at table edge**: right edge is the table boundary. Drag distributes across spanned columns.
- **Single-cell table**: one column handle (right), one row handle (bottom).
- **Nested rowspan + colspan**: right-edge handle triggers column resize with equal distribution; bottom-edge handle triggers row resize with equal distribution. Boundary groups correctly exclude interior boundaries in both dimensions.
- **Scroll during drag**: highlights update on animation frame as visible row set changes.

## Test Plan

1. **Simple table (no merges)**: hover any cell's right edge → full column highlight. Drag → all rows update width. Same for bottom edge / row height.
2. **Table with colspan**: hover B|C boundary → highlight on all rows except those with a colspan spanning B–C. Hover colspan's outer right edge → only that row highlights.
3. **Table with rowspan**: hover a row boundary → highlight on all columns except those with a rowspan spanning across it.
4. **Colspan drag distribution**: drag a colspan cell's right edge by 60px with 3 spanned columns → each grows by 20px.
5. **Corner priority**: cursor at bottom-right corner of a cell → col-resize cursor (not row-resize).
6. **Scroll during drag**: start dragging in a large table, scroll → highlights update, no stale highlights.
7. **Handle hit zone**: verify 7px target works on regular and high-DPI displays.
8. **Auto-fit from any row**: double-click handle on a non-header row → column auto-fits.
9. **Colspan auto-fit**: double-click on colspan handle → all spanned columns auto-fit independently.

## Files to Modify

- `src/webview/table.tsx` — main changes: remove `resize_handle_row`, add boundary group computation, place handles on every cell, add highlight state/coordination
- `src/webview/styles.css` — update handle widths to 7px, add highlight classes, adjust z-index
- `src/webview/app.tsx` — update `handle_column_resize` callback to support multi-column resize from colspan drags
