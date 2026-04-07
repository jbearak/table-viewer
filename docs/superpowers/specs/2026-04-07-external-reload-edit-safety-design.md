# External Reload Edit Safety

## Problem

When a CSV/TSV file is modified externally while the user has unsaved edits in the table viewer, the extension either silently discards all edits (original behavior) or blindly preserves coordinate-keyed edits that may no longer correspond to the correct cells (initial fix). Additionally, if a reload disables CSV editing (e.g., file becomes truncated), edit mode can persist in an inconsistent state.

## Design

### Data Model: Track Base Values

Extend `dirty_cells` in `use-editing.ts` from `Map<string, string>` to `Map<string, DirtyEntry>`:

```typescript
interface DirtyEntry {
    value: string;  // The user's edited value
    base: string;   // The original cell value when the edit was made
}
```

When `confirm_edit` stores a dirty cell, it also records the cell's original value (from `rows[row][col]`) as `base`. This enables conflict detection after reloads.

### Conflict Detection on External Reload

When `rows` changes externally (not from a save-in-flight):

1. Close the active cell editor.
2. Compare each dirty entry's `base` against the corresponding cell in the new `rows`. If they differ, mark the entry as **conflicted**.
3. Expose a `conflicted_keys: Set<string>` from the hook (derived state, recomputed when `dirty_cells` or `rows` change).

### Conflict Banner

When conflicted edits exist after an external reload, show a banner in the webview:

> "File changed externally. N edit(s) may be affected — highlighted cells show conflicts."
> [Keep All] [Discard Conflicted] [Discard All]

- **Keep All**: dismiss the banner; conflicted cells retain their visual flag until individually resolved.
- **Discard Conflicted**: remove only conflicted entries from `dirty_cells`; keep clean edits.
- **Discard All**: clear all dirty cells and exit edit mode.

### Visual Treatment for Conflicted Cells

- **Normal edited cell**: existing background highlight (unchanged).
- **Conflicted edited cell**: same background highlight + distinct text color using `var(--vscode-editorWarning-foreground)` via a `.cell-conflicted` CSS class.

### Context Menu: "Discard edit"

When the user right-clicks on a cell that has a pending edit (exists in `dirty_cells`), add a **"Discard edit"** item to the context menu. Clicking it removes that cell's entry from `dirty_cells`. Works for both normal and conflicted edited cells.

Location: `src/webview/app.tsx`, after the existing "Edit cell" menu item (around line 857), conditionally added when the right-clicked cell has a dirty entry.

### csvEditable Gate

When a reload sets `csvEditable` to `false` while `edit_mode` is `true`: exit edit mode and clear dirty cells. This handles the truncation case where editing must be disabled.

Implementation: in the reload handler in `app.tsx` (around line 160), after updating `csv_editable`, check if the new value is `false` and if so call `editing.set_edit_mode(false)` and `editing.clear_dirty()`.

### Mtime Staleness Check (Already Implemented)

The `saveCsv` handler in `csv-panel.ts` already compares the file's current mtime against the mtime recorded at parse time. If the file changed externally, the save is blocked with a warning. This provides a safety net: even if the user keeps conflicted edits, they cannot be written to disk without the user re-saving after reviewing fresh data.

## Files to Modify

| File | Change |
|------|--------|
| `src/webview/use-editing.ts` | `DirtyEntry` type, base tracking in `confirm_edit`, conflict detection on rows change, `conflicted_keys` derived state, `discard_edit(key)` method, `discard_conflicted()` method |
| `src/webview/app.tsx` | Conflict banner component, "Discard edit" context menu item, csvEditable gate in reload handler |
| `src/webview/styles.css` | `.cell-conflicted` class |
| `src/webview/table.tsx` | Pass `conflicted_keys` to cell rendering, apply `.cell-conflicted` class |
| `src/types.ts` | Update `pendingEdits` type in `PerFileState` to include base values |
| `src/webview/sheet-state.ts` | Update `normalize_pending_edits` for new shape |

## Persistence

The `pendingEditsChanged` message and `PerFileState.pendingEdits` must be updated to persist the new `DirtyEntry` shape (value + base) so edits survive tab close/reopen with conflict information intact.

## Testing

- Unit test: `use_editing` returns conflicted keys when rows change under dirty cells
- Unit test: `discard_edit` removes a single dirty entry
- Unit test: `discard_conflicted` removes only conflicted entries
- Unit test: csvEditable=false clears edit mode
- Manual: edit a cell, externally modify a different cell, verify no conflict flag
- Manual: edit a cell, externally modify the same cell, verify conflict flag appears
- Manual: right-click an edited cell, verify "Discard edit" appears and works
- Build: `npm run bundle && npm run bundle:webview`
- Tests: `npm run test`
