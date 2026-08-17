import { useState, useCallback, useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { read_overlay_editor_value } from './live-editor';
import {
    create_edit_session_store,
    is_entry_conflicted,
    type DirtyEntry,
    type EditSessionStore,
    type GetCellRaw,
    type StoreWrite,
} from './edit-session-store';
import {
    copy_dirty_entry,
    dirty_entry_value_changed,
    make_dirty_entry,
    type CsvDirtyEntry,
    type WorksheetTarget,
} from '../types';
import {
    begin_gesture_capture,
    type PersistedCellHistoryState,
} from './history-capture-model';
import {
    absent_overlay,
    combined_overlay,
    history_value,
    hyperlink_only_overlay,
    overlay_state_from_dirty_entry,
    value_only_overlay,
    type CellOverlayState,
} from './history-cell-state-model';
import type { HistoryStore } from './history-store';
import { hyperlinks_equal, type CellHyperlink } from '../cell-content';
import {
    cell_edit_base,
    cell_edits_equal,
    committed_value_runs,
    dirty_value_edit_text,
    edit_display_text,
    parse_cell_edit,
    type EditableSourceCell,
    type EditSyntax,
    type ParsedCellEdit,
} from '../cell-edit-model';

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
/** Markdown-mode wiring, absent for plain (CSV) consumers. */
export interface UseEditingOptions {
    /** How this sheet's cells are edited. Defaults to 'plain'. */
    readonly syntax?: EditSyntax;
    /**
     * The full loaded cell by source coordinates, for markdown mode only:
     * edit text and conflict bases derive from the cell's effective rich
     * content, which the plain-text reader cannot carry. Same residency
     * contract as {@link GetCellRaw} (`null` = resident-but-blank,
     * `undefined` = not resident).
     */
    readonly get_cell?: (source_row: number, col: number) => EditableSourceCell | null | undefined;
    /**
     * Which sheet these edits belong to. Recorded on every history change, so
     * an undo can find its way back to the sheet the edit was made on — the
     * history is workbook-wide and its entries have to say where they landed.
     */
    readonly worksheet?: WorksheetTarget;
    /**
     * The workbook's history. Capture is on only when this and `worksheet` are
     * both supplied, so the hook's own tests and any consumer with no workbook
     * around it keep working unchanged, editing without recording.
     */
    readonly history?: HistoryStore;
}

/** One cell's new text, in source space. */
export interface CellValueEdit {
    readonly source_row: number;
    readonly source_col: number;
    readonly value: string;
}

/** One cell's new whole-cell hyperlink, or `null` to clear it. */
export interface CellHyperlinkEdit {
    readonly source_row: number;
    readonly source_col: number;
    readonly value: CellHyperlink | null;
}

/**
 * A planned write: the entry to store, plus the overlay it MEANS.
 *
 * The overlay travels alongside because the entry alone cannot express it —
 * `{value: 'A', base: 'A', link}` is written by two different intents that undo
 * differently (see `ValueDimensionIntent`). The planner knows which one it just
 * made, so it says, rather than leaving capture to guess with `'infer'`.
 */
interface PlannedOverlayWrite {
    readonly entry: DirtyEntry | undefined;
    readonly overlay: CellOverlayState;
}

/**
 * What a text commit should leave in the store — decided, not applied.
 *
 * Pure so a batch can plan every cell of a paste before any of them mutates:
 * a gesture is one transaction, and a half-applied paste is not a state the
 * user ever asked for. The revert rule lives here rather than in the store
 * because only this layer can read the cell's persisted content.
 */
function plan_value_write(
    before_entry: DirtyEntry | undefined,
    input: string,
    base: ParsedCellEdit,
    syntax: EditSyntax,
): PlannedOverlayWrite {
    const parsed = parse_cell_edit(input, syntax);
    // A pending link change is its own dimension: a text revert must not
    // discard it, and a text commit must carry it forward.
    const link_dimension = before_entry?.link !== undefined
        ? { link: before_entry.link, baseLink: before_entry.baseLink ?? null }
        : undefined;
    const base_value = history_value(base.text, base.rich);

    // Semantic comparison: retyping a bold cell's own `**markup**`, however
    // spelled, is a revert; deleting the `**` is an edit.
    if (cell_edits_equal(parsed, base)) {
        if (link_dimension === undefined) {
            return { entry: undefined, overlay: absent_overlay() };
        }
        // Text reverted, link still pending: the entry survives as link-only,
        // its value dimension back at the base — and `link-only` is exactly
        // what the overlay has to say, since the entry it writes is the
        // ambiguous `{value: A, base: A, link}` shape.
        return {
            entry: make_dirty_entry(
                base.text, base.text, base.rich, base.rich,
                link_dimension.link, link_dimension.baseLink,
            ),
            overlay: hyperlink_only_overlay(
                base_value, link_dimension.link, link_dimension.baseLink,
            ),
        };
    }

    // Explicit plain runs when the user stripped a styled base's markup — see
    // committed_value_runs.
    const value_runs = committed_value_runs(parsed, base);
    const entry = make_dirty_entry(
        parsed.text, base.text, value_runs, base.rich,
        link_dimension?.link, link_dimension?.baseLink,
    );
    const value = history_value(parsed.text, value_runs);
    return {
        entry,
        overlay: link_dimension === undefined
            ? value_only_overlay(value, base_value)
            : combined_overlay(
                value, base_value, link_dimension.link, link_dimension.baseLink,
            ),
    };
}

/**
 * What a hyperlink commit should leave in the store.
 *
 * `persisted_link` is the cell's link on disk. The base recorded is the already
 * pending `baseLink` when there is one, never the pending value, so re-editing
 * one cell's link keeps a single honest conflict base.
 */
function plan_hyperlink_write(
    before_entry: DirtyEntry | undefined,
    next: CellHyperlink | null,
    base: ParsedCellEdit,
    persisted_link: CellHyperlink | null,
): PlannedOverlayWrite {
    const base_link = before_entry?.link !== undefined
        ? before_entry.baseLink ?? null
        : persisted_link;
    const value_changed = before_entry !== undefined && dirty_entry_value_changed(before_entry);
    const base_value = history_value(base.text, base.rich);

    if (hyperlinks_equal(next, base_link)) {
        // Link reverted. Drop the dimension, keep any value change.
        if (!value_changed) return { entry: undefined, overlay: absent_overlay() };
        const entry = copy_dirty_entry(before_entry!, { link: undefined, baseLink: undefined });
        return {
            entry,
            overlay: value_only_overlay(
                history_value(entry.value, entry.valueRuns),
                history_value(entry.base, entry.baseRuns),
            ),
        };
    }

    if (before_entry !== undefined) {
        const entry = copy_dirty_entry(before_entry, { link: next, baseLink: base_link });
        const value = history_value(entry.value, entry.valueRuns);
        // The value dimension's intent survives from the entry being extended:
        // a cell whose value never moved keeps a link-only value dimension even
        // as its link changes, so undo does not restore text it never wrote.
        return {
            entry,
            overlay: value_changed
                ? combined_overlay(
                    value, history_value(entry.base, entry.baseRuns), next, base_link,
                )
                : hyperlink_only_overlay(value, next, base_link),
        };
    }

    // Link-only entry: value dimension pinned at the base text.
    return {
        entry: make_dirty_entry(base.text, base.text, base.rich, base.rich, next, base_link),
        overlay: hyperlink_only_overlay(base_value, next, base_link),
    };
}

export function use_editing(
    get_cell_raw: GetCellRaw,
    reload_token: number,
    session_id: string | undefined,
    store?: EditSessionStore,
    options?: UseEditingOptions,
) {
    const syntax: EditSyntax = options?.syntax ?? 'plain';
    const get_cell = options?.get_cell;
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

    // The cell's conflict base in edit space: its effective rich content when
    // the loaded cell is available in markdown mode, else the plain raw text.
    // The fallback matters even in markdown mode — `get_cell_raw` layers the
    // in-flight save's values over residency, which `get_cell` cannot see, so
    // the raw reader stays the authority on the *text* and the loaded cell
    // only contributes styling.
    /**
     * The cell's persisted link, for conflict detection. Only markdown-mode
     * consumers supply `get_cell`, which is also the only place link edits can
     * be made, so the reader is absent exactly when there are no links to
     * check. `null` distinguishes a resident linkless cell from a
     * non-resident row (`undefined`), which is what keeps an evicted page from
     * reading as a conflict.
     */
    const get_cell_link = useMemo(
        () => (get_cell
            ? (source_row: number, col: number) => {
                const cell = get_cell(source_row, col);
                return cell === undefined ? undefined : cell?.hyperlink ?? null;
            }
            : undefined),
        [get_cell],
    );

    const edit_base_at = useCallback(
        (source_row: number, source_col: number): ParsedCellEdit => {
            const raw = get_cell_raw(source_row, source_col) ?? '';
            if (syntax === 'markdown') {
                const cell = get_cell?.(source_row, source_col);
                if (cell && (cell.raw ?? '') === raw) return cell_edit_base(cell);
            }
            return { text: raw };
        },
        [get_cell_raw, get_cell, syntax],
    );

    // Every coordinate below is a source coordinate. The store's keys, the
    // GetCellRaw reader and EditingCell all live in source space, so nothing on
    // this path converts — and a caller holding a display row must convert
    // before it arrives (grid-shell does that in `commit_source_row`).
    const begin_editing = useCallback(
        (source_row: number, source_col: number) => {
            const key = `${source_row}:${source_col}`;
            const dirty_entry = dirty_cells.get(key);
            if (dirty_entry !== undefined) {
                // A dirty markdown cell re-opens showing its stored runs as
                // markup, so what the user last committed is what they resume
                // editing — spelled canonically, which the revert rule accepts.
                set_editing_cell({
                    source_row,
                    source_col,
                    value: dirty_value_edit_text(dirty_entry, syntax),
                });
                return;
            }
            set_editing_cell({
                source_row,
                source_col,
                value: edit_display_text(edit_base_at(source_row, source_col), syntax),
            });
        },
        [edit_base_at, dirty_cells, syntax],
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

    // Capture needs both: a history to record into, and the sheet identity to
    // record. Consumers without a workbook around them (the hook's own tests,
    // GridShell before App wires one down) edit exactly as before, unrecorded.
    const worksheet = options?.worksheet;
    const history = options?.history;
    const capturing = worksheet !== undefined && history !== undefined;

    /**
     * The cell's state on disk — the side of an undo transition the overlay is
     * an edit ON TOP OF.
     *
     * `undefined` when the page is not resident, and the caller must then refuse
     * that cell rather than mutate it. `edit_base_at`'s `?? ''` fallback is fine
     * for opening an editor, where a wrong base only means the user retypes; as
     * a history base it would fabricate the missing side, and undo would write
     * an empty cell over content it never saw.
     */
    const persisted_history_state_at = useCallback(
        (source_row: number, source_col: number): PersistedCellHistoryState | undefined => {
            const raw = get_cell_raw(source_row, source_col);
            if (raw === undefined) return undefined;
            if (syntax !== 'markdown') {
                // CSV and TSV cannot carry an editable whole-cell hyperlink, so
                // `null` here is a known persisted state rather than a guess.
                return { value: history_value(raw), hyperlink: null };
            }
            const cell = get_cell?.(source_row, source_col);
            if (cell === undefined) return undefined;
            // Same rich-text consistency rule as `edit_base_at`: the loaded cell
            // contributes styling only while its plain projection still agrees
            // with the raw reader, which sees an in-flight save's values.
            if (cell !== null && (cell.raw ?? '') === raw) {
                const base = cell_edit_base(cell);
                return {
                    value: history_value(base.text, base.rich),
                    hyperlink: cell.hyperlink ?? null,
                };
            }
            return { value: history_value(raw), hyperlink: cell?.hyperlink ?? null };
        },
        [get_cell_raw, get_cell, syntax],
    );

    /**
     * Apply one gesture: plan every cell, then swap the edits and the history
     * recording together.
     *
     * The transaction is the point. Looping over `commit`/`remove` would publish
     * each cell of a paste separately — a re-render, a pendingEdits post and a
     * host-side workspace-state write per cell — and would leave a half-applied
     * gesture visible if anything after the first cell refused. Planning is
     * pure and total: it reads state and produces every write or none.
     *
     * `plan` returns the store entry AND the overlay it means, per cell. The
     * overlay is what capture records; nothing here re-derives one from the
     * entry, because the entry cannot express the difference.
     */
    const run_edit_gesture = useCallback(
        <T extends { readonly source_row: number; readonly source_col: number }>(
            edits: readonly T[],
            label: string,
            plan: (
                edit: T,
                before_entry: DirtyEntry | undefined,
                persisted: PersistedCellHistoryState | undefined,
            ) => PlannedOverlayWrite | undefined,
        ): void => {
            if (edits.length === 0) return;
            const writes: StoreWrite[] = [];
            const gesture = begin_gesture_capture();
            // The store as this gesture found it, plus what the gesture has
            // written so far: a paste whose target overlaps a cell it already
            // wrote has to plan against its own earlier write, not against the
            // state the batch began in.
            const working = new Map<string, DirtyEntry | undefined>();

            for (const edit of edits) {
                const { source_row, source_col } = edit;
                if (!Number.isInteger(source_row) || source_row < 0) continue;
                if (!Number.isInteger(source_col) || source_col < 0) continue;
                const key = `${source_row}:${source_col}`;
                const persisted = persisted_history_state_at(source_row, source_col);
                // Capture cannot represent a cell with no persisted side, so
                // that cell does not move either — an applied edit history could
                // not describe would let undo cross an unrecorded change.
                if (capturing && persisted === undefined) continue;
                const before_entry = working.has(key) ? working.get(key) : active_store.get(key);

                const planned = plan(edit, before_entry, persisted);
                if (planned === undefined) continue;

                writes.push({ key, entry: planned.entry });
                working.set(key, planned.entry);

                if (!capturing || persisted === undefined) continue;
                gesture.record(key, {
                    worksheet,
                    sourceRow: source_row,
                    sourceColumn: source_col,
                    // The exact overlay an earlier write in this gesture left,
                    // when there was one; otherwise what the store holds, read
                    // with `'infer'` because its writer's intent is long gone.
                    before: gesture.overlay_at(key)
                        ?? (before_entry === undefined
                            ? absent_overlay()
                            : overlay_state_from_dirty_entry(before_entry)),
                    after: planned.overlay,
                    persisted,
                });
            }

            const staged_writes = active_store.stage_writes(session_id, writes);
            // The session moved on: this hook's writes belong to a session that
            // is no longer current, so nothing lands and nothing is recorded.
            if (staged_writes === undefined) return;
            const staged_record = capturing
                ? history.stage_record(gesture.action(label))
                : undefined;

            // Validate both before moving either: committing the edits and then
            // finding the history unrecordable would leave the two out of step.
            if (!staged_writes.valid()) return;
            if (staged_record !== undefined && !staged_record.valid()) return;

            staged_writes.commit();
            // A refusal commits too — its state is the barrier, and by decision
            // an oversized gesture stays applied with the history cleared behind
            // it rather than being rejected.
            staged_record?.commit();
            staged_writes.notify();
            staged_record?.notify();
        },
        [active_store, capturing, history, persisted_history_state_at, session_id, worksheet],
    );

    /**
     * Commit new text into cells: one gesture, one history action.
     *
     * Parses each editor's text in the sheet's syntax and reverts a cell whose
     * text means the same thing as its persisted content, otherwise stores the
     * plain projection plus runs when styled.
     */
    const commit_edits = useCallback(
        (edits: readonly CellValueEdit[], label = 'Edit cell'): void => {
            run_edit_gesture(edits, label, (edit, before_entry) => plan_value_write(
                before_entry,
                edit.value,
                edit_base_at(edit.source_row, edit.source_col),
                syntax,
            ));
        },
        [run_edit_gesture, edit_base_at, syntax],
    );

    /**
     * Commit whole-cell hyperlink changes (dialog output): a link to set, or
     * null to clear. Reverting to a cell's current link removes the link
     * dimension — and the whole entry when no value change remains.
     */
    const commit_hyperlinks = useCallback(
        (edits: readonly CellHyperlinkEdit[], label = 'Edit hyperlink'): void => {
            run_edit_gesture(edits, label, (edit, before_entry, persisted) => {
                const loaded_link = persisted !== undefined
                    ? persisted.hyperlink
                    : get_cell?.(edit.source_row, edit.source_col)?.hyperlink ?? null;
                return plan_hyperlink_write(
                    before_entry,
                    edit.value,
                    edit_base_at(edit.source_row, edit.source_col),
                    loaded_link,
                );
            });
        },
        [run_edit_gesture, edit_base_at, get_cell],
    );

    const commit_hyperlink = useCallback(
        (source_row: number, source_col: number, next: CellHyperlink | null) => {
            commit_hyperlinks([{ source_row, source_col, value: next }]);
        },
        [commit_hyperlinks],
    );

    const confirm_edit = useCallback(
        (new_value: string) => {
            if (!editing_cell) return;
            const { source_row, source_col } = editing_cell;
            set_editing_cell(null);
            commit_edits([{ source_row, source_col, value: new_value }]);
        },
        [editing_cell, commit_edits],
    );

    // Location-based commit for Glide, whose overlay editor reports edits via
    // onCellEdited(location, newCell). Unlike confirm_edit it doesn't rely on
    // editing_cell, but it still clears the open editor if it happens to match.
    // The caller resolves Glide's display row to a source row first, so both
    // arguments are already source coordinates here.
    const commit_edit = useCallback(
        (source_row: number, source_col: number, new_value: string) => {
            set_editing_cell((prev) =>
                prev && prev.source_row === source_row && prev.source_col === source_col
                    ? null
                    : prev,
            );
            commit_edits([{ source_row, source_col, value: new_value }]);
        },
        [commit_edits],
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
                is_entry_conflicted(active_key, active_entry, get_cell_raw, get_cell_link)
            ) {
                set_editing_cell(null);
            }
        }
        active_store.retain(
            session_id,
            (key, entry) => !is_entry_conflicted(key, entry, get_cell_raw, get_cell_link),
        );
    }, [active_store, get_cell_raw, get_cell_link, editing_cell, dirty_cells, session_id]);

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
            if (is_entry_conflicted(key, entry, get_cell_raw, get_cell_link)) {
                keys.add(key);
            }
        }
        return keys;
    }, [dirty_cells, get_cell_raw, get_cell_link]);

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
        commit_edits,
        commit_hyperlink,
        commit_hyperlinks,
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
