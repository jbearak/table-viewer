# CSV/TSV Cell Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline cell editing for CSV/TSV files in standalone table mode with explicit save.

**Architecture:** Edit mode is toggled via a toolbar button (CSV/TSV only). Double-clicking a cell opens an input overlay. Dirty state lives in React; on save, the webview posts edits to the extension host, which re-serializes and writes the file. The file watcher suppresses the self-triggered reload.

**Tech Stack:** React 18, TypeScript, VS Code webview API, PapaParse (for re-serialization reference)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify | Add `saveCsv` message type, `csvEditable` flag on `HostMessage` |
| `src/webview/cell-editor.tsx` | Create | `CellEditor` component — input/textarea overlay for editing a single cell |
| `src/webview/use-editing.ts` | Create | `use_editing` hook — edit mode state, dirty map, cell editing lifecycle |
| `src/webview/table.tsx` | Modify | Render `CellEditor` overlay, pass double-click handler, add dirty cell CSS class |
| `src/webview/toolbar.tsx` | Modify | Add edit mode toggle button |
| `src/webview/app.tsx` | Modify | Wire editing state, pass `edit_mode` / `is_csv` to toolbar and table, handle Cmd+S |
| `src/webview/styles.css` | Modify | Styles for cell editor overlay and dirty cell indicator |
| `src/csv-panel.ts` | Modify | Add `saveCsv` message handler, file watcher suppression, send `csvEditable` flag |
| `src/serialize-csv.ts` | Create | Re-serialize edited rows back to CSV/TSV text |
| `src/test/serialize-csv.test.ts` | Create | Tests for CSV/TSV serialization |
| `src/test/use-editing.test.ts` | Create | Tests for the editing hook |
| `src/test/cell-editor.test.ts` | Create | Tests for the cell editor component |
| `README.md` | Modify | Add editing section |

---

### Task 1: Add Message Types

**Files:**
- Modify: `src/types.ts:49-59`

- [ ] **Step 1: Write the failing type check**

Create a temporary file to verify the new types compile:

```typescript
// src/test/type-check-editing.ts
import type { WebviewMessage, HostMessage } from '../types';

// These should compile without error
const save_msg: WebviewMessage = {
    type: 'saveCsv',
    edits: { '0:1': 'new value', '2:3': '' },
};

const host_msg: HostMessage = {
    type: 'workbookData',
    data: { sheets: [], hasFormatting: false },
    state: {},
    defaultTabOrientation: 'horizontal',
    csvEditable: true,
};
```

Run: `npx tsc --noEmit`
Expected: FAIL — `saveCsv` and `csvEditable` don't exist yet.

- [ ] **Step 2: Add the new types**

In `src/types.ts`, add `csvEditable` to the `workbookData` host message and add the `saveCsv` webview message:

```typescript
/** Messages from extension host to webview */
export type HostMessage =
    | { type: 'workbookData'; data: WorkbookData; state: StoredPerFileState; defaultTabOrientation: 'horizontal' | 'vertical'; truncationMessage?: string; previewMode?: boolean; csvEditable?: boolean }
    | { type: 'reload'; data: WorkbookData; truncationMessage?: string }
    | { type: 'scrollToRow'; row: number };

/** Messages from webview to extension host */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'stateChanged'; state: PerFileState }
    | { type: 'visibleRowChanged'; row: number }
    | { type: 'saveCsv'; edits: Record<string, string> };
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Delete the temporary type-check file and commit**

```bash
rm src/test/type-check-editing.ts
git add src/types.ts
git commit -m "feat: add saveCsv message type and csvEditable flag"
```

---

### Task 2: CSV Serialization

**Files:**
- Create: `src/serialize-csv.ts`
- Create: `src/test/serialize-csv.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/test/serialize-csv.test.ts
import { describe, it, expect } from 'vitest';
import { serialize_csv } from '../serialize-csv';
import type { CellData } from '../types';

function cell(raw: string): CellData {
    return { raw, formatted: raw, bold: false, italic: false };
}

describe('serialize_csv', () => {
    it('serializes simple rows with comma delimiter', () => {
        const rows: (CellData | null)[][] = [
            [cell('a'), cell('b'), cell('c')],
            [cell('1'), cell('2'), cell('3')],
        ];
        expect(serialize_csv(rows, ',')).toBe('a,b,c\n1,2,3\n');
    });

    it('serializes with tab delimiter', () => {
        const rows: (CellData | null)[][] = [
            [cell('a'), cell('b')],
            [cell('1'), cell('2')],
        ];
        expect(serialize_csv(rows, '\t')).toBe('a\tb\n1\t2\n');
    });

    it('quotes fields containing the delimiter', () => {
        const rows: (CellData | null)[][] = [
            [cell('hello, world'), cell('plain')],
        ];
        expect(serialize_csv(rows, ',')).toBe('"hello, world",plain\n');
    });

    it('quotes fields containing newlines', () => {
        const rows: (CellData | null)[][] = [
            [cell('line1\nline2'), cell('ok')],
        ];
        expect(serialize_csv(rows, ',')).toBe('"line1\nline2",ok\n');
    });

    it('escapes double quotes by doubling them', () => {
        const rows: (CellData | null)[][] = [
            [cell('say "hello"'), cell('ok')],
        ];
        expect(serialize_csv(rows, ',')).toBe('"say ""hello""",ok\n');
    });

    it('treats null cells as empty strings', () => {
        const rows: (CellData | null)[][] = [
            [cell('a'), null, cell('c')],
        ];
        expect(serialize_csv(rows, ',')).toBe('a,,c\n');
    });

    it('applies edits map overriding cell values', () => {
        const rows: (CellData | null)[][] = [
            [cell('a'), cell('b')],
            [cell('c'), cell('d')],
        ];
        const edits: Record<string, string> = {
            '0:1': 'B',
            '1:0': 'C',
        };
        expect(serialize_csv(rows, ',', edits)).toBe('a,B\nC,d\n');
    });

    it('applies edits to null cells', () => {
        const rows: (CellData | null)[][] = [
            [null, cell('b')],
        ];
        const edits: Record<string, string> = {
            '0:0': 'filled',
        };
        expect(serialize_csv(rows, ',', edits)).toBe('filled,b\n');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/serialize-csv.test.ts`
Expected: FAIL — module `../serialize-csv` does not exist.

- [ ] **Step 3: Implement serialize_csv**

```typescript
// src/serialize-csv.ts
import type { CellData } from './types';

export function serialize_csv(
    rows: (CellData | null)[][],
    delimiter: ',' | '\t',
    edits?: Record<string, string>
): string {
    const lines: string[] = [];

    for (let r = 0; r < rows.length; r++) {
        const fields: string[] = [];
        for (let c = 0; c < rows[r].length; c++) {
            const key = `${r}:${c}`;
            let value: string;
            if (edits && key in edits) {
                value = edits[key];
            } else {
                const cell = rows[r][c];
                value = cell !== null ? String(cell.raw ?? '') : '';
            }
            fields.push(quote_field(value, delimiter));
        }
        lines.push(fields.join(delimiter));
    }

    return lines.join('\n') + '\n';
}

function quote_field(value: string, delimiter: string): string {
    if (
        value.includes(delimiter) ||
        value.includes('\n') ||
        value.includes('\r') ||
        value.includes('"')
    ) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/serialize-csv.test.ts`
Expected: PASS — all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/serialize-csv.ts src/test/serialize-csv.test.ts
git commit -m "feat: add CSV/TSV serializer with edit support"
```

---

### Task 3: Save Handler in csv-panel.ts

**Files:**
- Modify: `src/csv-panel.ts:104-114` (message handler)
- Modify: `src/csv-panel.ts:117-125` (file watcher)
- Modify: `src/csv-panel.ts:58-78` (send_initial_data)

- [ ] **Step 1: Write the failing test**

```typescript
// src/test/csv-panel-save.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serialize_csv } from '../serialize-csv';
import type { CellData } from '../types';

// Test that serialize_csv with edits produces the expected output,
// which is the core logic the save handler will use.
// The actual VS Code API calls can't be unit-tested here, but
// we verify the serialization pipeline is correct.

function cell(raw: string): CellData {
    return { raw, formatted: raw, bold: false, italic: false };
}

describe('csv save pipeline', () => {
    it('applies edits and serializes back to CSV', () => {
        const rows: (CellData | null)[][] = [
            [cell('name'), cell('age')],
            [cell('Alice'), cell('30')],
            [cell('Bob'), cell('25')],
        ];
        const edits: Record<string, string> = {
            '1:1': '31',
            '2:0': 'Robert',
        };
        const result = serialize_csv(rows, ',', edits);
        expect(result).toBe('name,age\nAlice,31\nRobert,25\n');
    });

    it('applies edits and serializes back to TSV', () => {
        const rows: (CellData | null)[][] = [
            [cell('x'), cell('y')],
            [cell('1'), cell('2')],
        ];
        const edits: Record<string, string> = { '1:1': '99' };
        const result = serialize_csv(rows, '\t', edits);
        expect(result).toBe('x\ty\n1\t99\n');
    });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/test/csv-panel-save.test.ts`
Expected: PASS — these rely on the already-implemented `serialize_csv`.

- [ ] **Step 3: Add save handler and watcher suppression to csv-panel.ts**

Add these changes to `src/csv-panel.ts`:

1. Import `serialize_csv` at the top:
```typescript
import { serialize_csv } from './serialize-csv';
```

2. Add a suppression flag after `let consecutive_reload_failures = 0;` (line 34):
```typescript
let suppress_next_reload = false;
```

3. Add `csvEditable: true` to the `send_initial_data` postMessage call (inside the object at line 67):
```typescript
panel.webview.postMessage({
    type: 'workbookData',
    data: result.data,
    state,
    defaultTabOrientation: default_orientation,
    truncationMessage: result.truncationMessage,
    csvEditable: true,
});
```

4. Store the last parsed result so the save handler can access the rows. Add after the `parse_file` function (line 56):
```typescript
let last_parsed: CsvParseResult | null = null;
```

Update `send_initial_data` to store it:
```typescript
async function send_initial_data(): Promise<void> {
    try {
        const result = await parse_file();
        last_parsed = result;
        // ... rest unchanged
```

Update `send_reload` similarly:
```typescript
async function send_reload(): Promise<void> {
    if (suppress_next_reload) {
        suppress_next_reload = false;
        return;
    }
    try {
        const result = await parse_file();
        last_parsed = result;
        // ... rest unchanged
```

5. Add the `saveCsv` and `showSaveDialog` cases to the message handler (line 106-114):
```typescript
disposables.push(
    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
        switch (msg.type) {
            case 'ready':
                send_initial_data();
                break;
            case 'stateChanged':
                state_store.set(file_path, msg.state);
                break;
            case 'saveCsv': {
                if (!last_parsed) return;
                try {
                    const content = serialize_csv(
                        last_parsed.data.sheets[0].rows,
                        get_delimiter(),
                        msg.edits
                    );
                    suppress_next_reload = true;
                    await vscode.workspace.fs.writeFile(
                        uri,
                        new TextEncoder().encode(content)
                    );
                    last_parsed = await parse_file();
                    panel.webview.postMessage({ type: 'saveResult', success: true });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Failed to save: ${message}`);
                    panel.webview.postMessage({ type: 'saveResult', success: false });
                }
                break;
            }
            case 'showSaveDialog': {
                const choice = await vscode.window.showWarningMessage(
                    'You have unsaved changes.',
                    { modal: true },
                    'Save',
                    'Discard'
                );
                panel.webview.postMessage({
                    type: 'saveDialogResult',
                    choice: choice === 'Save' ? 'save' : choice === 'Discard' ? 'discard' : 'cancel',
                });
                break;
            }
        }
    })
);
```

- [ ] **Step 4: Add `saveResult` and `saveDialogResult` to HostMessage type**

In `src/types.ts`, add new host message variants:
```typescript
export type HostMessage =
    | { type: 'workbookData'; data: WorkbookData; state: StoredPerFileState; defaultTabOrientation: 'horizontal' | 'vertical'; truncationMessage?: string; previewMode?: boolean; csvEditable?: boolean }
    | { type: 'reload'; data: WorkbookData; truncationMessage?: string }
    | { type: 'scrollToRow'; row: number }
    | { type: 'saveResult'; success: boolean }
    | { type: 'saveDialogResult'; choice: 'save' | 'discard' | 'cancel' };
```

And add `showSaveDialog` to `WebviewMessage`:
```typescript
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'stateChanged'; state: PerFileState }
    | { type: 'visibleRowChanged'; row: number }
    | { type: 'saveCsv'; edits: Record<string, string> }
    | { type: 'showSaveDialog' };
```

- [ ] **Step 5: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/csv-panel.ts src/types.ts src/test/csv-panel-save.test.ts
git commit -m "feat: add save handler and file watcher suppression for CSV editing"
```

---

### Task 4: Editing Hook (use_editing)

**Files:**
- Create: `src/webview/use-editing.ts`
- Create: `src/test/use-editing.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/test/use-editing.test.ts
// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, it, expect, afterEach } from 'vitest';
import type { CellData } from '../types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let hook_result: ReturnType<typeof import('../webview/use-editing').use_editing> | null = null;

function cell(raw: string): CellData {
    return { raw, formatted: raw, bold: false, italic: false };
}

const rows: (CellData | null)[][] = [
    [cell('a'), cell('b'), cell('c')],
    [cell('d'), cell('e'), cell('f')],
    [cell('g'), null, cell('i')],
];

function TestComponent({ rows }: { rows: (CellData | null)[][] }) {
    const { use_editing } = require('../webview/use-editing');
    hook_result = use_editing(rows, 3, 3);
    return null;
}

async function render() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(TestComponent, { rows }));
    });
}

afterEach(() => {
    if (root && container) {
        root.unmount();
        document.body.removeChild(container);
    }
    root = null;
    container = null;
    hook_result = null;
});

describe('use_editing', () => {
    it('starts in read-only mode', async () => {
        await render();
        expect(hook_result!.edit_mode).toBe(false);
        expect(hook_result!.editing_cell).toBe(null);
        expect(hook_result!.is_dirty).toBe(false);
    });

    it('can toggle edit mode', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        expect(hook_result!.edit_mode).toBe(true);
    });

    it('start_editing sets the active cell', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 1); });
        expect(hook_result!.editing_cell).toEqual({ row: 0, col: 1, value: 'b' });
    });

    it('start_editing on null cell uses empty string', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(2, 1); });
        expect(hook_result!.editing_cell).toEqual({ row: 2, col: 1, value: '' });
    });

    it('confirm_edit stores the dirty value', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.confirm_edit('A'); });
        expect(hook_result!.is_dirty).toBe(true);
        expect(hook_result!.dirty_cells.get('0:0')).toBe('A');
        expect(hook_result!.editing_cell).toBe(null);
    });

    it('cancel_edit does not store a dirty value', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.cancel_edit(); });
        expect(hook_result!.is_dirty).toBe(false);
        expect(hook_result!.editing_cell).toBe(null);
    });

    it('get_display_value returns dirty value when present', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.confirm_edit('A'); });
        expect(hook_result!.get_display_value(0, 0)).toBe('A');
        expect(hook_result!.get_display_value(0, 1)).toBe(null);
    });

    it('clear_dirty resets all edits', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.confirm_edit('A'); });
        await act(async () => { hook_result!.clear_dirty(); });
        expect(hook_result!.is_dirty).toBe(false);
        expect(hook_result!.dirty_cells.size).toBe(0);
    });

    it('does not allow editing when not in edit mode', async () => {
        await render();
        await act(async () => { hook_result!.start_editing(0, 0); });
        expect(hook_result!.editing_cell).toBe(null);
    });

    it('confirm_edit with unchanged value does not mark dirty', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.confirm_edit('a'); });
        expect(hook_result!.is_dirty).toBe(false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/use-editing.test.ts`
Expected: FAIL — module `../webview/use-editing` does not exist.

- [ ] **Step 3: Implement use_editing hook**

```typescript
// src/webview/use-editing.ts
import { useState, useCallback } from 'react';
import type { CellData } from '../types';

export interface EditingCell {
    row: number;
    col: number;
    value: string;
}

export function use_editing(
    rows: (CellData | null)[][],
    row_count: number,
    col_count: number
) {
    const [edit_mode, set_edit_mode] = useState(false);
    const [editing_cell, set_editing_cell] = useState<EditingCell | null>(null);
    const [dirty_cells, set_dirty_cells] = useState<Map<string, string>>(new Map());

    const is_dirty = dirty_cells.size > 0;

    const toggle_edit_mode = useCallback(() => {
        set_edit_mode(prev => !prev);
        set_editing_cell(null);
    }, []);

    const start_editing = useCallback((row: number, col: number) => {
        if (!edit_mode) return;
        const key = `${row}:${col}`;
        // Use dirty value if present, otherwise use cell raw value
        const dirty_value = dirty_cells.get(key);
        if (dirty_value !== undefined) {
            set_editing_cell({ row, col, value: dirty_value });
            return;
        }
        const cell = rows[row]?.[col];
        const value = cell !== null ? String(cell?.raw ?? '') : '';
        set_editing_cell({ row, col, value });
    }, [edit_mode, rows, dirty_cells]);

    const confirm_edit = useCallback((new_value: string) => {
        if (!editing_cell) return;
        const { row, col } = editing_cell;
        const key = `${row}:${col}`;

        // Check if the value actually changed from the original
        const cell = rows[row]?.[col];
        const original = cell !== null ? String(cell?.raw ?? '') : '';

        set_editing_cell(null);

        if (new_value === original) {
            // Value unchanged from original — remove from dirty if present
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
            next.set(key, new_value);
            return next;
        });
    }, [editing_cell, rows]);

    const cancel_edit = useCallback(() => {
        set_editing_cell(null);
    }, []);

    const clear_dirty = useCallback(() => {
        set_dirty_cells(new Map());
    }, []);

    const get_display_value = useCallback((row: number, col: number): string | null => {
        return dirty_cells.get(`${row}:${col}`) ?? null;
    }, [dirty_cells]);

    return {
        edit_mode,
        editing_cell,
        dirty_cells,
        is_dirty,
        toggle_edit_mode,
        set_edit_mode,
        start_editing,
        confirm_edit,
        cancel_edit,
        clear_dirty,
        get_display_value,
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/use-editing.test.ts`
Expected: PASS — all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/webview/use-editing.ts src/test/use-editing.test.ts
git commit -m "feat: add use_editing hook for cell edit state management"
```

---

### Task 5: Cell Editor Component

**Files:**
- Create: `src/webview/cell-editor.tsx`
- Create: `src/test/cell-editor.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/test/cell-editor.test.ts
// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, it, expect, afterEach, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
    if (root && container) {
        root.unmount();
        document.body.removeChild(container);
    }
    root = null;
    container = null;
});

async function render_editor(props: {
    value: string;
    on_confirm: (value: string) => void;
    on_cancel: () => void;
}) {
    const { CellEditor } = await import('../webview/cell-editor');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(CellEditor, props));
    });
}

describe('CellEditor', () => {
    it('renders an input with the initial value', async () => {
        await render_editor({ value: 'hello', on_confirm: vi.fn(), on_cancel: vi.fn() });
        const input = container!.querySelector('input') as HTMLInputElement;
        expect(input).not.toBeNull();
        expect(input.value).toBe('hello');
    });

    it('renders a textarea for multi-line values', async () => {
        await render_editor({ value: 'line1\nline2', on_confirm: vi.fn(), on_cancel: vi.fn() });
        const textarea = container!.querySelector('textarea') as HTMLTextAreaElement;
        expect(textarea).not.toBeNull();
        expect(textarea.value).toBe('line1\nline2');
    });

    it('calls on_confirm with the value and "down" on Enter for single-line', async () => {
        const on_confirm = vi.fn();
        await render_editor({ value: 'test', on_confirm, on_cancel: vi.fn() });
        const input = container!.querySelector('input') as HTMLInputElement;
        await act(async () => {
            input.value = 'changed';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(on_confirm).toHaveBeenCalledWith('changed', 'down');
    });

    it('calls on_cancel on Escape', async () => {
        const on_cancel = vi.fn();
        await render_editor({ value: 'test', on_confirm: vi.fn(), on_cancel });
        const input = container!.querySelector('input') as HTMLInputElement;
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        expect(on_cancel).toHaveBeenCalled();
    });

    it('calls on_confirm with value and "right" on Tab', async () => {
        const on_confirm = vi.fn();
        await render_editor({ value: 'test', on_confirm, on_cancel: vi.fn() });
        const input = container!.querySelector('input') as HTMLInputElement;
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        });
        expect(on_confirm).toHaveBeenCalledWith('test', 'right');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/test/cell-editor.test.ts`
Expected: FAIL — module `../webview/cell-editor` does not exist.

- [ ] **Step 3: Implement CellEditor component**

```tsx
// src/webview/cell-editor.tsx
import React, { useEffect, useRef, useState } from 'react';

interface CellEditorProps {
    value: string;
    on_confirm: (value: string, advance: 'down' | 'right' | 'none') => void;
    on_cancel: () => void;
}

export function CellEditor({
    value,
    on_confirm,
    on_cancel,
}: CellEditorProps): React.JSX.Element {
    const [current_value, set_current_value] = useState(value);
    const input_ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
    const is_multiline = value.includes('\n');

    useEffect(() => {
        const el = input_ref.current;
        if (el) {
            el.focus();
            el.select();
        }
    }, []);

    const handle_key_down = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            on_cancel();
            return;
        }

        if (e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            on_confirm(current_value, 'right');
            return;
        }

        if (e.key === 'Enter' && !is_multiline) {
            e.preventDefault();
            e.stopPropagation();
            on_confirm(current_value, 'down');
            return;
        }

        // For multiline: Ctrl/Cmd+Enter confirms
        if (e.key === 'Enter' && is_multiline && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            on_confirm(current_value, 'down');
            return;
        }

        // Stop propagation for all other keys to prevent table keyboard handlers
        e.stopPropagation();
    };

    const shared_props = {
        className: 'cell-editor-input',
        onKeyDown: handle_key_down,
        onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            set_current_value(e.target.value),
    };

    if (is_multiline) {
        return (
            <textarea
                ref={input_ref as React.RefObject<HTMLTextAreaElement>}
                value={current_value}
                rows={current_value.split('\n').length}
                {...shared_props}
            />
        );
    }

    return (
        <input
            ref={input_ref as React.RefObject<HTMLInputElement>}
            type="text"
            value={current_value}
            {...shared_props}
        />
    );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/cell-editor.test.ts`
Expected: PASS — all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/webview/cell-editor.tsx src/test/cell-editor.test.ts
git commit -m "feat: add CellEditor component for inline cell editing"
```

---

### Task 6: CSS for Cell Editor and Dirty Indicator

**Files:**
- Modify: `src/webview/styles.css`

- [ ] **Step 1: Add styles**

Append these styles to the end of `src/webview/styles.css`:

```css
/* Cell editing */

.cell-editor-wrapper {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 10;
}

.cell-editor-input {
    width: 100%;
    height: 100%;
    min-height: 100%;
    padding: 3px 6px;
    border: 2px solid var(--vscode-focusBorder, #007acc);
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
    outline: none;
    box-sizing: border-box;
    resize: none;
}

.data-table td.dirty-cell {
    position: relative;
}

.data-table td.dirty-cell::after {
    content: '';
    position: absolute;
    top: 2px;
    right: 2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vscode-editorWarning-foreground, #cca700);
    z-index: 3;
}

.toggle.has-unsaved {
    border-color: var(--vscode-editorWarning-foreground, #cca700);
    color: var(--vscode-editorWarning-foreground, #cca700);
}

.toggle.active.has-unsaved {
    background: var(--vscode-editorWarning-foreground, #cca700);
    border-color: var(--vscode-editorWarning-foreground, #cca700);
    color: var(--vscode-button-foreground, #fff);
}
```

- [ ] **Step 2: Verify build succeeds**

Run: `npm run build`
Expected: PASS — CSS is valid.

- [ ] **Step 3: Commit**

```bash
git add src/webview/styles.css
git commit -m "feat: add CSS for cell editor overlay and dirty indicator"
```

---

### Task 7: Wire Toolbar Edit Toggle

**Files:**
- Modify: `src/webview/toolbar.tsx:8-17` (ToolbarProps interface)
- Modify: `src/webview/toolbar.tsx:19-67` (Toolbar component)

- [ ] **Step 1: Add edit mode props and button to Toolbar**

In `src/webview/toolbar.tsx`, add new props to the `ToolbarProps` interface:

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
    edit_mode: boolean;
    is_dirty: boolean;
    on_toggle_edit_mode: () => void;
    show_edit_button: boolean;
}
```

Update the Toolbar function signature and add the Edit button at the end of the toolbar div:

```tsx
export function Toolbar({
    show_formatting,
    on_toggle_formatting,
    show_formatting_button,
    vertical_tabs,
    on_toggle_tab_orientation,
    show_vertical_tabs_button,
    auto_fit_active,
    on_toggle_auto_fit,
    edit_mode,
    is_dirty,
    on_toggle_edit_mode,
    show_edit_button,
}: ToolbarProps): React.JSX.Element {

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
            {show_edit_button && (
                <ToolbarButton
                    label="Edit"
                    active={edit_mode}
                    tooltip_text={
                        edit_mode
                            ? 'Exit edit mode.'
                            : 'Enter edit mode to modify cell values.'
                    }
                    onClick={on_toggle_edit_mode}
                    extra_class={is_dirty ? 'has-unsaved' : undefined}
                />
            )}
        </div>
    );
}
```

Update `ToolbarButton` to accept an optional `extra_class` prop:

```tsx
function ToolbarButton({
    label,
    active,
    tooltip_text,
    onClick,
    extra_class,
}: {
    label: string;
    active: boolean;
    tooltip_text: string;
    onClick: () => void;
    extra_class?: string;
}): React.JSX.Element {
```

And update the button className:

```tsx
className={`toggle ${active ? 'active' : ''} ${extra_class ?? ''}`}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: FAIL — `App` component doesn't pass the new props yet. That's expected; we'll fix it in Task 8.

- [ ] **Step 3: Commit**

```bash
git add src/webview/toolbar.tsx
git commit -m "feat: add edit mode toggle button to toolbar"
```

---

### Task 8: Wire Everything in app.tsx and table.tsx

**Files:**
- Modify: `src/webview/app.tsx`
- Modify: `src/webview/table.tsx`

- [ ] **Step 1: Add editing state to app.tsx**

Add at the top of `App()` alongside existing state (after line 34):

```typescript
const [csv_editable, set_csv_editable] = useState(false);
```

In the `workbookData` message handler (around line 63), capture the flag:

```typescript
set_csv_editable(msg.csvEditable ?? false);
```

Update the `Toolbar` JSX in both rendering paths (vertical-tabs and non-vertical-tabs) to pass the new props:

```tsx
<Toolbar
    show_formatting={show_formatting}
    on_toggle_formatting={handle_toggle_formatting}
    show_formatting_button={workbook.hasFormatting}
    vertical_tabs={vertical_tabs}
    on_toggle_tab_orientation={handle_toggle_tab_orientation}
    show_vertical_tabs_button={has_multiple_sheets}
    auto_fit_active={auto_fit_active[active_sheet_index] ?? false}
    on_toggle_auto_fit={handle_toggle_auto_fit}
    edit_mode={false}
    is_dirty={false}
    on_toggle_edit_mode={() => {}}
    show_edit_button={csv_editable}
/>
```

(We pass stubs for now — the real wiring happens in `TableWithSelection`.)

- [ ] **Step 2: Move editing state into TableWithSelection**

The editing hook needs access to the sheet data and selection. Add it inside `TableWithSelection`:

Import at top of app.tsx:
```typescript
import { use_editing } from './use-editing';
import { vscode_api } from './use-state-sync';
```

Update `TableWithSelectionProps` to include:
```typescript
interface TableWithSelectionProps {
    // ... existing props ...
    csv_editable: boolean;
    on_edit_mode_change: (edit_mode: boolean, is_dirty: boolean) => void;
}
```

Inside `TableWithSelection`, add the editing hook and wire it:

```typescript
function TableWithSelection({
    // ... existing props ...
    csv_editable,
    on_edit_mode_change,
}: TableWithSelectionProps): React.JSX.Element {
    const sel = use_selection(sheet, show_formatting);
    const editing = use_editing(sheet.rows, sheet.rowCount, sheet.columnCount);

    // Report edit mode / dirty state changes up to App
    useEffect(() => {
        on_edit_mode_change(editing.edit_mode, editing.is_dirty);
    }, [editing.edit_mode, editing.is_dirty, on_edit_mode_change]);

    // Handle Cmd+S for saving
    useEffect(() => {
        if (!editing.edit_mode) return;
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault();
                if (editing.editing_cell) {
                    // Confirm current edit first, then save
                    // The save will happen on the next render via the effect below
                }
                if (editing.is_dirty) {
                    const edits: Record<string, string> = {};
                    editing.dirty_cells.forEach((value, key) => {
                        edits[key] = value;
                    });
                    vscode_api.postMessage({ type: 'saveCsv', edits });
                    editing.clear_dirty();
                }
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [editing.edit_mode, editing.is_dirty, editing.dirty_cells, editing.editing_cell, editing.clear_dirty]);

    // Listen for saveResult
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data;
            if (msg.type === 'saveResult' && !msg.success) {
                // Save failed — edits are already cleared, but the extension showed an error
                // No action needed in the webview
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, []);
```

- [ ] **Step 3: Lift edit mode state to App for toolbar**

Instead of passing stubs, use callback state:

In `App`, add:
```typescript
const [toolbar_edit_state, set_toolbar_edit_state] = useState<{ edit_mode: boolean; is_dirty: boolean }>({ edit_mode: false, is_dirty: false });
const editing_ref = useRef<{ toggle_edit_mode: () => void }>({ toggle_edit_mode: () => {} });

const handle_edit_mode_change = useCallback((edit_mode: boolean, is_dirty: boolean) => {
    set_toolbar_edit_state({ edit_mode, is_dirty });
}, []);
```

Update Toolbar to use these:
```tsx
<Toolbar
    // ... existing props ...
    edit_mode={toolbar_edit_state.edit_mode}
    is_dirty={toolbar_edit_state.is_dirty}
    on_toggle_edit_mode={() => editing_ref.current.toggle_edit_mode()}
    show_edit_button={csv_editable}
/>
```

Pass to `TableWithSelection`:
```tsx
<TableWithSelection
    // ... existing props ...
    csv_editable={csv_editable}
    on_edit_mode_change={handle_edit_mode_change}
    editing_ref={editing_ref}
/>
```

In `TableWithSelection`, register the ref:
```typescript
useEffect(() => {
    if (editing_ref) {
        editing_ref.current = { toggle_edit_mode: editing.toggle_edit_mode };
    }
}, [editing.toggle_edit_mode, editing_ref]);
```

- [ ] **Step 4: Wire double-click and editing into table.tsx**

Add new props to `TableProps` in `table.tsx`:

```typescript
interface TableProps {
    // ... existing props ...
    editing_cell: import('./use-editing').EditingCell | null;
    dirty_cells: Map<string, string>;
    edit_mode: boolean;
    on_double_click: (row: number, col: number) => void;
    on_confirm_edit: (value: string) => void;
    on_cancel_edit: () => void;
    get_display_value: (row: number, col: number) => string | null;
}
```

Import `CellEditor`:
```typescript
import { CellEditor } from './cell-editor';
```

In the `<td>` rendering (around line 211-265), add:

1. A `onDoubleClick` handler:
```tsx
onDoubleClick={() => on_double_click(r, c)}
```

2. The dirty cell class:
```typescript
const is_dirty = dirty_cells.has(`${r}:${c}`);
// Add to class_names array:
is_dirty ? 'dirty-cell' : '',
```

3. The CellEditor overlay (inside the `<td>`, after `<RowResizeHandle>`):
```tsx
{editing_cell && editing_cell.row === r && editing_cell.col === c && (
    <div className="cell-editor-wrapper">
        <CellEditor
            value={editing_cell.value}
            on_confirm={on_confirm_edit}
            on_cancel={on_cancel_edit}
        />
    </div>
)}
```

4. Override displayed text for dirty cells (modify `CellContent` rendering):
```tsx
{editing_cell?.row === r && editing_cell?.col === c ? null : (
    <CellContent
        cell={cell}
        show_formatting={show_formatting}
        display_override={get_display_value(r, c)}
    />
)}
```

Update `CellContent` to accept a `display_override`:
```tsx
function CellContent({
    cell,
    show_formatting,
    display_override,
}: {
    cell: CellData | null;
    show_formatting: boolean;
    display_override?: string | null;
}): React.JSX.Element {
    if (!cell && !display_override) return <></>;

    const text = display_override !== null && display_override !== undefined
        ? display_override
        : show_formatting
            ? cell!.formatted
            : get_raw_cell_text(cell!.raw);

    // ... rest unchanged
```

- [ ] **Step 5: Pass editing props from TableWithSelection to Table**

In `TableWithSelection`, pass the new props:

```tsx
<Table
    // ... existing props ...
    editing_cell={editing.editing_cell}
    dirty_cells={editing.dirty_cells}
    edit_mode={editing.edit_mode}
    on_double_click={(r, c) => {
        if (editing.edit_mode) editing.start_editing(r, c);
    }}
    on_confirm_edit={(value) => editing.confirm_edit(value)}
    on_cancel_edit={() => editing.cancel_edit()}
    get_display_value={editing.get_display_value}
/>
```

- [ ] **Step 6: Handle Enter/Tab navigation after edit**

In `TableWithSelection`, wrap `on_confirm_edit` to handle cursor movement:

```typescript
const handle_confirm_edit = useCallback((value: string, advance: 'down' | 'right' | 'none') => {
    editing.confirm_edit(value);
    if (!editing.editing_cell) return;
    const { row, col } = editing.editing_cell;

    if (advance === 'down' && row < sheet.rowCount - 1) {
        sel.select_cell_at?.(row + 1, col);
        // Use setTimeout to let state settle, then start editing
        setTimeout(() => editing.start_editing(row + 1, col), 0);
    } else if (advance === 'right' && col < sheet.columnCount - 1) {
        sel.select_cell_at?.(row, col + 1);
        setTimeout(() => editing.start_editing(row, col + 1), 0);
    }
}, [editing, sel, sheet.rowCount, sheet.columnCount]);
```

This requires updating `CellEditor` to report which key confirmed:

Update `CellEditorProps`:
```typescript
interface CellEditorProps {
    value: string;
    on_confirm: (value: string, advance: 'down' | 'right' | 'none') => void;
    on_cancel: () => void;
}
```

Update key handlers in `CellEditor`:
- Enter → `on_confirm(current_value, 'down')`
- Tab → `on_confirm(current_value, 'right')`
- Ctrl+Enter (multiline) → `on_confirm(current_value, 'down')`

Update `Table` props and pass-through:
```typescript
on_confirm_edit: (value: string, advance: 'down' | 'right' | 'none') => void;
```

- [ ] **Step 7: Handle toggle-off with unsaved changes**

In `TableWithSelection`, wrap the toggle to show a dialog:

```typescript
const handle_toggle_edit_mode = useCallback(async () => {
    if (editing.edit_mode && editing.is_dirty) {
        // Can't use native confirm in webview — use a simple approach
        // Post a message to the extension to show a dialog
        // For now, implement with window.confirm as a simple solution
        // (VS Code webviews support window.confirm)
        const result = window.confirm(
            'You have unsaved changes. Do you want to save before exiting edit mode?'
        );
        if (result) {
            // Save first
            const edits: Record<string, string> = {};
            editing.dirty_cells.forEach((value, key) => {
                edits[key] = value;
            });
            vscode_api.postMessage({ type: 'saveCsv', edits });
            editing.clear_dirty();
        }
        // Whether saved or discarded, exit edit mode
        editing.clear_dirty();
        editing.toggle_edit_mode();
    } else {
        editing.toggle_edit_mode();
    }
}, [editing]);
```

Note: `window.confirm` in webviews is limited. For a proper three-way dialog, we route through the extension via `showSaveDialog` / `saveDialogResult` messages (already added in Task 3).

In `TableWithSelection`, handle the dialog flow:
```typescript
const pending_toggle_ref = useRef(false);

const handle_toggle_edit_mode = useCallback(() => {
    if (editing.edit_mode && editing.is_dirty) {
        pending_toggle_ref.current = true;
        vscode_api.postMessage({ type: 'showSaveDialog' });
    } else {
        editing.toggle_edit_mode();
    }
}, [editing]);

// Listen for dialog result
useEffect(() => {
    const handler = (event: MessageEvent) => {
        const msg = event.data;
        if (msg.type === 'saveDialogResult' && pending_toggle_ref.current) {
            pending_toggle_ref.current = false;
            if (msg.choice === 'save') {
                const edits: Record<string, string> = {};
                editing.dirty_cells.forEach((value, key) => {
                    edits[key] = value;
                });
                vscode_api.postMessage({ type: 'saveCsv', edits });
            }
            if (msg.choice !== 'cancel') {
                editing.clear_dirty();
                editing.toggle_edit_mode();
            }
        }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
}, [editing]);
```

- [ ] **Step 8: Expose select_cell from use_selection**

The `use_selection` hook already has `select_cell` internally but doesn't return it. We need it for navigating after edit. Add it to the return object in `src/webview/use-selection.ts`:

```typescript
return {
    // ... existing returns ...
    select_cell,
};
```

- [ ] **Step 9: Verify full build and type check**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS

- [ ] **Step 10: Run all tests**

Run: `npm test`
Expected: PASS — all existing tests should still pass, plus the new ones.

- [ ] **Step 11: Commit**

```bash
git add src/webview/app.tsx src/webview/table.tsx src/webview/use-selection.ts src/webview/cell-editor.tsx src/webview/use-editing.ts src/csv-panel.ts src/types.ts
git commit -m "feat: wire cell editing into table, toolbar, and app components"
```

---

### Task 9: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add Editing section to README**

After the "Selection and copy" section (around line 50), add:

```markdown
**Editing (CSV/TSV only)**
- Click the **Edit** button in the toolbar to enter edit mode
- Double-click a cell to edit its value
- **Enter** confirms and moves to the cell below; **Tab** moves right
- **Escape** cancels the current edit
- **Ctrl+S** / **Cmd+S** saves all changes back to the file
- Edited cells show a dot indicator until saved
- When exiting edit mode with unsaved changes, you're prompted to save or discard
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add CSV/TSV editing section to README"
```

---

### Task 10: End-to-End Smoke Test

**Files:** None (manual testing)

- [ ] **Step 1: Build the extension**

Run: `npm run build`
Expected: PASS

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 3: Manual smoke test**

1. Open VS Code with the extension
2. Open a CSV file → verify "Edit" button appears in toolbar
3. Open an Excel file → verify "Edit" button does NOT appear
4. Click "Edit" → enter edit mode
5. Double-click a cell → verify input appears
6. Type a new value, press Enter → verify cell updates, dirty dot shows, cursor moves down
7. Press Tab → verify cursor moves right
8. Press Escape → verify edit cancels
9. Press Cmd+S → verify file saves, dots disappear
10. Toggle edit off with unsaved changes → verify save/discard dialog appears

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address smoke test findings"
```
