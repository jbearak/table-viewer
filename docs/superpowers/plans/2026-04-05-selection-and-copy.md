# Selection & Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cell/range/column selection, keyboard navigation (arrows + vim keys), right-click context menu, and clipboard copy to the table viewer webview.

**Architecture:** All logic lives in the React webview — no extension host changes. A pure-logic `selection.ts` module handles selection computation, navigation, and clipboard formatting. A `use-selection.ts` hook wraps it with React state. A `context-menu.tsx` component renders the right-click menu. `table.tsx` and `app.tsx` are wired up with handlers and CSS classes.

**Tech Stack:** React 18, TypeScript, vitest (pure function tests), VS Code webview, `navigator.clipboard.writeText()`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/webview/selection.ts` | Create | Pure selection logic: range normalization, merge expansion, navigation, clipboard formatting |
| `src/webview/use-selection.ts` | Create | React hook: state, mouse handlers, keyboard handler, clipboard call |
| `src/webview/context-menu.tsx` | Create | Context menu component: positioned menu, dismiss logic, menu items |
| `src/webview/table.tsx` | Modify | Wire selection props, mouse/keyboard handlers, CSS classes onto cells |
| `src/webview/app.tsx` | Modify | Call `use_selection`, pass props to Table, render ContextMenu |
| `src/webview/styles.css` | Modify | Selection, active-cell, and context-menu styles |
| `src/test/selection.test.ts` | Create | Tests for pure selection logic |

---

### Task 1: Selection Types and Range Normalization

**Files:**
- Create: `src/webview/selection.ts`
- Create: `src/test/selection.test.ts`

- [ ] **Step 1: Write failing tests for selection types and normalization**

```ts
// src/test/selection.test.ts
import { describe, it, expect } from 'vitest';
import {
    normalize_range,
    is_cell_in_range,
    type SelectionRange,
} from '../webview/selection';

describe('normalize_range', () => {
    it('returns top-left to bottom-right regardless of input order', () => {
        const range: SelectionRange = {
            start_row: 5,
            start_col: 3,
            end_row: 2,
            end_col: 1,
        };
        expect(normalize_range(range)).toEqual({
            start_row: 2,
            start_col: 1,
            end_row: 5,
            end_col: 3,
        });
    });

    it('leaves already-normalized ranges unchanged', () => {
        const range: SelectionRange = {
            start_row: 0,
            start_col: 0,
            end_row: 3,
            end_col: 2,
        };
        expect(normalize_range(range)).toEqual(range);
    });
});

describe('is_cell_in_range', () => {
    const range: SelectionRange = {
        start_row: 1,
        start_col: 1,
        end_row: 3,
        end_col: 3,
    };

    it('returns true for cells inside the range', () => {
        expect(is_cell_in_range(2, 2, range)).toBe(true);
        expect(is_cell_in_range(1, 1, range)).toBe(true);
        expect(is_cell_in_range(3, 3, range)).toBe(true);
    });

    it('returns false for cells outside the range', () => {
        expect(is_cell_in_range(0, 0, range)).toBe(false);
        expect(is_cell_in_range(4, 2, range)).toBe(false);
        expect(is_cell_in_range(2, 4, range)).toBe(false);
    });

    it('returns false when range is null', () => {
        expect(is_cell_in_range(0, 0, null)).toBe(false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/selection.test.ts`
Expected: FAIL — module `../webview/selection` not found

- [ ] **Step 3: Implement selection types and normalization**

```ts
// src/webview/selection.ts
import type { SheetData, CellData, MergeRange } from '../types';

export interface SelectionRange {
    start_row: number;
    start_col: number;
    end_row: number;
    end_col: number;
}

export interface SelectionState {
    range: SelectionRange;
    anchor_row: number;
    anchor_col: number;
}

export function normalize_range(range: SelectionRange): SelectionRange {
    return {
        start_row: Math.min(range.start_row, range.end_row),
        start_col: Math.min(range.start_col, range.end_col),
        end_row: Math.max(range.start_row, range.end_row),
        end_col: Math.max(range.start_col, range.end_col),
    };
}

export function is_cell_in_range(
    row: number,
    col: number,
    range: SelectionRange | null
): boolean {
    if (!range) return false;
    const n = normalize_range(range);
    return (
        row >= n.start_row &&
        row <= n.end_row &&
        col >= n.start_col &&
        col <= n.end_col
    );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/selection.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/selection.ts src/test/selection.test.ts
git commit -m "feat: add selection types and range normalization"
```

---

### Task 2: Merge-Aware Selection Expansion

**Files:**
- Modify: `src/webview/selection.ts`
- Modify: `src/test/selection.test.ts`

- [ ] **Step 1: Write failing tests for merge expansion**

Append to `src/test/selection.test.ts`:

```ts
import {
    normalize_range,
    is_cell_in_range,
    expand_range_for_merges,
    resolve_merge_anchor,
    type SelectionRange,
} from '../webview/selection';
import type { MergeRange } from '../types';

describe('expand_range_for_merges', () => {
    const merges: MergeRange[] = [
        { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
        { startRow: 5, startCol: 0, endRow: 5, endCol: 3 },
    ];

    it('expands range to include full merge when partially intersected', () => {
        const range: SelectionRange = {
            start_row: 0,
            start_col: 0,
            end_row: 1,
            end_col: 1,
        };
        expect(expand_range_for_merges(range, merges)).toEqual({
            start_row: 0,
            start_col: 0,
            end_row: 2,
            end_col: 2,
        });
    });

    it('returns range unchanged when no merges intersect', () => {
        const range: SelectionRange = {
            start_row: 3,
            start_col: 3,
            end_row: 4,
            end_col: 4,
        };
        expect(expand_range_for_merges(range, merges)).toEqual(range);
    });

    it('handles range already fully containing a merge', () => {
        const range: SelectionRange = {
            start_row: 0,
            start_col: 0,
            end_row: 3,
            end_col: 3,
        };
        expect(expand_range_for_merges(range, merges)).toEqual(range);
    });
});

describe('resolve_merge_anchor', () => {
    const merges: MergeRange[] = [
        { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
    ];

    it('returns merge anchor when clicking inside a merged cell', () => {
        expect(resolve_merge_anchor(2, 2, merges)).toEqual({ row: 1, col: 1 });
    });

    it('returns same position when not inside a merge', () => {
        expect(resolve_merge_anchor(0, 0, merges)).toEqual({ row: 0, col: 0 });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/selection.test.ts`
Expected: FAIL — `expand_range_for_merges` and `resolve_merge_anchor` not exported

- [ ] **Step 3: Implement merge expansion**

Add to `src/webview/selection.ts`:

```ts
export function resolve_merge_anchor(
    row: number,
    col: number,
    merges: MergeRange[]
): { row: number; col: number } {
    for (const m of merges) {
        if (
            row >= m.startRow &&
            row <= m.endRow &&
            col >= m.startCol &&
            col <= m.endCol
        ) {
            return { row: m.startRow, col: m.startCol };
        }
    }
    return { row, col };
}

export function expand_range_for_merges(
    range: SelectionRange,
    merges: MergeRange[]
): SelectionRange {
    let n = normalize_range(range);
    let changed = true;
    while (changed) {
        changed = false;
        for (const m of merges) {
            const overlaps =
                m.startRow <= n.end_row &&
                m.endRow >= n.start_row &&
                m.startCol <= n.end_col &&
                m.endCol >= n.start_col;
            if (overlaps) {
                const expanded = {
                    start_row: Math.min(n.start_row, m.startRow),
                    start_col: Math.min(n.start_col, m.startCol),
                    end_row: Math.max(n.end_row, m.endRow),
                    end_col: Math.max(n.end_col, m.endCol),
                };
                if (
                    expanded.start_row !== n.start_row ||
                    expanded.start_col !== n.start_col ||
                    expanded.end_row !== n.end_row ||
                    expanded.end_col !== n.end_col
                ) {
                    n = expanded;
                    changed = true;
                }
            }
        }
    }
    return n;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/selection.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/selection.ts src/test/selection.test.ts
git commit -m "feat: add merge-aware selection expansion"
```

---

### Task 3: Keyboard Navigation Logic

**Files:**
- Modify: `src/webview/selection.ts`
- Modify: `src/test/selection.test.ts`

- [ ] **Step 1: Write failing tests for navigation**

Append to `src/test/selection.test.ts`:

```ts
import {
    // ... previous imports ...
    move_active_cell,
    type SelectionRange,
} from '../webview/selection';
import type { MergeRange } from '../types';

describe('move_active_cell', () => {
    const row_count = 5;
    const col_count = 4;
    const no_merges: MergeRange[] = [];

    it('moves right', () => {
        expect(move_active_cell(0, 0, 'right', row_count, col_count, no_merges))
            .toEqual({ row: 0, col: 1 });
    });

    it('moves left', () => {
        expect(move_active_cell(0, 1, 'left', row_count, col_count, no_merges))
            .toEqual({ row: 0, col: 0 });
    });

    it('moves down', () => {
        expect(move_active_cell(0, 0, 'down', row_count, col_count, no_merges))
            .toEqual({ row: 1, col: 0 });
    });

    it('moves up', () => {
        expect(move_active_cell(1, 0, 'up', row_count, col_count, no_merges))
            .toEqual({ row: 0, col: 0 });
    });

    it('clamps at boundaries', () => {
        expect(move_active_cell(0, 0, 'up', row_count, col_count, no_merges))
            .toEqual({ row: 0, col: 0 });
        expect(move_active_cell(0, 0, 'left', row_count, col_count, no_merges))
            .toEqual({ row: 0, col: 0 });
        expect(move_active_cell(4, 3, 'down', row_count, col_count, no_merges))
            .toEqual({ row: 4, col: 3 });
        expect(move_active_cell(4, 3, 'right', row_count, col_count, no_merges))
            .toEqual({ row: 4, col: 3 });
    });

    it('skips over merged cells moving right', () => {
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 1, endRow: 0, endCol: 2 },
        ];
        // From (0,0) moving right, land on merge anchor (0,1)
        expect(move_active_cell(0, 0, 'right', row_count, col_count, merges))
            .toEqual({ row: 0, col: 1 });
        // From merge anchor (0,1), moving right skips to (0,3) — past the merge
        expect(move_active_cell(0, 1, 'right', row_count, col_count, merges))
            .toEqual({ row: 0, col: 3 });
    });

    it('skips over merged cells moving down', () => {
        const merges: MergeRange[] = [
            { startRow: 1, startCol: 0, endRow: 2, endCol: 0 },
        ];
        expect(move_active_cell(0, 0, 'down', row_count, col_count, merges))
            .toEqual({ row: 1, col: 0 });
        expect(move_active_cell(1, 0, 'down', row_count, col_count, merges))
            .toEqual({ row: 3, col: 0 });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/selection.test.ts`
Expected: FAIL — `move_active_cell` not exported

- [ ] **Step 3: Implement navigation**

Add to `src/webview/selection.ts`:

```ts
export type Direction = 'up' | 'down' | 'left' | 'right';

export function move_active_cell(
    row: number,
    col: number,
    direction: Direction,
    row_count: number,
    col_count: number,
    merges: MergeRange[]
): { row: number; col: number } {
    // If currently on a merge anchor, skip past the entire merge
    const current_merge = merges.find(
        (m) => m.startRow === row && m.startCol === col
    );

    let next_row = row;
    let next_col = col;

    switch (direction) {
        case 'up':
            next_row = row - 1;
            break;
        case 'down':
            next_row = current_merge ? current_merge.endRow + 1 : row + 1;
            break;
        case 'left':
            next_col = col - 1;
            break;
        case 'right':
            next_col = current_merge ? current_merge.endCol + 1 : col + 1;
            break;
    }

    // Clamp to bounds
    next_row = Math.max(0, Math.min(next_row, row_count - 1));
    next_col = Math.max(0, Math.min(next_col, col_count - 1));

    // If we landed inside a merge, resolve to anchor
    const anchor = resolve_merge_anchor(next_row, next_col, merges);
    return anchor;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/selection.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/selection.ts src/test/selection.test.ts
git commit -m "feat: add merge-aware keyboard navigation"
```

---

### Task 4: Clipboard Formatting

**Files:**
- Modify: `src/webview/selection.ts`
- Modify: `src/test/selection.test.ts`

- [ ] **Step 1: Write failing tests for clipboard formatting**

Append to `src/test/selection.test.ts`:

```ts
import {
    // ... previous imports ...
    format_selection_for_clipboard,
    type SelectionRange,
} from '../webview/selection';
import type { CellData, MergeRange } from '../types';

function cell(raw: string | number | null, formatted?: string): CellData {
    return {
        raw,
        formatted: formatted ?? String(raw ?? ''),
        bold: false,
        italic: false,
    };
}

describe('format_selection_for_clipboard', () => {
    const rows: (CellData | null)[][] = [
        [cell('A1'), cell('B1'), cell('C1')],
        [cell('A2'), cell('B2'), cell('C2')],
        [cell('A3'), cell('B3'), cell('C3')],
    ];

    it('formats single cell as plain text', () => {
        const range: SelectionRange = {
            start_row: 0, start_col: 0,
            end_row: 0, end_col: 0,
        };
        expect(format_selection_for_clipboard(rows, range, [], true))
            .toBe('A1');
    });

    it('formats multi-cell range as TSV', () => {
        const range: SelectionRange = {
            start_row: 0, start_col: 0,
            end_row: 1, end_col: 1,
        };
        expect(format_selection_for_clipboard(rows, range, [], true))
            .toBe('A1\tB1\nA2\tB2');
    });

    it('uses raw values when show_formatting is false', () => {
        const rows_with_fmt: (CellData | null)[][] = [
            [cell(42, '$42.00'), cell(100, '$100.00')],
        ];
        const range: SelectionRange = {
            start_row: 0, start_col: 0,
            end_row: 0, end_col: 1,
        };
        expect(format_selection_for_clipboard(rows_with_fmt, range, [], false))
            .toBe('42\t100');
    });

    it('uses formatted values when show_formatting is true', () => {
        const rows_with_fmt: (CellData | null)[][] = [
            [cell(42, '$42.00'), cell(100, '$100.00')],
        ];
        const range: SelectionRange = {
            start_row: 0, start_col: 0,
            end_row: 0, end_col: 1,
        };
        expect(format_selection_for_clipboard(rows_with_fmt, range, [], true))
            .toBe('$42.00\t$100.00');
    });

    it('handles null cells as empty strings', () => {
        const rows_with_null: (CellData | null)[][] = [
            [cell('A1'), null, cell('C1')],
        ];
        const range: SelectionRange = {
            start_row: 0, start_col: 0,
            end_row: 0, end_col: 2,
        };
        expect(format_selection_for_clipboard(rows_with_null, range, [], true))
            .toBe('A1\t\tC1');
    });

    it('places merged cell value at top-left only, empty elsewhere', () => {
        const merged_rows: (CellData | null)[][] = [
            [cell('merged'), null, cell('C1')],
            [null, null, cell('C2')],
        ];
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
        ];
        const range: SelectionRange = {
            start_row: 0, start_col: 0,
            end_row: 1, end_col: 2,
        };
        expect(format_selection_for_clipboard(merged_rows, range, merges, true))
            .toBe('merged\t\tC1\n\t\tC2');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/selection.test.ts`
Expected: FAIL — `format_selection_for_clipboard` not exported

- [ ] **Step 3: Implement clipboard formatting**

Add to `src/webview/selection.ts`:

```ts
export function format_selection_for_clipboard(
    rows: (CellData | null)[][],
    range: SelectionRange,
    merges: MergeRange[],
    show_formatting: boolean
): string {
    const n = normalize_range(range);

    function cell_text(cell: CellData | null): string {
        if (!cell) return '';
        if (show_formatting) return cell.formatted;
        return cell.raw !== null ? String(cell.raw) : '';
    }

    // Build a set of merge-hidden positions (non-anchor cells in merges)
    const hidden = new Set<string>();
    for (const m of merges) {
        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r === m.startRow && c === m.startCol) continue;
                hidden.add(`${r}:${c}`);
            }
        }
    }

    const output_rows: string[] = [];
    for (let r = n.start_row; r <= n.end_row; r++) {
        const row = rows[r];
        const cells: string[] = [];
        for (let c = n.start_col; c <= n.end_col; c++) {
            if (hidden.has(`${r}:${c}`)) {
                cells.push('');
            } else {
                cells.push(cell_text(row?.[c] ?? null));
            }
        }
        output_rows.push(cells.join('\t'));
    }

    return output_rows.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/selection.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/selection.ts src/test/selection.test.ts
git commit -m "feat: add clipboard formatting with merge support"
```

---

### Task 5: Selection Hook (`use-selection`)

**Files:**
- Create: `src/webview/use-selection.ts`

This hook wires the pure selection logic to React state and DOM events. No unit tests — this is thin glue; it will be tested by manual interaction after wiring in Tasks 7-8.

- [ ] **Step 1: Create the hook**

```ts
// src/webview/use-selection.ts
import { useState, useCallback, useRef } from 'react';
import type { SheetData, MergeRange } from '../types';
import {
    type SelectionRange,
    type SelectionState,
    type Direction,
    normalize_range,
    expand_range_for_merges,
    resolve_merge_anchor,
    move_active_cell,
    format_selection_for_clipboard,
} from './selection';

export interface ContextMenuState {
    x: number;
    y: number;
    row: number;
    col: number;
}

export function use_selection(
    sheet: SheetData,
    show_formatting: boolean
) {
    const [selection, set_selection] = useState<SelectionState | null>(null);
    const [context_menu, set_context_menu] = useState<ContextMenuState | null>(null);
    const dragging_ref = useRef(false);

    const merges = sheet.merges;
    const row_count = sheet.rowCount;
    const col_count = sheet.columnCount;

    const select_cell = useCallback(
        (row: number, col: number) => {
            const anchor = resolve_merge_anchor(row, col, merges);
            const range: SelectionRange = {
                start_row: anchor.row,
                start_col: anchor.col,
                end_row: anchor.row,
                end_col: anchor.col,
            };
            const expanded = expand_range_for_merges(range, merges);
            set_selection({
                range: expanded,
                anchor_row: anchor.row,
                anchor_col: anchor.col,
            });
        },
        [merges]
    );

    const extend_selection = useCallback(
        (to_row: number, to_col: number) => {
            if (!selection) return;
            const range: SelectionRange = {
                start_row: selection.anchor_row,
                start_col: selection.anchor_col,
                end_row: to_row,
                end_col: to_col,
            };
            const expanded = expand_range_for_merges(range, merges);
            set_selection({
                ...selection,
                range: expanded,
            });
        },
        [selection, merges]
    );

    const on_cell_mouse_down = useCallback(
        (row: number, col: number, e: React.MouseEvent) => {
            if (e.button !== 0) return; // left click only
            e.preventDefault();
            dragging_ref.current = true;

            if (e.shiftKey && selection) {
                extend_selection(row, col);
            } else {
                select_cell(row, col);
            }
        },
        [selection, select_cell, extend_selection]
    );

    const on_cell_mouse_move = useCallback(
        (row: number, col: number) => {
            if (!dragging_ref.current) return;
            extend_selection(row, col);
        },
        [extend_selection]
    );

    const on_cell_mouse_up = useCallback(() => {
        dragging_ref.current = false;
    }, []);

    const on_context_menu = useCallback(
        (row: number, col: number, e: React.MouseEvent) => {
            e.preventDefault();
            // If right-clicked cell is outside current selection, move selection
            if (selection) {
                const n = normalize_range(selection.range);
                const inside =
                    row >= n.start_row &&
                    row <= n.end_row &&
                    col >= n.start_col &&
                    col <= n.end_col;
                if (!inside) {
                    select_cell(row, col);
                }
            } else {
                select_cell(row, col);
            }
            set_context_menu({ x: e.clientX, y: e.clientY, row, col });
        },
        [selection, select_cell]
    );

    const dismiss_context_menu = useCallback(() => {
        set_context_menu(null);
    }, []);

    const copy_selection = useCallback(async () => {
        if (!selection) return;
        const text = format_selection_for_clipboard(
            sheet.rows,
            selection.range,
            merges,
            show_formatting
        );
        await navigator.clipboard.writeText(text);
    }, [selection, sheet.rows, merges, show_formatting]);

    const copy_cell = useCallback(
        async (row: number, col: number) => {
            const range: SelectionRange = {
                start_row: row,
                start_col: col,
                end_row: row,
                end_col: col,
            };
            const text = format_selection_for_clipboard(
                sheet.rows,
                range,
                merges,
                show_formatting
            );
            await navigator.clipboard.writeText(text);
        },
        [sheet.rows, merges, show_formatting]
    );

    const select_row = useCallback(
        (row: number) => {
            const range: SelectionRange = {
                start_row: row,
                start_col: 0,
                end_row: row,
                end_col: col_count - 1,
            };
            const expanded = expand_range_for_merges(range, merges);
            set_selection({
                range: expanded,
                anchor_row: row,
                anchor_col: 0,
            });
        },
        [col_count, merges]
    );

    const select_column = useCallback(
        (col: number) => {
            const range: SelectionRange = {
                start_row: 0,
                start_col: col,
                end_row: row_count - 1,
                end_col: col,
            };
            const expanded = expand_range_for_merges(range, merges);
            set_selection({
                range: expanded,
                anchor_row: 0,
                anchor_col: col,
            });
        },
        [row_count, merges]
    );

    const select_all = useCallback(() => {
        set_selection({
            range: {
                start_row: 0,
                start_col: 0,
                end_row: row_count - 1,
                end_col: col_count - 1,
            },
            anchor_row: 0,
            anchor_col: 0,
        });
    }, [row_count, col_count]);

    const clear_selection = useCallback(() => {
        set_selection(null);
    }, []);

    const on_key_down = useCallback(
        (e: React.KeyboardEvent) => {
            const meta = e.metaKey || e.ctrlKey;

            // Cmd+A — select all
            if (meta && e.key === 'a') {
                e.preventDefault();
                select_all();
                return;
            }

            // Cmd+C — copy
            if (meta && e.key === 'c') {
                e.preventDefault();
                copy_selection();
                return;
            }

            // Escape — clear
            if (e.key === 'Escape') {
                clear_selection();
                dismiss_context_menu();
                return;
            }

            // Direction keys
            const direction_map: Record<string, Direction> = {
                ArrowUp: 'up',
                ArrowDown: 'down',
                ArrowLeft: 'left',
                ArrowRight: 'right',
                h: 'left',
                j: 'down',
                k: 'up',
                l: 'right',
                Tab: 'right',
            };

            let key = e.key;
            // Shift+Tab goes left
            if (e.key === 'Tab' && e.shiftKey) {
                key = 'ShiftTab';
            }
            const shift_tab_map: Record<string, Direction> = {
                ...direction_map,
                ShiftTab: 'left',
            };

            const direction = shift_tab_map[key];
            if (!direction) return;

            // Don't capture vim keys when meta is held
            if (meta && 'hjkl'.includes(e.key)) return;

            e.preventDefault();

            const current_row = selection?.anchor_row ?? 0;
            const current_col = selection?.anchor_col ?? 0;

            if (e.shiftKey && e.key !== 'Tab') {
                // Extend selection
                const edge = selection
                    ? {
                          row: normalize_range(selection.range).end_row,
                          col: normalize_range(selection.range).end_col,
                      }
                    : { row: current_row, col: current_col };
                const next = move_active_cell(
                    edge.row,
                    edge.col,
                    direction,
                    row_count,
                    col_count,
                    merges
                );
                const anchor_row = selection?.anchor_row ?? current_row;
                const anchor_col = selection?.anchor_col ?? current_col;
                const range: SelectionRange = {
                    start_row: anchor_row,
                    start_col: anchor_col,
                    end_row: next.row,
                    end_col: next.col,
                };
                const expanded = expand_range_for_merges(range, merges);
                set_selection({
                    range: expanded,
                    anchor_row,
                    anchor_col,
                });
            } else {
                // Move active cell
                const next = move_active_cell(
                    current_row,
                    current_col,
                    direction,
                    row_count,
                    col_count,
                    merges
                );
                select_cell(next.row, next.col);
            }
        },
        [
            selection,
            row_count,
            col_count,
            merges,
            select_all,
            copy_selection,
            clear_selection,
            dismiss_context_menu,
            select_cell,
        ]
    );

    const is_multi_cell = selection
        ? (() => {
              const n = normalize_range(selection.range);
              return n.start_row !== n.end_row || n.start_col !== n.end_col;
          })()
        : false;

    return {
        selection,
        context_menu,
        is_multi_cell,
        on_cell_mouse_down,
        on_cell_mouse_move,
        on_cell_mouse_up,
        on_context_menu,
        on_key_down,
        dismiss_context_menu,
        copy_selection,
        copy_cell,
        select_row,
        select_column,
        select_all,
        clear_selection,
    };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors (or only pre-existing errors unrelated to this file)

- [ ] **Step 3: Commit**

```bash
git add src/webview/use-selection.ts
git commit -m "feat: add use_selection React hook"
```

---

### Task 6: Context Menu Component

**Files:**
- Create: `src/webview/context-menu.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/webview/context-menu.tsx
import React, { useEffect, useRef } from 'react';

export interface MenuItem {
    label: string;
    on_click: () => void;
}

interface ContextMenuProps {
    x: number;
    y: number;
    items: MenuItem[];
    on_dismiss: () => void;
}

export function ContextMenu({
    x,
    y,
    items,
    on_dismiss,
}: ContextMenuProps): React.JSX.Element {
    const menu_ref = useRef<HTMLDivElement>(null);

    // Viewport-clamped positioning
    useEffect(() => {
        const el = menu_ref.current;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = x;
        let top = y;

        if (left + rect.width > vw) {
            left = vw - rect.width - 4;
        }
        if (top + rect.height > vh) {
            top = vh - rect.height - 4;
        }

        el.style.left = `${Math.max(0, left)}px`;
        el.style.top = `${Math.max(0, top)}px`;
    }, [x, y]);

    // Dismiss on outside click
    useEffect(() => {
        const handle_click = (e: MouseEvent) => {
            if (
                menu_ref.current &&
                !menu_ref.current.contains(e.target as Node)
            ) {
                on_dismiss();
            }
        };
        // Use timeout so the opening right-click doesn't immediately dismiss
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handle_click);
        }, 0);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handle_click);
        };
    }, [on_dismiss]);

    // Dismiss on scroll
    useEffect(() => {
        const handle_scroll = () => on_dismiss();
        // Capture phase to catch scroll on any element
        document.addEventListener('scroll', handle_scroll, true);
        return () =>
            document.removeEventListener('scroll', handle_scroll, true);
    }, [on_dismiss]);

    return (
        <div
            ref={menu_ref}
            className="context-menu"
            style={{ left: x, top: y }}
        >
            {items.map((item, i) => (
                <div
                    key={i}
                    className="context-menu-item"
                    onClick={() => {
                        item.on_click();
                        on_dismiss();
                    }}
                >
                    {item.label}
                </div>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/webview/context-menu.tsx
git commit -m "feat: add context menu component"
```

---

### Task 7: Wire Selection into Table Component

**Files:**
- Modify: `src/webview/table.tsx`

- [ ] **Step 1: Update Table props and cell rendering**

Replace the entire content of `src/webview/table.tsx` with:

```tsx
import React, { useCallback, useRef } from 'react';
import type { SheetData, CellData, MergeRange } from '../types';
import { type SelectionState, normalize_range, is_cell_in_range } from './selection';

interface TableProps {
    sheet: SheetData;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    row_heights: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    on_row_resize: (row: number, height: number) => void;
    scroll_ref: React.RefObject<HTMLDivElement | null>;
    selection: SelectionState | null;
    on_cell_mouse_down: (row: number, col: number, e: React.MouseEvent) => void;
    on_cell_mouse_move: (row: number, col: number) => void;
    on_cell_mouse_up: () => void;
    on_context_menu: (row: number, col: number, e: React.MouseEvent) => void;
    on_key_down: (e: React.KeyboardEvent) => void;
}

export function Table({
    sheet,
    show_formatting,
    column_widths,
    row_heights,
    on_column_resize,
    on_row_resize,
    scroll_ref,
    selection,
    on_cell_mouse_down,
    on_cell_mouse_move,
    on_cell_mouse_up,
    on_context_menu,
    on_key_down,
}: TableProps): React.JSX.Element {
    const merge_map = build_merge_map(sheet.merges);

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

    const sel_range = selection ? normalize_range(selection.range) : null;

    return (
        <div
            className="table-container"
            ref={scroll_ref as React.LegacyRef<HTMLDivElement>}
            tabIndex={0}
            onKeyDown={on_key_down}
            onMouseUp={on_cell_mouse_up}
        >
            <table className="data-table">
                <tbody>
                    {sheet.rows.map((row, r) => (
                        <tr
                            key={r}
                            style={{
                                position: 'relative',
                                ...(row_heights[r]
                                    ? { height: `${row_heights[r]}px` }
                                    : undefined),
                            }}
                        >
                            {row.map((cell, c) => {
                                const key = `${r}:${c}`;
                                const merge_info = merge_map.get(key);

                                if (merge_info === 'hidden') return null;

                                const span_props: {
                                    rowSpan?: number;
                                    colSpan?: number;
                                } = {};
                                if (merge_info) {
                                    span_props.rowSpan =
                                        merge_info.rowSpan;
                                    span_props.colSpan =
                                        merge_info.colSpan;
                                }

                                const show_resize_handle =
                                    resize_handle_row.get(c) === r;

                                const selected = is_cell_in_range(
                                    r,
                                    c,
                                    sel_range
                                );
                                const is_anchor =
                                    selection !== null &&
                                    r === selection.anchor_row &&
                                    c === selection.anchor_col;

                                const class_names = [
                                    selected ? 'selected' : '',
                                    is_anchor ? 'active-cell' : '',
                                ]
                                    .filter(Boolean)
                                    .join(' ');

                                return (
                                    <td
                                        key={c}
                                        {...span_props}
                                        className={
                                            class_names || undefined
                                        }
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
                                        onMouseDown={(e) =>
                                            on_cell_mouse_down(r, c, e)
                                        }
                                        onMouseMove={() =>
                                            on_cell_mouse_move(r, c)
                                        }
                                        onContextMenu={(e) =>
                                            on_context_menu(r, c, e)
                                        }
                                    >
                                        {show_resize_handle && (
                                            <ColumnResizeHandle
                                                col={c}
                                                on_resize={
                                                    on_column_resize
                                                }
                                            />
                                        )}
                                        <CellContent
                                            cell={cell}
                                            show_formatting={
                                                show_formatting
                                            }
                                        />
                                    </td>
                                );
                            })}
                            <RowResizeHandle
                                row={r}
                                on_resize={on_row_resize}
                            />
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function CellContent({
    cell,
    show_formatting,
}: {
    cell: CellData | null;
    show_formatting: boolean;
}): React.JSX.Element {
    if (!cell) return <></>;

    const text = show_formatting
        ? cell.formatted
        : (cell.raw !== null ? String(cell.raw) : '');

    let content: React.ReactNode = text;

    if (cell.bold && cell.italic) {
        content = <b><i>{text}</i></b>;
    } else if (cell.bold) {
        content = <b>{text}</b>;
    } else if (cell.italic) {
        content = <i>{text}</i>;
    }

    return <>{content}</>;
}

interface ColumnResizeHandleProps {
    col: number;
    on_resize: (col: number, width: number) => void;
}

function ColumnResizeHandle({
    col,
    on_resize,
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

    return (
        <div
            className="col-resize-handle"
            onMouseDown={handle_mouse_down}
        />
    );
}

interface RowResizeHandleProps {
    row: number;
    on_resize: (row: number, height: number) => void;
}

function RowResizeHandle({
    row,
    on_resize,
}: RowResizeHandleProps): React.JSX.Element {
    const handle_mouse_down = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            const tr = (e.target as HTMLElement).closest('tr')!;
            const start_y = e.clientY;
            const start_height = tr.offsetHeight;

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
        },
        [row, on_resize]
    );

    return (
        <td style={{ padding: 0, width: 0, border: 'none', position: 'relative' }}>
            <div
                className="row-resize-handle"
                onMouseDown={handle_mouse_down}
            />
        </td>
    );
}

type MergeMapEntry =
    | 'hidden'
    | { rowSpan: number; colSpan: number };

function build_merge_map(
    merges: MergeRange[]
): Map<string, MergeMapEntry> {
    const map = new Map<string, MergeMapEntry>();

    for (const m of merges) {
        map.set(`${m.startRow}:${m.startCol}`, {
            rowSpan: m.endRow - m.startRow + 1,
            colSpan: m.endCol - m.startCol + 1,
        });

        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r === m.startRow && c === m.startCol) continue;
                map.set(`${r}:${c}`, 'hidden');
            }
        }
    }

    return map;
}
```

Note: `e.stopPropagation()` was added to `ColumnResizeHandle.handle_mouse_down` so dragging a resize handle doesn't trigger cell selection.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: Errors in `app.tsx` because `Table` now requires new props — this is expected and fixed in Task 8.

- [ ] **Step 3: Commit**

```bash
git add src/webview/table.tsx
git commit -m "feat: wire selection state and event handlers into Table"
```

---

### Task 8: Wire Everything into App

**Files:**
- Modify: `src/webview/app.tsx`

- [ ] **Step 1: Update App to use selection hook and render context menu**

Replace the entire content of `src/webview/app.tsx` with:

```tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { WorkbookData, PerFileState, HostMessage } from '../types';
import { Toolbar } from './toolbar';
import { SheetTabs } from './sheet-tabs';
import { Table } from './table';
import { ContextMenu, type MenuItem } from './context-menu';
import {
    clamp_sheet_index,
    normalize_per_file_state,
    trim_sheet_state_array,
} from './sheet-state';
import { vscode_api, use_state_sync } from './use-state-sync';
import { use_selection } from './use-selection';
import './styles.css';

export function App(): React.JSX.Element {
    const [workbook, set_workbook] = useState<WorkbookData | null>(null);
    const [active_sheet_index, set_active_sheet_index] = useState(0);
    const [show_formatting, set_show_formatting] = useState(true);
    const [vertical_tabs, set_vertical_tabs] = useState(false);
    const [column_widths, set_column_widths] = useState<
        (Record<number, number> | undefined)[]
    >([]);
    const [row_heights, set_row_heights] = useState<
        (Record<number, number> | undefined)[]
    >([]);

    const scroll_ref = useRef<HTMLDivElement | null>(null);
    const state_ref = useRef<PerFileState>({});
    const scroll_positions_ref = useRef<
        ({ top: number; left: number } | undefined)[]
    >([]);

    const { persist_debounced, persist_immediate } =
        use_state_sync(state_ref);

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data as HostMessage;

            if (msg.type === 'workbookData') {
                set_workbook(msg.data);
                const s = normalize_per_file_state(
                    msg.state,
                    msg.data.sheets.map((sheet) => sheet.name)
                );
                set_active_sheet_index(s.activeSheetIndex ?? 0);
                set_column_widths(s.columnWidths ?? []);
                set_row_heights(s.rowHeights ?? []);
                scroll_positions_ref.current = s.scrollPosition ?? [];

                const tab_orient =
                    s.tabOrientation ?? null;
                set_vertical_tabs(
                    tab_orient !== null
                        ? tab_orient === 'vertical'
                        : msg.defaultTabOrientation === 'vertical'
                );
                state_ref.current = s;

                requestAnimationFrame(() => {
                    const pos =
                        scroll_positions_ref.current[s.activeSheetIndex ?? 0];
                    if (pos && scroll_ref.current) {
                        scroll_ref.current.scrollTop = pos.top;
                        scroll_ref.current.scrollLeft = pos.left;
                    }
                });
            }

            if (msg.type === 'reload') {
                set_workbook(msg.data);
                const sheet_count = msg.data.sheets.length;

                set_column_widths((prev) =>
                    trim_sheet_state_array(prev, sheet_count)
                );
                set_row_heights((prev) =>
                    trim_sheet_state_array(prev, sheet_count)
                );
                scroll_positions_ref.current = trim_sheet_state_array(
                    scroll_positions_ref.current,
                    sheet_count
                );

                const next_active_sheet_index = clamp_sheet_index(
                    active_sheet_index,
                    sheet_count
                );
                set_active_sheet_index(next_active_sheet_index);

                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: trim_sheet_state_array(
                        state_ref.current.columnWidths,
                        sheet_count
                    ),
                    rowHeights: trim_sheet_state_array(
                        state_ref.current.rowHeights,
                        sheet_count
                    ),
                    scrollPosition: trim_sheet_state_array(
                        state_ref.current.scrollPosition,
                        sheet_count
                    ),
                    activeSheetIndex: next_active_sheet_index,
                };
                persist_immediate();
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [active_sheet_index, persist_immediate]);

    useEffect(() => {
        vscode_api.postMessage({ type: 'ready' });
    }, []);

    useEffect(() => {
        const el = scroll_ref.current;
        if (!el) return;

        const on_scroll = () => {
            scroll_positions_ref.current[active_sheet_index] = {
                top: el.scrollTop,
                left: el.scrollLeft,
            };
            state_ref.current = {
                ...state_ref.current,
                scrollPosition: [...scroll_positions_ref.current],
            };
            persist_debounced();
        };

        el.addEventListener('scroll', on_scroll, { passive: true });
        return () => el.removeEventListener('scroll', on_scroll);
    }, [active_sheet_index, persist_debounced]);

    const handle_sheet_select = useCallback(
        (sheet_index: number) => {
            if (scroll_ref.current) {
                scroll_positions_ref.current[active_sheet_index] = {
                    top: scroll_ref.current.scrollTop,
                    left: scroll_ref.current.scrollLeft,
                };
            }
            set_active_sheet_index(sheet_index);
            state_ref.current = {
                ...state_ref.current,
                activeSheetIndex: sheet_index,
                scrollPosition: [...scroll_positions_ref.current],
            };
            persist_immediate();

            requestAnimationFrame(() => {
                const pos = scroll_positions_ref.current[sheet_index];
                if (pos && scroll_ref.current) {
                    scroll_ref.current.scrollTop = pos.top;
                    scroll_ref.current.scrollLeft = pos.left;
                } else if (scroll_ref.current) {
                    scroll_ref.current.scrollTop = 0;
                    scroll_ref.current.scrollLeft = 0;
                }
            });
        },
        [active_sheet_index, persist_immediate]
    );

    const handle_toggle_formatting = useCallback(() => {
        set_show_formatting((prev) => !prev);
    }, []);

    const handle_toggle_tab_orientation = useCallback(() => {
        set_vertical_tabs((prev) => {
            const next = !prev;
            state_ref.current = {
                ...state_ref.current,
                tabOrientation: next ? 'vertical' : 'horizontal',
            };
            persist_immediate();
            return next;
        });
    }, [persist_immediate]);

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
        },
        [active_sheet_index, persist_immediate]
    );

    const handle_row_resize = useCallback(
        (row: number, height: number) => {
            set_row_heights((prev) => {
                const next = [...prev];
                const sheet_heights = { ...(next[active_sheet_index] ?? {}) };
                sheet_heights[row] = height;
                next[active_sheet_index] = sheet_heights;
                state_ref.current = {
                    ...state_ref.current,
                    rowHeights: [...next],
                };
                persist_immediate();
                return next;
            });
        },
        [active_sheet_index, persist_immediate]
    );

    if (!workbook) {
        return <div className="loading">Loading...</div>;
    }
    const current_sheet = workbook.sheets[active_sheet_index];

    if (!current_sheet) {
        return <div className="loading">No sheets found</div>;
    }

    const sheet_names = workbook.sheets.map((s) => s.name);

    return (
        <div className={`viewer ${vertical_tabs ? 'vertical-tabs' : ''}`}>
            <Toolbar
                show_formatting={show_formatting}
                on_toggle_formatting={handle_toggle_formatting}
                vertical_tabs={vertical_tabs}
                on_toggle_tab_orientation={
                    handle_toggle_tab_orientation
                }
            />
            {vertical_tabs ? (
                <div className="content-area">
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet_index={active_sheet_index}
                        on_select={handle_sheet_select}
                        vertical={true}
                    />
                    <TableWithSelection
                        sheet={current_sheet}
                        show_formatting={show_formatting}
                        column_widths={
                            column_widths[active_sheet_index] ?? {}
                        }
                        row_heights={
                            row_heights[active_sheet_index] ?? {}
                        }
                        on_column_resize={handle_column_resize}
                        on_row_resize={handle_row_resize}
                        scroll_ref={scroll_ref}
                    />
                </div>
            ) : (
                <>
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet_index={active_sheet_index}
                        on_select={handle_sheet_select}
                        vertical={false}
                    />
                    <TableWithSelection
                        sheet={current_sheet}
                        show_formatting={show_formatting}
                        column_widths={
                            column_widths[active_sheet_index] ?? {}
                        }
                        row_heights={
                            row_heights[active_sheet_index] ?? {}
                        }
                        on_column_resize={handle_column_resize}
                        on_row_resize={handle_row_resize}
                        scroll_ref={scroll_ref}
                    />
                </>
            )}
        </div>
    );
}

interface TableWithSelectionProps {
    sheet: import('../types').SheetData;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    row_heights: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    on_row_resize: (row: number, height: number) => void;
    scroll_ref: React.RefObject<HTMLDivElement | null>;
}

function TableWithSelection({
    sheet,
    show_formatting,
    column_widths,
    row_heights,
    on_column_resize,
    on_row_resize,
    scroll_ref,
}: TableWithSelectionProps): React.JSX.Element {
    const sel = use_selection(sheet, show_formatting);

    const menu_items: MenuItem[] = [];
    if (sel.context_menu) {
        menu_items.push({
            label: 'Copy cell',
            on_click: () =>
                sel.copy_cell(sel.context_menu!.row, sel.context_menu!.col),
        });
        if (sel.is_multi_cell) {
            menu_items.push({
                label: 'Copy selection',
                on_click: () => sel.copy_selection(),
            });
        }
        menu_items.push({
            label: 'Select row',
            on_click: () => sel.select_row(sel.context_menu!.row),
        });
        menu_items.push({
            label: 'Select column',
            on_click: () => sel.select_column(sel.context_menu!.col),
        });
        menu_items.push({
            label: 'Select all',
            on_click: () => sel.select_all(),
        });
    }

    return (
        <>
            <Table
                sheet={sheet}
                show_formatting={show_formatting}
                column_widths={column_widths}
                row_heights={row_heights}
                on_column_resize={on_column_resize}
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

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run existing tests to check for regressions**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/webview/app.tsx
git commit -m "feat: wire selection hook and context menu into App"
```

---

### Task 9: Selection and Context Menu Styles

**Files:**
- Modify: `src/webview/styles.css`

- [ ] **Step 1: Add selection, active-cell, and context-menu CSS**

Append to the end of `src/webview/styles.css`:

```css
/* Selection */

.data-table td.selected {
    background: rgba(0, 122, 204, 0.15);
}

.data-table td.active-cell {
    outline: 2px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -2px;
}

.table-container:focus {
    outline: none;
}

/* Prevent text selection while drag-selecting cells */
.table-container:active {
    user-select: none;
}

/* Context Menu */

.context-menu {
    position: fixed;
    z-index: 50;
    min-width: 160px;
    background: var(--vscode-menu-background, #252526);
    border: 1px solid var(--vscode-menu-border, #454545);
    border-radius: 4px;
    padding: 4px 0;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    font-size: 12px;
}

.context-menu-item {
    padding: 6px 20px;
    cursor: pointer;
    color: var(--vscode-menu-foreground, #ccc);
    white-space: nowrap;
}

.context-menu-item:hover {
    background: var(--vscode-menu-selectionBackground, #094771);
    color: var(--vscode-menu-selectionForeground, #fff);
}
```

- [ ] **Step 2: Build the webview bundle to verify**

Run: `npm run bundle:webview`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/webview/styles.css
git commit -m "feat: add selection and context menu styles"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (including selection tests from Tasks 1-4)

- [ ] **Step 2: Build both bundles**

Run: `npm run bundle && npm run bundle:webview`
Expected: Both builds succeed

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Manual testing checklist**

Open a `.xlsx` file in VS Code with the extension loaded. Verify:

1. Click a cell — it highlights with blue tint and border
2. Click-drag — rectangular selection highlights
3. Shift+click — extends selection from anchor
4. Arrow keys — move active cell
5. h/j/k/l — vim navigation works
6. Shift+Arrow — extends selection
7. Cmd+A — selects all cells
8. Cmd+C — copies selection (paste into text editor to verify TSV format)
9. Right-click — context menu appears at cursor
10. "Copy cell" — copies single cell value
11. "Copy selection" — appears only with multi-cell selection, copies TSV
12. "Select row" / "Select column" / "Select all" — work correctly
13. Context menu dismisses on click outside, Escape, or scroll
14. Merged cells: clicking selects the whole merge, navigation skips hidden cells
15. Toggle formatting off, copy — raw values are copied
16. Escape — clears selection
17. Tab / Shift+Tab — moves right/left

- [ ] **Step 5: Commit any fixes, then final commit if clean**

```bash
git status
```
