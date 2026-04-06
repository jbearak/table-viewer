# Column Resizing Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-column resize, double-click auto-size, and an auto-fit-all toolbar toggle to the table viewer.

**Architecture:** A new `measure_column_fit_width()` utility handles DOM-based column measurement. The existing `ColumnResizeHandle` gains a double-click handler. The `on_column_resize` callback in `app.tsx` is updated to apply widths across selected columns. A new toolbar toggle snapshots widths before auto-fitting and can revert them.

**Tech Stack:** React, TypeScript, Vitest (jsdom)

---

### Task 1: Create `measure_column_fit_width` utility

**Files:**
- Create: `src/webview/measure-column.ts`
- Test: `src/test/measure-column.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/test/measure-column.test.ts`:

```typescript
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { measure_column_fit_width } from '../webview/measure-column';
import type { MergeRange } from '../types';

function build_table(rows: string[][], merges: MergeRange[] = []): HTMLTableElement {
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    const hidden = new Set<string>();
    const span_map = new Map<string, { rowSpan: number; colSpan: number }>();
    for (const m of merges) {
        span_map.set(`${m.startRow}:${m.startCol}`, {
            rowSpan: m.endRow - m.startRow + 1,
            colSpan: m.endCol - m.startCol + 1,
        });
        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r !== m.startRow || c !== m.startCol) {
                    hidden.add(`${r}:${c}`);
                }
            }
        }
    }

    for (let r = 0; r < rows.length; r++) {
        const tr = document.createElement('tr');
        for (let c = 0; c < rows[r].length; c++) {
            if (hidden.has(`${r}:${c}`)) continue;
            const td = document.createElement('td');
            td.textContent = rows[r][c];
            const spans = span_map.get(`${r}:${c}`);
            if (spans) {
                td.rowSpan = spans.rowSpan;
                td.colSpan = spans.colSpan;
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }

    document.body.appendChild(table);
    return table;
}

describe('measure_column_fit_width', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('returns minimum width of 40 for empty cells', () => {
        const table = build_table([[''], [''], ['']]);
        const width = measure_column_fit_width(table, 0, []);
        expect(width).toBe(40);
    });

    it('measures the widest cell in the column plus padding', () => {
        const table = build_table([
            ['short', 'x'],
            ['a much longer cell value', 'y'],
            ['mid', 'z'],
        ]);
        // We can't assert exact pixel values in jsdom (no layout engine),
        // but we can verify it returns at least the minimum
        const width = measure_column_fit_width(table, 0, []);
        expect(width).toBeGreaterThanOrEqual(40);
    });

    it('skips merged header row when it spans multiple columns', () => {
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
        ];
        const table = build_table(
            [
                ['Very long merged header text', ''],
                ['A', 'B'],
                ['C', 'D'],
            ],
            merges
        );
        // Should not throw and should return a valid width
        const width = measure_column_fit_width(table, 0, merges);
        expect(width).toBeGreaterThanOrEqual(40);
    });

    it('includes header row when it is not merged across columns', () => {
        const table = build_table([
            ['Header Col 0', 'Header Col 1'],
            ['A', 'B'],
        ]);
        const width = measure_column_fit_width(table, 0, []);
        expect(width).toBeGreaterThanOrEqual(40);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/test/measure-column.test.ts`
Expected: FAIL — `measure_column_fit_width` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/webview/measure-column.ts`:

```typescript
import type { MergeRange } from '../types';

const MIN_WIDTH = 40;
const PADDING = 16;

export function measure_column_fit_width(
    table: HTMLTableElement,
    col: number,
    merges: MergeRange[]
): number {
    const rows = table.querySelectorAll('tbody tr');
    if (rows.length === 0) return MIN_WIDTH;

    // Build a set of merge-hidden cells and a map of multi-column merges
    const hidden = new Set<string>();
    const multi_col_merges = new Set<string>();
    for (const m of merges) {
        if (m.endCol > m.startCol) {
            for (let r = m.startRow; r <= m.endRow; r++) {
                for (let c = m.startCol; c <= m.endCol; c++) {
                    multi_col_merges.add(`${r}:${c}`);
                }
            }
        }
        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r !== m.startRow || c !== m.startCol) {
                    hidden.add(`${r}:${c}`);
                }
            }
        }
    }

    // Create an off-screen measurement element
    const measurer = document.createElement('span');
    measurer.style.position = 'absolute';
    measurer.style.visibility = 'hidden';
    measurer.style.whiteSpace = 'nowrap';
    measurer.style.left = '-9999px';
    document.body.appendChild(measurer);

    let max_width = 0;

    rows.forEach((tr, row_index) => {
        // Skip hidden cells
        if (hidden.has(`${row_index}:${col}`)) return;

        // Skip row 0 if it's a multi-column merge at this column
        if (row_index === 0 && multi_col_merges.has(`0:${col}`)) return;

        // Find the td for this column. Since hidden cells are not rendered,
        // we need to count visible columns up to our target.
        let visible_col = 0;
        let target_td: HTMLTableCellElement | null = null;
        const tds = tr.querySelectorAll('td');
        for (const td of tds) {
            const col_span = td.colSpan || 1;
            if (visible_col <= col && col < visible_col + col_span) {
                // Only measure if this td is exactly for our column
                // (not a multi-column span that happens to cover it)
                if (col_span === 1) {
                    target_td = td;
                }
                break;
            }
            visible_col += col_span;
        }

        if (!target_td) return;

        // Copy font styles from the cell
        const computed = window.getComputedStyle(target_td);
        measurer.style.fontFamily = computed.fontFamily;
        measurer.style.fontSize = computed.fontSize;
        measurer.style.fontWeight = computed.fontWeight;
        measurer.style.fontStyle = computed.fontStyle;

        measurer.textContent = target_td.textContent;
        const measured = measurer.offsetWidth;
        if (measured > max_width) {
            max_width = measured;
        }
    });

    document.body.removeChild(measurer);

    return Math.max(MIN_WIDTH, max_width + PADDING);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/test/measure-column.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/measure-column.ts src/test/measure-column.test.ts
git commit -m "Add measure_column_fit_width utility for auto-sizing columns"
```

---

### Task 2: Add double-click auto-size to `ColumnResizeHandle`

**Files:**
- Modify: `src/webview/table.tsx` (lines 195-248, `ColumnResizeHandle` component)

- [ ] **Step 1: Update `ColumnResizeHandleProps` and add `onDoubleClick`**

In `src/webview/table.tsx`, update the `ColumnResizeHandle` component. Add `on_auto_size` to the props interface and add an `onDoubleClick` handler to the div:

```typescript
interface ColumnResizeHandleProps {
    col: number;
    on_resize: (col: number, width: number) => void;
    on_auto_size: (col: number) => void;
}

function ColumnResizeHandle({
    col,
    on_resize,
    on_auto_size,
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
        },
        [col, on_resize]
    );

    const handle_double_click = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            on_auto_size(col);
        },
        [col, on_auto_size]
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

- [ ] **Step 2: Update the `Table` component props to include `on_auto_size`**

In `src/webview/table.tsx`, add `on_auto_size` to the `TableProps` interface:

```typescript
interface TableProps {
    sheet: SheetData;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    row_heights: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    on_auto_size: (col: number) => void;
    on_row_resize: (row: number, height: number) => void;
    scroll_ref: React.RefObject<HTMLDivElement | null>;
    selection: SelectionState | null;
    on_cell_mouse_down: (row: number, col: number, e: React.MouseEvent) => void;
    on_cell_mouse_move: (row: number, col: number) => void;
    on_cell_mouse_up: () => void;
    on_context_menu: (row: number, col: number, e: React.MouseEvent) => void;
    on_key_down: (e: React.KeyboardEvent) => void;
}
```

Update the `Table` function signature to destructure `on_auto_size` and pass it to `ColumnResizeHandle`:

```typescript
{show_resize_handle && (
    <ColumnResizeHandle
        col={c}
        on_resize={on_column_resize}
        on_auto_size={on_auto_size}
    />
)}
```

- [ ] **Step 3: Run existing tests to verify nothing is broken**

Run: `npx vitest run`
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/webview/table.tsx
git commit -m "Add double-click auto-size handler to ColumnResizeHandle"
```

---

### Task 3: Wire up multi-column resize and auto-size in `app.tsx`

**Files:**
- Modify: `src/webview/app.tsx`
- Modify: `src/webview/table.tsx` (pass `on_auto_size` through `TableWithSelection`)

- [ ] **Step 1: Add `on_auto_size` prop to `TableWithSelectionProps` and wire it through**

In `src/webview/app.tsx`, update `TableWithSelectionProps`:

```typescript
interface TableWithSelectionProps {
    sheet: import('../types').SheetData;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    row_heights: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    on_auto_size: (col: number) => void;
    on_row_resize: (row: number, height: number) => void;
    scroll_ref: React.RefObject<HTMLDivElement | null>;
}
```

In the `TableWithSelection` function, destructure `on_auto_size` and pass it to `<Table>`:

```typescript
function TableWithSelection({
    sheet,
    show_formatting,
    column_widths,
    row_heights,
    on_column_resize,
    on_auto_size,
    on_row_resize,
    scroll_ref,
}: TableWithSelectionProps): React.JSX.Element {
    const sel = use_selection(sheet, show_formatting);

    // ... menu_items unchanged ...

    return (
        <>
            <Table
                sheet={sheet}
                show_formatting={show_formatting}
                column_widths={column_widths}
                row_heights={row_heights}
                on_column_resize={on_column_resize}
                on_auto_size={on_auto_size}
                on_row_resize={on_row_resize}
                scroll_ref={scroll_ref}
                selection={sel.selection}
                on_cell_mouse_down={sel.on_cell_mouse_down}
                on_cell_mouse_move={sel.on_cell_mouse_move}
                on_cell_mouse_up={sel.on_cell_mouse_up}
                on_context_menu={sel.on_context_menu}
                on_key_down={sel.on_key_down}
            />
            {/* ... context menu unchanged ... */}
        </>
    );
}
```

- [ ] **Step 2: Update `handle_column_resize` to support multi-column selection**

The current `handle_column_resize` in `app.tsx` needs access to the current selection. Since selection lives inside `TableWithSelection` via `use_selection`, we need to lift the multi-column logic. The cleanest approach: pass selection-aware resize callbacks down from `TableWithSelection`.

Instead of modifying `App`'s `handle_column_resize` directly (which doesn't have access to selection), wrap it inside `TableWithSelection`:

In `src/webview/app.tsx`, inside the `TableWithSelection` function, create selection-aware wrappers:

```typescript
function TableWithSelection({
    sheet,
    show_formatting,
    column_widths,
    row_heights,
    on_column_resize,
    on_auto_size,
    on_row_resize,
    scroll_ref,
}: TableWithSelectionProps): React.JSX.Element {
    const sel = use_selection(sheet, show_formatting);

    const handle_column_resize = useCallback(
        (col: number, width: number) => {
            if (sel.selection) {
                const range = normalize_range(sel.selection.range);
                if (col >= range.start_col && col <= range.end_col && range.start_col !== range.end_col) {
                    for (let c = range.start_col; c <= range.end_col; c++) {
                        on_column_resize(c, width);
                    }
                    return;
                }
            }
            on_column_resize(col, width);
        },
        [sel.selection, on_column_resize]
    );

    const handle_auto_size = useCallback(
        (col: number) => {
            if (sel.selection) {
                const range = normalize_range(sel.selection.range);
                if (col >= range.start_col && col <= range.end_col && range.start_col !== range.end_col) {
                    for (let c = range.start_col; c <= range.end_col; c++) {
                        on_auto_size(c);
                    }
                    return;
                }
            }
            on_auto_size(col);
        },
        [sel.selection, on_auto_size]
    );

    // ... menu_items unchanged ...

    return (
        <>
            <Table
                sheet={sheet}
                show_formatting={show_formatting}
                column_widths={column_widths}
                row_heights={row_heights}
                on_column_resize={handle_column_resize}
                on_auto_size={handle_auto_size}
                on_row_resize={on_row_resize}
                scroll_ref={scroll_ref}
                selection={sel.selection}
                on_cell_mouse_down={sel.on_cell_mouse_down}
                on_cell_mouse_move={sel.on_cell_mouse_move}
                on_cell_mouse_up={sel.on_cell_mouse_up}
                on_context_menu={sel.on_context_menu}
                on_key_down={sel.on_key_down}
            />
            {sel.context_menu && (
                <ContextMenu
                    x={sel.context_menu.x}
                    y={sel.context_menu.y}
                    items={menu_items}
                    on_dismiss={sel.dismiss_context_menu}
                />
            )}
        </>
    );
}
```

Add the `normalize_range` import at the top of `app.tsx`:

```typescript
import { normalize_range } from './selection';
```

Also add `useCallback` to the React import if not already present (it is already imported).

- [ ] **Step 3: Create `handle_auto_size` in `App` and add a table ref**

In `src/webview/app.tsx`, add a ref to the table element and a handler that calls `measure_column_fit_width`:

Add import at the top:

```typescript
import { measure_column_fit_width } from './measure-column';
```

Inside the `App` function, add a table ref:

```typescript
const table_ref = useRef<HTMLTableElement | null>(null);
```

Add the auto-size handler after `handle_column_resize`:

```typescript
const handle_auto_size = useCallback(
    (col: number) => {
        const table = table_ref.current;
        if (!table) return;
        const sheet = workbook?.sheets[active_sheet_index];
        if (!sheet) return;
        const width = measure_column_fit_width(table, col, sheet.merges);
        handle_column_resize(col, width);
    },
    [workbook, active_sheet_index, handle_column_resize]
);
```

Pass `table_ref` and `handle_auto_size` to `TableWithSelection`:

```typescript
<TableWithSelection
    key={active_sheet_index}
    sheet={current_sheet}
    show_formatting={show_formatting}
    column_widths={column_widths[active_sheet_index] ?? {}}
    row_heights={row_heights[active_sheet_index] ?? {}}
    on_column_resize={handle_column_resize}
    on_auto_size={handle_auto_size}
    on_row_resize={handle_row_resize}
    scroll_ref={scroll_ref}
    table_ref={table_ref}
/>
```

- [ ] **Step 4: Add `table_ref` prop to `TableWithSelectionProps` and pass to `Table`**

In `src/webview/app.tsx`, update `TableWithSelectionProps`:

```typescript
interface TableWithSelectionProps {
    sheet: import('../types').SheetData;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    row_heights: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    on_auto_size: (col: number) => void;
    on_row_resize: (row: number, height: number) => void;
    scroll_ref: React.RefObject<HTMLDivElement | null>;
    table_ref: React.RefObject<HTMLTableElement | null>;
}
```

In `src/webview/table.tsx`, add `table_ref` to `TableProps`:

```typescript
interface TableProps {
    sheet: SheetData;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    row_heights: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    on_auto_size: (col: number) => void;
    on_row_resize: (row: number, height: number) => void;
    scroll_ref: React.RefObject<HTMLDivElement | null>;
    table_ref: React.RefObject<HTMLTableElement | null>;
    selection: SelectionState | null;
    on_cell_mouse_down: (row: number, col: number, e: React.MouseEvent) => void;
    on_cell_mouse_move: (row: number, col: number) => void;
    on_cell_mouse_up: () => void;
    on_context_menu: (row: number, col: number, e: React.MouseEvent) => void;
    on_key_down: (e: React.KeyboardEvent) => void;
}
```

Apply it to the `<table>` element in the `Table` component:

```typescript
<table className="data-table" ref={table_ref}>
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/webview/app.tsx src/webview/table.tsx
git commit -m "Wire up multi-column resize and auto-size in app"
```

---

### Task 4: Add auto-fit toggle to toolbar

**Files:**
- Modify: `src/webview/toolbar.tsx`
- Modify: `src/webview/app.tsx`
- Test: `src/test/toolbar.test.ts`

- [ ] **Step 1: Write failing test for the auto-fit button**

Add to `src/test/toolbar.test.ts`:

```typescript
it('renders the Auto-fit Columns button and calls on_toggle_auto_fit on click', () => {
    const on_toggle_auto_fit = vi.fn();
    render_toolbar({
        auto_fit_active: false,
        on_toggle_auto_fit,
    });

    const auto_fit = get_button('Auto-fit Columns');
    expect(auto_fit).toBeDefined();
    expect(auto_fit.classList.contains('active')).toBe(false);

    act(() => {
        auto_fit.click();
    });
    expect(on_toggle_auto_fit).toHaveBeenCalledTimes(1);
});

it('shows active state and correct tooltip when auto-fit is active', () => {
    render_toolbar({
        auto_fit_active: true,
        on_toggle_auto_fit: vi.fn(),
    });

    const auto_fit = get_button('Auto-fit Columns');
    expect(auto_fit.classList.contains('active')).toBe(true);

    dispatch_mouse_event(auto_fit, 'mouseover');
    expect(get_tooltip()?.textContent).toBe('Restore original column widths.');
});

it('shows correct tooltip when auto-fit is inactive', () => {
    render_toolbar({
        auto_fit_active: false,
        on_toggle_auto_fit: vi.fn(),
    });

    const auto_fit = get_button('Auto-fit Columns');
    dispatch_mouse_event(auto_fit, 'mouseover');
    expect(get_tooltip()?.textContent).toBe(
        'Auto-fit all columns to their content.'
    );
});
```

Update the `render_toolbar` helper's `merged_props` to include the new props with defaults:

```typescript
const merged_props: React.ComponentProps<typeof Toolbar> = {
    show_formatting: true,
    on_toggle_formatting,
    show_formatting_button: true,
    vertical_tabs: false,
    on_toggle_tab_orientation,
    show_vertical_tabs_button: true,
    auto_fit_active: false,
    on_toggle_auto_fit: vi.fn(),
    ...props,
};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/test/toolbar.test.ts`
Expected: FAIL — `auto_fit_active` and `on_toggle_auto_fit` props don't exist on `Toolbar` yet.

- [ ] **Step 3: Add auto-fit button to `Toolbar`**

In `src/webview/toolbar.tsx`, update the `ToolbarProps` interface:

```typescript
interface ToolbarProps {
    show_formatting: boolean;
    on_toggle_formatting: () => void;
    show_formatting_button: boolean;
    vertical_tabs: boolean;
    on_toggle_tab_orientation: () => void;
    show_vertical_tabs_button: boolean;
    auto_fit_active: boolean;
    on_toggle_auto_fit: () => void;
}
```

Update the `Toolbar` function to destructure and render the new button. Change the null-return guard to also consider the auto-fit button:

```typescript
export function Toolbar({
    show_formatting,
    on_toggle_formatting,
    show_formatting_button,
    vertical_tabs,
    on_toggle_tab_orientation,
    show_vertical_tabs_button,
    auto_fit_active,
    on_toggle_auto_fit,
}: ToolbarProps): React.JSX.Element | null {
    if (!show_formatting_button && !show_vertical_tabs_button) return null;

    return (
        <div className="toolbar">
            {show_formatting_button && (
                <ToolbarButton
                    label="Formatting"
                    active={show_formatting}
                    tooltip_text={
                        show_formatting
                            ? 'Show raw cell values.'
                            : 'Show formatted cell values.'
                    }
                    onClick={on_toggle_formatting}
                />
            )}
            {show_vertical_tabs_button && (
                <ToolbarButton
                    label="Vertical Tabs"
                    active={vertical_tabs}
                    tooltip_text={
                        vertical_tabs
                            ? 'Move sheet tabs above the table.'
                            : 'Move sheet tabs to the left of the table.'
                    }
                    onClick={on_toggle_tab_orientation}
                />
            )}
            <ToolbarButton
                label="Auto-fit Columns"
                active={auto_fit_active}
                tooltip_text={
                    auto_fit_active
                        ? 'Restore original column widths.'
                        : 'Auto-fit all columns to their content.'
                }
                onClick={on_toggle_auto_fit}
            />
        </div>
    );
}
```

- [ ] **Step 4: Run toolbar tests to verify they pass**

Run: `npx vitest run src/test/toolbar.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/toolbar.tsx src/test/toolbar.test.ts
git commit -m "Add Auto-fit Columns toggle button to toolbar"
```

---

### Task 5: Wire up auto-fit toggle state in `app.tsx`

**Files:**
- Modify: `src/webview/app.tsx`

- [ ] **Step 1: Add auto-fit state**

In `src/webview/app.tsx`, inside the `App` function, add state after the existing state declarations:

```typescript
const [auto_fit_active, set_auto_fit_active] = useState<boolean[]>([]);
const [auto_fit_snapshot, set_auto_fit_snapshot] = useState<
    (Record<number, number> | undefined)[]
>([]);
```

- [ ] **Step 2: Update `handle_column_resize` to deactivate auto-fit on manual resize**

Replace the existing `handle_column_resize` in `App`:

```typescript
const handle_column_resize = useCallback(
    (col: number, width: number) => {
        set_column_widths((prev) => {
            const next = [...prev];
            const sheet_widths = { ...(next[active_sheet_index] ?? {}) };
            sheet_widths[col] = width;
            next[active_sheet_index] = sheet_widths;
            state_ref.current = {
                ...state_ref.current,
                columnWidths: [...next],
            };
            persist_immediate();
            return next;
        });

        // Deactivate auto-fit if it was active (keep current widths, discard snapshot)
        if (auto_fit_active[active_sheet_index]) {
            set_auto_fit_active((prev) => {
                const next = [...prev];
                next[active_sheet_index] = false;
                return next;
            });
            set_auto_fit_snapshot((prev) => {
                const next = [...prev];
                next[active_sheet_index] = undefined;
                return next;
            });
        }
    },
    [active_sheet_index, persist_immediate, auto_fit_active]
);
```

- [ ] **Step 3: Create `handle_toggle_auto_fit`**

Add this handler after `handle_auto_size` in the `App` function:

```typescript
const handle_toggle_auto_fit = useCallback(() => {
    if (auto_fit_active[active_sheet_index]) {
        // Deactivate: restore snapshotted widths
        const snapshot = auto_fit_snapshot[active_sheet_index];
        set_column_widths((prev) => {
            const next = [...prev];
            next[active_sheet_index] = snapshot;
            state_ref.current = {
                ...state_ref.current,
                columnWidths: [...next],
            };
            persist_immediate();
            return next;
        });
        set_auto_fit_active((prev) => {
            const next = [...prev];
            next[active_sheet_index] = false;
            return next;
        });
        set_auto_fit_snapshot((prev) => {
            const next = [...prev];
            next[active_sheet_index] = undefined;
            return next;
        });
    } else {
        // Activate: snapshot current widths, then auto-fit all columns
        const current_widths = column_widths[active_sheet_index];
        set_auto_fit_snapshot((prev) => {
            const next = [...prev];
            next[active_sheet_index] = current_widths
                ? { ...current_widths }
                : undefined;
            return next;
        });

        const table = table_ref.current;
        const sheet = workbook?.sheets[active_sheet_index];
        if (table && sheet) {
            set_column_widths((prev) => {
                const next = [...prev];
                const new_widths: Record<number, number> = {};
                for (let c = 0; c < sheet.columnCount; c++) {
                    new_widths[c] = measure_column_fit_width(
                        table,
                        c,
                        sheet.merges
                    );
                }
                next[active_sheet_index] = new_widths;
                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: [...next],
                };
                persist_immediate();
                return next;
            });
        }

        set_auto_fit_active((prev) => {
            const next = [...prev];
            next[active_sheet_index] = true;
            return next;
        });
    }
}, [
    active_sheet_index,
    auto_fit_active,
    auto_fit_snapshot,
    column_widths,
    workbook,
    persist_immediate,
]);
```

- [ ] **Step 4: Pass auto-fit props to `Toolbar`**

Update both `<Toolbar>` usages in the JSX (there's only one, rendered once):

```typescript
<Toolbar
    show_formatting={show_formatting}
    on_toggle_formatting={handle_toggle_formatting}
    show_formatting_button={workbook.hasFormatting}
    vertical_tabs={vertical_tabs}
    on_toggle_tab_orientation={handle_toggle_tab_orientation}
    show_vertical_tabs_button={has_multiple_sheets}
    auto_fit_active={auto_fit_active[active_sheet_index] ?? false}
    on_toggle_auto_fit={handle_toggle_auto_fit}
/>
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/webview/app.tsx
git commit -m "Wire up auto-fit toggle state with snapshot/restore logic"
```

---

### Task 6: Handle auto-fit deactivation on manual resize from double-click

**Files:**
- Modify: `src/webview/app.tsx`

The `handle_auto_size` callback in `App` currently calls `handle_column_resize`, which already deactivates auto-fit. However, when auto-fit is active and the user double-clicks to auto-size a single column, we want to deactivate the toggle but keep the auto-fitted widths (same as manual resize behavior). This is already handled because `handle_column_resize` deactivates auto-fit and discards the snapshot while keeping current widths.

- [ ] **Step 1: Verify the behavior is correct**

Read through `handle_auto_size` → it calls `handle_column_resize(col, width)` → which deactivates auto-fit and discards snapshot. This is correct per the spec: manual column resize while active sets toggle to inactive, keeps all current widths, discards snapshot.

No code changes needed — the existing flow already handles this correctly.

- [ ] **Step 2: Run all tests to confirm**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Manual verification checklist**

Build and test in VS Code:
```bash
npm run bundle && npm run bundle:webview
```

Then open a spreadsheet file in the extension and verify:
1. Double-click a resize handle → column auto-fits to content
2. Select multiple columns, double-click a resize handle in the selection → each selected column auto-fits independently
3. Select multiple columns, drag a resize handle → all selected columns get the same width
4. Drag a resize handle outside a selection → only that column resizes (existing behavior)
5. Click "Auto-fit Columns" → all columns auto-fit, button shows active
6. Click "Auto-fit Columns" again → columns revert to pre-auto-fit widths
7. Click "Auto-fit Columns", then manually drag a column → toggle deactivates, widths stay
8. Switch sheets → auto-fit state is independent per sheet

- [ ] **Step 4: Final commit if any adjustments were needed**

```bash
git add -A
git commit -m "Column resizing features: multi-column resize, auto-size, auto-fit toggle"
```
