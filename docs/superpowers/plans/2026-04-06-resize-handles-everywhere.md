# Resize Handles Everywhere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable column and row resizing from any cell, with cross-cell border highlighting that respects colspan/rowspan boundaries.

**Architecture:** Every `<td>` gets resize handle divs on its right and bottom edges. A precomputed boundary-group map determines which rows/cols share each boundary. Hover/drag state is lifted to the `Table` component and drives CSS highlight classes on visible cells.

**Tech Stack:** React, TypeScript, Vitest (jsdom), CSS

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/webview/boundary-groups.ts` | Create | Pure function: `build_boundary_groups()` — computes `col_boundary_groups` and `row_boundary_groups` from merge map |
| `src/test/boundary-groups.test.ts` | Create | Tests for boundary group computation |
| `src/webview/table.tsx` | Modify | Remove `resize_handle_row` map, add handles to every cell, lift hover/drag state, apply highlight classes |
| `src/webview/styles.css` | Modify | Update handle widths to 7px, add highlight classes, adjust z-index |
| `src/webview/app.tsx` | Modify | Support multi-column resize callback for colspan drags |

---

### Task 1: Build boundary group computation

**Files:**
- Create: `src/webview/boundary-groups.ts`
- Create: `src/test/boundary-groups.test.ts`

- [ ] **Step 1: Write the test file with tests for col_boundary_groups**

Create `src/test/boundary-groups.test.ts`:

```typescript
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { build_boundary_groups } from '../webview/boundary-groups';
import type { MergeRange } from '../types';

describe('build_boundary_groups', () => {
    it('returns all rows for each boundary in a simple 3x3 table', () => {
        const { col_boundary_groups, row_boundary_groups } =
            build_boundary_groups(3, 3, []);

        // Every row has every column boundary exposed
        expect(col_boundary_groups.get(0)).toEqual(new Set([0, 1, 2]));
        expect(col_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));
        expect(col_boundary_groups.get(2)).toEqual(new Set([0, 1, 2]));

        // Every column has every row boundary exposed
        expect(row_boundary_groups.get(0)).toEqual(new Set([0, 1, 2]));
        expect(row_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));
        expect(row_boundary_groups.get(2)).toEqual(new Set([0, 1, 2]));
    });

    it('excludes interior colspan boundaries', () => {
        // Row 1 has a colspan spanning cols 0-1 (boundary 0 is interior)
        const merges: MergeRange[] = [
            { startRow: 1, startCol: 0, endRow: 1, endCol: 1 },
        ];
        const { col_boundary_groups } =
            build_boundary_groups(3, 3, merges);

        // Boundary 0 (right edge of col 0): row 1 excluded (interior of colspan)
        expect(col_boundary_groups.get(0)).toEqual(new Set([0, 2]));
        // Boundary 1 (right edge of col 1 = outer edge of colspan): all rows
        expect(col_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));
        // Boundary 2 (right edge of col 2): all rows
        expect(col_boundary_groups.get(2)).toEqual(new Set([0, 1, 2]));
    });

    it('excludes interior rowspan boundaries', () => {
        // Col 1 has a rowspan spanning rows 0-1 (boundary 0 is interior)
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 1, endRow: 1, endCol: 1 },
        ];
        const { row_boundary_groups } =
            build_boundary_groups(3, 3, merges);

        // Boundary 0 (bottom edge of row 0): col 1 excluded (interior of rowspan)
        expect(row_boundary_groups.get(0)).toEqual(new Set([0, 2]));
        // Boundary 1 (bottom edge of row 1 = outer edge of rowspan): all cols
        expect(row_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));
    });

    it('handles a cell with both colspan and rowspan', () => {
        // Cell at (0,0) spans 2 rows and 2 cols
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
        ];
        const { col_boundary_groups, row_boundary_groups } =
            build_boundary_groups(3, 3, merges);

        // Col boundary 0: rows 0 and 1 excluded (interior of colspan)
        expect(col_boundary_groups.get(0)).toEqual(new Set([2]));
        // Col boundary 1 (outer right edge): all rows (rows 0-1 exposed via the merged cell)
        expect(col_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));

        // Row boundary 0: cols 0 and 1 excluded (interior of rowspan)
        expect(row_boundary_groups.get(0)).toEqual(new Set([2]));
        // Row boundary 1 (outer bottom edge): all cols (cols 0-1 exposed via the merged cell)
        expect(row_boundary_groups.get(1)).toEqual(new Set([0, 1, 2]));
    });

    it('handles fully merged row (one cell spans all columns)', () => {
        // Row 0: single cell spanning all 3 columns
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 2 },
        ];
        const { col_boundary_groups } =
            build_boundary_groups(2, 3, merges);

        // Boundary 0 (interior): row 0 excluded
        expect(col_boundary_groups.get(0)).toEqual(new Set([1]));
        // Boundary 1 (interior): row 0 excluded
        expect(col_boundary_groups.get(1)).toEqual(new Set([1]));
        // Boundary 2 (outer right edge of full-row span): row 0 included
        expect(col_boundary_groups.get(2)).toEqual(new Set([0, 1]));
    });

    it('returns empty maps for a single-cell table', () => {
        const { col_boundary_groups, row_boundary_groups } =
            build_boundary_groups(1, 1, []);

        expect(col_boundary_groups.get(0)).toEqual(new Set([0]));
        expect(row_boundary_groups.get(0)).toEqual(new Set([0]));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/boundary-groups.test.ts`
Expected: FAIL — module `../webview/boundary-groups` not found.

- [ ] **Step 3: Write the boundary-groups module**

Create `src/webview/boundary-groups.ts`:

```typescript
import type { MergeRange } from '../types';

export interface BoundaryGroups {
    /** For each column boundary (right edge of col c), the set of rows where that boundary is exposed. */
    col_boundary_groups: Map<number, Set<number>>;
    /** For each row boundary (bottom edge of row r), the set of columns where that boundary is exposed. */
    row_boundary_groups: Map<number, Set<number>>;
}

/**
 * Precompute which rows/columns share each resize boundary.
 *
 * A column boundary at `c` is "exposed" on row `r` if the cell occupying
 * column `c` on row `r` ends at column `c` (i.e., `c` is the rightmost
 * column of that cell). Interior boundaries of a colspan are NOT exposed.
 *
 * Same logic transposed for row boundaries.
 */
export function build_boundary_groups(
    row_count: number,
    col_count: number,
    merges: MergeRange[]
): BoundaryGroups {
    // Build merge lookup: for each anchor cell, store its span dimensions.
    // All other cells in a merge are "hidden".
    type MergeEntry = 'hidden' | { rowSpan: number; colSpan: number };
    const merge_map = new Map<string, MergeEntry>();

    for (const m of merges) {
        merge_map.set(`${m.startRow}:${m.startCol}`, {
            rowSpan: m.endRow - m.startRow + 1,
            colSpan: m.endCol - m.startCol + 1,
        });
        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r === m.startRow && c === m.startCol) continue;
                merge_map.set(`${r}:${c}`, 'hidden');
            }
        }
    }

    const col_boundary_groups = new Map<number, Set<number>>();
    const row_boundary_groups = new Map<number, Set<number>>();

    // Initialize all boundaries
    for (let c = 0; c < col_count; c++) {
        col_boundary_groups.set(c, new Set());
    }
    for (let r = 0; r < row_count; r++) {
        row_boundary_groups.set(r, new Set());
    }

    // Iterate every cell position
    for (let r = 0; r < row_count; r++) {
        for (let c = 0; c < col_count; c++) {
            const entry = merge_map.get(`${r}:${c}`);
            if (entry === 'hidden') continue;

            const col_span = entry ? entry.colSpan : 1;
            const row_span = entry ? entry.rowSpan : 1;

            // This cell's outer right edge is at column (c + colSpan - 1)
            const right_boundary = c + col_span - 1;
            col_boundary_groups.get(right_boundary)!.add(r);

            // This cell's outer bottom edge is at row (r + rowSpan - 1)
            const bottom_boundary = r + row_span - 1;
            row_boundary_groups.get(bottom_boundary)!.add(c);
        }
    }

    return { col_boundary_groups, row_boundary_groups };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/boundary-groups.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview/boundary-groups.ts src/test/boundary-groups.test.ts
git commit -m "feat: add boundary group computation for resize highlights"
```

---

### Task 2: Update CSS for new handle sizes and highlight classes

**Files:**
- Modify: `src/webview/styles.css:172-200`

- [ ] **Step 1: Update col-resize-handle width and z-index**

In `src/webview/styles.css`, change the `.col-resize-handle` rule (lines 172-180):

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
```

Changes: `width: 5px` → `width: 7px`, `z-index: 1` → `z-index: 2`.

- [ ] **Step 2: Update row-resize-handle height and z-index**

Change the `.row-resize-handle` rule (lines 187-195):

```css
.row-resize-handle {
    position: absolute;
    bottom: 0;
    left: 0;
    width: 100%;
    height: 7px;
    cursor: row-resize;
    z-index: 1;
}
```

Changes: `height: 5px` → `height: 7px`. z-index stays at 1 (column wins at corners).

- [ ] **Step 3: Add highlight classes**

After the `.row-resize-handle.dragging` rule (after line 200), add:

```css
.data-table td.resize-col-highlight {
    border-right: 2px solid var(--vscode-focusBorder, #007acc);
}

.data-table td.resize-row-highlight {
    border-bottom: 2px solid var(--vscode-focusBorder, #007acc);
}
```

- [ ] **Step 4: Verify styles visually**

Run: `npm run bundle:webview`
Expected: Build succeeds. No CSS errors.

- [ ] **Step 5: Commit**

```bash
git add src/webview/styles.css
git commit -m "feat: update resize handle sizes to 7px and add highlight classes"
```

---

### Task 3: Place resize handles on every cell and remove old placement logic

**Files:**
- Modify: `src/webview/table.tsx:24-170`

This task adds handles to every cell and removes the `resize_handle_row` map. No highlight coordination yet — that comes in Task 4.

- [ ] **Step 1: Remove the resize_handle_row computation**

In `src/webview/table.tsx`, delete lines 43-52 (the `resize_handle_row` map computation):

```typescript
// DELETE THIS BLOCK:
    const resize_handle_row = new Map<number, number>();
    for (let c = 0; c < sheet.columnCount; c++) {
        for (let r = 0; r < sheet.rows.length; r++) {
            const entry = merge_map.get(`${r}:${c}`);
            if (entry !== 'hidden') {
                resize_handle_row.set(c, r);
                break;
            }
        }
    }
```

- [ ] **Step 2: Make every td position: relative and add both handles**

Replace the cell rendering logic. The current code (lines 93-94, 113-161) conditionally shows the handle and sets `position: relative`. Change it so every cell always has both handles.

In the `<td>` style, replace:

```typescript
style={{
    ...(column_widths[c]
        ? {
              width: `${column_widths[c]}px`,
              minWidth: `${column_widths[c]}px`,
          }
        : undefined),
    ...(show_resize_handle
        ? {
              position:
                  'relative',
          }
        : undefined),
}}
```

With:

```typescript
style={{
    position: 'relative',
    ...(column_widths[c]
        ? {
              width: `${column_widths[c]}px`,
              minWidth: `${column_widths[c]}px`,
          }
        : undefined),
}}
```

Remove the `show_resize_handle` variable (line 93-94) and the conditional render of `ColumnResizeHandle` (lines 144-152). Replace with unconditional handles:

```tsx
<ColumnResizeHandle
    col={span_props.colSpan
        ? c + (span_props.colSpan - 1)
        : c}
    on_resize={on_column_resize}
    on_auto_size={on_auto_size}
    colspan_cols={span_props.colSpan && span_props.colSpan > 1
        ? Array.from({ length: span_props.colSpan }, (_, i) => c + i)
        : undefined}
/>
<CellContent
    cell={cell}
    show_formatting={show_formatting}
/>
```

- [ ] **Step 3: Move RowResizeHandle from trailing td to inside each cell**

Currently, `RowResizeHandle` is rendered as a trailing `<td>` after each row (line 162-165):

```tsx
<RowResizeHandle
    row={r}
    on_resize={on_row_resize}
/>
```

Remove this from after the `row.map(...)` call. Instead, add a `RowResizeHandle` div inside each `<td>`, right after the `ColumnResizeHandle`:

```tsx
<ColumnResizeHandle
    col={span_props.colSpan
        ? c + (span_props.colSpan - 1)
        : c}
    on_resize={on_column_resize}
    on_auto_size={on_auto_size}
    colspan_cols={span_props.colSpan && span_props.colSpan > 1
        ? Array.from({ length: span_props.colSpan }, (_, i) => c + i)
        : undefined}
/>
<RowResizeHandle
    row={span_props.rowSpan
        ? r + (span_props.rowSpan - 1)
        : r}
    on_resize={on_row_resize}
    rowspan_rows={span_props.rowSpan && span_props.rowSpan > 1
        ? Array.from({ length: span_props.rowSpan }, (_, i) => r + i)
        : undefined}
/>
<CellContent
    cell={cell}
    show_formatting={show_formatting}
/>
```

- [ ] **Step 4: Update ColumnResizeHandle to accept colspan_cols prop**

Update the `ColumnResizeHandleProps` interface and component:

```typescript
interface ColumnResizeHandleProps {
    col: number;
    on_resize: (col: number, width: number) => void;
    on_auto_size: (col: number) => void;
    colspan_cols?: number[];
}
```

In `handle_mouse_down`, when `colspan_cols` is provided, distribute the delta equally:

```typescript
function ColumnResizeHandle({
    col,
    on_resize,
    on_auto_size,
    colspan_cols,
}: ColumnResizeHandleProps): React.JSX.Element {
    const dragging_ref = useRef(false);

    const handle_mouse_down = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            dragging_ref.current = true;

            const start_x = e.clientX;
            const td = (e.target as HTMLElement).parentElement!;
            const start_width = td.offsetWidth;

            if (colspan_cols && colspan_cols.length > 1) {
                // Colspan drag: distribute delta equally
                const handle_mouse_move = (move_e: MouseEvent) => {
                    const new_width = Math.max(
                        40 * colspan_cols.length,
                        start_width + move_e.clientX - start_x
                    );
                    td.style.width = `${new_width}px`;
                    td.style.minWidth = `${new_width}px`;
                };

                const handle_mouse_up = (up_e: MouseEvent) => {
                    dragging_ref.current = false;
                    document.removeEventListener('mousemove', handle_mouse_move);
                    document.removeEventListener('mouseup', handle_mouse_up);
                    const total_delta = up_e.clientX - start_x;
                    const per_col_delta = total_delta / colspan_cols.length;
                    // We need the individual starting widths. Approximate by
                    // dividing the starting td width equally.
                    const per_col_start = start_width / colspan_cols.length;
                    for (const c of colspan_cols) {
                        const final_width = Math.max(40, per_col_start + per_col_delta);
                        on_resize(c, final_width);
                    }
                };

                document.addEventListener('mousemove', handle_mouse_move);
                document.addEventListener('mouseup', handle_mouse_up);
            } else {
                // Single column drag (existing logic)
                const handle_mouse_move = (move_e: MouseEvent) => {
                    const new_width = Math.max(
                        40,
                        start_width + move_e.clientX - start_x
                    );
                    td.style.width = `${new_width}px`;
                    td.style.minWidth = `${new_width}px`;
                };

                const handle_mouse_up = (up_e: MouseEvent) => {
                    dragging_ref.current = false;
                    document.removeEventListener('mousemove', handle_mouse_move);
                    document.removeEventListener('mouseup', handle_mouse_up);
                    const final_width = Math.max(
                        40,
                        start_width + up_e.clientX - start_x
                    );
                    on_resize(col, final_width);
                };

                document.addEventListener('mousemove', handle_mouse_move);
                document.addEventListener('mouseup', handle_mouse_up);
            }
        },
        [col, on_resize, colspan_cols]
    );

    const handle_double_click = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (colspan_cols && colspan_cols.length > 1) {
                for (const c of colspan_cols) {
                    on_auto_size(c);
                }
            } else {
                on_auto_size(col);
            }
        },
        [col, on_auto_size, colspan_cols]
    );

    return (
        <div
            className="col-resize-handle"
            onMouseDown={handle_mouse_down}
            onDoubleClick={handle_double_click}
        />
    );
}
```

- [ ] **Step 5: Update RowResizeHandle to be a div (not a td) and accept rowspan_rows**

Replace the entire `RowResizeHandle` component. It currently renders as a `<td>` — change it to a `<div>` positioned inside the cell:

```typescript
interface RowResizeHandleProps {
    row: number;
    on_resize: (row: number, height: number) => void;
    rowspan_rows?: number[];
}

function RowResizeHandle({
    row,
    on_resize,
    rowspan_rows,
}: RowResizeHandleProps): React.JSX.Element {
    const handle_mouse_down = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const tr = (e.target as HTMLElement).closest('tr')!;
            const start_y = e.clientY;
            const start_height = tr.offsetHeight;

            if (rowspan_rows && rowspan_rows.length > 1) {
                const handle_mouse_move = (move_e: MouseEvent) => {
                    const new_height = Math.max(
                        20 * rowspan_rows.length,
                        start_height + move_e.clientY - start_y
                    );
                    tr.style.height = `${new_height}px`;
                };

                const handle_mouse_up = (up_e: MouseEvent) => {
                    document.removeEventListener('mousemove', handle_mouse_move);
                    document.removeEventListener('mouseup', handle_mouse_up);
                    const total_delta = up_e.clientY - start_y;
                    const per_row_delta = total_delta / rowspan_rows.length;
                    const per_row_start = start_height / rowspan_rows.length;
                    for (const r of rowspan_rows) {
                        const final_height = Math.max(20, per_row_start + per_row_delta);
                        on_resize(r, final_height);
                    }
                };

                document.addEventListener('mousemove', handle_mouse_move);
                document.addEventListener('mouseup', handle_mouse_up);
            } else {
                const handle_mouse_move = (move_e: MouseEvent) => {
                    const new_height = Math.max(
                        20,
                        start_height + move_e.clientY - start_y
                    );
                    tr.style.height = `${new_height}px`;
                };

                const handle_mouse_up = (up_e: MouseEvent) => {
                    document.removeEventListener('mousemove', handle_mouse_move);
                    document.removeEventListener('mouseup', handle_mouse_up);
                    const final_height = Math.max(
                        20,
                        start_height + up_e.clientY - start_y
                    );
                    on_resize(row, final_height);
                };

                document.addEventListener('mousemove', handle_mouse_move);
                document.addEventListener('mouseup', handle_mouse_up);
            }
        },
        [row, on_resize, rowspan_rows]
    );

    return (
        <div
            className="row-resize-handle"
            onMouseDown={handle_mouse_down}
        />
    );
}
```

- [ ] **Step 6: Verify build succeeds**

Run: `npm run bundle:webview`
Expected: Build succeeds with no errors.

- [ ] **Step 7: Run existing tests to check for regressions**

Run: `npx vitest run`
Expected: All existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/webview/table.tsx
git commit -m "feat: place resize handles on every cell with colspan/rowspan support"
```

---

### Task 4: Add cross-cell highlight on hover and during drag

**Files:**
- Modify: `src/webview/table.tsx`

This task adds the highlight coordination: when hovering or dragging a resize handle, applicable cells across the column/row get a CSS highlight class.

- [ ] **Step 1: Import boundary groups and add state to Table component**

At the top of `table.tsx`, add the import:

```typescript
import { build_boundary_groups } from './boundary-groups';
```

Inside the `Table` function body, after `const merge_map = build_merge_map(sheet.merges);`, add:

```typescript
const { col_boundary_groups, row_boundary_groups } = build_boundary_groups(
    sheet.rows.length,
    sheet.columnCount,
    sheet.merges
);

const [active_col_boundary, set_active_col_boundary] = useState<number | null>(null);
const [active_row_boundary, set_active_row_boundary] = useState<number | null>(null);
```

Add `useState` to the React import at the top of the file.

- [ ] **Step 2: Create highlight helper function**

Add a helper inside the `Table` component to check if a cell should be highlighted:

```typescript
const is_col_highlighted = useCallback(
    (r: number, c: number, col_span: number): boolean => {
        if (active_col_boundary === null) return false;
        const cell_right_boundary = c + col_span - 1;
        if (cell_right_boundary !== active_col_boundary) return false;
        const group = col_boundary_groups.get(active_col_boundary);
        return group !== undefined && group.has(r);
    },
    [active_col_boundary, col_boundary_groups]
);

const is_row_highlighted = useCallback(
    (r: number, c: number, row_span: number): boolean => {
        if (active_row_boundary === null) return false;
        const cell_bottom_boundary = r + row_span - 1;
        if (cell_bottom_boundary !== active_row_boundary) return false;
        const group = row_boundary_groups.get(active_row_boundary);
        return group !== undefined && group.has(c);
    },
    [active_row_boundary, row_boundary_groups]
);
```

- [ ] **Step 3: Pass highlight callbacks to ColumnResizeHandle and RowResizeHandle**

Update `ColumnResizeHandleProps` to include hover callbacks:

```typescript
interface ColumnResizeHandleProps {
    col: number;
    on_resize: (col: number, width: number) => void;
    on_auto_size: (col: number) => void;
    colspan_cols?: number[];
    on_hover_start: (boundary_col: number) => void;
    on_hover_end: () => void;
}
```

In `ColumnResizeHandle`, add `onMouseEnter` and `onMouseLeave` to the returned div:

```tsx
return (
    <div
        className="col-resize-handle"
        onMouseDown={handle_mouse_down}
        onDoubleClick={handle_double_click}
        onMouseEnter={() => on_hover_start(col)}
        onMouseLeave={() => {
            if (!dragging_ref.current) on_hover_end();
        }}
    />
);
```

In the `handle_mouse_up` handlers (both single and colspan branches), add `on_hover_end()` after removing listeners:

```typescript
const handle_mouse_up = (up_e: MouseEvent) => {
    dragging_ref.current = false;
    document.removeEventListener('mousemove', handle_mouse_move);
    document.removeEventListener('mouseup', handle_mouse_up);
    // ... existing resize logic ...
    on_hover_end();
};
```

Do the same for `RowResizeHandleProps`:

```typescript
interface RowResizeHandleProps {
    row: number;
    on_resize: (row: number, height: number) => void;
    rowspan_rows?: number[];
    on_hover_start: (boundary_row: number) => void;
    on_hover_end: () => void;
}
```

Add `onMouseEnter` and `onMouseLeave` to the row handle div, and `on_hover_end()` in `handle_mouse_up`.

- [ ] **Step 4: Wire up hover callbacks in Table component**

In the `Table` component, create the callbacks:

```typescript
const handle_col_hover_start = useCallback(
    (boundary_col: number) => set_active_col_boundary(boundary_col),
    []
);
const handle_col_hover_end = useCallback(
    () => set_active_col_boundary(null),
    []
);
const handle_row_hover_start = useCallback(
    (boundary_row: number) => set_active_row_boundary(boundary_row),
    []
);
const handle_row_hover_end = useCallback(
    () => set_active_row_boundary(null),
    []
);
```

Pass these to the handle components:

```tsx
<ColumnResizeHandle
    col={span_props.colSpan ? c + (span_props.colSpan - 1) : c}
    on_resize={on_column_resize}
    on_auto_size={on_auto_size}
    colspan_cols={span_props.colSpan && span_props.colSpan > 1
        ? Array.from({ length: span_props.colSpan }, (_, i) => c + i)
        : undefined}
    on_hover_start={handle_col_hover_start}
    on_hover_end={handle_col_hover_end}
/>
<RowResizeHandle
    row={span_props.rowSpan ? r + (span_props.rowSpan - 1) : r}
    on_resize={on_row_resize}
    rowspan_rows={span_props.rowSpan && span_props.rowSpan > 1
        ? Array.from({ length: span_props.rowSpan }, (_, i) => r + i)
        : undefined}
    on_hover_start={handle_row_hover_start}
    on_hover_end={handle_row_hover_end}
/>
```

- [ ] **Step 5: Apply highlight classes to cells**

In the cell rendering, update the `class_names` computation to include highlight classes:

```typescript
const col_span = span_props.colSpan ?? 1;
const row_span = span_props.rowSpan ?? 1;

const col_highlighted = is_col_highlighted(r, c, col_span);
const row_highlighted = is_row_highlighted(r, c, row_span);

const class_names = [
    selected ? 'selected' : '',
    is_anchor ? 'active-cell' : '',
    col_highlighted ? 'resize-col-highlight' : '',
    row_highlighted ? 'resize-row-highlight' : '',
]
    .filter(Boolean)
    .join(' ');
```

- [ ] **Step 6: Verify build succeeds**

Run: `npm run bundle:webview`
Expected: Build succeeds.

- [ ] **Step 7: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/webview/table.tsx
git commit -m "feat: add cross-cell highlight on resize handle hover and drag"
```

---

### Task 5: Add visible-row optimization for highlights

**Files:**
- Modify: `src/webview/table.tsx`

For large tables, applying highlight classes to all rows is expensive. This task limits highlights to rows visible in the scroll viewport and updates on scroll during drag.

- [ ] **Step 1: Add visible-row computation helper**

Add a function inside or outside the Table component:

```typescript
function get_visible_row_range(
    scroll_el: HTMLElement,
    table_el: HTMLTableElement
): { first: number; last: number } {
    const rows = table_el.querySelectorAll('tbody tr');
    if (rows.length === 0) return { first: 0, last: -1 };

    const scroll_top = scroll_el.scrollTop;
    const viewport_bottom = scroll_top + scroll_el.clientHeight;

    let first = 0;
    let last = rows.length - 1;

    // Binary search for first visible row
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const row = rows[mid] as HTMLElement;
        if (row.offsetTop + row.offsetHeight < scroll_top) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    first = lo;

    // Binary search for last visible row
    lo = first;
    hi = rows.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        const row = rows[mid] as HTMLElement;
        if (row.offsetTop > viewport_bottom) {
            hi = mid - 1;
        } else {
            lo = mid;
        }
    }
    last = lo;

    return { first, last };
}
```

- [ ] **Step 2: Integrate visible-row filtering into highlight logic**

Update `is_col_highlighted` and `is_row_highlighted` to accept a visible range and filter against it:

```typescript
const visible_range_ref = useRef<{ first: number; last: number }>({ first: 0, last: Infinity });

// Recompute visible range when active boundary changes
useEffect(() => {
    if (active_col_boundary === null && active_row_boundary === null) return;
    const scroll_el = scroll_ref.current;
    const table_el = table_ref.current;
    if (!scroll_el || !table_el) return;
    visible_range_ref.current = get_visible_row_range(scroll_el, table_el);
}, [active_col_boundary, active_row_boundary]);
```

Update `is_col_highlighted`:

```typescript
const is_col_highlighted = useCallback(
    (r: number, c: number, col_span: number): boolean => {
        if (active_col_boundary === null) return false;
        const cell_right_boundary = c + col_span - 1;
        if (cell_right_boundary !== active_col_boundary) return false;
        const { first, last } = visible_range_ref.current;
        if (r < first || r > last) return false;
        const group = col_boundary_groups.get(active_col_boundary);
        return group !== undefined && group.has(r);
    },
    [active_col_boundary, col_boundary_groups]
);
```

Apply the same pattern to `is_row_highlighted` (check column visibility instead of row).

- [ ] **Step 3: Add scroll listener during drag to update highlights**

Add a `useEffect` that attaches a scroll listener when a boundary is active:

```typescript
useEffect(() => {
    if (active_col_boundary === null && active_row_boundary === null) return;
    const scroll_el = scroll_ref.current;
    const table_el = table_ref.current;
    if (!scroll_el || !table_el) return;

    let raf_id: number | null = null;

    const on_scroll = () => {
        if (raf_id !== null) return;
        raf_id = requestAnimationFrame(() => {
            raf_id = null;
            visible_range_ref.current = get_visible_row_range(scroll_el, table_el);
            // Force re-render to update highlight classes
            set_active_col_boundary((prev) => prev);
            set_active_row_boundary((prev) => prev);
        });
    };

    scroll_el.addEventListener('scroll', on_scroll, { passive: true });
    return () => {
        scroll_el.removeEventListener('scroll', on_scroll);
        if (raf_id !== null) cancelAnimationFrame(raf_id);
    };
}, [active_col_boundary, active_row_boundary]);
```

Note: `set_active_col_boundary((prev) => prev)` with an identity updater forces a re-render so the highlight classes recalculate against the new visible range. This is a lightweight way to trigger the update without additional state.

- [ ] **Step 4: Verify build**

Run: `npm run bundle:webview`
Expected: Build succeeds.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/webview/table.tsx
git commit -m "feat: optimize resize highlights to visible rows only"
```

---

### Task 6: Update app.tsx for multi-column resize from colspan drags

**Files:**
- Modify: `src/webview/app.tsx:554-584`

The `handle_column_resize` in `TableWithSelection` already handles selection-aware multi-column resize. The `handle_column_resize` in `App` (line 317) handles single-column resize. Both need to work correctly when the `Table` component calls `on_resize` multiple times (once per column in a colspan drag).

- [ ] **Step 1: Verify current behavior is compatible**

The current `handle_column_resize` in `app.tsx` (lines 317-335) sets widths for a single column and deactivates auto-fit. When a colspan drag calls it N times (once per spanned column), each call will:
1. Set that column's width ✓
2. Call `deactivate_auto_fit_for_sheet` — which is idempotent ✓

The `TableWithSelection` wrapper (lines 554-568) checks if the resized column is in a multi-column selection. For colspan drags, the `on_resize` is called from the handle component directly — it doesn't go through the selection-aware wrapper's loop because each column gets its own `on_resize` call.

This should work correctly as-is. No code changes needed.

- [ ] **Step 2: Verify auto-size for colspan double-click**

When `ColumnResizeHandle` is double-clicked on a colspan cell, the component calls `on_auto_size(c)` for each column in `colspan_cols`. The `handle_auto_size` in `TableWithSelection` (lines 570-583) checks if the column is in a multi-column selection — if not, it calls `on_auto_size(col)` which measures and resizes.

This should work correctly — each column gets auto-sized independently.

- [ ] **Step 3: Run full test suite to verify**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 4: Commit (if any changes were needed)**

No commit needed if no changes were required. Move to Task 7.

---

### Task 7: End-to-end verification and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 2: Run production build**

Run: `npm run bundle && npm run bundle:webview`
Expected: Both builds succeed with no errors.

- [ ] **Step 3: Manual testing checklist**

Open the extension in VS Code with a test spreadsheet. Verify:

1. Simple table: hover any cell's right edge → col-resize cursor appears, blue highlight on full column border
2. Simple table: hover any cell's bottom edge → row-resize cursor appears, blue highlight on full row border
3. Drag column handle from a non-header row → column resizes, all rows update
4. Drag row handle from any cell → row resizes
5. Table with colspans: hover B|C boundary → highlight on rows without a spanning colspan, not on rows with one
6. Colspan cell: hover outer right edge → only that cell highlights
7. Colspan cell: drag right edge → all spanned columns resize equally
8. Colspan cell: double-click right edge → all spanned columns auto-fit
9. Corner of cell: col-resize cursor takes priority over row-resize
10. Large table: scroll while dragging → highlights update smoothly
11. Handle zone feels comfortable to target (7px)

- [ ] **Step 4: Final commit if any cleanup was done**

```bash
git add -A
git commit -m "chore: cleanup after resize handles everywhere implementation"
```
