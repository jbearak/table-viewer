/**
 * The dirty-edit map, owned by the **edit session** rather than by the grid
 * generation. GridShell is keyed on `${sheet}:${load_epoch}:${generation}`
 * (app.tsx), and `generation` bumps on every applied transform and refresh
 * snapshot, so a map living inside the grid's hooks is destroyed by events that
 * have nothing to do with the edit session. App holds this store instead and
 * hands it down; the hook is a view over it.
 *
 * Deliberately React-free and row-space-agnostic: keys arrive fully formed from
 * the hook, so the store has no opinion about whether the row component is a
 * display row or a source row. That is what keeps the source-row rekey out of
 * this file entirely.
 */

import type { CsvDirtyEntry } from '../types';

export interface DirtyEntry extends CsvDirtyEntry {
    // When true, `base` has not yet been captured against a resident page (an
    // old-format string edit restored while its page was evicted). Conflict
    // detection skips such entries until the page loads and `base` is captured.
    base_pending?: boolean;
}

/**
 * Reads a cell's current persisted raw text from the paged cache, addressed by
 * **canonical source row** — the same row space durable edit keys are in, which
 * is what lets this store stay row-space-agnostic: it splits a key and hands the
 * row component straight here, and the two agree by construction.
 *
 * A loaded but blank cell yields ''; a source row that is NOT resident yields
 * `undefined` — its page was evicted from (or never fetched into) the row-loader
 * LRU, or the row is filtered out of the current view entirely. This distinction
 * is load-bearing: conflict detection treats `undefined` as "unknown", never as a
 * changed value, so a non-resident row can never produce a false conflict. The
 * hook never holds onto the full grid, so editing scales to ~1M rows; conflict
 * detection compares against {@link DirtyEntry.base}, snapshotted at edit-start,
 * so it never depends on a page that may since have been evicted.
 */
export type GetCellRaw = (source_row: number, col: number) => string | undefined;

export function clear_saved_dirty_entries(
    dirty: ReadonlyMap<string, DirtyEntry>,
    saved: Readonly<Record<string, string>>,
): Map<string, DirtyEntry> {
    const next = new Map(dirty);
    for (const [key, value] of Object.entries(saved)) {
        const entry = next.get(key);
        if (!entry) continue;
        if (entry.value === value) next.delete(key);
        else next.set(key, { value: entry.value, base: value });
    }
    return next;
}

export function is_entry_conflicted(
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

export interface EditSessionIdentity {
    /** Host-granted session id. `undefined` is a real, distinct value (edits
     *  restored without a grant — app.tsx sets edit_mode from
     *  `restored_edits !== undefined` with no session), compared with ===,
     *  never treated as a wildcard.
     *
     *  Sheet index is deliberately *not* part of the identity: the sheet split
     *  lives outside the store, in the registry's `Map<sheet_index, store>`,
     *  so a store never spans more than one worksheet and its keys stay in one
     *  sheet's `row:col` space. */
    readonly session_id: string | undefined;
}

export interface EditSessionStore {
    // reads
    /** Copy-on-write: identical reference until the next mutation, so it is a
     *  valid useSyncExternalStore getSnapshot. */
    snapshot(): ReadonlyMap<string, DirtyEntry>;
    subscribe(listener: () => void): () => void;
    /** The stamped session, or null for a store that has never been given one. */
    identity(): EditSessionIdentity | null;
    /** Single-key read for the Glide hot paths, which must not take the
     *  subscribed value. */
    get(key: string): DirtyEntry | undefined;
    size(): number;
    /** Read imperatively, never subscribed: the base-capture effect's early
     *  return must cost one field read (get_cell_raw rebinds every page load). */
    has_pending_base(): boolean;

    // identity boundary
    /**
     * Cross a hydration boundary: replace the whole map and stamp the session it
     * belongs to. A string-valued entry is normalized to a base_pending entry
     * (see {@link create_edit_session_store}).
     */
    install(identity: EditSessionIdentity, edits?: Record<string, string | DirtyEntry>): void;
    /**
     * Re-stamp the session without touching contents, the pending-base flag, or
     * any listener. The stamp guards against a *stale writer* — a hook mounted
     * under a previous session — but it must never strand a *current* writer
     * against a lagging stamp. The host advances `csvEditSessionId` on every
     * applied snapshot while an install happens only for the current session, so
     * the id can legitimately move with no install behind it; attributing the
     * retained map to the newly adopted session is exactly what the unchanged
     * `initial_edits` prop used to do by re-seeding across that transition.
     */
    adopt_session(session_id: string | undefined): void;

    // mutators; each dropped when session_id !== the stamp
    /**
     * Takes a fully-formed entry rather than `(row, col, value)`: key
     * construction and base capture stay in the hook, so the store never has to
     * know which row space the key is in.
     *
     * The revert rule stays in the hook too — "new value equals the original ⇒
     * delete" needs `get_cell_raw`, so the hook calls {@link remove} or
     * {@link commit} accordingly.
     */
    commit(session_id: string | undefined, key: string, entry: CsvDirtyEntry): void;
    remove(session_id: string | undefined, key: string): void;
    remove_keys(session_id: string | undefined, keys: ReadonlySet<string>): void;
    clear(session_id: string | undefined): void;
    /**
     * Replace the whole map, carrying each entry's `base_pending` across. The
     * save-lifecycle restore path round-trips the live map back through here
     * (`resolve_csv_save_hydration` filters entries but preserves the objects),
     * so entries arriving with the flag still set have a placeholder `base` of
     * `''`. Dropping the flag would promote that placeholder to a real base:
     * conflict detection would start comparing against `''` and a save would be
     * admitted with a base the user never saw, instead of being held back by
     * `collect_exact_dirty_edits`.
     */
    replace(
        session_id: string | undefined,
        entries: Readonly<Record<string, CsvDirtyEntry & { base_pending?: boolean }>>,
    ): void;
    /**
     * Filter in place by an arbitrary predicate. Exists so `discard_conflicted`'s
     * predicate ({@link is_entry_conflicted} against `get_cell_raw`) stays
     * outside the store — page residency is the loader's concern, not the
     * session's.
     */
    retain(session_id: string | undefined, keep: (key: string, entry: DirtyEntry) => boolean): void;
    clear_saved(session_id: string | undefined, saved: Readonly<Record<string, string>>): void;
    /** Capture true bases for base_pending entries whose page became resident.
     *  Notifies only when something changed. */
    resolve_pending_bases(session_id: string | undefined, get_cell_raw: GetCellRaw): void;
}

function normalize(
    edits: Record<string, string | DirtyEntry> | undefined,
): { entries: Map<string, DirtyEntry>; pending_base: boolean } {
    const entries = new Map<string, DirtyEntry>();
    let pending_base = false;
    for (const [key, value] of Object.entries(edits ?? {})) {
        if (typeof value === 'object' && value !== null) {
            entries.set(key, value);
            // A restored entry can itself still be pending (an install that
            // round-trips a not-yet-resolved map back through the prop).
            if (value.base_pending) pending_base = true;
            continue;
        }
        // Old-format string entry: defer base capture uniformly. Baking in a
        // base now would risk a permanent false conflict when the page isn't
        // resident; resolve_pending_bases captures the true base once the page
        // loads.
        pending_base = true;
        entries.set(key, { value, base: '', base_pending: true });
    }
    return { entries, pending_base };
}

/**
 * Value-equality for two dirty maps, used only to decide whether a mutation is a
 * no-op worth notifying about. O(size) worst case and allocation-free per entry:
 * the notification it suppresses is the expensive thing, so this must not itself
 * cost a copy, a stringify, or a Set per call — it runs on every keystroke.
 *
 * Sizes first, then one pass over `next` looking each key up in `prev`. That is a
 * complete comparison, not a one-directional one: equal sizes plus "every key of
 * `next` is present in `prev` with equal fields" means the pass found `next.size`
 * distinct keys of `prev`, i.e. all of them. A key in `prev` and not in `next`
 * would force some key of `next` to be absent from `prev` and fail the lookup.
 * So there is nothing to catch with a second loop the other way — please don't
 * add one and make this O(n^2).
 *
 * `base_pending` is compared as a boolean, not by ===: normalize/replace write
 * the flag only when true, so `{value, base}` and `{value, base, base_pending:
 * false}` are the same entry and absent/undefined/false must all compare equal.
 */
function entries_equal(
    prev: ReadonlyMap<string, DirtyEntry>,
    next: ReadonlyMap<string, DirtyEntry>,
): boolean {
    if (prev === next) return true;
    if (prev.size !== next.size) return false;
    for (const [key, entry] of next) {
        const before = prev.get(key);
        if (before === undefined) return false;
        if (before === entry) continue;
        if (before.value !== entry.value || before.base !== entry.base) return false;
        if (!!before.base_pending !== !!entry.base_pending) return false;
    }
    return true;
}

export function create_edit_session_store(
    identity?: EditSessionIdentity,
    edits?: Record<string, string | DirtyEntry>,
): EditSessionStore {
    let stamp: EditSessionIdentity | null = identity ?? null;
    let state = normalize(edits);
    const listeners = new Set<() => void>();

    const notify = (): void => {
        // Copy first: a listener may unsubscribe during the walk.
        for (const listener of [...listeners]) listener();
    };

    // The pending-base flag lives here rather than in the hook because a
    // generation remount no longer re-runs an install: a hook-local ref would
    // reset to false while base_pending entries remain, and both consequences
    // are silent — is_entry_conflicted would never flag a real external change,
    // and collect_exact_dirty_edits (csv-save-model.ts) would refuse the save
    // forever with "Load every edited row before saving…", with no path out.

    // The stamp rejects a write from a hook that mounted under an earlier
    // session. A store that has never crossed a hydration boundary has no
    // session to be stale relative to, so it accepts writes from anyone.
    const owns = (session_id: string | undefined): boolean =>
        stamp === null || stamp.session_id === session_id;

    // `force_notify` exists for `install` alone: see the call site for why a
    // hydration boundary notifies even when it changes nothing.
    const set_entries = (
        entries: Map<string, DirtyEntry>,
        pending_base: boolean,
        force_notify = false,
    ): void => {
        // Every mutator funnels through here, so this one guard covers all of
        // them: an identical-value commit, a clear on an empty map, remove_keys
        // matching nothing, a retain that keeps everything, a clear_saved that
        // matches nothing. Each of those used to run the whole downstream chain —
        // a React re-render via useSyncExternalStore, two Object.fromEntries over
        // the dirty map in grid-shell, a postMessage, a host-side structuredClone
        // and an async workspace-state write, which always bumps a CAS revision
        // because the host's handler spreads into a fresh object and so never
        // hits its own no-change shortcut. Not saved here: the candidate map the
        // mutator already built above, which is why correctness (not that copy)
        // is what this guard is for.
        //
        // A pendingEdits write also clears the host's failed-save tombstone and
        // retires the save lifecycle, so a no-op post is not purely wasted work.
        // This guard does not fully close that: a failed save also re-installs,
        // and install force-notifies below, so one post still gets through. See
        // the plan doc's PR 1b section for the follow-ups (both live in files
        // outside this one).
        if (!force_notify && pending_base === state.pending_base
            && entries_equal(state.entries, entries)) {
            // Deliberately keep the *existing* map rather than swapping in the
            // equal candidate. The two are interchangeable by value, so holding
            // the old one keeps `snapshot()` reference-stable across a no-op —
            // strictly better than a new-but-equal reference, which
            // useSyncExternalStore would tolerate but would still treat as a
            // change at the next unrelated render. It also means the store never
            // adopts a map (or entry objects) built by the caller on this path,
            // so no aliasing is introduced; the candidate is simply dropped.
            return;
        }
        state = { entries, pending_base };
        notify();
    };

    // Recompute the flag from what actually survived. The mutators that only ever
    // drop entries (remove, remove_keys, clear, retain, clear_saved) previously
    // carried the old flag forward, leaving it stuck `true` after the last pending
    // entry was gone. That is self-healing rather than incorrect — no reader
    // treats the flag as authority, the save gate reads per-entry `base_pending` —
    // but a stale `true` defeats the hot-path guard in use-editing's base-capture
    // effect, so it re-ran the scan on every page load and every keystroke for the
    // rest of the session. Cheap to keep honest: these paths already walk or copy
    // the map. Only ever narrows, never sets the flag where it was false.
    const set_entries_recomputed = (entries: Map<string, DirtyEntry>): void => {
        if (!state.pending_base) {
            set_entries(entries, false);
            return;
        }
        let pending_base = false;
        for (const entry of entries.values()) {
            if (entry.base_pending) {
                pending_base = true;
                break;
            }
        }
        set_entries(entries, pending_base);
    };

    return {
        snapshot: () => state.entries,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        identity: () => stamp,
        get: (key: string) => state.entries.get(key),
        size: () => state.entries.size,
        has_pending_base: () => state.pending_base,

        install: (next_identity, next_edits) => {
            stamp = next_identity;
            const next = normalize(next_edits);
            // Always notifies, even for an identical map. Unlike the mutators,
            // install is a hydration boundary that also re-stamps the session, so
            // "the contents didn't change" is not the same claim as "nothing that
            // a subscriber cares about changed" — and it runs once per grant or
            // restore, never on a keystroke, so there is no cost to buy by
            // guessing. The one thing suppression would definitely be safe for is
            // the map identity itself; everything else here (a fresh normalize
            // that re-stamps caller-owned entry objects into the store, a session
            // change that GridShell may already be mid-remount for) is exactly
            // the kind of boundary where a silent install would be a very quiet
            // bug. The guard exists for the hot paths; this isn't one.
            set_entries(next.entries, next.pending_base, true);
        },
        adopt_session: (session_id) => {
            stamp = { session_id };
        },

        commit: (session_id, key, entry) => {
            if (!owns(session_id)) return;
            const next = new Map(state.entries);
            next.set(key, { value: entry.value, base: entry.base });
            set_entries(next, state.pending_base);
        },
        remove: (session_id, key) => {
            if (!owns(session_id) || !state.entries.has(key)) return;
            const next = new Map(state.entries);
            next.delete(key);
            set_entries_recomputed(next);
        },
        remove_keys: (session_id, keys) => {
            if (!owns(session_id)) return;
            const next = new Map(state.entries);
            for (const key of keys) next.delete(key);
            set_entries_recomputed(next);
        },
        clear: (session_id) => {
            if (!owns(session_id)) return;
            set_entries(new Map(), false);
        },
        replace: (session_id, entries) => {
            if (!owns(session_id)) return;
            let pending_base = false;
            const next = new Map<string, DirtyEntry>();
            for (const [key, entry] of Object.entries(entries)) {
                if (entry.base_pending) {
                    pending_base = true;
                    next.set(key, { value: entry.value, base: entry.base, base_pending: true });
                    continue;
                }
                next.set(key, { value: entry.value, base: entry.base });
            }
            set_entries(next, pending_base);
        },
        retain: (session_id, keep) => {
            if (!owns(session_id)) return;
            const next = new Map<string, DirtyEntry>();
            for (const [key, entry] of state.entries) {
                if (keep(key, entry)) next.set(key, entry);
            }
            set_entries_recomputed(next);
        },
        clear_saved: (session_id, saved) => {
            if (!owns(session_id)) return;
            set_entries_recomputed(clear_saved_dirty_entries(state.entries, saved));
        },
        resolve_pending_bases: (session_id, get_cell_raw) => {
            if (!owns(session_id)) return;
            let changed = false;
            let still_pending = false;
            const next = new Map<string, DirtyEntry>();
            for (const [key, entry] of state.entries) {
                if (entry.base_pending) {
                    const [r, c] = key.split(':').map(Number);
                    const cur = get_cell_raw(r, c);
                    if (cur !== undefined) {
                        next.set(key, { value: entry.value, base: cur });
                        changed = true;
                        continue;
                    }
                    still_pending = true;
                }
                next.set(key, entry);
            }
            // Notify only on a real change: get_cell_raw rebinds on every page
            // load, so an unconditional notification would re-render (and
            // recompute conflicted_keys) on every scroll of a pending session.
            if (!changed) {
                state = { entries: state.entries, pending_base: still_pending };
                return;
            }
            set_entries(next, still_pending);
        },
    };
}
