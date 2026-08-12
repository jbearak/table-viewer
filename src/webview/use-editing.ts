import { useState, useCallback, useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { read_overlay_editor_value } from './live-editor';
import {
    create_edit_session_store,
    is_entry_conflicted,
    type EditSessionStore,
    type GetCellRaw,
} from './edit-session-store';
import type { CsvDirtyEntry } from '../types';

// Re-exported so consumers keep importing the edit vocabulary from the hook they
// already use; the definitions moved to the store because it, not the hook, owns
// the map now.
export type { DirtyEntry, GetCellRaw } from './edit-session-store';
export { clear_saved_dirty_entries } from './edit-session-store';

/**
 * The cell this hook currently has an editor open on, in **source** space — the
 * same space as the store's keys, so `${source_row}:${source_col}` is a durable
 * edit key and needs no conversion.
 *
 * There is deliberately no display coordinate here. Every consumer of this
 * struct either builds a store key from it or reads the cell through
 * {@link GetCellRaw}, and both of those are source-keyed; the only thing that
 * ever wants a display position is the visible cursor, which Glide owns (see
 * grid-shell's `onCellEdited` / `provideEditor` path). A second field for the
 * display row would be an unread copy that still had to be kept in step with a
 * sort, which is precisely the aliasing this PR removes.
 */
export interface EditingCell {
    source_row: number;
    source_col: number;
    value: string;
}

/**
 * CSV edit-mode state machine, decoupled from any concrete grid. Cells are read
 * through {@link GetCellRaw} (the paged cache) rather than a materialized array.
 * `reload_token` is an opaque counter the consumer bumps whenever the underlying
 * data reloads (external file change or our own save-triggered reload); a change
 * closes the open editor while preserving dirty edits, and conflict detection
 * then flags any entry whose base drifted.
 *
 * The dirty map lives in `store`, whose lifetime is the edit session rather than
 * this hook's mount, and `session_id` stamps every write so a hook left over
 * from a previous session cannot land an edit in the current one. A consumer
 * that has nowhere to hoist the store to (the hook's own tests, and GridShell
 * before App wires one down) gets a hook-owned one instead.
 */
export function use_editing(
    get_cell_raw: GetCellRaw,
    reload_token: number,
    session_id: string | undefined,
    store?: EditSessionStore,
) {
    const own_store_ref = useRef<EditSessionStore | null>(null);
    // Only when no store was handed down, matching GridShell's fallback: building
    // one anyway would allocate a map per mount that nothing ever reads.
    if (store === undefined && own_store_ref.current === null) {
        // No identity: a hook-owned store lives and dies with this hook, so there
        // is no other writer for a session stamp to fence off, and stamping the
        // first render's session would strand this hook's own later writes if the
        // id moved. A hoisted store is where the stamp earns its keep.
        own_store_ref.current = create_edit_session_store();
    }
    const active_store = store ?? own_store_ref.current!;

    // useSyncExternalStore rather than the useReducer bump pattern that
    // use-row-loader.ts uses: that loader is owned by the hook, so nothing can
    // change the source of truth between render and subscribe. Here App can
    // install into the store while GridShell is mid-remount — the session grant
    // does exactly that (set_initial_edits + set_load_epoch in one handler).
    // useSyncExternalStore re-reads after subscribing; a hand-rolled useEffect
    // subscribe + bump would silently drop that install.
    const dirty_cells = useSyncExternalStore(active_store.subscribe, active_store.snapshot);

    // GridShell never reads this (it takes edit_mode as a prop from App), so it
    // only gates the reload-token effect below.
    const [edit_mode, set_edit_mode] = useState(() => active_store.size() > 0);
    // Stays local state on purpose: it names a cell whose editor is open right
    // now, and an editor cannot outlive the mount that opened it. Source-keyed
    // (see EditingCell), so a generation remount clears it for lifetime reasons
    // rather than because the coordinate went stale.
    const [editing_cell, set_editing_cell] = useState<EditingCell | null>(null);

    const is_dirty = dirty_cells.size > 0;

    const toggle_edit_mode = useCallback(() => {
        set_edit_mode((prev) => !prev);
        set_editing_cell(null);
    }, []);

    // Every coordinate below is a source coordinate. The store's keys, the
    // GetCellRaw reader and EditingCell all live in source space, so nothing on
    // this path converts — and a caller holding a display row must convert
    // before it arrives (grid-shell does that in `commit_source_row`).
    const begin_editing = useCallback(
        (source_row: number, source_col: number) => {
            const key = `${source_row}:${source_col}`;
            const dirty_entry = dirty_cells.get(key);
            if (dirty_entry !== undefined) {
                set_editing_cell({ source_row, source_col, value: dirty_entry.value });
                return;
            }
            set_editing_cell({
                source_row,
                source_col,
                value: get_cell_raw(source_row, source_col) ?? '',
            });
        },
        [get_cell_raw, dirty_cells],
    );

    const start_editing = useCallback(
        (source_row: number, source_col: number) => {
            if (!edit_mode) return;
            begin_editing(source_row, source_col);
        },
        [edit_mode, begin_editing],
    );

    // Like start_editing but bypasses the edit_mode check.
    // Used when entering edit mode and starting editing in the same tick.
    const force_start_editing = useCallback(
        (source_row: number, source_col: number) => {
            begin_editing(source_row, source_col);
        },
        [begin_editing],
    );

    const confirm_edit = useCallback(
        (new_value: string) => {
            if (!editing_cell) return;
            const { source_row, source_col } = editing_cell;
            const key = `${source_row}:${source_col}`;
            // begin-edit/commit always run on a resident, visible cell, so a
            // definite string is expected; coalesce defensively.
            const original = get_cell_raw(source_row, source_col) ?? '';

            set_editing_cell(null);

            // The revert rule lives here rather than in the store: only the hook
            // can read the cell's persisted text.
            if (new_value === original) {
                active_store.remove(session_id, key);
                return;
            }

            active_store.commit(session_id, key, { value: new_value, base: original });
        },
        [active_store, editing_cell, get_cell_raw, session_id],
    );

    // Location-based commit for Glide, whose overlay editor reports edits via
    // onCellEdited(location, newCell). Unlike confirm_edit it doesn't rely on
    // editing_cell, but it still clears the open editor if it happens to match.
    // The caller resolves Glide's display row to a source row first, so both
    // arguments are already source coordinates here.
    const commit_edit = useCallback(
        (source_row: number, source_col: number, new_value: string) => {
            const key = `${source_row}:${source_col}`;
            const original = get_cell_raw(source_row, source_col) ?? '';

            set_editing_cell((prev) =>
                prev && prev.source_row === source_row && prev.source_col === source_col
                    ? null
                    : prev,
            );

            if (new_value === original) {
                active_store.remove(session_id, key);
                return;
            }

            active_store.commit(session_id, key, { value: new_value, base: original });
        },
        [active_store, get_cell_raw, session_id],
    );

    const cancel_edit = useCallback(() => {
        set_editing_cell(null);
    }, []);

    const clear_dirty = useCallback(() => {
        active_store.clear(session_id);
    }, [active_store, session_id]);

    const replace_dirty = useCallback((entries: Readonly<Record<string, CsvDirtyEntry>>) => {
        active_store.replace(session_id, entries);
    }, [active_store, session_id]);

    const clear_dirty_keys = useCallback((keys: Set<string>) => {
        active_store.remove_keys(session_id, keys);
    }, [active_store, session_id]);

    const clear_dirty_saved_edits = useCallback((edits: Record<string, string>) => {
        active_store.clear_saved(session_id, edits);
    }, [active_store, session_id]);

    // The dirty value of a cell named in source space — the "display" in the name
    // is the *rendered text* it should show, not a display coordinate.
    const get_display_value = useCallback(
        (source_row: number, source_col: number): string | null => {
            const entry = dirty_cells.get(`${source_row}:${source_col}`);
            return entry?.value ?? null;
        },
        [dirty_cells],
    );

    const discard_edit = useCallback(
        (key: string) => {
            if (
                editing_cell
                && `${editing_cell.source_row}:${editing_cell.source_col}` === key
            ) {
                set_editing_cell(null);
            }
            active_store.remove(session_id, key);
        },
        [active_store, editing_cell, session_id],
    );

    const discard_conflicted = useCallback(() => {
        if (editing_cell) {
            const active_key =
                `${editing_cell.source_row}:${editing_cell.source_col}`;
            const active_entry = dirty_cells.get(active_key);
            if (
                active_entry &&
                is_entry_conflicted(active_key, active_entry, get_cell_raw)
            ) {
                set_editing_cell(null);
            }
        }
        active_store.retain(
            session_id,
            (key, entry) => !is_entry_conflicted(key, entry, get_cell_raw),
        );
    }, [active_store, get_cell_raw, editing_cell, dirty_cells, session_id]);

    // Resolve deferred bases for old-format restores: once a pending entry's page
    // becomes resident, capture its true on-disk value as the base. Runs whenever
    // get_cell_raw's identity changes (the consumer rebinds it as pages load) and
    // whenever the map itself changes.
    //
    // `dirty_cells` is a real dependency, not defensive padding. An old-format
    // string map can now be installed into a *mounted* hook (a same-generation
    // refresh while editing), where get_cell_raw does not rebind because no page
    // loaded. Without this dep the pending entries would never be resolved for
    // already-resident rows: is_entry_conflicted short-circuits on base_pending,
    // so conflict detection would be silently off, and collect_save_payload
    // would keep refusing the save with no user-reachable way to clear it.
    useEffect(() => {
        // Hot-path guard: nothing pending means nothing to resolve, so skip the
        // Map rebuild + rescan entirely. get_cell_raw rebinds on every page load
        // and every commit produces a new map, so without this the effect would
        // re-run on every scroll and every keystroke.
        if (!active_store.has_pending_base()) return;
        active_store.resolve_pending_bases(session_id, get_cell_raw);
    }, [active_store, get_cell_raw, session_id, dirty_cells]);

    const conflicted_keys = useMemo(() => {
        const keys = new Set<string>();
        for (const [key, entry] of dirty_cells) {
            if (is_entry_conflicted(key, entry, get_cell_raw)) {
                keys.add(key);
            }
        }
        return keys;
    }, [dirty_cells, get_cell_raw]);

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
        const live = read_overlay_editor_value(document);
        return live !== null ? live : editing_cell.value;
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
        replace_dirty,
        clear_dirty_keys,
        clear_dirty_saved_edits,
        get_display_value,
        get_active_editor_value,
        conflicted_keys,
        discard_edit,
        discard_conflicted,
    };
}
