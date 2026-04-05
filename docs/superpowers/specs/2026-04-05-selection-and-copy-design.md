# Selection & Copy for Table Viewer

## Summary

Add cell selection, keyboard navigation, right-click context menu, and clipboard copy to the read-only table viewer VS Code extension. All logic lives in the webview — no extension host changes needed.

## Non-Goals

- Editing cells (cut, paste-to-edit)
- Persisting selection state across reloads
- Multi-sheet selection

## Selection Model

Selection is a rectangular range: `{start_row, start_col, end_row, end_col}` plus an **anchor cell** (where the selection originated). This single representation covers:

- **Single cell click:** start and end are the same cell
- **Click-drag:** start is mousedown position, end is mouseup position
- **Shift+click:** extends from anchor to clicked cell
- **Column select:** full column (start_row=0, end_row=last)
- **Row select:** full row (start_col=0, end_col=last)
- **Select all (Cmd+A):** entire sheet

**Merged cells:** When a selection intersects a merged region, the selection expands to include the full merge range. Clicking any part of a merged cell selects the whole merged cell.

Selection state is ephemeral — not persisted to extension state.

## Keyboard Navigation

The table container gets `tabIndex={0}` and gains focus on cell click.

| Key | Action |
|-----|--------|
| Arrow keys / `h` `j` `k` `l` | Move active cell (clears selection to single cell) |
| Shift + Arrow / Shift + `h` `j` `k` `l` | Extend selection from anchor |
| Cmd+A | Select all cells in current sheet |
| Cmd+C | Copy current selection to clipboard |
| Escape | Clear selection |
| Tab / Shift+Tab | Move active cell right/left |

Arrow/vim navigation skips hidden cells in merged regions — landing on a merged cell selects the merge anchor. Moving past a merge lands on the first non-hidden cell after it.

## Context Menu

Custom React component positioned at mouse cursor on right-click. Menu items adapt to context:

**Menu items (always shown):**
- Copy cell — copies right-clicked cell value as plain text
- Select row — selects full row of right-clicked cell
- Select column — selects full column of right-clicked cell
- Select all — selects entire sheet

**Conditional:**
- Copy selection — shown only when a multi-cell selection exists; copies range as TSV

**Behavior:**
- Right-clicking within an existing selection preserves it
- Right-clicking outside the selection moves selection to that cell
- Dismissed on: click outside, Escape, scroll
- Viewport-clamped positioning (shifts if it would overflow)
- Styled with VS Code theme variables

## Clipboard Format

| Context | Format |
|---------|--------|
| Single cell | Plain text: `cell.formatted` (or `String(cell.raw)` when formatting is off) |
| Multi-cell range | TSV: rows separated by `\n`, cells by `\t` |
| Column copy | TSV (same as range, spanning all rows) |

Uses `navigator.clipboard.writeText()` in the webview.

**Merged cells in range:** Value appears at top-left position only. Other cells in the merge export as empty strings, preserving rectangular grid shape for correct spreadsheet paste.

Respects the `show_formatting` toggle — copies formatted values when on, raw values when off.

## Selection Visual Style

Spreadsheet-style: selected cells get a light background tint (`rgba` of VS Code focus color at ~15% opacity) plus a 2px border in `--vscode-focusBorder` color. The anchor/active cell gets a solid 2px border (no background change beyond the selection tint) to distinguish it from other selected cells which only have the tinted background.

## Component Architecture

### New files

- **`src/webview/use-selection.ts`** — Custom hook managing selection state, keyboard handlers, and clipboard logic. Exports:
  - Selection range state
  - Mouse event handlers: `on_cell_mouse_down`, `on_cell_mouse_move`, `on_cell_mouse_up`
  - Keyboard handler: `on_key_down`
  - `copy_selection()` function
  - Context menu trigger state

- **`src/webview/context-menu.tsx`** — `ContextMenu` component. Receives position, menu items, and callbacks. Renders a positioned div with click handlers. Includes dismiss-on-outside-click and dismiss-on-Escape logic.

### Modified files

- **`src/webview/table.tsx`** — Receives selection state and event handlers as props. Each `<td>` gets mouse and context menu handlers. Selected cells get a `selected` CSS class. Table container gets `tabIndex={0}` and `onKeyDown`.

- **`src/webview/app.tsx`** — Calls `use_selection` hook, passes selection props to `Table`, renders `ContextMenu` when active. Passes `show_formatting` and sheet data to hook for clipboard formatting.

- **`src/webview/styles.css`** — New rules for `.selected` cells, `.active-cell` indicator, context menu styling, and table container focus outline.

### Unchanged

No changes to extension host (`custom-editor.ts`), types (`types.ts`), parsers, or state persistence.
