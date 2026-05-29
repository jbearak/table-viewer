import { useState, useCallback, useEffect, useRef, useMemo } from 'react';

export interface EditingCell {
    row: number;
    col: number;
    value: string;
}

export interface DirtyEntry {
    value: string;
    base: string;
    // When true, `base` has not yet been captured against a resident page (an
    // old-format string edit restored while its page was evicted). Conflict
    // detection skips such entries until the page loads and `base` is captured.
    base_pending?: boolean;
}

/**
 * Reads a cell's current persisted raw text from the paged cache. A loaded but
 * blank cell yields ''; a row whose page is NOT resident (evicted from / not yet
 * fetched into the row-loader LRU) yields `undefined`. This distinction is
 * load-bearing: conflict detection treats `undefined` as "unknown", never as a
 * changed value, so an evicted page can never produce a false conflict. The hook
 * never holds onto the full grid, so editing scales to ~1M rows; conflict
 * detection compares against {@link DirtyEntry.base}, snapshotted at edit-start,
 * so it never depends on a page that may since have been evicted.
 */
export type GetCellRaw = (row: number, col: number) => string | undefined;

function is_entry_conflicted(
    key: string,
    entry: DirtyEntry,
    get_cell_raw: GetCellRaw,
): boolean {
    // Base not yet captured (old-format restore on a non-resident page): can't
    // judge a conflict yet, so never flag.
    if (entry.base_pending) return false;
    const [r, c] = key.split(':').map(Number);
    const cur = get_cell_raw(r, c);
    // `undefined` means the page isn't resident — unknown, not a conflict.
    return cur !== undefined && cur !== entry.base;
}

/**
 * CSV edit-mode state machine, decoupled from any concrete grid. Cells are read
 * through {@link GetCellRaw} (the paged cache) rather than a materialized array.
 * `reload_token` is an opaque counter the consumer bumps whenever the underlying
 * data reloads (external file change or our own save-triggered reload); a change
 * closes the open editor while preserving dirty edits, and conflict detection
 * then flags any entry whose base drifted.
 */
export function use_editing(
    get_cell_raw: GetCellRaw,
    reload_token: number,
    initial_edits?: Record<string, string | DirtyEntry>,
) {
    const [edit_mode, set_edit_mode] = useState(
        () => initial_edits !== undefined && Object.keys(initial_edits).length > 0,
    );
    const [editing_cell, set_editing_cell] = useState<EditingCell | null>(null);
    const [dirty_cells, set_dirty_cells] = useState<Map<string, DirtyEntry>>(
        () =>
            initial_edits
                ? new Map(
                      Object.entries(initial_edits).map(([k, v]) => {
                          if (typeof v === 'object' && v !== null)
                              return [k, v as DirtyEntry];
                          // Old-format string entry: capture the base from the
                          // current cell. If the page isn't resident yet
                          // (undefined), defer capture — baking in '' would be a
                          // permanent false conflict. base_pending is resolved by
                          // the effect below once the page loads.
                          const [r, c] = k.split(':').map(Number);
                          const cur = get_cell_raw(r, c);
                          return cur === undefined
                              ? [k, { value: v, base: '', base_pending: true }]
                              : [k, { value: v, base: cur }];
                      }),
                  )
                : new Map(),
    );

    const is_dirty = dirty_cells.size > 0;

    const toggle_edit_mode = useCallback(() => {
        set_edit_mode((prev) => !prev);
        set_editing_cell(null);
    }, []);

    const begin_editing = useCallback(
        (row: number, col: number) => {
            const key = `${row}:${col}`;
            const dirty_entry = dirty_cells.get(key);
            if (dirty_entry !== undefined) {
                set_editing_cell({ row, col, value: dirty_entry.value });
                return;
            }
            set_editing_cell({ row, col, value: get_cell_raw(row, col) ?? '' });
        },
        [get_cell_raw, dirty_cells],
    );

    const start_editing = useCallback(
        (row: number, col: number) => {
            if (!edit_mode) return;
            begin_editing(row, col);
        },
        [edit_mode, begin_editing],
    );

    // Like start_editing but bypasses the edit_mode check.
    // Used when entering edit mode and starting editing in the same tick.
    const force_start_editing = useCallback(
        (row: number, col: number) => {
            begin_editing(row, col);
        },
        [begin_editing],
    );

    const confirm_edit = useCallback(
        (new_value: string) => {
            if (!editing_cell) return;
            const { row, col } = editing_cell;
            const key = `${row}:${col}`;
            // begin-edit/commit always run on a resident, visible cell, so a
            // definite string is expected; coalesce defensively.
            const original = get_cell_raw(row, col) ?? '';

            set_editing_cell(null);

            if (new_value === original) {
                set_dirty_cells((prev) => {
                    if (!prev.has(key)) return prev;
                    const next = new Map(prev);
                    next.delete(key);
                    return next;
                });
                return;
            }

            set_dirty_cells((prev) => {
                const next = new Map(prev);
                next.set(key, { value: new_value, base: original });
                return next;
            });
        },
        [editing_cell, get_cell_raw],
    );

    // Location-based commit for Glide, whose overlay editor reports edits via
    // onCellEdited(location, newCell). Unlike confirm_edit it doesn't rely on
    // editing_cell, but it still clears the open editor if it happens to match.
    const commit_edit = useCallback(
        (row: number, col: number, new_value: string) => {
            const key = `${row}:${col}`;
            const original = get_cell_raw(row, col) ?? '';

            set_editing_cell((prev) =>
                prev && prev.row === row && prev.col === col ? null : prev,
            );

            if (new_value === original) {
                set_dirty_cells((prev) => {
                    if (!prev.has(key)) return prev;
                    const next = new Map(prev);
                    next.delete(key);
                    return next;
                });
                return;
            }

            set_dirty_cells((prev) => {
                const next = new Map(prev);
                next.set(key, { value: new_value, base: original });
                return next;
            });
        },
        [get_cell_raw],
    );

    const cancel_edit = useCallback(() => {
        set_editing_cell(null);
    }, []);

    const clear_dirty = useCallback(() => {
        set_dirty_cells(new Map());
    }, []);

    const clear_dirty_keys = useCallback((keys: Set<string>) => {
        set_dirty_cells((prev) => {
            const next = new Map(prev);
            for (const key of keys) next.delete(key);
            return next;
        });
    }, []);

    const get_display_value = useCallback(
        (row: number, col: number): string | null => {
            const entry = dirty_cells.get(`${row}:${col}`);
            return entry?.value ?? null;
        },
        [dirty_cells],
    );

    const discard_edit = useCallback(
        (key: string) => {
            if (editing_cell && `${editing_cell.row}:${editing_cell.col}` === key) {
                set_editing_cell(null);
            }
            set_dirty_cells((prev) => {
                if (!prev.has(key)) return prev;
                const next = new Map(prev);
                next.delete(key);
                return next;
            });
        },
        [editing_cell],
    );

    const discard_conflicted = useCallback(() => {
        if (editing_cell) {
            const active_key = `${editing_cell.row}:${editing_cell.col}`;
            const active_entry = dirty_cells.get(active_key);
            if (
                active_entry &&
                is_entry_conflicted(active_key, active_entry, get_cell_raw)
            ) {
                set_editing_cell(null);
            }
        }
        set_dirty_cells((prev) => {
            const next = new Map<string, DirtyEntry>();
            for (const [key, entry] of prev) {
                if (!is_entry_conflicted(key, entry, get_cell_raw)) {
                    next.set(key, entry);
                }
            }
            return next;
        });
    }, [get_cell_raw, editing_cell, dirty_cells]);

    // Resolve deferred bases for old-format restores: once a pending entry's page
    // becomes resident, capture its true on-disk value as the base. Runs whenever
    // get_cell_raw's identity changes (the consumer rebinds it as pages load).
    useEffect(() => {
        set_dirty_cells((prev) => {
            let changed = false;
            const next = new Map<string, DirtyEntry>();
            for (const [key, entry] of prev) {
                if (entry.base_pending) {
                    const [r, c] = key.split(':').map(Number);
                    const cur = get_cell_raw(r, c);
                    if (cur !== undefined) {
                        next.set(key, { value: entry.value, base: cur });
                        changed = true;
                        continue;
                    }
                }
                next.set(key, entry);
            }
            return changed ? next : prev;
        });
    }, [get_cell_raw]);

    const conflicted_keys = useMemo(() => {
        const keys = new Set<string>();
        for (const [key, entry] of dirty_cells) {
            if (is_entry_conflicted(key, entry, get_cell_raw)) {
                keys.add(key);
            }
        }
        return keys;
    }, [dirty_cells, get_cell_raw]);

    // Flag set before posting saveCsv so consumers can distinguish save-triggered
    // reloads from external file changes.
    const save_in_flight_ref = useRef(false);

    // Close any open editor when the data reloads (token bump) — whether from our
    // own save or an external change. Dirty edits are preserved either way so the
    // user never silently loses unsaved work; conflict detection then flags any
    // entry whose base drifted.
    const prev_token_ref = useRef(reload_token);
    useEffect(() => {
        if (prev_token_ref.current !== reload_token && edit_mode) {
            set_editing_cell(null);
        }
        prev_token_ref.current = reload_token;
    }, [reload_token, edit_mode]);

    // Read the live value from the active cell's editor. Glide portals our custom
    // overlay editor into `.gdg-clip-region`; fall back to the committed value if
    // the overlay isn't mounted (e.g. between renders).
    const get_active_editor_value = useCallback((): string | null => {
        if (!editing_cell) return null;
        const el = document.querySelector(
            '.gdg-clip-region textarea, .gdg-clip-region input',
        ) as HTMLInputElement | HTMLTextAreaElement | null;
        return el ? el.value : editing_cell.value;
    }, [editing_cell]);

    return {
        edit_mode,
        editing_cell,
        dirty_cells,
        is_dirty,
        toggle_edit_mode,
        set_edit_mode,
        start_editing,
        force_start_editing,
        confirm_edit,
        commit_edit,
        cancel_edit,
        clear_dirty,
        clear_dirty_keys,
        save_in_flight_ref,
        get_display_value,
        get_active_editor_value,
        conflicted_keys,
        discard_edit,
        discard_conflicted,
    };
}
