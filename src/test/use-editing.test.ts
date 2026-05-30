// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, afterEach } from 'vitest';
import type { CellData } from '../types';
import { clear_saved_dirty_entries, use_editing } from '../webview/use-editing';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let hook_result: ReturnType<typeof use_editing> | null = null;

function cell(raw: string): CellData {
    return { raw, formatted: raw, bold: false, italic: false };
}

const base_rows: (CellData | null)[][] = [
    [cell('a'), cell('b'), cell('c')],
    [cell('d'), cell('e'), cell('f')],
    [cell('g'), null, cell('i')],
];

// Mirrors the live consumer: read the cell's raw text from the paged cache.
// A row that is absent from `rows` (undefined entry) models a page that is NOT
// resident, and yields `undefined` — distinct from a loaded-but-blank cell ('').
function make_get_cell_raw(rows: (CellData | null)[][]) {
    return (r: number, c: number): string | undefined => {
        const row = rows[r];
        if (row === undefined) return undefined; // page not resident
        const cell = row[c];
        return cell != null ? String(cell.raw ?? '') : '';
    };
}

function Harness({ rows, token }: { rows: (CellData | null)[][]; token: number }) {
    hook_result = use_editing(make_get_cell_raw(rows), token);
    return null;
}

async function render(rows: (CellData | null)[][] = base_rows, token = 0) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(Harness, { rows, token }));
    });
}

// Simulate a data reload: swap the rows the callback reads and bump the token.
async function rerender(rows: (CellData | null)[][], token: number) {
    await act(async () => {
        root!.render(React.createElement(Harness, { rows, token }));
    });
}

afterEach(() => {
    if (root && container) {
        act(() => {
            root!.unmount();
        });
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

describe('clear_saved_dirty_entries', () => {
    it('preserves and rebases a dirty entry changed after the saved snapshot', () => {
        const current = new Map([
            ['0:0', { value: 'newer', base: 'a', base_pending: true }],
            ['0:1', { value: 'saved', base: 'b' }],
        ]);

        const next = clear_saved_dirty_entries(current, { '0:0': 'sent', '0:1': 'saved' });

        expect(next.get('0:0')).toEqual({ value: 'newer', base: 'sent' });
        expect(next.has('0:1')).toBe(false);
    });
});

// Glide opens its own overlay editor and reports edits via
// onCellEdited(location, newCell) — the location is supplied, not tracked in
// editing_cell. commit_edit is the location-based counterpart to confirm_edit.
describe('commit_edit (location-based)', () => {
    it('stores the dirty value at the given location without start_editing', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.commit_edit(0, 0, 'A'); });
        expect(hook_result!.is_dirty).toBe(true);
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({ value: 'A', base: 'a' });
    });

    it('does not mark dirty when the value equals the original', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.commit_edit(0, 0, 'a'); });
        expect(hook_result!.is_dirty).toBe(false);
    });

    it('removes an existing dirty entry when reverted to the original', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.commit_edit(0, 0, 'A'); });
        expect(hook_result!.dirty_cells.has('0:0')).toBe(true);
        await act(async () => { hook_result!.commit_edit(0, 0, 'a'); });
        expect(hook_result!.dirty_cells.has('0:0')).toBe(false);
    });

    it('clears the active editor when it matches the committed location', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.commit_edit(0, 0, 'A'); });
        expect(hook_result!.editing_cell).toBe(null);
    });

    it('stores empty base for null cells', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.commit_edit(2, 1, 'X'); });
        expect(hook_result!.dirty_cells.get('2:1')).toEqual({ value: 'X', base: '' });
    });
});

describe('conflict detection', () => {
    it('marks conflicted keys when base value changes after reload', async () => {
        await render(base_rows, 0);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.confirm_edit('A'); });

        // Simulate external reload: cell 0:0 changed from 'a' to 'z'
        const new_rows: (CellData | null)[][] = [
            [cell('z'), cell('b'), cell('c')],
            [cell('d'), cell('e'), cell('f')],
            [cell('g'), null, cell('i')],
        ];
        await rerender(new_rows, 1);

        expect(hook_result!.conflicted_keys.has('0:0')).toBe(true);
    });

    it('does not mark conflict when base value unchanged after reload', async () => {
        await render(base_rows, 0);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.confirm_edit('A'); });

        // Reload with same base values
        const new_rows: (CellData | null)[][] = [
            [cell('a'), cell('b'), cell('c')],
            [cell('d'), cell('e'), cell('f')],
            [cell('g'), null, cell('i')],
        ];
        await rerender(new_rows, 1);

        expect(hook_result!.conflicted_keys.has('0:0')).toBe(false);
    });

    it('discard_edit removes a single dirty entry', async () => {
        await render(base_rows, 0);
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
        await render(base_rows, 0);
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
        await rerender(new_rows, 1);

        expect(hook_result!.conflicted_keys.size).toBe(1);
        await act(async () => { hook_result!.discard_conflicted(); });
        expect(hook_result!.dirty_cells.size).toBe(1);
        expect(hook_result!.dirty_cells.has('0:1')).toBe(true);
    });

    it('discard_conflicted preserves active editor on non-conflicted cell', async () => {
        await render(base_rows, 0);
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
        await rerender(new_rows, 1);

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

    it('closes the active editor when the reload token changes', async () => {
        await render(base_rows, 0);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        expect(hook_result!.editing_cell).not.toBe(null);

        // External reload bumps the token: open editor closes, edit mode stays on.
        await rerender(base_rows, 1);
        expect(hook_result!.editing_cell).toBe(null);
        expect(hook_result!.edit_mode).toBe(true);
    });
});

// A "page not resident" row is modeled by a `undefined` entry in the rows array
// (see make_get_cell_raw). These tests guard against the false-conflict bug:
// get_cell_raw returning '' for an evicted page must NOT look like a changed
// on-disk value.
describe('conflict detection with non-resident pages', () => {
    // base_rows but with row 1 evicted (page not resident).
    function rows_with_row1_evicted(): (CellData | null)[][] {
        const rows: (CellData | null)[][] = [
            [cell('a'), cell('b'), cell('c')],
            // row 1 omitted via a hole — modeled as undefined below
            undefined as unknown as (CellData | null)[],
            [cell('g'), null, cell('i')],
        ];
        return rows;
    }

    it('B1: a dirty cell whose page is NOT resident is never conflicted', async () => {
        // Edit cell 1:0 (base 'd') while it is resident.
        await render(base_rows, 0);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(1, 0); });
        await act(async () => { hook_result!.confirm_edit('D'); });
        expect(hook_result!.dirty_cells.get('1:0')).toEqual({ value: 'D', base: 'd' });

        // Page for row 1 gets evicted (reload + eviction). get_cell_raw -> undefined.
        await rerender(rows_with_row1_evicted(), 1);

        expect(hook_result!.conflicted_keys.has('1:0')).toBe(false);
        expect(hook_result!.conflicted_keys.size).toBe(0);
    });

    it('B2: a dirty cell whose page IS resident with disk != base is conflicted', async () => {
        await render(base_rows, 0);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(1, 0); });
        await act(async () => { hook_result!.confirm_edit('D'); });

        // Reload: row 1 resident, on-disk 1:0 changed 'd' -> 'z'.
        const new_rows: (CellData | null)[][] = [
            [cell('a'), cell('b'), cell('c')],
            [cell('z'), cell('e'), cell('f')],
            [cell('g'), null, cell('i')],
        ];
        await rerender(new_rows, 1);

        expect(hook_result!.conflicted_keys.has('1:0')).toBe(true);
    });

    it('B3: a dirty cell whose page IS resident with disk == base is not conflicted', async () => {
        await render(base_rows, 0);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(1, 0); });
        await act(async () => { hook_result!.confirm_edit('D'); });

        await rerender(base_rows, 1);

        expect(hook_result!.conflicted_keys.has('1:0')).toBe(false);
    });

    it('B4: discard_conflicted does not drop an edit whose page is non-resident', async () => {
        await render(base_rows, 0);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(1, 0); });
        await act(async () => { hook_result!.confirm_edit('D'); });

        await rerender(rows_with_row1_evicted(), 1);

        await act(async () => { hook_result!.discard_conflicted(); });
        expect(hook_result!.dirty_cells.has('1:0')).toBe(true);
        expect(hook_result!.dirty_cells.get('1:0')).toEqual({ value: 'D', base: 'd' });
    });
});

// Old-format restore: initial_edits with plain string values (no base). When the
// cell's page is not resident at mount, base must NOT be baked in as '' (which
// would be a permanent false conflict). It must be captured against the true
// on-disk value once the page becomes resident.
describe('old-format string-edit restore (B5)', () => {
    function InitHarness({
        rows,
        token,
        initial_edits,
    }: {
        rows: (CellData | null)[][];
        token: number;
        initial_edits: Record<string, string>;
    }) {
        hook_result = use_editing(make_get_cell_raw(rows), token, initial_edits);
        return null;
    }

    async function render_init(
        rows: (CellData | null)[][],
        token: number,
        initial_edits: Record<string, string>,
    ) {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(
                React.createElement(InitHarness, { rows, token, initial_edits }),
            );
        });
    }

    async function rerender_init(
        rows: (CellData | null)[][],
        token: number,
        initial_edits: Record<string, string>,
    ) {
        await act(async () => {
            root!.render(
                React.createElement(InitHarness, { rows, token, initial_edits }),
            );
        });
    }

    it('B5: non-resident page at mount does not yield a false conflict, and works once resident', async () => {
        const initial_edits = { '1:0': 'D' };
        // Row 1 not resident at mount.
        const rows_evicted: (CellData | null)[][] = [
            [cell('a'), cell('b'), cell('c')],
            undefined as unknown as (CellData | null)[],
            [cell('g'), null, cell('i')],
        ];
        await render_init(rows_evicted, 0, initial_edits);

        // No false conflict while the page is unknown.
        expect(hook_result!.conflicted_keys.has('1:0')).toBe(false);

        // Page becomes resident, matching on-disk base 'd' — still not conflicted.
        await rerender_init(base_rows, 1, initial_edits);
        expect(hook_result!.conflicted_keys.has('1:0')).toBe(false);
    });

    it('B5: base is captured on first residency, then later external changes ARE detected', async () => {
        const initial_edits = { '1:0': 'D' };
        const rows_evicted: (CellData | null)[][] = [
            [cell('a'), cell('b'), cell('c')],
            undefined as unknown as (CellData | null)[],
            [cell('g'), null, cell('i')],
        ];
        await render_init(rows_evicted, 0, initial_edits);
        expect(hook_result!.conflicted_keys.has('1:0')).toBe(false);

        // Page first becomes resident with the true on-disk value 'd' — this is
        // captured as the base (no false conflict from a baked-in '').
        await rerender_init(base_rows, 1, initial_edits);
        expect(hook_result!.conflicted_keys.has('1:0')).toBe(false);

        // A SUBSEQUENT external change of 1:0 ('d' -> 'z') is now detected against
        // the captured base.
        const changed: (CellData | null)[][] = [
            [cell('a'), cell('b'), cell('c')],
            [cell('z'), cell('e'), cell('f')],
            [cell('g'), null, cell('i')],
        ];
        await rerender_init(changed, 2, initial_edits);
        expect(hook_result!.conflicted_keys.has('1:0')).toBe(true);
    });
});
