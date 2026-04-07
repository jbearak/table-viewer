# External Reload Edit Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When external file changes occur while the user has unsaved CSV edits, detect conflicts per-cell rather than silently discarding or blindly preserving edits.

**Architecture:** Extend `dirty_cells` to track the original base value alongside each edit. On external reload, compare base values against new rows to identify conflicted cells. Show a conflict banner with resolution options. Add per-cell "Discard edit" to the context menu. Gate edit mode on `csvEditable`.

**Tech Stack:** React hooks, VS Code webview messaging, CSS custom properties

---

### Task 1: Extend DirtyEntry Type and Update use-editing Hook Data Model

**Files:**
- Modify: `src/webview/use-editing.ts:1-146`
- Modify: `src/types.ts:32-39,58-65`
- Modify: `src/webview/sheet-state.ts:79-92`
- Test: `src/test/use-editing.test.ts`

This task changes the core data model from `Map<string, string>` to `Map<string, DirtyEntry>` and updates all consumers within the hook.

- [ ] **Step 1: Write failing tests for base-value tracking**

Add to `src/test/use-editing.test.ts`:

```typescript
it('confirm_edit stores the base value alongside the dirty value', async () => {
    await render();
    await act(async () => { hook_result!.toggle_edit_mode(); });
    await act(async () => { hook_result!.start_editing(0, 0); });
    await act(async () => { hook_result!.confirm_edit('A'); });
    const entry = hook_result!.dirty_cells.get('0:0');
    expect(entry).toEqual({ value: 'A', base: 'a' });
});

it('confirm_edit stores empty base for null cells', async () => {
    await render();
    await act(async () => { hook_result!.toggle_edit_mode(); });
    await act(async () => { hook_result!.start_editing(2, 1); });
    await act(async () => { hook_result!.confirm_edit('X'); });
    const entry = hook_result!.dirty_cells.get('2:1');
    expect(entry).toEqual({ value: 'X', base: '' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/use-editing.test.ts`
Expected: FAIL — `dirty_cells.get('0:0')` returns `'A'` (string) not `{ value: 'A', base: 'a' }`

- [ ] **Step 3: Add DirtyEntry type and update dirty_cells state**

In `src/webview/use-editing.ts`, add the `DirtyEntry` interface after the existing `EditingCell` interface:

```typescript
export interface DirtyEntry {
    value: string;
    base: string;
}
```

Change `dirty_cells` state type from `Map<string, string>` to `Map<string, DirtyEntry>`:

```typescript
const [dirty_cells, set_dirty_cells] = useState<Map<string, DirtyEntry>>(
    () => initial_edits ? new Map(
        Object.entries(initial_edits).map(([k, v]) =>
            [k, typeof v === 'object' && v !== null ? v as DirtyEntry : { value: v, base: '' }]
        )
    ) : new Map()
);
```

Update the `initial_edits` parameter type from `Record<string, string>` to `Record<string, string | DirtyEntry>` for backwards compatibility.

- [ ] **Step 4: Update confirm_edit to store base values**

In `confirm_edit`, capture the base value and store `DirtyEntry` objects:

```typescript
const confirm_edit = useCallback((new_value: string) => {
    if (!editing_cell) return;
    const { row, col } = editing_cell;
    const key = `${row}:${col}`;

    const cell = rows[row]?.[col];
    const original = cell !== null ? String(cell?.raw ?? '') : '';

    set_editing_cell(null);

    if (new_value === original) {
        set_dirty_cells(prev => {
            if (!prev.has(key)) return prev;
            const next = new Map(prev);
            next.delete(key);
            return next;
        });
        return;
    }

    set_dirty_cells(prev => {
        const next = new Map(prev);
        next.set(key, { value: new_value, base: original });
        return next;
    });
}, [editing_cell, rows]);
```

- [ ] **Step 5: Update begin_editing to read from DirtyEntry**

In `begin_editing`, extract the `value` field from `DirtyEntry`:

```typescript
const begin_editing = useCallback((row: number, col: number) => {
    const key = `${row}:${col}`;
    const dirty_entry = dirty_cells.get(key);
    if (dirty_entry !== undefined) {
        set_editing_cell({ row, col, value: dirty_entry.value });
        return;
    }
    const cell = rows[row]?.[col];
    const value = cell !== null ? String(cell?.raw ?? '') : '';
    set_editing_cell({ row, col, value });
}, [rows, dirty_cells]);
```

- [ ] **Step 6: Update get_display_value to extract value from DirtyEntry**

```typescript
const get_display_value = useCallback((row: number, col: number): string | null => {
    const entry = dirty_cells.get(`${row}:${col}`);
    return entry?.value ?? null;
}, [dirty_cells]);
```

- [ ] **Step 7: Update PerFileState pendingEdits type**

In `src/types.ts`, change the `pendingEdits` type in `PerFileState`:

```typescript
pendingEdits?: Record<string, string | { value: string; base: string }>;
```

Also update the `pendingEditsChanged` message type in `WebviewMessage`:

```typescript
| { type: 'pendingEditsChanged'; edits: Record<string, { value: string; base: string }> | null };
```

- [ ] **Step 8: Update normalize_pending_edits for backwards compatibility**

In `src/webview/sheet-state.ts`, update `normalize_pending_edits` to handle both old string format and new `DirtyEntry` format:

```typescript
function normalize_pending_edits(
    value: unknown
): Record<string, { value: string; base: string }> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const result: Record<string, { value: string; base: string }> = {};
    for (const [key, val] of Object.entries(value)) {
        if (typeof val === 'string') {
            // Backwards compat: old format stored just the value string
            result[key] = { value: val, base: '' };
        } else if (
            typeof val === 'object' && val !== null &&
            'value' in val && typeof (val as Record<string, unknown>).value === 'string' &&
            'base' in val && typeof (val as Record<string, unknown>).base === 'string'
        ) {
            result[key] = { value: (val as { value: string; base: string }).value, base: (val as { value: string; base: string }).base };
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
```

- [ ] **Step 9: Fix existing tests for new DirtyEntry format**

Update existing tests in `src/test/use-editing.test.ts` that check `dirty_cells.get(key)` to expect `DirtyEntry` objects:

- Line 84: `expect(hook_result!.dirty_cells.get('0:0')).toBe('A')` → `expect(hook_result!.dirty_cells.get('0:0')).toEqual({ value: 'A', base: 'a' })`

- [ ] **Step 10: Run all tests**

Run: `npx vitest run src/test/use-editing.test.ts`
Expected: ALL PASS

- [ ] **Step 11: Commit**

```bash
git add src/webview/use-editing.ts src/types.ts src/webview/sheet-state.ts src/test/use-editing.test.ts
git commit -m "feat: track base values in dirty cell entries for conflict detection"
```

---

### Task 2: Add Conflict Detection and discard_edit / discard_conflicted Methods

**Files:**
- Modify: `src/webview/use-editing.ts`
- Test: `src/test/use-editing.test.ts`

- [ ] **Step 1: Write failing tests for conflict detection**

Add to `src/test/use-editing.test.ts`. These tests need a component that allows re-rendering with new rows to simulate an external reload:

```typescript
function ReloadableComponent({ rows }: { rows: (CellData | null)[][] }) {
    hook_result = use_editing(rows, rows.length, rows[0]?.length ?? 0);
    return null;
}

async function render_reloadable(initial_rows: (CellData | null)[][]) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(ReloadableComponent, { rows: initial_rows }));
    });
}

async function rerender_with_rows(new_rows: (CellData | null)[][]) {
    await act(async () => {
        root!.render(React.createElement(ReloadableComponent, { rows: new_rows }));
    });
}
```

```typescript
describe('conflict detection', () => {
    it('marks conflicted keys when base value changes after reload', async () => {
        await render_reloadable(rows);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.confirm_edit('A'); });

        // Simulate external reload: cell 0:0 changed from 'a' to 'z'
        const new_rows: (CellData | null)[][] = [
            [cell('z'), cell('b'), cell('c')],
            [cell('d'), cell('e'), cell('f')],
            [cell('g'), null, cell('i')],
        ];
        await rerender_with_rows(new_rows);

        expect(hook_result!.conflicted_keys.has('0:0')).toBe(true);
    });

    it('does not mark conflict when base value unchanged after reload', async () => {
        await render_reloadable(rows);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.confirm_edit('A'); });

        // Reload with same base values
        const new_rows: (CellData | null)[][] = [
            [cell('a'), cell('b'), cell('c')],
            [cell('d'), cell('e'), cell('f')],
            [cell('g'), null, cell('i')],
        ];
        await rerender_with_rows(new_rows);

        expect(hook_result!.conflicted_keys.has('0:0')).toBe(false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/use-editing.test.ts`
Expected: FAIL — `conflicted_keys` does not exist on hook result

- [ ] **Step 3: Add conflicted_keys derived state**

In `src/webview/use-editing.ts`, add a `useMemo` that computes conflicted keys by comparing each dirty entry's `base` against the current row data:

```typescript
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
```

```typescript
const conflicted_keys = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, entry] of dirty_cells) {
        const [r, c] = key.split(':').map(Number);
        const cell = rows[r]?.[c];
        const current_base = cell !== null ? String(cell?.raw ?? '') : '';
        if (current_base !== entry.base) {
            keys.add(key);
        }
    }
    return keys;
}, [dirty_cells, rows]);
```

Add `conflicted_keys` to the return object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/use-editing.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Write failing tests for discard_edit and discard_conflicted**

```typescript
it('discard_edit removes a single dirty entry', async () => {
    await render_reloadable(rows);
    await act(async () => { hook_result!.toggle_edit_mode(); });
    await act(async () => { hook_result!.start_editing(0, 0); });
    await act(async () => { hook_result!.confirm_edit('A'); });
    await act(async () => { hook_result!.start_editing(0, 1); });
    await act(async () => { hook_result!.confirm_edit('B'); });
    expect(hook_result!.dirty_cells.size).toBe(2);

    await act(async () => { hook_result!.discard_edit('0:0'); });
    expect(hook_result!.dirty_cells.size).toBe(1);
    expect(hook_result!.dirty_cells.has('0:0')).toBe(false);
    expect(hook_result!.dirty_cells.has('0:1')).toBe(true);
});

it('discard_conflicted removes only conflicted entries', async () => {
    await render_reloadable(rows);
    await act(async () => { hook_result!.toggle_edit_mode(); });
    // Edit two cells
    await act(async () => { hook_result!.start_editing(0, 0); });
    await act(async () => { hook_result!.confirm_edit('A'); });
    await act(async () => { hook_result!.start_editing(0, 1); });
    await act(async () => { hook_result!.confirm_edit('B'); });

    // Reload: only cell 0:0 changed externally
    const new_rows: (CellData | null)[][] = [
        [cell('z'), cell('b'), cell('c')],
        [cell('d'), cell('e'), cell('f')],
        [cell('g'), null, cell('i')],
    ];
    await rerender_with_rows(new_rows);

    expect(hook_result!.conflicted_keys.size).toBe(1);
    await act(async () => { hook_result!.discard_conflicted(); });
    expect(hook_result!.dirty_cells.size).toBe(1);
    expect(hook_result!.dirty_cells.has('0:1')).toBe(true);
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run src/test/use-editing.test.ts`
Expected: FAIL — `discard_edit` and `discard_conflicted` do not exist

- [ ] **Step 7: Implement discard_edit and discard_conflicted**

In `src/webview/use-editing.ts`:

```typescript
const discard_edit = useCallback((key: string) => {
    set_dirty_cells(prev => {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
    });
}, []);

const discard_conflicted = useCallback(() => {
    set_dirty_cells(prev => {
        const next = new Map<string, DirtyEntry>();
        for (const [key, entry] of prev) {
            const [r, c] = key.split(':').map(Number);
            const cell = rows[r]?.[c];
            const current_base = cell !== null ? String(cell?.raw ?? '') : '';
            if (current_base === entry.base) {
                next.set(key, entry);
            }
        }
        return next;
    });
}, [rows]);
```

Add `discard_edit` and `discard_conflicted` to the return object.

- [ ] **Step 8: Run all tests**

Run: `npx vitest run src/test/use-editing.test.ts`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add src/webview/use-editing.ts src/test/use-editing.test.ts
git commit -m "feat: add conflict detection and per-cell discard for dirty edits"
```

---

### Task 3: Update App-Level Consumers of dirty_cells

**Files:**
- Modify: `src/webview/app.tsx:649-658` (pendingEditsChanged effect)
- Modify: `src/webview/app.tsx:705-728` (collect_edits_for_save)
- Modify: `src/webview/table.tsx:28,221` (dirty_cells prop type and usage)

These locations read from `dirty_cells` and need updating for the `DirtyEntry` type.

- [ ] **Step 1: Update pendingEditsChanged effect in app.tsx**

At line 649-658, change the effect that syncs dirty cells to extension state:

```typescript
useEffect(() => {
    if (editing.is_dirty) {
        const edits: Record<string, { value: string; base: string }> = {};
        editing.dirty_cells.forEach((entry, key) => { edits[key] = entry; });
        vscode_api.postMessage({ type: 'pendingEditsChanged', edits });
    } else {
        vscode_api.postMessage({ type: 'pendingEditsChanged', edits: null });
    }
}, [editing.dirty_cells, editing.is_dirty]);
```

- [ ] **Step 2: Update collect_edits_for_save in app.tsx**

At line 705-728, the `saveCsv` message still needs `Record<string, string>` (just values, no base). Extract `.value` from each entry:

```typescript
const collect_edits_for_save = useCallback(() => {
    const active_value = editing.get_active_editor_value();
    if (active_value !== null) {
        editing.confirm_edit(active_value);
    }
    const edits: Record<string, string> = {};
    editing.dirty_cells.forEach((entry, key) => {
        edits[key] = entry.value;
    });
    if (active_value !== null && editing.editing_cell) {
        const { row, col } = editing.editing_cell;
        const cell = sheet.rows[row]?.[col];
        const original = cell !== null ? String(cell?.raw ?? '') : '';
        if (active_value !== original) {
            edits[`${row}:${col}`] = active_value;
        } else {
            delete edits[`${row}:${col}`];
        }
    }
    return edits;
}, [editing, sheet.rows]);
```

- [ ] **Step 3: Update Table component dirty_cells prop type**

In `src/webview/table.tsx`, update the `TableProps` interface:

```typescript
import type { EditingCell, DirtyEntry } from './use-editing';
```

Change line 28:
```typescript
dirty_cells: Map<string, DirtyEntry>;
```

Update the cell rendering at line 221:
```typescript
const is_dirty_cell = dirty_cells.has(`${r}:${c}`);
```
(This line stays the same — it just checks presence.)

- [ ] **Step 4: Run full test suite and build**

Run: `npx vitest run && npm run bundle && npm run bundle:webview`
Expected: ALL PASS, build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/webview/app.tsx src/webview/table.tsx
git commit -m "refactor: update dirty_cells consumers for DirtyEntry type"
```

---

### Task 4: Add Conflicted Cell Visual Treatment

**Files:**
- Modify: `src/webview/table.tsx:9-34,215-232`
- Modify: `src/webview/styles.css:318-320`
- Modify: `src/webview/app.tsx` (pass `conflicted_keys` to Table)

- [ ] **Step 1: Add conflicted_keys prop to Table**

In `src/webview/table.tsx`, add to `TableProps`:

```typescript
conflicted_keys: Set<string>;
```

Add to the destructured props in the `Table` function signature.

- [ ] **Step 2: Apply conflicted class in cell rendering**

At line 221-231 in `table.tsx`, add the conflicted check:

```typescript
const is_dirty_cell = dirty_cells.has(`${r}:${c}`);
const is_conflicted = conflicted_keys.has(`${r}:${c}`);

const class_names = [
    !is_editing_cell ? 'display-cell' : '',
    selected ? 'selected' : '',
    is_anchor ? 'active-cell' : '',
    col_highlighted ? 'resize-col-highlight' : '',
    row_highlighted ? 'resize-row-highlight' : '',
    is_dirty_cell ? 'dirty-cell' : '',
    is_conflicted ? 'cell-conflicted' : '',
]
    .filter(Boolean)
    .join(' ');
```

- [ ] **Step 3: Add CSS for conflicted cells**

In `src/webview/styles.css`, after the `.data-table td.dirty-cell` rule:

```css
.data-table td.cell-conflicted {
    color: var(--vscode-editorWarning-foreground, #cca700);
}
```

- [ ] **Step 4: Pass conflicted_keys from TableWithSelection to Table**

In `src/webview/app.tsx`, find where `<Table>` is rendered inside `TableWithSelection` and add the prop:

```typescript
conflicted_keys={editing.conflicted_keys}
```

- [ ] **Step 5: Run build to verify**

Run: `npm run bundle:webview`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/webview/table.tsx src/webview/styles.css src/webview/app.tsx
git commit -m "feat: add visual treatment for conflicted edited cells"
```

---

### Task 5: Add Conflict Banner

**Files:**
- Modify: `src/webview/app.tsx` (banner JSX in TableWithSelection, between toolbar and table)
- Modify: `src/webview/styles.css` (banner styling)

- [ ] **Step 1: Add conflict banner JSX**

In `src/webview/app.tsx`, inside `TableWithSelection`, add a state for banner dismissal and the banner JSX. Place this after the `editing` hook call (around line 642):

```typescript
const [conflict_banner_dismissed, set_conflict_banner_dismissed] = useState(false);

// Reset banner dismissal when conflicts change
useEffect(() => {
    if (editing.conflicted_keys.size > 0) {
        set_conflict_banner_dismissed(false);
    }
}, [editing.conflicted_keys.size]);

const show_conflict_banner = editing.conflicted_keys.size > 0 && !conflict_banner_dismissed;
```

Find where Table is rendered and add the banner JSX immediately before `<Table`:

```tsx
{show_conflict_banner && (
    <div className="conflict-banner">
        <span>
            File changed externally. {editing.conflicted_keys.size} edit{editing.conflicted_keys.size !== 1 ? 's' : ''} may be affected — highlighted cells show conflicts.
        </span>
        <span className="conflict-banner-actions">
            <button onClick={() => set_conflict_banner_dismissed(true)}>Keep All</button>
            <button onClick={() => { editing.discard_conflicted(); }}>Discard Conflicted</button>
            <button onClick={() => { editing.clear_dirty(); editing.set_edit_mode(false); }}>Discard All</button>
        </span>
    </div>
)}
```

- [ ] **Step 2: Add banner CSS**

In `src/webview/styles.css`, add after the `.truncation-banner` rule:

```css
.conflict-banner {
    padding: 4px 8px;
    background: var(--vscode-editorWarning-background, rgba(204, 167, 0, 0.1));
    color: var(--vscode-editorWarning-foreground, #cca700);
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    font-size: 12px;
    flex-shrink: 0;
    text-align: center;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.conflict-banner-actions {
    display: flex;
    gap: 4px;
}

.conflict-banner-actions button {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 2px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 11px;
}

.conflict-banner-actions button:hover {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
}
```

- [ ] **Step 3: Run build to verify**

Run: `npm run bundle:webview`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/webview/app.tsx src/webview/styles.css
git commit -m "feat: add conflict banner with Keep All / Discard Conflicted / Discard All"
```

---

### Task 6: Add "Discard edit" Context Menu Item

**Files:**
- Modify: `src/webview/app.tsx:844-880` (context menu construction)

- [ ] **Step 1: Add "Discard edit" to context menu**

In `src/webview/app.tsx`, in the context menu construction block (around line 857), add after the "Edit cell" item:

```typescript
if (csv_editable) {
    menu_items.push({
        label: 'Edit cell',
        on_click: () => {
            const { row, col } = sel.context_menu!;
            if (!editing.edit_mode) {
                editing.set_edit_mode(true);
            }
            editing.force_start_editing(row, col);
        },
    });
}
if (editing.dirty_cells.has(`${sel.context_menu.row}:${sel.context_menu.col}`)) {
    menu_items.push({
        label: 'Discard edit',
        on_click: () => {
            const { row, col } = sel.context_menu!;
            editing.discard_edit(`${row}:${col}`);
        },
    });
}
```

- [ ] **Step 2: Run build to verify**

Run: `npm run bundle:webview`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/webview/app.tsx
git commit -m "feat: add 'Discard edit' to context menu for edited cells"
```

---

### Task 7: Add csvEditable Gate

**Files:**
- Modify: `src/webview/app.tsx:160-165` (reload handler)

- [ ] **Step 1: Add gate logic in reload handler**

In `src/webview/app.tsx`, in the reload message handler, after the `set_csv_editable` call (around line 161), the csvEditable gate cannot directly call `editing` methods because `editing` lives in `TableWithSelection`, not the `App` component where the reload handler is. Instead, we need to pass the new `csvEditable` value down and handle it in `TableWithSelection`.

Add a new effect in `TableWithSelection` that watches `csv_editable`:

```typescript
// Exit edit mode when CSV editing becomes disabled (e.g., file truncated on reload)
useEffect(() => {
    if (!csv_editable && editing.edit_mode) {
        editing.clear_dirty();
        editing.set_edit_mode(false);
    }
}, [csv_editable, editing.edit_mode, editing.clear_dirty, editing.set_edit_mode]);
```

Place this after the existing `on_edit_mode_change` effect (around line 647).

- [ ] **Step 2: Run full test suite and build**

Run: `npx vitest run && npm run bundle && npm run bundle:webview`
Expected: ALL PASS, build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/webview/app.tsx
git commit -m "fix: exit edit mode when csvEditable becomes false on reload"
```

---

### Task 8: Final Verification

**Files:** (none — verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Run production build**

Run: `npm run bundle && npm run bundle:webview`
Expected: Build succeeds with no errors

- [ ] **Step 3: Run type checking**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit any remaining changes**

If any cleanup was needed, commit with an appropriate message.
