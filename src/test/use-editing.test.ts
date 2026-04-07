// @vitest-environment jsdom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, it, expect, afterEach } from 'vitest';
import type { CellData } from '../types';
import { use_editing } from '../webview/use-editing';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let hook_result: ReturnType<typeof use_editing> | null = null;

function cell(raw: string): CellData {
    return { raw, formatted: raw, bold: false, italic: false };
}

const rows: (CellData | null)[][] = [
    [cell('a'), cell('b'), cell('c')],
    [cell('d'), cell('e'), cell('f')],
    [cell('g'), null, cell('i')],
];

function TestComponent({ rows }: { rows: (CellData | null)[][] }) {
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
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({ value: 'A', base: 'a' });
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
});

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

    it('discard_conflicted preserves active editor on non-conflicted cell', async () => {
        await render_reloadable(rows);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        // Edit cell 0:0 and confirm
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.confirm_edit('A'); });
        // Edit cell 0:1 and confirm (non-conflicted)
        await act(async () => { hook_result!.start_editing(0, 1); });
        await act(async () => { hook_result!.confirm_edit('B'); });

        // Reload: only cell 0:0 changed externally → 0:0 is conflicted, 0:1 is not
        const new_rows: (CellData | null)[][] = [
            [cell('z'), cell('b'), cell('c')],
            [cell('d'), cell('e'), cell('f')],
            [cell('g'), null, cell('i')],
        ];
        await rerender_with_rows(new_rows);

        // Now start editing a non-conflicted cell (0:2)
        await act(async () => { hook_result!.start_editing(0, 2); });
        expect(hook_result!.editing_cell).toEqual({ row: 0, col: 2, value: 'c' });

        // Discard conflicted should NOT close the active editor on the non-conflicted cell
        await act(async () => { hook_result!.discard_conflicted(); });
        expect(hook_result!.editing_cell).toEqual({ row: 0, col: 2, value: 'c' });
        // Conflicted entry removed, non-conflicted entries preserved
        expect(hook_result!.dirty_cells.has('0:0')).toBe(false);
        expect(hook_result!.dirty_cells.has('0:1')).toBe(true);
    });
});
