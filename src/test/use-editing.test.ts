// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, afterEach } from 'vitest';
import {
    dirty_entry_link_changed,
    is_strict_wire_dirty_entry,
    type CellData,
    type WorksheetTarget,
} from '../types';
import { clear_saved_dirty_entries, use_editing } from '../webview/use-editing';
import { collect_save_payload } from '../webview/csv-save-model';
import {
    create_edit_session_store,
    type EditSessionStore,
} from '../webview/edit-session-store';
import { create_history_store, type HistoryStore } from '../webview/history-store';
import {
    history_value,
    overlay_state_from_dirty_entry,
} from '../webview/history-cell-state-model';
import { plan_history_replay } from '../webview/history-replay-model';
import type { RichText } from '../cell-content';

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
    hook_result = use_editing(make_get_cell_raw(rows), token, undefined);
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
        expect(hook_result!.editing_cell).toEqual({ source_row: 0, source_col: 1, value: 'b' });
    });

    it('start_editing on null cell uses empty string', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(2, 1); });
        expect(hook_result!.editing_cell).toEqual({ source_row: 2, source_col: 1, value: '' });
    });

    it('confirm_edit stores the dirty value', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(0, 0); });
        await act(async () => { hook_result!.confirm_edit('A'); });
        expect(hook_result!.is_dirty).toBe(true);
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({
            value: 'A', base: 'a', formattingKnown: true,
        });
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
        expect(entry).toEqual({ value: 'A', base: 'a', formattingKnown: true });
    });

    it('confirm_edit stores empty base for null cells', async () => {
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(2, 1); });
        await act(async () => { hook_result!.confirm_edit('X'); });
        const entry = hook_result!.dirty_cells.get('2:1');
        expect(entry).toEqual({ value: 'X', base: '', formattingKnown: true });
    });

    it('names the open cell in source space, on a row only the source reader resolves', async () => {
        // The hook takes and reports source coordinates end to end: EditingCell's
        // fields are source_row/source_col, the store key is built from them, and
        // get_cell_raw's domain is source rows. Pin that with a reader that
        // resolves *only* source row 7 — no viewport-relative offset can reach it,
        // so a conversion sneaking back onto this path would read an unloaded row
        // and both assertions below would collapse to ''.
        const resident: (CellData | null)[][] = [];
        resident[7] = [cell('base')];
        await render(resident, 0);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.start_editing(7, 0); });
        expect(hook_result!.editing_cell).toEqual({
            source_row: 7,
            source_col: 0,
            value: 'base',
        });

        await act(async () => { hook_result!.confirm_edit('edited'); });
        expect(hook_result!.dirty_cells.get('7:0')).toEqual({
            value: 'edited',
            base: 'base',
            formattingKnown: true,
        });
        expect(hook_result!.editing_cell).toBe(null);
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
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({
            value: 'A', base: 'a', formattingKnown: true,
        });
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
        expect(hook_result!.dirty_cells.get('2:1')).toEqual({
            value: 'X', base: '', formattingKnown: true,
        });
    });
});

describe('pending edits affected by file changes', () => {
    it('retains the original and tracks the latest file value after reload', async () => {
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
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({
            value: 'A',
            base: 'a',
            formattingKnown: true,
            observedBase: { value: 'z' },
        });

        const changed_again = new_rows.map((row) => [...row]);
        changed_again[0][0] = cell('y');
        await rerender(changed_again, 2);
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({
            value: 'A',
            base: 'a',
            formattingKnown: true,
            observedBase: { value: 'y' },
        });

        await rerender(base_rows, 3);
        expect(hook_result!.conflicted_keys.has('0:0')).toBe(false);
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({
            value: 'A',
            base: 'a',
            formattingKnown: true,
        });
    });

    it('keeps original and current sides when the pending value is edited again', async () => {
        await render(base_rows, 0);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.commit_edit(0, 0, 'first pending'); });
        const changed = base_rows.map((row) => [...row]);
        changed[0][0] = cell('current file');
        await rerender(changed, 1);

        await act(async () => { hook_result!.commit_edit(0, 0, 'second pending'); });
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({
            value: 'second pending',
            base: 'a',
            formattingKnown: true,
            observedBase: { value: 'current file' },
        });

        await act(async () => { hook_result!.commit_edit(0, 0, 'a'); });
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({
            value: 'a',
            base: 'a',
            observedBase: { value: 'current file' },
            writeValue: true,
            formattingKnown: true,
        });
        expect(collect_save_payload(hook_result!.dirty_cells)).toMatchObject({
            status: 'ready',
            edits: { '0:0': 'a' },
        });
    });

    it('detects a conflict on a source row the reader resolves in isolation', async () => {
        // Durable edit keys are source-keyed, and the store splits a key and hands
        // the row component straight to get_cell_raw — so the reader's domain is
        // source rows, not display offsets. Model that with a reader that resolves
        // *only* source row 7: no display-window position is available, so a
        // conflict can only be found by passing the key's row through unchanged.
        const resident: (CellData | null)[][] = [];
        resident[7] = [cell('base')];
        await render(resident, 0);
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.commit_edit(7, 0, 'edited'); });
        expect(hook_result!.dirty_cells.has('7:0')).toBe(true);
        expect(hook_result!.dirty_cells.get('7:0')!.base).toBe('base');
        expect(hook_result!.conflicted_keys.size).toBe(0);

        // Source row 7 drifts (external change to that row).
        const drifted: (CellData | null)[][] = [];
        drifted[7] = [cell('drifted')];
        await rerender(drifted, 1);

        expect(hook_result!.conflicted_keys.has('7:0')).toBe(true);
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
        expect(hook_result!.editing_cell).toEqual({ source_row: 0, source_col: 2, value: 'c' });

        // Discard conflicted should NOT close the active editor on the non-conflicted cell
        await act(async () => { hook_result!.discard_conflicted(); });
        expect(hook_result!.editing_cell).toEqual({ source_row: 0, source_col: 2, value: 'c' });
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
        expect(hook_result!.dirty_cells.get('1:0')).toEqual({
            value: 'D', base: 'd', formattingKnown: true,
        });

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
        expect(hook_result!.dirty_cells.get('1:0')).toEqual({
            value: 'D', base: 'd', formattingKnown: true,
        });
    });
});

// Old-format restore: initial_edits with plain string values (no base). When the
// cell's page is not resident at mount, base must NOT be baked in as '' (which
// would be a permanent false conflict). It must be captured against the true
// on-disk value once the page becomes resident.
describe('old-format string-edit restore (B5)', () => {
    // The store is created outside the component, so the install happens once —
    // a re-render with the same initial_edits does NOT reinstall. That is the
    // point of hoisting the map: a remount no longer re-seeds it.
    let init_store: EditSessionStore | null = null;

    function InitHarness({
        rows,
        token,
    }: {
        rows: (CellData | null)[][];
        token: number;
    }) {
        hook_result = use_editing(
            make_get_cell_raw(rows),
            token,
            undefined,
            init_store!,
        );
        return null;
    }

    async function render_init(
        rows: (CellData | null)[][],
        token: number,
        initial_edits: Record<string, string>,
    ) {
        init_store = create_edit_session_store({ session_id: undefined }, initial_edits);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(React.createElement(InitHarness, { rows, token }));
        });
    }

    async function rerender_init(
        rows: (CellData | null)[][],
        token: number,
    ) {
        await act(async () => {
            root!.render(React.createElement(InitHarness, { rows, token }));
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
        await rerender_init(base_rows, 1);
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
        await rerender_init(base_rows, 1);
        expect(hook_result!.conflicted_keys.has('1:0')).toBe(false);

        // A SUBSEQUENT external change of 1:0 ('d' -> 'z') is now detected against
        // the captured base.
        const changed: (CellData | null)[][] = [
            [cell('a'), cell('b'), cell('c')],
            [cell('z'), cell('e'), cell('f')],
            [cell('g'), null, cell('i')],
        ];
        await rerender_init(changed, 2);
        expect(hook_result!.conflicted_keys.has('1:0')).toBe(true);
    });
});

// The map used to be seeded by a one-time useState initializer, so a changed
// edit map could only reach the hook through a remount. With a hoisted store the
// install lands in the mounted hook, and its session stamp fences off a hook
// left over from the previous session.
describe('hoisted store installs', () => {
    let session_store: EditSessionStore | null = null;
    let session_id: string | undefined;
    const mount_count = { n: 0 };

    function StoreHarness({ rows, token }: { rows: (CellData | null)[][]; token: number }) {
        // Counted in the ref body, not in useRef's argument — that argument is
        // evaluated on every render, so it would count renders, not mounts.
        const mount_ref = React.useRef<number | null>(null);
        if (mount_ref.current === null) mount_ref.current = ++mount_count.n;
        // Memoized on `rows`, mirroring production: GridShell's get_cell_raw is a
        // useCallback keyed on `version`, so it rebinds only on a page load. A
        // fresh function per render would re-run every effect that depends on it
        // and mask any missing dependency in the hook.
        const get_cell_raw = React.useMemo(() => make_get_cell_raw(rows), [rows]);
        hook_result = use_editing(
            get_cell_raw,
            token,
            session_id,
            session_store!,
        );
        return null;
    }

    async function render_store(initial_session: string | undefined) {
        session_store = create_edit_session_store({ session_id: initial_session });
        session_id = initial_session;
        mount_count.n = 0;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(React.createElement(StoreHarness, { rows: base_rows, token: 0 }));
        });
    }

    it('a changed edit map installs without a remount', async () => {
        await render_store(undefined);
        await act(async () => { hook_result!.commit_edit(0, 0, 'A'); });
        expect(Object.fromEntries(hook_result!.dirty_cells)).toEqual({
            '0:0': { value: 'A', base: 'a', formattingKnown: true },
        });
        const mounts_before = mount_count.n;

        await act(async () => {
            session_store!.install({ session_id: 'granted' }, {
                '1:1': { value: 'G', base: 'e' },
            });
        });

        expect(Object.fromEntries(hook_result!.dirty_cells)).toEqual({
            '1:1': { value: 'G', base: 'e' },
        });
        expect(mount_count.n).toBe(mounts_before);
    });

    it('drops a write from a hook still carrying the pre-install session', async () => {
        await render_store(undefined);
        await act(async () => {
            session_store!.install({ session_id: 'granted' }, {
                '1:1': { value: 'G', base: 'e' },
            });
        });

        // The hook's session_id prop hasn't caught up yet, so this write belongs
        // to the previous session and must not land in the granted one.
        await act(async () => { hook_result!.commit_edit(0, 0, 'A'); });

        expect(Object.fromEntries(hook_result!.dirty_cells)).toEqual({
            '1:1': { value: 'G', base: 'e' },
        });
    });

    it('resolves bases for an old-format map installed into the mounted hook', async () => {
        // Pre-refactor an edit map could only arrive through a remount, and a
        // remount always re-ran the base-capture effect. Now install lands in a
        // mounted hook, and get_cell_raw only rebinds on a page load — so for
        // already-resident rows nothing else would ever trigger the resolve, and
        // the entry would stay base_pending forever. That is not a cosmetic flag:
        // is_entry_conflicted short-circuits on base_pending (conflict detection
        // silently off) and collect_save_payload returns an unresolved-bases
        // blocker, so the save is refused with no way for the user to clear it.
        await render_store(undefined);

        await act(async () => {
            session_store!.install({ session_id: undefined }, { '0:0': 'A' });
        });

        expect(session_store!.has_pending_base()).toBe(false);
        expect(Object.fromEntries(hook_result!.dirty_cells)).toEqual({
            '0:0': { value: 'A', base: 'a', formattingKnown: true },
        });
    });
});

describe('use_editing — markdown syntax', () => {
    // A sheet whose A1 carries resolved rich runs ("plain **bold**"), B1 a
    // whole-cell italic, and C1 plain text with a markdown-special character.
    const rich_rows: (CellData | null)[][] = [[
        {
            raw: 'plain bold',
            formatted: 'plain bold',
            bold: false,
            italic: false,
            richText: { runs: [{ text: 'plain ' }, { text: 'bold', style: { bold: true } }] },
        },
        { raw: 'lean', formatted: 'lean', bold: false, italic: true },
        { raw: '2*3', formatted: '2*3', bold: false, italic: false },
    ]];

    function MarkdownHarness({ rows }: { rows: (CellData | null)[][] }) {
        hook_result = use_editing(make_get_cell_raw(rows), 0, undefined, undefined, {
            syntax: 'markdown',
            get_cell: (r, c) => {
                const row = rows[r];
                if (row === undefined) return undefined;
                return row[c] ?? null;
            },
        });
        return null;
    }

    async function render_markdown(rows: (CellData | null)[][] = rich_rows) {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(React.createElement(MarkdownHarness, { rows }));
        });
        await act(async () => { hook_result!.toggle_edit_mode(); });
    }

    it('opens the editor with the cell\'s markup', async () => {
        await render_markdown();
        await act(async () => { hook_result!.start_editing(0, 0); });
        expect(hook_result!.editing_cell?.value).toBe('plain **bold**');
        await act(async () => { hook_result!.start_editing(0, 1); });
        expect(hook_result!.editing_cell?.value).toBe('*lean*');
        // Plain text opens escaped, so committing it back unchanged is a revert.
        await act(async () => { hook_result!.start_editing(0, 2); });
        expect(hook_result!.editing_cell?.value).toBe('2\\*3');
    });

    it('retyping the cell\'s own markup is a revert, not an edit', async () => {
        await render_markdown();
        await act(async () => { hook_result!.commit_edit(0, 0, 'plain **bold**'); });
        expect(hook_result!.is_dirty).toBe(false);
        await act(async () => { hook_result!.commit_edit(0, 2, '2\\*3'); });
        expect(hook_result!.is_dirty).toBe(false);
    });

    it('deleting the markup is a formatting edit with explicit plain runs', async () => {
        await render_markdown();
        await act(async () => { hook_result!.commit_edit(0, 0, 'plain bold'); });
        // valueRuns carries explicit plain runs, not nothing: a bare string
        // would let the cell font re-style the text on save (see
        // committed_value_runs), silently undoing the un-bolding.
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({
            value: 'plain bold',
            base: 'plain bold',
            valueRuns: { runs: [{ text: 'plain bold' }] },
            baseRuns: { runs: [{ text: 'plain ' }, { text: 'bold', style: { bold: true } }] },
            formattingKnown: true,
        });
    });

    it('adding markup to a plain cell stores the plain projection plus runs', async () => {
        await render_markdown();
        await act(async () => { hook_result!.commit_edit(0, 2, '**6**'); });
        expect(hook_result!.dirty_cells.get('0:2')).toEqual({
            value: '6',
            base: '2*3',
            valueRuns: { runs: [{ text: '6', style: { bold: true } }] },
            formattingKnown: true,
        });
    });

    it('a dirty cell re-opens showing its committed runs as markup', async () => {
        await render_markdown();
        await act(async () => { hook_result!.commit_edit(0, 2, '**6**'); });
        await act(async () => { hook_result!.start_editing(0, 2); });
        expect(hook_result!.editing_cell?.value).toBe('**6**');
        // …and committing that spelling back keeps the same entry (no churn).
        await act(async () => { hook_result!.confirm_edit('**6**'); });
        expect(hook_result!.dirty_cells.get('0:2')?.value).toBe('6');
    });

    it('falls back to plain text when the loaded cell is unavailable', async () => {
        // Row 1 is not resident: get_cell returns undefined, so the base is the
        // raw reader's text (also undefined → ''), and commits still work.
        await render_markdown();
        await act(async () => { hook_result!.commit_edit(5, 0, 'X'); });
        expect(hook_result!.dirty_cells.get('5:0')).toEqual({ value: 'X', base: '' });
    });
});

describe('use_editing — commit_hyperlink', () => {
    const site = { kind: 'external' as const, target: 'https://example.com/' };
    const other = { kind: 'external' as const, target: 'https://other.example/' };
    const linked_rows: (CellData | null)[][] = [[
        { raw: 'site', formatted: 'site', bold: false, italic: false, hyperlink: site },
        { raw: 'plain', formatted: 'plain', bold: false, italic: false },
    ]];

    function LinkHarness({ rows }: { rows: (CellData | null)[][] }) {
        hook_result = use_editing(make_get_cell_raw(rows), 0, undefined, undefined, {
            syntax: 'markdown',
            get_cell: (r, c) => {
                const row = rows[r];
                if (row === undefined) return undefined;
                return row[c] ?? null;
            },
        });
        return null;
    }

    async function render_linked(rows: (CellData | null)[][] = linked_rows) {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(React.createElement(LinkHarness, { rows }));
        });
        await act(async () => { hook_result!.toggle_edit_mode(); });
    }

    it('a link-only change makes a link-only entry, value pinned at the base', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_hyperlink(0, 1, site); });
        expect(hook_result!.dirty_cells.get('0:1')).toEqual({
            value: 'plain', base: 'plain', link: site, baseLink: null,
        });
        expect(hook_result!.is_dirty).toBe(true);
    });

    it('clearing an existing link records null against the loaded base', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_hyperlink(0, 0, null); });
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({
            value: 'site', base: 'site', link: null, baseLink: site,
        });
    });

    it('reverting to the cell\'s own link removes the entry', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_hyperlink(0, 0, other); });
        expect(hook_result!.is_dirty).toBe(true);
        await act(async () => { hook_result!.commit_hyperlink(0, 0, site); });
        expect(hook_result!.is_dirty).toBe(false);
    });

    it('a text revert keeps a pending link change, and vice versa', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_edit(0, 1, 'renamed'); });
        await act(async () => { hook_result!.commit_hyperlink(0, 1, site); });
        expect(hook_result!.dirty_cells.get('0:1')).toEqual({
            value: 'renamed', base: 'plain', link: site, baseLink: null,
            formattingKnown: true,
        });
        // Text back to base: entry survives as link-only.
        await act(async () => { hook_result!.commit_edit(0, 1, 'plain'); });
        expect(hook_result!.dirty_cells.get('0:1')).toEqual({
            value: 'plain', base: 'plain', link: site, baseLink: null,
        });
        // Link back to base: entry gone.
        await act(async () => { hook_result!.commit_hyperlink(0, 1, null); });
        expect(hook_result!.is_dirty).toBe(false);
    });

    it('a link revert keeps a pending text change', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_hyperlink(0, 1, site); });
        await act(async () => { hook_result!.commit_edit(0, 1, 'renamed'); });
        await act(async () => { hook_result!.commit_hyperlink(0, 1, null); });
        expect(hook_result!.dirty_cells.get('0:1')).toEqual({
            value: 'renamed', base: 'plain',
            formattingKnown: true,
        });
    });

    it('re-editing a pending link keeps the original loaded base', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_hyperlink(0, 0, other); });
        await act(async () => {
            hook_result!.commit_hyperlink(0, 0, { kind: 'internal', location: 'B2' });
        });
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({
            value: 'site', base: 'site',
            link: { kind: 'internal', location: 'B2' }, baseLink: site,
        });
    });

    it('keeps choosing the original link as a real write after the file moves', async () => {
        const rows: (CellData | null)[][] = [[
            { raw: 'site', formatted: 'site', bold: false, italic: false, hyperlink: site },
        ]];
        await render_linked(rows);
        await act(async () => { hook_result!.commit_hyperlink(0, 0, other); });
        const current = { kind: 'internal' as const, location: 'Sheet2!B2' };
        rows[0][0] = {
            raw: 'site', formatted: 'site', bold: false, italic: false,
            hyperlink: current,
        };
        await act(async () => {
            root!.render(React.createElement(LinkHarness, { rows }));
        });

        await act(async () => { hook_result!.commit_hyperlink(0, 0, site); });
        const entry = hook_result!.dirty_cells.get('0:0')!;
        expect(entry).toEqual({
            value: 'site',
            base: 'site',
            link: site,
            baseLink: site,
            observedBase: { value: 'site', link: current },
        });
        expect(dirty_entry_link_changed(entry)).toBe(true);
    });

    it('flags a stale link edit as conflicted and discards it locally', async () => {
        // The source link changed under a pending link edit. Detected here,
        // not only at save time, so the cell is tinted and reachable by
        // "Discard conflicted" like any other stale edit.
        const rows: (CellData | null)[][] = [[
            { raw: 'site', formatted: 'site', bold: false, italic: false, hyperlink: site },
        ]];
        await render_linked(rows);
        await act(async () => { hook_result!.commit_hyperlink(0, 0, other); });
        expect(hook_result!.conflicted_keys.has('0:0')).toBe(false);

        rows[0][0] = {
            raw: 'site', formatted: 'site', bold: false, italic: false,
            hyperlink: { kind: 'internal', location: 'B2' },
        };
        // Re-render so the hook re-derives against the changed source.
        await act(async () => {
            root!.render(React.createElement(LinkHarness, { rows }));
        });
        expect(hook_result!.conflicted_keys.has('0:0')).toBe(true);

        await act(async () => { hook_result!.discard_conflicted(); });
        expect(hook_result!.dirty_cells.has('0:0')).toBe(false);
    });

    it('adapts an observed text side when a link dimension is added and removed', async () => {
        const rows: (CellData | null)[][] = [[
            { raw: 'plain', formatted: 'plain', bold: false, italic: false },
        ]];
        await render_linked(rows);
        await act(async () => { hook_result!.commit_edit(0, 0, 'pending'); });
        rows[0][0] = { raw: 'current', formatted: 'current', bold: false, italic: false };
        await act(async () => {
            root!.render(React.createElement(LinkHarness, { rows }));
        });

        await act(async () => { hook_result!.commit_hyperlink(0, 0, site); });
        const linked = hook_result!.dirty_cells.get('0:0')!;
        expect(linked.observedBase).toEqual({ value: 'current', link: null });
        expect(is_strict_wire_dirty_entry(linked)).toBe(true);

        await act(async () => { hook_result!.commit_hyperlink(0, 0, null); });
        const unlinked = hook_result!.dirty_cells.get('0:0')!;
        expect(unlinked.observedBase).toEqual({ value: 'current' });
        expect(is_strict_wire_dirty_entry(unlinked)).toBe(true);
    });

    it('does not flag a link edit whose row is not resident', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_hyperlink(0, 1, site); });
        // Row 9 was never loaded; an unknown cell is not a conflict.
        await act(async () => { hook_result!.commit_hyperlink(9, 0, site); });
        expect(hook_result!.conflicted_keys.has('9:0')).toBe(false);
    });
});

describe('use_editing — history capture', () => {
    const SHEET: WorksheetTarget = { sheetIndex: 0, sheetName: 'Data', worksheetId: 'rId1' };
    let history: HistoryStore | null = null;
    let capture_store: EditSessionStore | null = null;

    function CaptureHarness({ rows }: { rows: (CellData | null)[][] }) {
        const get_cell_raw = React.useMemo(() => make_get_cell_raw(rows), [rows]);
        hook_result = use_editing(get_cell_raw, 0, undefined, capture_store!, {
            capture: { worksheet: SHEET, history: history! },
        });
        return null;
    }

    async function render_capturing(rows: (CellData | null)[][] = base_rows) {
        history = create_history_store();
        capture_store = create_edit_session_store();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(React.createElement(CaptureHarness, { rows }));
        });
        await act(async () => { hook_result!.toggle_edit_mode(); });
    }

    function undo_stack() {
        return history!.snapshot().undoStack;
    }

    it('records one action per gesture, however many cells it touched', async () => {
        await render_capturing();
        await act(async () => {
            hook_result!.commit_edits([
                { source_row: 0, source_col: 0, value: 'A' },
                { source_row: 0, source_col: 1, value: 'B' },
                { source_row: 1, source_col: 0, value: 'C' },
            ], 'Paste');
        });

        expect(undo_stack()).toHaveLength(1);
        expect(undo_stack()[0].action.label).toBe('Paste');
        expect(undo_stack()[0].action.changes).toHaveLength(3);
        expect(hook_result!.dirty_cells.size).toBe(3);
    });

    it('publishes a whole batch as one notification from each store', async () => {
        await render_capturing();
        // Subscribed below React, so every intermediate map a per-cell loop
        // would have published gets counted — each one is a re-render, a
        // pendingEdits post and a host-side workspace-state write.
        let edits_published = 0;
        let history_published = 0;
        capture_store!.subscribe(() => { edits_published += 1; });
        history!.subscribe(() => { history_published += 1; });

        await act(async () => {
            hook_result!.commit_edits([
                { source_row: 0, source_col: 0, value: 'A' },
                { source_row: 0, source_col: 1, value: 'B' },
                { source_row: 1, source_col: 0, value: 'C' },
            ], 'Paste');
        });

        expect(edits_published).toBe(1);
        expect(history_published).toBe(1);
        expect(hook_result!.dirty_cells.size).toBe(3);
    });

    it('records a single typed commit', async () => {
        await render_capturing();
        await act(async () => { hook_result!.commit_edit(0, 0, 'A'); });

        expect(undo_stack()).toHaveLength(1);
        expect(undo_stack()[0].action.label).toBe('Edit cell');
        const change = undo_stack()[0].action.changes[0];
        if (change.kind !== 'cell') throw new Error('expected a cell change');
        expect(change.delta.value?.expected.content.text).toBe('a');
        expect(change.delta.value?.desired.content.text).toBe('A');
        expect(change.delta.worksheet).toEqual(SHEET);
    });

    it('records nothing for a commit that reverts to the persisted text', async () => {
        await render_capturing();
        await act(async () => { hook_result!.commit_edit(0, 0, 'a'); });

        expect(undo_stack()).toEqual([]);
        expect(hook_result!.is_dirty).toBe(false);
    });

    it('records a revert of a previous edit as leaving the overlay', async () => {
        await render_capturing();
        await act(async () => { hook_result!.commit_edit(0, 0, 'A'); });
        await act(async () => { hook_result!.commit_edit(0, 0, 'a'); });

        expect(undo_stack()).toHaveLength(2);
        const change = undo_stack()[1].action.changes[0];
        if (change.kind !== 'cell') throw new Error('expected a cell change');
        expect(change.delta.value?.mode).toBe('membership');
        expect(change.delta.value?.desired.overlay).toBe('absent');
    });

    it('transitions a twice-touched cell from its own earlier write', async () => {
        await render_capturing();
        await act(async () => {
            hook_result!.commit_edits([
                { source_row: 0, source_col: 0, value: 'A' },
                { source_row: 0, source_col: 0, value: 'B' },
            ], 'Paste');
        });

        const [first, second] = undo_stack()[0].action.changes;
        if (first.kind !== 'cell' || second.kind !== 'cell') {
            throw new Error('expected cell changes');
        }
        expect(first.delta.value?.desired.content.text).toBe('A');
        // Not 'a': the second write starts where the first one left the cell.
        expect(second.delta.value?.expected.content.text).toBe('A');
        expect(hook_result!.dirty_cells.get('0:0')?.value).toBe('B');
    });

    it('refuses a cell whose page is not resident rather than editing it blind', async () => {
        await render_capturing();
        await act(async () => {
            hook_result!.commit_edits([
                { source_row: 0, source_col: 0, value: 'A' },
                { source_row: 99, source_col: 0, value: 'B' },
            ], 'Paste');
        });

        // The resident cell moved; the one with no readable persisted side did
        // not, because an applied edit history cannot describe would let undo
        // cross an unrecorded change.
        expect(hook_result!.dirty_cells.get('0:0')?.value).toBe('A');
        expect(hook_result!.dirty_cells.has('99:0')).toBe(false);
        expect(undo_stack()[0].action.changes).toHaveLength(1);
    });

    it('ignores negative and fractional coordinates', async () => {
        await render_capturing();
        await act(async () => {
            hook_result!.commit_edits([
                { source_row: -1, source_col: 0, value: 'A' },
                { source_row: 0.5, source_col: 0, value: 'B' },
            ], 'Paste');
        });

        expect(hook_result!.dirty_cells.size).toBe(0);
        expect(undo_stack()).toEqual([]);
    });

    it('records nothing for an empty batch', async () => {
        await render_capturing();
        await act(async () => { hook_result!.commit_edits([], 'Paste'); });
        expect(undo_stack()).toEqual([]);
    });

    it('records a gesture whose cells all reverted as no action at all', async () => {
        await render_capturing();
        await act(async () => {
            hook_result!.commit_edits([
                { source_row: 0, source_col: 0, value: 'a' },
                { source_row: 0, source_col: 1, value: 'b' },
            ], 'Paste');
        });
        expect(undo_stack()).toEqual([]);
        expect(hook_result!.is_dirty).toBe(false);
    });

    it('does not capture a discard', async () => {
        await render_capturing();
        await act(async () => { hook_result!.commit_edit(0, 0, 'A'); });
        await act(async () => { hook_result!.discard_edit('0:0'); });

        // Discard capture is a later stage; until then a discard leaves the
        // history exactly as the edit left it.
        expect(undo_stack()).toHaveLength(1);
        expect(hook_result!.is_dirty).toBe(false);
    });

    it('does not capture a save-lifecycle clear', async () => {
        await render_capturing();
        await act(async () => { hook_result!.commit_edit(0, 0, 'A'); });
        await act(async () => { hook_result!.clear_dirty_saved_edits({ '0:0': 'A' }); });

        expect(undo_stack()).toHaveLength(1);
    });

    it('leaves history alone when no worksheet identity is supplied', async () => {
        // The default harness supplies neither worksheet nor history.
        await render();
        await act(async () => { hook_result!.toggle_edit_mode(); });
        await act(async () => { hook_result!.commit_edit(0, 0, 'A'); });
        expect(hook_result!.dirty_cells.get('0:0')?.value).toBe('A');
    });
});

describe('use_editing — hyperlink capture', () => {
    const SHEET: WorksheetTarget = { sheetIndex: 2, sheetName: 'Links' };
    const site = { kind: 'external' as const, target: 'https://example.com/' };
    const other = { kind: 'external' as const, target: 'https://other.example/' };
    const linked_rows: (CellData | null)[][] = [[
        { raw: 'site', formatted: 'site', bold: false, italic: false, hyperlink: site },
        { raw: 'plain', formatted: 'plain', bold: false, italic: false },
    ]];
    let history: HistoryStore | null = null;
    let link_store: EditSessionStore | null = null;

    function LinkCaptureHarness({ rows }: { rows: (CellData | null)[][] }) {
        const get_cell_raw = React.useMemo(() => make_get_cell_raw(rows), [rows]);
        hook_result = use_editing(get_cell_raw, 0, undefined, link_store!, {
            syntax: 'markdown',
            get_cell: (r, c) => {
                const row = rows[r];
                if (row === undefined) return undefined;
                return row[c] ?? null;
            },
            capture: { worksheet: SHEET, history: history! },
        });
        return null;
    }

    async function render_linked(rows: (CellData | null)[][] = linked_rows) {
        history = create_history_store();
        link_store = create_edit_session_store();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(React.createElement(LinkCaptureHarness, { rows }));
        });
        await act(async () => { hook_result!.toggle_edit_mode(); });
    }

    function only_change() {
        const stack = history!.snapshot().undoStack;
        const change = stack[stack.length - 1].action.changes[0];
        if (change.kind !== 'cell') throw new Error('expected a cell change');
        return change.delta;
    }

    it('records a link attached to an unedited cell without touching its value', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_hyperlink(0, 1, site); });

        const delta = only_change();
        // The entry it writes is the ambiguous {value: 'plain', base: 'plain',
        // link} shape; only the writer's own overlay says the value dimension
        // is not in the overlay, so undo leaves the text alone.
        expect(delta.value).toBeUndefined();
        expect(delta.hyperlink?.desired.content).toEqual(site);
        expect(delta.hyperlink?.expected.content).toBeNull();
    });

    it('records only the link when it joins an existing text edit', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_edit(0, 1, 'edited'); });
        await act(async () => { hook_result!.commit_hyperlink(0, 1, site); });

        const delta = only_change();
        // The text moved under the PREVIOUS action, so this one leaves it
        // alone — undoing the link must not also undo the typing.
        expect(delta.value).toBeUndefined();
        expect(delta.hyperlink?.desired.content).toEqual(site);
        // But the overlay it records still has the value dimension in it, so a
        // later transition off this state knows the text was edited.
        expect(delta.afterOverlay.kind === 'present'
            && delta.afterOverlay.value.kind).toBe('present');
    });

    it('records the text when a later edit joins an existing link', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_hyperlink(0, 1, site); });
        await act(async () => { hook_result!.commit_edit(0, 1, 'edited'); });

        const delta = only_change();
        expect(delta.value?.desired.content.text).toBe('edited');
        expect(delta.value?.expected.content.text).toBe('plain');
        expect(delta.hyperlink).toBeUndefined();
        expect(hook_result!.dirty_cells.get('0:1')).toEqual({
            value: 'edited', base: 'plain', link: site, baseLink: null,
            formattingKnown: true,
        });
    });

    it('records a link revert that leaves the cell entirely', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_hyperlink(0, 1, site); });
        await act(async () => { hook_result!.commit_hyperlink(0, 1, null); });

        const delta = only_change();
        expect(delta.hyperlink?.mode).toBe('membership');
        expect(hook_result!.is_dirty).toBe(false);
    });

    it('records clearing a cell\'s persisted link against that link', async () => {
        await render_linked();
        await act(async () => { hook_result!.commit_hyperlink(0, 0, null); });

        const delta = only_change();
        expect(delta.hyperlink?.expected.content).toEqual(site);
        expect(delta.hyperlink?.desired.content).toBeNull();
    });

    it('keeps a resolved no-op entry\'s value dimension in the overlay', async () => {
        // resolve_pending_bases can leave a legacy entry at {value: A, base: A}:
        // genuinely in the map — tinted, persisted, saved — while comparing
        // equal. Membership and semantic inequality are different facts, and
        // reading membership off the comparison would record a value dimension
        // leaving an overlay it never entered.
        const rich_rows: (CellData | null)[][] = [[
            linked_rows[0][0],
            {
                ...linked_rows[0][1]!,
                richText: {
                    runs: [{ text: 'plain', style: { bold: true } }],
                },
            },
        ]];
        await render_linked(rich_rows);
        await act(async () => {
            link_store!.install(
                { session_id: undefined },
                { '0:1': { value: 'plain', base: 'plain' } },
            );
        });
        await act(async () => { hook_result!.commit_hyperlink(0, 1, site); });

        const delta = only_change();
        // The durable marker disambiguates this from a link-only entry after the
        // gesture has left the hook. Its one-time metadata transition is recorded
        // so compare-and-swap sees exactly what the store now holds.
        expect(delta.value).toBeDefined();
        expect(delta.afterOverlay.kind === 'present'
            && delta.afterOverlay.value.kind).toBe('present');
        expect(link_store!.get('0:1')).toEqual({
            value: 'plain',
            base: 'plain',
            link: site,
            baseLink: null,
            retainValue: true,
        });
        const save_payload = collect_save_payload(link_store!.snapshot());
        expect(save_payload.status).toBe('ready');
        if (save_payload.status !== 'ready') throw new Error('expected ready save payload');
        expect(save_payload.edits).toEqual({});

        // Re-read through the same inference path a later undo uses. Without the
        // marker this becomes link-only and undo deletes the pre-existing entry.
        const action = history!.snapshot().undoStack.at(-1)!.action;
        const stored = overlay_state_from_dirty_entry(link_store!.get('0:1')!);
        const undone = plan_history_replay(action, 'undo', () => ({
            overlay: stored,
            persisted: history_value('plain'),
            persistedHyperlink: null,
        }));
        expect(undone.kind).toBe('plan');
        if (undone.kind !== 'plan') throw new Error('expected undo plan');
        expect(undone.writes[0]?.entry).toEqual({ value: 'plain', base: 'plain' });

        const undo_entry = undone.writes[0]!.entry!;
        const redone = plan_history_replay(action, 'redo', () => ({
            overlay: overlay_state_from_dirty_entry(undo_entry),
            persisted: history_value('plain'),
            persistedHyperlink: null,
        }));
        expect(redone.kind).toBe('plan');
        if (redone.kind !== 'plan') throw new Error('expected redo plan');
        expect(redone.writes[0]?.entry).toEqual({
            value: 'plain',
            base: 'plain',
            link: site,
            baseLink: null,
            retainValue: true,
        });
    });

    it('preserves unknown legacy formatting when the pending text is edited again', async () => {
        const rich_rows: (CellData | null)[][] = [[
            linked_rows[0][0],
            {
                ...linked_rows[0][1]!,
                richText: {
                    runs: [{ text: 'plain', style: { bold: true } }],
                },
            },
        ]];
        await render_linked(rich_rows);
        await act(async () => {
            link_store!.install(
                { session_id: undefined },
                { '0:1': { value: 'plain', base: 'plain' } },
            );
        });

        await act(async () => { hook_result!.commit_edit(0, 1, 'changed'); });

        expect(link_store!.get('0:1')).toEqual({
            value: 'changed',
            base: 'plain',
            valueRuns: { runs: [{ text: 'changed' }] },
            baseRuns: {
                runs: [{ text: 'plain', style: { bold: true } }],
            },
            formattingKnown: true,
        });
        expect(hook_result!.conflicted_keys.size).toBe(0);
    });

    it('does not promote pending-side runs into historical formatting provenance', async () => {
        const current_runs = {
            runs: [{ text: 'current', style: { bold: true as const } }],
        };
        const rows: (CellData | null)[][] = [[
            linked_rows[0][0],
            {
                raw: 'current', formatted: 'current', bold: false, italic: false,
                richText: current_runs,
            },
        ]];
        await render_linked(rows);
        await act(async () => {
            link_store!.install(
                { session_id: undefined },
                {
                    '0:1': {
                        value: 'legacy pending',
                        base: 'original',
                        observedBase: { value: 'current', runs: current_runs },
                    },
                },
            );
        });

        await act(async () => { hook_result!.commit_edit(0, 1, 'first rewrite'); });
        expect(link_store!.get('0:1')).toMatchObject({
            value: 'first rewrite',
            base: 'original',
            valueRuns: { runs: [{ text: 'first rewrite' }] },
        });
        expect(link_store!.get('0:1')?.formattingKnown).toBeUndefined();

        await act(async () => { hook_result!.commit_edit(0, 1, 'second rewrite'); });
        expect(link_store!.get('0:1')).toMatchObject({
            value: 'second rewrite',
            base: 'original',
            valueRuns: { runs: [{ text: 'second rewrite' }] },
        });
        expect(link_store!.get('0:1')?.baseRuns).toBeUndefined();
        expect(link_store!.get('0:1')?.formattingKnown).toBeUndefined();
    });

    it('tracks formatting changes after a legacy entry has an observed side', async () => {
        const bold_c = { runs: [{ text: 'c', style: { bold: true as const } }] };
        const italic_c = { runs: [{ text: 'c', style: { italic: true as const } }] };
        const rows = (runs: RichText): (CellData | null)[][] => [[
            linked_rows[0][0],
            {
                raw: 'c', formatted: 'c', bold: false, italic: false,
                richText: runs,
            },
        ]];
        await render_linked(rows(bold_c));
        await act(async () => {
            link_store!.install(
                { session_id: undefined },
                {
                    '0:1': {
                        value: 'B',
                        base: 'a',
                        observedBase: { value: 'c', runs: bold_c },
                    },
                },
            );
        });

        await act(async () => {
            root!.render(React.createElement(LinkCaptureHarness, { rows: rows(italic_c) }));
        });

        expect(link_store!.get('0:1')?.observedBase).toEqual({
            value: 'c', runs: italic_c,
        });
    });

    it('carries a value dimension written earlier in the same gesture', async () => {
        // The planner reads membership off the overlay the gesture itself left,
        // not off a value/base comparison — a formatting-only edit moves no
        // text but is genuinely a value edit.
        await render_linked();
        await act(async () => {
            hook_result!.commit_edits([{ source_row: 0, source_col: 1, value: '**plain**' }]);
        });
        await act(async () => { hook_result!.commit_hyperlink(0, 1, site); });

        expect(hook_result!.dirty_cells.get('0:1')).toEqual({
            value: 'plain',
            base: 'plain',
            valueRuns: { runs: [{ text: 'plain', style: { bold: true } }] },
            link: site,
            baseLink: null,
            formattingKnown: true,
        });
        const delta = only_change();
        expect(delta.afterOverlay.kind === 'present'
            && delta.afterOverlay.value.kind).toBe('present');
    });

    it('records several cells\' links as one action', async () => {
        await render_linked();
        await act(async () => {
            hook_result!.commit_hyperlinks([
                { source_row: 0, source_col: 0, value: other },
                { source_row: 0, source_col: 1, value: other },
            ], 'Edit hyperlinks');
        });

        const stack = history!.snapshot().undoStack;
        expect(stack).toHaveLength(1);
        expect(stack[0].action.label).toBe('Edit hyperlinks');
        expect(stack[0].action.changes).toHaveLength(2);
    });
});

describe('the history-ordering reservation', () => {
    let admitted = true;
    let session_store: EditSessionStore | null = null;

    function GateHarness({ rows }: { rows: (CellData | null)[][] }) {
        const get_cell_raw = React.useMemo(() => make_get_cell_raw(rows), [rows]);
        hook_result = use_editing(get_cell_raw, 0, 'session-1', session_store!, {
            gestures_admitted: () => admitted,
        });
        return null;
    }

    async function render_gate() {
        admitted = true;
        session_store = create_edit_session_store({ session_id: 'session-1' });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => {
            root!.render(React.createElement(GateHarness, { rows: base_rows }));
        });
        await act(async () => { hook_result!.toggle_edit_mode(); });
    }

    it('admits a gesture when nothing is replaying', async () => {
        await render_gate();
        await act(async () => { hook_result!.commit_edits([
            { source_row: 0, source_col: 0, value: 'typed' },
        ]); });
        expect(session_store!.get('0:0')?.value).toBe('typed');
    });

    it('drops a gesture that lands while a replay is in flight', async () => {
        await render_gate();
        admitted = false;
        await act(async () => { hook_result!.commit_edits([
            { source_row: 0, source_col: 0, value: 'typed' },
        ]); });
        // Dropped like a keystroke arriving with no session — not an error, and
        // not a reason to leave edit mode.
        expect(session_store!.get('0:0')).toBeUndefined();
        expect(hook_result!.edit_mode).toBe(true);
    });

    it('admits again once the replay has settled', async () => {
        await render_gate();
        admitted = false;
        await act(async () => { hook_result!.commit_edits([
            { source_row: 0, source_col: 0, value: 'lost' },
        ]); });
        admitted = true;
        await act(async () => { hook_result!.commit_edits([
            { source_row: 0, source_col: 0, value: 'kept' },
        ]); });
        expect(session_store!.get('0:0')?.value).toBe('kept');
    });

    it('drops a hyperlink gesture too, which no grid flag gates', async () => {
        // The reason this predicate lives in App rather than in GridShell's
        // `editable_cells`: the hyperlink dialog commits straight through
        // `commit_hyperlink`, consulting no per-cell editability at all. A
        // highlight round trip in flight has to close THIS path as well, or an
        // edit enters the history ahead of the highlight the user made first.
        await render_gate();
        admitted = false;
        await act(async () => {
            hook_result!.commit_hyperlink(0, 0, {
                kind: 'external',
                target: 'https://example.com/',
            });
        });
        expect(session_store!.get('0:0')).toBeUndefined();

        admitted = true;
        await act(async () => {
            hook_result!.commit_hyperlink(0, 0, {
                kind: 'external',
                target: 'https://example.com/',
            });
        });
        expect(session_store!.get('0:0')?.link).toEqual({
            kind: 'external',
            target: 'https://example.com/',
        });
    });
});
