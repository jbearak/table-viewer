---
title: CSV/TSV Cell Editing
date: 2026-04-06
status: approved
---

# CSV/TSV Cell Editing

## Overview

Add inline cell editing for CSV and TSV files in standalone table mode. Excel files remain read-only. Split preview mode remains read-only (it already has the text editor).

## Motivation

The viewer is currently read-only. Adding lightweight editing for CSV/TSV files lets users correct values without switching to a text editor, while keeping the scope intentionally simple — no formula bar, no format editing, no multi-cell paste.

## Design

### Entry Point

- Files always open read-only (current behavior, unchanged).
- A toggle button in the toolbar enables edit mode. The button only appears for CSV/TSV files.
- Toggling edit mode off with unsaved changes shows a three-way dialog: Save / Discard / Cancel.

### Cell Interaction

- **Double-click** a cell to start editing. An input appears over the cell with the raw value.
- **Enter** (no cell editor active) opens the selected cell for editing.
- **Enter** (cell editor active) confirms the edit and opens the cell below for editing.
- **Shift+Enter / Alt+Enter** inserts a line break at the cursor position. If the cell is a single-line `<input>`, it switches to a `<textarea>`.
- **Tab** confirms the edit and opens the cell to the right for editing.
- **Escape** cancels the edit (reverts to the value before this edit session).
- **Empty cells** are editable — double-clicking opens an empty input.
- **Multi-line values** use a `<textarea>` that expands to show multiple lines (CSV cells can contain newlines in quoted fields; a single-line input would lose data).
- **Edge navigation**: Enter on the last row confirms the edit without moving. Tab on the last column confirms the edit without moving.

### Dirty State Tracking

- **Per-cell markers**: Edited-but-unsaved cells display a visual indicator (small dot or subtle background tint) so the user can see what changed.
- **File-level indicator**: The edit toggle button changes appearance (e.g., color or badge) when there are unsaved changes.
- **Data structure**: Dirty state stored as `Map<"row:col", string>` in React state, where the value is the new raw string.

### Save

- **Cmd+S / Ctrl+S** while in edit mode triggers save.
- The webview sends the edits map to the extension via `postMessage`.
- The extension applies the edits to the parsed row data and re-serializes the full file as CSV or TSV (preserving the original delimiter).
- The file watcher suppresses the next file-change event to avoid a redundant reload.
- Save clears dirty state. The file stays in edit mode.

### Architecture

- No change to `CustomReadonlyEditorProvider`. The editing state lives entirely in the webview.
- The extension adds a new message handler for "write CSV/TSV to disk" that receives the edits map, applies it to the parsed data, and writes the file.
- The file watcher in `custom-editor.ts` gains a suppression flag to skip the reload triggered by the extension's own write.

### Keyboard Navigation Summary

| Key | In read-only mode | In edit mode (no cell active) | While editing a cell |
|-----|-------------------|-------------------------------|---------------------|
| Double-click | Select cell | Open cell for editing | — |
| Enter | — | — | Confirm edit, open cell below |
| Tab | — | — | Confirm edit, open cell right |
| Escape | — | — | Cancel edit |
| Arrow keys | Navigate selection | Navigate selection | — (default input behavior) |
| Cmd+S / Ctrl+S | — | Save edits to disk | Confirm current edit, save all |

## Non-Goals

- Excel file editing (`.xlsx`, `.xls`) — write support adds significant complexity
- Split preview editing — the text editor side already supports editing
- Formula support
- Multi-cell paste or fill
- Undo/redo beyond single-cell cancel (Escape)
- Auto-save

## README Update

Add an "Editing" section to the README documenting the new CSV/TSV editing capability.
