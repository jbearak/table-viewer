// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, afterEach } from 'vitest';
import type { CellData } from '../types';
import { clear_saved_dirty_entries, use_editing } from '../webview/use-editing';
import {
    create_edit_session_store,
    type EditSessionStore,
} from '../webview/edit-session-store';

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
            '0:0': { value: 'A', base: 'a' },
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
            '0:0': { value: 'A', base: 'a' },
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

    it('deleting the markup is a formatting edit with runs and baseRuns', async () => {
        await render_markdown();
        await act(async () => { hook_result!.commit_edit(0, 0, 'plain bold'); });
        expect(hook_result!.dirty_cells.get('0:0')).toEqual({
            value: 'plain bold',
            base: 'plain bold',
            baseRuns: { runs: [{ text: 'plain ' }, { text: 'bold', style: { bold: true } }] },
        });
    });

    it('adding markup to a plain cell stores the plain projection plus runs', async () => {
        await render_markdown();
        await act(async () => { hook_result!.commit_edit(0, 2, '**6**'); });
        expect(hook_result!.dirty_cells.get('0:2')).toEqual({
            value: '6',
            base: '2*3',
            valueRuns: { runs: [{ text: '6', style: { bold: true } }] },
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
